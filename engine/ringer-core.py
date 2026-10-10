#!/usr/bin/env python3
"""ringer-core: launch pymobiledevice3 unchanged, with ONE behaviour change.

WHY: the first time you type from the desktop, pymobiledevice3's serve-web registers a virtual
hardware keyboard with the iPhone. While a hardware keyboard is attached iOS hides its on-screen
keyboard, and the server only drops that virtual keyboard when the media session restarts. So after
typing once from the desktop you could no longer use the phone's own keyboard (Fred, 2026-10-09).

WHAT: wrap ScreenStreamServer._handle_key so that IDLE_SECONDS after the last desktop keystroke (and
never while a key is held) the HID connection that carries the virtual keyboard is closed. That
deregisters the keyboard, the phone's on-screen keyboard works again, and touch/buttons re-open their
HID connection by themselves on the next tap (the worker already does that lazily). Video and audio
are not touched, so there is no restart glitch.

Everything else is stock: this file only patches one method in memory and then runs the normal CLI.
pymobiledevice3 is GPL-3.0; nothing of it is copied here. The patch is pinned to the internals of
11.26.0 and fails loudly at start-up if they move.
"""

import asyncio
import base64
import contextlib
import hmac
import json
import sys
import time

from pymobiledevice3.__main__ import main
from pymobiledevice3.remote.core_device import screen_stream
from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
from pymobiledevice3.remote.core_device.screen_stream import ScreenStreamServer as Server

IDLE_SECONDS = 5.0

for _name in ("_handle_key", "_ensure_hid", "_ensure_keyboard", "_stop_hid"):
    if not hasattr(Server, _name):
        sys.exit(f"ringer-core: pymobiledevice3 changed (ScreenStreamServer.{_name} is gone); refusing to run the keyboard patch")

# STILL SCREEN != BROKEN STREAM (Fred, 2026-10-09: "waiting for frames" all the time). The phone's encoder sends
# nothing while the screen does not change, and the stock stall watchdog restarts the whole media stream after
# _STALL_RESTART_SECS = 5 s without a frame, so every pause restarted it (97 restarts in one evening on fnix).
# Wait for a real outage (60 s) and, while the screen is still, ask for one fresh frame every 10 s as a heartbeat so
# the viewer keeps seeing life. A forced keyframe every few seconds can itself stall the encoder (the server's own
# comments report that), hence 10 s.
STALL_RESTART_SECS = 60.0
KEEPALIVE_SECS = 10.0
for _name in ("_stall_watchdog", "_request_recovery_idr"):
    if not hasattr(Server, _name):
        sys.exit(f"ringer-core: pymobiledevice3 changed (ScreenStreamServer.{_name} is gone); refusing to run the watchdog patch")
if not hasattr(screen_stream, "_STALL_RESTART_SECS"):
    sys.exit("ringer-core: pymobiledevice3 changed (_STALL_RESTART_SECS is gone); refusing to run the watchdog patch")
screen_stream._STALL_RESTART_SECS = STALL_RESTART_SECS
_original_watchdog = Server._stall_watchdog


async def _watchdog_with_keepalive(self) -> None:
    async def keepalive() -> None:
        loop = asyncio.get_running_loop()
        last = 0.0
        while True:
            await asyncio.sleep(2.0)
            if not self._subscribers or self._active_service is None:
                continue
            now = loop.time()
            if now - self._last_good_au_t >= KEEPALIVE_SECS - 1 and now - last >= KEEPALIVE_SECS:
                last = now
                self._request_recovery_idr(reason="ringer-keepalive")

    task = asyncio.create_task(keepalive())
    try:
        await _original_watchdog(self)
    finally:
        task.cancel()


Server._stall_watchdog = _watchdog_with_keepalive

# ORIENTATION. The phone keeps its capture buffer portrait-shaped and turns the picture inside it when it goes
# landscape, and the server can only change orientation, not report it. The phone does report it through its
# display-info call, so poll that over the engine's own RSD connection (a service, not a second RSD client) and offer
# the result on a small authenticated port next to the viewer, for the gus proxy to hand to the page.
ORIENT_PORT = 18093
_orientation = {"orientation": None, "flat": None, "t": 0.0}
_orient_server = None


def _arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else default


