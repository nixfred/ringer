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

  // ---- scripted strokes -----------------------------------------------------------------------------------------
  let busy = false; // a scripted stroke is running
  const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

  async function stroke(points, dt, holdEndMs = 0) {
    if (busy || (typeof activePointer !== 'undefined' && activePointer !== null) || ws || zs) return;
    busy = true;
    try {
      await send('contact', points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) { await sleep(dt); await send('contact', points[i][0], points[i][1]); }
      const [x, y] = points[points.length - 1];
      for (let h = 0; h < holdEndMs; h += 100) { await sleep(100); await send('contact', x, y); }
      await send('release', x, y);
    } finally { busy = false; }
  }

  const gestures = {
    back: () => stroke(line(1200, 33000, 36000, 33000, 10), 16),                 // from the left edge, rightwards
    forward: () => stroke(line(64300, 33000, 29000, 33000, 10), 16),             // from the right edge, leftwards
    switcher: () => stroke(line(32768, 65000, 32768, 36000, 14), 16, 600),       // up from the bottom edge, then hold
    control: () => stroke(line(58500, 400, 58500, 30000, 12), 16),               // down from the top right corner
    notifications: () => stroke(line(16000, 400, 16000, 34000, 12), 16),         // down from the top left
    refresh: () => stroke(line(32768, 20000, 32768, 46000, 18), 28, 250),        // slow pull down, hold, release
  };
  window.ringerGestures = gestures;

  // ---- wheel: scroll / pull to refresh / horizontal --------------------------------------------------------------
  const UNITS_PER_PX = 40;         // finger travel per wheel pixel (one notch is ~100 px, about 6% of the screen)
  const IDLE_MS = 140;             // no wheel event for this long ends the stroke
  const LO = 2500, HI = 63000;     // keep the finger off the very edges: those start system gestures
  let ws = null;                   // { x, y, hist: [[t, x, y]], timer }
  const burst = [];                // recent wheel timestamps, for acceleration

  function wheelEnd() {
    if (!ws) return;
    const s = ws; ws = null; clearTimeout(s.timer);
    // Fling: if the last 120 ms moved fast, continue that motion for a few quick samples so iOS sees velocity.
    const now = performance.now();
    const recent = s.hist.filter((h) => now - h[0] < 120);
    let { x, y } = s;
    if (recent.length >= 2) {
      const a = recent[0], b = recent[recent.length - 1], dtm = Math.max(1, b[0] - a[0]);
      const vx = (b[1] - a[1]) / dtm, vy = (b[2] - a[2]) / dtm; // units per ms
      if (Math.hypot(vx, vy) > 9) for (let i = 0; i < 3; i++) { x = clamp(x + vx * 16, LO, HI); y = clamp(y + vy * 16, LO, HI); send('contact', x, y); }
    }
    send('release', x, y);
  }

  function wheelMove(c, fx, fy) {
    if (!ws) {
      const x = clamp(c.x, 4000, 61500), y = clamp(c.y, 7000, 58500);
      ws = { x, y, hist: [], timer: 0 };
      send('contact', x, y);
    }
    const nx = clamp(ws.x + fx, LO, HI), ny = clamp(ws.y + fy, LO, HI);
    const atEdge = nx !== ws.x + fx || ny !== ws.y + fy;
    ws.x = nx; ws.y = ny;
    ws.hist.push([performance.now(), nx, ny]);
    if (ws.hist.length > 12) ws.hist.shift();
    send('contact', nx, ny);
    clearTimeout(ws.timer);
    ws.timer = setTimeout(wheelEnd, atEdge ? 0 : IDLE_MS); // out of room: lift now, the next notch starts a new stroke
  }

  // ---- ctrl + wheel: zoom by double-tap and drag ------------------------------------------------------------------
  let zs = null; // { x, y, ready, pending, timer }
  async function zoomEnd() {
    if (!zs) return;
    const s = zs; zs = null; clearTimeout(s.timer);
    await send('release', s.x, s.y);
  }
  function zoomMove(c, dyFinger) {
    if (!zs) {
      zs = { x: clamp(c.x, 4000, 61500), y: clamp(c.y, 12000, 53000), ready: false, pending: 0, timer: 0 };
      const s = zs;
      (async () => {
        await send('contact', s.x, s.y); await sleep(40); await send('release', s.x, s.y); // first tap
        await sleep(70);
        await send('contact', s.x, s.y);                                                    // second tap, held for the drag
        s.ready = true;
        if (s.pending) { s.y = clamp(s.y + s.pending, LO, HI); await send('contact', s.x, s.y); s.pending = 0; }
      })();
    }
    if (!zs.ready) zs.pending += dyFinger;
    else { zs.y = clamp(zs.y + dyFinger, LO, HI); send('contact', zs.x, zs.y); }
    clearTimeout(zs.timer);
    zs.timer = setTimeout(zoomEnd, 260);
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (busy || (typeof activePointer !== 'undefined' && activePointer !== null)) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    const c = touchCoords(e);
    const now = performance.now();
    burst.push(now); while (burst.length && now - burst[0] > 250) burst.shift();
    const accel = 1 + Math.min(1.5, Math.max(0, burst.length - 3) / 5);
    if (e.ctrlKey) {
      if (ws) wheelEnd();
      // wheel up = zoom in = finger moves down (set the sign here if a particular app wants the opposite)
      zoomMove(c, -dy * UNITS_PER_PX * 0.6);
      return;
    }
    if (zs) zoomEnd();
    // Content follows the finger: wheel down scrolls down, so the finger moves up.
    wheelMove(c, -dx * UNITS_PER_PX * accel, -dy * UNITS_PER_PX * accel);
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
        dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight }) }).catch(() => {});
  }, 2000);
})();
