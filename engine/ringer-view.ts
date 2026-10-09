// ringer-view: a chromeless, authenticated front for pymobiledevice3's `display serve-web`.
//
// WHY it exists:
//  - The stock viewer wraps the phone in a title bar, side trays and a bottom row, and its fit
//    maths reserves fixed margins for them. Fred wants only the phone, filling the window.
//  - The stock viewer needs a Basic login. Putting the password in the page URL makes Chromium
//    refuse the video fetch (0.0 fps), so this proxy adds the login upstream instead.
//  - Anything in the browser could POST /touch to a bare loopback port. Every request here needs
//    a SameSite=Strict cookie that is only issued for ?k=<token>, so other web pages cannot send input.
//
// pymobiledevice3 is GPL-3.0: we only talk to it over HTTP, we never copy its code. The patches
// below are applied to its served JS in memory, and fail loud (log + unpatched pass-through) if the
// pinned version's text moves.

import { readFileSync } from "node:fs";

const cfg = `${process.env.HOME}/.config/ringer`;
const UPSTREAM = process.env.RINGER_UPSTREAM ?? "http://127.0.0.1:18091";
const PORT = Number(process.env.RINGER_PORT ?? 18092);
const token = readFileSync(`${cfg}/token`, "utf8").trim();
const upstreamAuth = "Basic " + Buffer.from(`ringer:${readFileSync(`${cfg}/vnc.pw`, "utf8").trim()}`).toString("base64");

const CSS = `
#topbar,#left-tray,#right-tray,#status,#help-overlay{display:none !important}
html,body{background:#05070a}
body{padding:2px;gap:0;min-height:100vh;overflow:hidden}
#workspace{gap:0}
#stage-wrap{padding:0;gap:0;max-height:none}
#stage::before{display:none}
/* The stock button row (Swipe, Home, Siri) hides below the window and slides up when the mouse
   touches the hot zone along the bottom edge. A small handle, like the iPhone's home bar, shows
   where to hover. Its buttons keep the viewer's own handlers. */
#bottom-row{display:flex !important;flex-wrap:nowrap;position:fixed;left:0;right:0;margin:0 auto;width:max-content;
  bottom:10px;z-index:30;transform:translateY(calc(100% + 24px));opacity:0;pointer-events:none;
  box-shadow:0 6px 24px #000c;transition:transform .16s ease,opacity .16s ease}
#ringer-hot{position:fixed;left:0;right:0;bottom:0;height:16px;z-index:25}
#ringer-hot::after{content:"";position:absolute;left:50%;bottom:4px;width:96px;height:4px;margin-left:-48px;
  border-radius:2px;background:rgba(255,255,255,.4);transition:opacity .16s ease,background .16s ease}
#ringer-hot:hover::after{opacity:0}
body:has(#ringer-hot:hover) #bottom-row,#bottom-row:hover{transform:translateY(0);opacity:1;pointer-events:auto}
`;

// [needle, replacement] pairs for the fixed margins in the stock fit maths (pymobiledevice3 11.26.0).
const JS_PATCHES: [string, string][] = [
  ["window.innerHeight - 150", "window.innerHeight - 6"],
  ["trayW('right-tray')) + 48 + 40", "trayW('right-tray')) + 16"],
];

function hasCookie(req: Request): boolean {
  return (req.headers.get("cookie") ?? "").split(/;\s*/).includes(`ringer=${token}`);
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host"]);

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // /stream and /clipboard/events are long-lived
  async fetch(req) {
    const url = new URL(req.url);
    // DNS-rebinding guard: only answer to our own loopback name.
    if (url.hostname !== "127.0.0.1") return new Response("bad host", { status: 421 });

    if (url.searchParams.get("k") === token) {
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": `ringer=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    if (!hasCookie(req)) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/ringer.css") return new Response(CSS, { headers: { "content-type": "text/css" } });

    // The upstream rejects any request whose Origin host differs from its own Host (its CSRF guard),
    // and the browser's Origin names this proxy. So: refuse foreign origins here, then present the
    // upstream's own origin to it.
    const origin = req.headers.get("origin");
    if (origin && origin !== "null" && new URL(origin).host !== url.host) return new Response("forbidden origin", { status: 403 });

    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP.has(k) && k !== "cookie" && k !== "authorization") headers.set(k, v);
    if (origin) headers.set("origin", UPSTREAM);
    if (headers.has("referer")) headers.set("referer", UPSTREAM + "/");
    headers.set("authorization", upstreamAuth);
    headers.set("accept-encoding", "identity");
    // Buffer request bodies (touch/key/clipboard POSTs are small). A streamed body goes out chunked,
    // and the upstream's hand-rolled HTTP parser only reads Content-Length, so it saw an empty body.
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const up = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      signal: req.signal,
    });

    const out = new Headers();
    for (const [k, v] of up.headers) if (!HOP.has(k)) out.set(k, v);

    if (url.pathname === "/" && up.ok) {
      const html = (await up.text())
        .replace("<title>pymobiledevice3 screen</title>", "<title>Ringer</title>")
        .replace("</head>", '<link rel="stylesheet" href="/ringer.css"></head>')
        .replace("</body>", '<div id="ringer-hot"></div></body>');
      return new Response(html, { status: up.status, headers: out });
    }
    if (url.pathname === "/viewer.js" && up.ok) {
      let js = await up.text();
      for (const [needle, repl] of JS_PATCHES) {
        if (js.includes(needle)) js = js.replace(needle, repl);
        else console.error(`ringer-view: viewer.js patch not found, left unpatched: ${needle}`);
      }
      return new Response(js, { status: up.status, headers: out });
    }
    return new Response(up.body, { status: up.status, headers: out });
  },
});

console.log(`ringer-view listening on http://127.0.0.1:${PORT}/ -> ${UPSTREAM}`);