async def _serve_orientation() -> None:
    global _orient_server
    if _orient_server is not None:
        return
    password = _arg("--password", "")
    expected = "Basic " + base64.b64encode(f"ringer:{password}".encode()).decode()

    async def handle(reader, writer):
        try:
            head = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)).decode("latin1")
            auth = next((l.split(":", 1)[1].strip() for l in head.split("\r\n") if l.lower().startswith("authorization:")), "")
            if password and hmac.compare_digest(auth, expected):
                status, body = "200 OK", json.dumps(_orientation).encode()
            else:
                status, body = "401 Unauthorized", b""
            writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    _orient_server = await asyncio.start_server(handle, _arg("--bind", "127.0.0.1"), ORIENT_PORT)


_watchdog_without_orientation = Server._stall_watchdog


async def _watchdog_with_orientation(self) -> None:
    async def poll() -> None:
        await _serve_orientation()
        last = None
        while True:
            try:
                async with DeviceInfoService(self._rsd) as svc:
                    while True:
                        o = (await svc.get_display_info()).get("orientation", {})
                        cur, flat = o.get("currentDeviceOrientation"), o.get("currentDeviceNonFlatOrientation")
                        _orientation.update(orientation=flat if cur in (None, "faceUp", "faceDown", "unknown") else cur, flat=flat, t=time.time())
                        if _orientation["orientation"] != last:
                            last = _orientation["orientation"]
                            print(f"ringer-core: phone orientation {last} (device says {cur}, last upright {flat})", flush=True)
                        await asyncio.sleep(1.0)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"ringer-core: orientation poll failed: {exc}", flush=True)
                await asyncio.sleep(3.0)

    task = asyncio.create_task(poll())
    try:
        await _watchdog_without_orientation(self)
    finally:
        task.cancel()


Server._stall_watchdog = _watchdog_with_orientation
print(f"ringer-core: stall watchdog {STALL_RESTART_SECS:.0f} s, still-screen keepalive every {KEEPALIVE_SECS:.0f} s", flush=True)

_original_handle_key = Server._handle_key


async def _release_when_idle(self) -> None:
    loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(1.0)
        if self._kb_service_id is None:
            return  # already gone, for example after a stream restart
        if loop.time() - self._ringer_kb_last < IDLE_SECONDS:
            continue
        # IDLE_SECONDS without any key report. A key that is really held keeps repeating, so silence means nothing
        # is held: a key-up that never arrived (focus left the window mid-press, e.g. a Super shortcut) must not pin
        # the virtual keyboard, and with it the phone's on-screen keyboard, for ever. Lift anything still down first.
        stuck = self._ringer_keys_down
        async with self._hid_lock:
            if self._uhs is not None:
                with contextlib.suppress(Exception):
                    if self._kb_service_id is not None:
                        await self._uhs.send_keyboard(self._kb_service_id, [])
                with contextlib.suppress(Exception):
                    await self._uhs.close()
                self._uhs = None
            self._kb_service_id = None
        self._ringer_keys_down = False
        print("ringer-core: virtual keyboard released (idle"
              + ("; a key-up never arrived" if stuck else "")
              + "); the phone's own keyboard is available again", flush=True)
        return


def _products(x, out):
    if isinstance(x, dict):
        for k, v in x.items():
            if k in ("Product", "product"):
                out.add(v.get("string") if isinstance(v, dict) else str(v))
            else:
                _products(v, out)
    elif isinstance(x, list):
        for v in x:
            _products(v, out)


async def _handle_key(self, body: bytes):
    # Debug hook (used to check that the virtual keyboard really goes away): POST /key {"ringer_debug": "hid"} prints
    # the HID surfaces the phone has registered, through the core's own connection (a second client would evict it).
    try:
        if json.loads(body).get("ringer_debug") == "hid":
            await self._ensure_hid()
            names: set = set()
            _products(await self._uhs.list_connected_services(), names)
            print("ringer-core: HID services: " + ", ".join(sorted(n for n in names if n)), flush=True)
            return 200, b"ok"
    except Exception as exc:
        print(f"ringer-core: HID debug failed: {exc}", flush=True)
        return 200, b"ok"
    result = await _original_handle_key(self, body)
    try:
        usages = json.loads(body).get("usages", [])
    except Exception:
        usages = []
    self._ringer_keys_down = bool(usages)
    self._ringer_kb_last = asyncio.get_running_loop().time()
    task = getattr(self, "_ringer_kb_task", None)
    if task is None or task.done():
        self._ringer_kb_task = asyncio.create_task(_release_when_idle(self))
    return result


Server._handle_key = _handle_key

if __name__ == "__main__":
    sys.argv[0] = "pymobiledevice3"
    main()
