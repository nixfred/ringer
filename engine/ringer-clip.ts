// ringer-clip: two-way clipboard sync between this Wayland desktop and the iPhone pasteboard.
//
// It talks to the local ringer-core server (pymobiledevice3 `display serve-web`, loopback only), which
// already owns the iPhone's CoreDevice pasteboard service:
//   GET  /clipboard                  -> {text, image, seq}   current device clipboard
//   GET  /clipboard/events?since=N   -> long-poll, returns when something is copied ON THE PHONE
//   GET  /clipboard/image?seq=N      -> PNG bytes
//   POST /clipboard {text} | POST /clipboard/image (image/png)  -> set the phone's clipboard
// pymobiledevice3 is GPL-3.0: we only call it over HTTP.
//
// Rules this daemon keeps:
//  - It runs only while ringer-core runs (the unit is PartOf it), so nothing syncs when Ringer is closed.
//  - Copies flagged as coming from a password manager are never sent to the phone.
//  - The first state on each side is a baseline, never an overwrite: starting the daemon changes nothing.
//  - One hash of the last content that crossed in EITHER direction stops the two sides echoing forever.
//  - Only the CLIPBOARD selection is touched, never PRIMARY (the clipboard lock cares about that).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const cfg = `${process.env.HOME}/.config/ringer`;
const UPSTREAM = process.env.RINGER_UPSTREAM ?? "http://127.0.0.1:18091";
const auth = "Basic " + Buffer.from(`ringer:${readFileSync(`${cfg}/vnc.pw`, "utf8").trim()}`).toString("base64");
const MAX_BYTES = 10 * 1024 * 1024;

let last = ""; // sha256 of the last content that crossed in either direction

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const up = (path: string, init: RequestInit = {}) =>
  fetch(UPSTREAM + path, { ...init, headers: { authorization: auth, ...(init.headers as Record<string, string>) } });

async function capture(cmd: string[]): Promise<Uint8Array> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  return out;
}

// wl-copy forks to keep serving the selection, so its stdout must not be a pipe we wait on.
async function setHost(data: string | Uint8Array, mime: string) {
  const p = Bun.spawn(["wl-copy", "--type", mime], { stdin: new Blob([data]), stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

// ---------------------------------------------------------------- host -> phone

async function pushHost() {
  const types = new TextDecoder().decode(await capture(["wl-paste", "--list-types"])).split("\n").map((t) => t.trim());
  if (types.some((t) => /passwordManagerHint/i.test(t))) return log("host copy skipped: flagged by a password manager");

  if (types.includes("image/png")) {
    const png = await capture(["wl-paste", "--type", "image/png"]);
    if (!png.length || png.length > MAX_BYTES) return;
    const h = sha(png);
    if (h === last) return;
    const prev = last;
    last = h;
    const r = await up("/clipboard/image", { method: "POST", headers: { "content-type": "image/png" }, body: png }).catch(() => null);
    if (!r?.ok) { last = prev; return log(`host image -> phone failed (${r ? r.status : "unreachable"})`); }
    return log(`host image -> phone (${png.length} bytes)`);
  }

  if (types.some((t) => t.startsWith("text/") || t === "UTF8_STRING" || t === "STRING")) {
    const text = new TextDecoder().decode(await capture(["wl-paste", "--no-newline"]));
    if (!text || text.length > MAX_BYTES) return;
    const h = sha(text);
    if (h === last) return;
    const prev = last;
    last = h;
    const r = await up("/clipboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
    if (!r?.ok) { last = prev; return log(`host text -> phone failed (${r ? r.status : "unreachable"})`); }
    return log(`host text -> phone (${text.length} chars)`);
  }
}

async function watchHost() {
  for (;;) {
    // `wl-paste --watch echo c` prints a line on every clipboard change, plus one at start (the baseline).
    const w = Bun.spawn(["wl-paste", "--watch", "echo", "c"], { stdout: "pipe", stderr: "ignore" });
    const reader = w.stdout.getReader();
    let baseline = true;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      if (baseline) {
        baseline = false;
        const t = new TextDecoder().decode(await capture(["wl-paste", "--no-newline"]).catch(() => new Uint8Array()));
        if (t) last = sha(t); // what is already on the host is not news
        continue;
      }
      await pushHost().catch((e) => log(`host push error: ${e}`));
    }
    log("wl-paste watcher ended, restarting");
    await sleep(2000);
  }
}

// ---------------------------------------------------------------- phone -> host

async function watchPhone() {
  let since: number | null = null;
  for (;;) {
    try {
      if (since === null) {
        // Baseline only: what is on the phone now is not copied over on start-up.
        const cur = await (await up("/clipboard")).json();
        since = Number(cur.seq ?? 0);
        log(`phone clipboard baseline seq=${since}`);
      }
      const r = await up(`/clipboard/events?since=${since}`);
      if (!r.ok) throw new Error(`events HTTP ${r.status}`);
      const j = await r.json();
      since = Number(j.seq ?? since);
      if (j.text == null && !j.image) continue;

      if (j.image) {
        const img = new Uint8Array(await (await up(`/clipboard/image?seq=${j.seq}`)).arrayBuffer());
        if (!img.length || img.length > MAX_BYTES) continue;
        const h = sha(img);
        if (h === last) continue;
        last = h;
        await setHost(img, "image/png");
        log(`phone image -> host (${img.length} bytes)`);
      } else {
        const text = String(j.text);
        const h = sha(text);
        if (h === last) continue;
        last = h;
        await setHost(text, "text/plain;charset=utf-8");
        log(`phone text -> host (${text.length} chars)`);
      }
    } catch (e) {
      since = null; // resync the baseline after any failure (core restarted, phone unplugged, ...)
      log(`phone watcher: ${e instanceof Error ? e.message : e}`);
      await sleep(3000);
    }
  }
}

log("ringer-clip starting");
await Promise.all([watchHost(), watchPhone()]);
