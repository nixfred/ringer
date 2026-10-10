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
import contextlib
import json
import sys

from pymobiledevice3.__main__ import main
from pymobiledevice3.remote.core_device import screen_stream
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
print(f"ringer-core: stall watchdog {STALL_RESTART_SECS:.0f} s, still-screen keepalive every {KEEPALIVE_SECS:.0f} s", flush=True)

_original_handle_key = Server._handle_key


async def _release_when_idle(self) -> None:
    loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(1.0)
        if self._kb_service_id is None:
            return  # already gone, for example after a stream restart
        if self._ringer_keys_down or loop.time() - self._ringer_kb_last < IDLE_SECONDS:
            continue
        async with self._hid_lock:
            if self._uhs is not None:
                with contextlib.suppress(Exception):
                    await self._uhs.close()
                self._uhs = None
            self._kb_service_id = None
        print("ringer-core: virtual keyboard released (idle); the phone's own keyboard is available again", flush=True)
        return


async def _handle_key(self, body: bytes):
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
