// ringer-gestures: mouse wheel scrolling, pull to refresh, edge swipes and system gestures for the phone window.
// Injected after viewer.js by ringer-view.ts, so postJson / touchCoords / canvas / activePointer from the stock
// viewer are in scope.
//
// The phone's HID touchscreen takes ONE finger at a time (no second contact, no scroll-wheel event, no
// pinch), so every gesture here is a scripted single-finger stroke. Coordinates are the device's 0..65535 space.
//
//   wheel up/down        scroll (finger drags; fast spins end with a small fling so iOS adds momentum)
//   wheel up past top    pull to refresh (the same drag just keeps going until you stop)
//   shift + wheel        horizontal scroll
//   ctrl  + wheel        zoom by double-tap-and-drag (Maps style; true pinch is impossible with one finger)
//   mouse back/forward   iOS back / forward edge swipes
//   middle click         App Switcher
//   toolbar              App Switcher, Control Center, Notifications, Refresh
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Touch samples must reach the phone in order, so they go through one promise chain.
  let chain = Promise.resolve();
  const send = (type, x, y) => (chain = chain.then(() => postJson('/touch', { type, x: Math.round(x), y: Math.round(y) })));
  // Gestures are written for the picture as the user SEES it, as fractions u,v of its width and height (0,0 = top left),
  // and mapped into the phone's own coordinates through the stock viewer's touchCoords(), which already undoes any
  // rotation. So they work the same whether the phone is portrait or landscape.
  function uv(u, v) {
    const r = canvas.getBoundingClientRect();
    return touchCoords({ clientX: r.left + u * r.width, clientY: r.top + v * r.height });
  }
  const sendUV = (type, u, v) => { const c = uv(u, v); return send(type, c.x, c.y); };

  // ---- scripted strokes -----------------------------------------------------------------------------------------
  let busy = false; // a scripted stroke is running
  const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

  async function stroke(points, dt, holdEndMs = 0) {
    if (busy || (typeof activePointer !== 'undefined' && activePointer !== null) || ws || zs) return;
    busy = true;
    try {
      await sendUV('contact', points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) { await sleep(dt); await sendUV('contact', points[i][0], points[i][1]); }
      const [u, v] = points[points.length - 1];
      for (let h = 0; h < holdEndMs; h += 100) { await sleep(100); await sendUV('contact', u, v); }
      await sendUV('release', u, v);
    } finally { busy = false; }
  }

  const gestures = {
    back: () => stroke(line(0.018, 0.5, 0.55, 0.5, 10), 16),                     // from the left edge, rightwards
    forward: () => stroke(line(0.982, 0.5, 0.44, 0.5, 10), 16),                  // from the right edge, leftwards
    switcher: () => stroke(line(0.5, 0.992, 0.5, 0.55, 14), 16, 600),            // up from the bottom edge, then hold
    control: () => stroke(line(0.893, 0.006, 0.893, 0.458, 12), 16),             // down from the top right corner
    notifications: () => stroke(line(0.244, 0.006, 0.244, 0.519, 12), 16),       // down from the top left
    refresh: () => stroke(line(0.5, 0.305, 0.5, 0.70, 18), 28, 250),             // slow pull down, hold, release
  };
  window.ringerGestures = gestures;

  // ---- wheel: scroll / pull to refresh / horizontal --------------------------------------------------------------
  // Positions are fractions (u,v) of the picture as the user sees it, mapped to the phone through uv(), so scrolling follows
  // the picture whether the phone is portrait or landscape.
  const PER_PX = 40 / 65535;       // finger travel per wheel pixel, as a fraction of the picture (one notch is ~100 px, about 6%)
  const IDLE_MS = 140;             // no wheel event for this long ends the stroke
  const LO = 2500 / 65535, HI = 63000 / 65535;   // keep the finger off the very edges: those start system gestures
  let ws = null;                   // { u, v, hist: [[t, u, v]], timer }
  const burst = [];                // recent wheel timestamps, for acceleration
  const clamp01 = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const frac = (e) => { const r = canvas.getBoundingClientRect(); return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height }; };

  function wheelEnd() {
    if (!ws) return;
    const s0 = ws; ws = null; clearTimeout(s0.timer);
    // Fling: if the last 120 ms moved fast, continue that motion for a few quick samples so iOS sees velocity.
    const now = performance.now();
    const recent = s0.hist.filter((h) => now - h[0] < 120);
    let { u, v } = s0;
    if (recent.length >= 2) {
      const a0 = recent[0], b0 = recent[recent.length - 1], dtm = Math.max(1, b0[0] - a0[0]);
      const vu = (b0[1] - a0[1]) / dtm, vv = (b0[2] - a0[2]) / dtm; // fractions per ms
      if (Math.hypot(vu, vv) > 9 / 65535) for (let i = 0; i < 3; i++) { u = clamp01(u + vu * 16, LO, HI); v = clamp01(v + vv * 16, LO, HI); sendUV('contact', u, v); }
    }
    sendUV('release', u, v);
  }

  function wheelMove(p, fu, fv) {
    if (!ws) {
      ws = { u: clamp01(p.u, 0.06, 0.94), v: clamp01(p.v, 0.107, 0.893), hist: [], timer: 0 };
      sendUV('contact', ws.u, ws.v);
    }
    const nu = clamp01(ws.u + fu, LO, HI), nv = clamp01(ws.v + fv, LO, HI);
    const atEdge = nu !== ws.u + fu || nv !== ws.v + fv;
    ws.u = nu; ws.v = nv;
    ws.hist.push([performance.now(), nu, nv]);
    if (ws.hist.length > 12) ws.hist.shift();
    sendUV('contact', nu, nv);
    clearTimeout(ws.timer);
    ws.timer = setTimeout(wheelEnd, atEdge ? 0 : IDLE_MS); // out of room: lift now, the next notch starts a new stroke
  }

  // ---- ctrl + wheel: zoom by double-tap and drag ------------------------------------------------------------------
  let zs = null; // { u, v, ready, pending, timer }
  async function zoomEnd() {
    if (!zs) return;
    const z = zs; zs = null; clearTimeout(z.timer);
    await sendUV('release', z.u, z.v);
  }
  function zoomMove(p, dv) {
    if (!zs) {
      zs = { u: clamp01(p.u, 0.06, 0.94), v: clamp01(p.v, 0.18, 0.81), ready: false, pending: 0, timer: 0 };
      const z = zs;
      (async () => {
        await sendUV('contact', z.u, z.v); await sleep(40); await sendUV('release', z.u, z.v); // first tap
        await sleep(70);
        await sendUV('contact', z.u, z.v);                                                      // second tap, held for the drag
        z.ready = true;
        if (z.pending) { z.v = clamp01(z.v + z.pending, LO, HI); await sendUV('contact', z.u, z.v); z.pending = 0; }
      })();
    }
    if (!zs.ready) zs.pending += dv;
    else { zs.v = clamp01(zs.v + dv, LO, HI); sendUV('contact', zs.u, zs.v); }
    clearTimeout(zs.timer);
    zs.timer = setTimeout(zoomEnd, 260);
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (busy || (typeof activePointer !== 'undefined' && activePointer !== null)) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    const p = frac(e);
    const now = performance.now();
    burst.push(now); while (burst.length && now - burst[0] > 250) burst.shift();
    const accel = 1 + Math.min(1.5, Math.max(0, burst.length - 3) / 5);
    if (e.ctrlKey) {
      if (ws) wheelEnd();
      // wheel up = zoom in = finger moves down (flip the sign here if a particular app wants the opposite)
      zoomMove(p, -dy * PER_PX * 0.6);
      return;
    }
    if (zs) zoomEnd();
    // Content follows the finger: wheel down scrolls down, so the finger moves up.
    wheelMove(p, -dx * PER_PX * accel, -dy * PER_PX * accel);
  }, { passive: false });

  // ---- mouse buttons: back / forward / middle ---------------------------------------------------------------------
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1) { e.preventDefault(); gestures.switcher(); }
    else if (e.button === 3) { e.preventDefault(); gestures.back(); }
    else if (e.button === 4) { e.preventDefault(); gestures.forward(); }
  });
  // Stop the browser acting on them too (history navigation, middle-click autoscroll).
  for (const t of ['mousedown', 'mouseup', 'auxclick', 'pointerup']) {
    canvas.addEventListener(t, (e) => { if (e.button === 1 || e.button >= 3) e.preventDefault(); });
  }

  // ---- toolbar: extra buttons next to the stock Swipe / Home / Siri ---------------------------------------------------
  const row = document.getElementById('bottom-row');
  if (row) {
    for (const [label, tip, fn] of [
      ['Apps', 'App Switcher (middle click)', gestures.switcher],
      ['Control', 'Control Center (swipe down from the top right)', gestures.control],
      ['Notices', 'Notifications (swipe down from the top left)', gestures.notifications],
      ['Refresh', 'Pull to refresh (or keep rolling the wheel up at the top)', gestures.refresh],
      ['Vol \u2212', 'Quieter phone sound (gain)', () => setGain(gainValue / 1.4)],
      ['Vol +', 'Louder phone sound (gain)', () => setGain(gainValue * 1.4)],
    ]) {
      const b = document.createElement('button');
      b.className = 'btn'; b.type = 'button'; b.textContent = label; b.title = tip;
      b.addEventListener('click', fn);
      row.appendChild(b);
    }
  }

  // ---- orientation: follow the phone ----------------------------------------------------------------------------------
  // The phone keeps its capture buffer portrait-shaped and turns the picture inside it when it goes landscape. The engine
  // reports the orientation (via the proxy's /ringer-orient); turn the picture upright with the stock viewer's own
  // setVisualRotation, and the proxy resizes the window to match.
  const ORIENT_DEG = { portrait: 0, landscapeLeft: -90, landscapeRight: 90, portraitUpsideDown: 180 };
  let lastOrient = null;
  setInterval(async () => {
    try {
      const r = await fetch('/ringer-orient', { cache: 'no-store' });
      const o = (await r.json()).orientation;
      if (!o || o === lastOrient || !(o in ORIENT_DEG)) return;
      lastOrient = o;
      if (typeof setVisualRotation === 'function') setVisualRotation(ORIENT_DEG[o]);
      if (typeof log === 'function') log('orientation: ' + o);
    } catch { /* engine unreachable: leave the picture as it is */ }
  }, 1000);

  // ---- audio gain ---------------------------------------------------------------------------------------------------------
  // The stock viewer plays the phone's decoded PCM at unity gain and the phone's stream is quiet, so it goes through
  // a gain stage and a limiter (so a boost cannot clip). The gain is remembered per browser profile.
  let gainValue = (() => { try { const v = parseFloat(localStorage.getItem('ringerGain')); return v > 0 ? v : 2.5; } catch { return 2.5; } })();
  let outCtx = null, gainNode = null;
  window.__ringerOut = (ctx) => {
    if (outCtx !== ctx) {
      gainNode = ctx.createGain(); gainNode.gain.value = gainValue;
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -8; lim.knee.value = 10; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.1;
      gainNode.connect(lim); lim.connect(ctx.destination);
      outCtx = ctx;
    }
    return gainNode;
  };
  function setGain(v) {
    gainValue = Math.max(0.5, Math.min(8, v));
    try { localStorage.setItem('ringerGain', String(gainValue)); } catch { /* ignore */ }
    if (gainNode) gainNode.gain.value = gainValue;
    if (typeof log === 'function') log('audio gain x' + gainValue.toFixed(1));
  }
  window.ringerAudioGain = { get: () => gainValue, set: setGain };

  // ---- stats: lets the proxy (and so Larry) read the real frame rate instead of guessing --------------------------------
  setInterval(() => {
    const fpsEl = document.getElementById('fps');
    const fps = fpsEl ? parseFloat(fpsEl.textContent) : NaN;
    fetch('/ringer-stat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: Date.now(), fps: isNaN(fps) ? null : fps, frames: typeof frameCount === 'number' ? frameCount : null,
        audio: typeof audioCtx !== 'undefined' && audioCtx ? audioCtx.state : 'off',
        dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight,
        cw: canvas.width, ch: canvas.height, vr: typeof visualRotation !== 'undefined' ? visualRotation : null,
        lastLandscape: typeof lastFrameLandscape !== 'undefined' ? lastFrameLandscape : null,
        cssw: Math.round(canvas.getBoundingClientRect().width), cssh: Math.round(canvas.getBoundingClientRect().height) }) }).catch(() => {});
  }, 2000);
})();
