# Ringer TODO

One iPhone app for Omarchy on gus. Repo: `github.com/nixfred/ringer`. Status as of **2026-10-09**.
Legend: `[x]` done and verified · `[~]` built, not yet verified on the live phone · `[ ]` not started · `[?]` waiting on a decision · `[-]` deliberately not doing.
Effort: **S** under 1 h · **M** 1 to 3 h · **L** over 3 h. Every item says what "done" means, because "it should work" is not done.

## How it is wired (reference)
- **fnix (Mac)** runs the engine (`~/.ringer/venv`, launchd `com.nixfred.ringer-core`): screen, touch, keyboard, clipboard, audio decode, over Apple's own wireless tunnel. Reachable on the tailnet at `http://<mac-tailnet-ip>:18091`.
- **gus** runs `ringer-view` (proxy, chromeless window, gestures), `ringer-clip` (clipboard sync) and `iphone-connect` (calls over Bluetooth). Setting file `~/.config/ringer/upstream` selects the fnix engine; delete it for USB mode.
- Limits: the phone must share fnix's Wi-Fi (not cellular); fnix must stay awake; the phone accepts **one finger** only (no pinch).

## Done
- [x] Catalog research, 5 forks imported as subtrees into `nixfred/ringer`
- [x] Remote control: screen, tap, type, wheel scroll, pull to refresh, back/forward, App Switcher, long press (right button), hover toolbar
- [x] Wireless (no cable) through fnix, Device Hub pairing
- [x] Two-way clipboard sync (text and images)
- [x] Phone keyboard works again after typing from the desktop (virtual keyboard released when idle)
- [x] Bar icon (green/normal/dim) and status panel
- [x] Bluetooth paired and trusted, calls profile connected, 2,524 contacts synced

## Selected by Fred (2026-10-09), in build order

### Phase 0: foundations and quick wins (one evening, they protect everything after)
- [ ] **0.1 Phone sound end to end** (S). Play audio on the phone, hear it on gus through the Ringer window. Restore the sound toggle that the clean window hides. *Done when:* Fred hears it and the toggle is reachable.
- [x] **0.2 fnix link health and sleep-proofing** (M). *Built and verified 2026-10-09:* panel shows an fnix row and says whether fnix or the phone is the problem (rendered in Test Drive, both states); `ringer-awake.service` holds `caffeinate -i` on fnix only while Ringer is open (checked: assertion appears on start, gone on stop). *Not yet tested:* a full 30 minute idle on fnix. Panel row for the fnix link, clear message when fnix is unreachable or the phone is off the LAN, keep fnix awake while Ringer is open (wrap the engine in `caffeinate`). Benefits Blip too (same Mac). *Done when:* the panel shows the link state, and a 30 minute idle on fnix does not drop the stream.
- [x] **0.3 Refresh the live bar plugin from the repo** (S). *Done 2026-10-09:* staged swap, Quickshell PID unchanged; window position is recorded by the plugin helper and restored by the launcher (verified twice, exact). The installed copy predates the panel wording and remote-aware status. Staged copy plus one `mv`. Remember the window position between opens. *Done when:* live plugin matches `plugin/`, window reopens where it was.

- [~] **0.4 Phone audio too quiet** (S). Built 2026-10-09: x2.5 gain plus limiter in the page, Vol -/+ on the hover toolbar (headless-tested only). *Done when:* Fred says the level is right on the live phone.
- [x] **0.5 "Waiting for frames" and frame rate** (M). *Root cause found and fixed 2026-10-09:* the server's stall watchdog (`_STALL_RESTART_SECS = 5`) restarted the whole stream after 5 s without a frame, and a still phone screen sends none (97 restarts in one evening); the page added "Stream offline" at 3 s and a restart at 25 s. `ringer-core.py` now waits 60 s and sends a heartbeat frame every 10 s on a still screen; `ringer-view.ts` raises the page thresholds (25 s / 120 s). *Measured:* 0 new restarts; page fps equals network fps (nothing dropped on gus: Brave CPU 2 to 44%); the stream reaches 44 to 55 fps at 5 to 6 Mbps in heavy motion, the phone encoder's own ceiling, and follows the content (a talking-head Short gave 9 to 35 fps). `--rctl --max-bitrate 12000` reached 7.8 Mbps and 51+ fps at one peak but was not a clear gain and carries a documented stall risk, so fnix runs `--no-motion-idr` only. Tools: `/ringer-stat` (page fps, network AU/s, kbps). *Open:* a clean A/B on a steady 60 fps source if Fred still sees stutter on a specific video.

- [x] **0.6 "Turn it off" must really turn it off, and the phone keyboard must come back** (M). *Findings 2026-10-09:* (1) the virtual-keyboard idle release worked only when every key-up arrived; with a missing key-up (focus left the window mid-press) it **never fired** and the phone's on-screen keyboard stayed hidden. Reproduced on the real phone (virtual keyboard still registered 13 s later), fixed in `ringer-core.py` (release 5 s after the last key report whatever looks held, and lift stuck keys first), re-verified (gone after 9 s). Debug hook: `POST /key {"ringer_debug":"hid"}` prints the phone's registered HID surfaces to `fnix:~/.ringer/core.log` without evicting the engine. (2) Closing the window stopped nothing and STOP only stopped gus: the Mac engine kept running 24/7 (launchd KeepAlive). *Fixed:* the engine plist now lives in `~/.ringer/` (never auto-loads, KeepAlive only on crash), STOP also boots it out over ssh (`~/.config/ringer/remote-host`), the launcher starts it on demand (3 s), closing the window switches everything off after `autoOffSeconds` (default 120, plugin setting), the panel says "Ringer is off" instead of an error. Verified live: after STOP the gus units, window, Mac engine and wake lock are all off; OPEN restores them with a live stream. *Not yet confirmed by Fred on the phone:* the on-screen keyboard visibly returning after typing from the desktop (iOS may also need a text field re-tapped).
- [x] **0.7 Landscape follows the phone** (M). *Built and verified 2026-10-09:* the engine polls the phone's `getdisplayinfo` orientation (over its own RSD service, no eviction) and serves it on authenticated port 18093; the proxy relays `/ringer-orient`; the page calls the stock `setVisualRotation` (landscapeLeft -90, landscapeRight +90, upside-down 180); the proxy resizes the window (470x1005 to 1006x471 and back, centre kept). Gestures are now written in display space (u,v of the picture as seen, mapped through the stock `touchCoords`), so wheel, zoom, edge swipes and hover toolbar follow the rotation. Verified: real phone landscapeLeft showed upright at 1006x471, then returned to portrait by itself when the phone was rotated back; headless test of all four orientations and wheel axis in landscape; portrait gesture regression unchanged. *Limit:* it follows the phone's reported physical orientation, so an app locked to portrait while the phone is held landscape would be turned wrongly.

### Phase 1: calls (your first request, so prove it before building more on it)
- [ ] **1.1 Real call test** (S) **needs Fred's OK on a number**. Outgoing, incoming (call this phone from another line), answer on gus, hang up, DTMF, audio on Govee pair + Maono mic. *Done when:* a call is heard both ways and the failures, if any, are written down.
- [ ] **1.2 Call audio devices** (S). Setting for which output/mic calls use (Govee pair vs headset). Depends on 1.1.
- [x] **1.3 Dialer, answer/decline, recents, missed calls inside Ringer's panel** (L). *Built and tested 2026-10-09:* `plugin/Calls.qml` + tab bar in `Panel.qml`. Live state from `iphone-connect watch` (event-driven); idle view has number field with contact-name search (ranked by word start, 2,524 contacts), 3x4 keypad, CALL, REDIAL, RECENTS (All / Missed, scrolls inside its own box, missed in red, badge on the tab and a red dot on the bar icon); incoming card with ANSWER / DECLINE; in-call card with timer, MUTE, KEYPAD (DTMF), TAKE ON PC, HANG UP; the panel never auto-opens (it would grab the keyboard), the bar icon turns red while ringing and green in a call. Scriptable: `omarchy-shell nixfred.ringer dial|answer|decline|hangup` (bind keys to them). Tested in Test Drive against `plugin/tests/fake-ringer.py` (invented people): all four scenarios rendered, `dial "555 555-0101"` sent `call 5555550101`, answer/decline/hangup correct, answer/hangup while idle did nothing, no QML errors. Installed on the live bar (hot reload, Quickshell PID unchanged); the live helper reaches the real backend (100 recents, 2,524 contacts). *Needs one shell restart* to register the new IPC commands (`dial/answer/decline/hangup/callsInfo`). *Not verified:* a real call (waiting on Fred), the Calls tab clicked on the live bar.
- [ ] **1.4 One icon** (S). Disable the separate iPhone Connect bar widget; its daemon stays, Ringer owns the UI. Depends on 1.3.
- [ ] **1.5 Notifications on the desktop** (M). Turn on `iphone-connect mirror`, show pop-ups and a list in the panel, clear on both sides. Opt-in per app. Depends on 1.4.
- [ ] **1.6 Music controls and battery** (S). Now-playing with previous/play/next, battery chip. Depends on 1.4.
- [ ] **1.7 Dynamic-Island style bubble** (M). Floating bubble that springs open for incoming calls, notifications, now-playing. UI only, so it comes last in this phase. Depends on 1.3, 1.5, 1.6. Reference: `buildscript-dev/omarchy-dynamic-island`.

### Phase 2: reach when you are out (Tailscale, works on cellular)
- [ ] **2.1 Phone to gus clipboard and files** (M). An Action Button / Back Tap Shortcut posts the clipboard, photos or files to a private tailnet endpoint on gus. This is the part of "out of the house" that Apple's local-only wireless link cannot do. Reference: `swheel33/tailbridge`, `aaronkhawkins/omarchy-iphone-clipboard`. *Done when:* a copy on the phone on cellular pastes on gus.

### Phase 3: control Omarchy from the phone
- [ ] **3.1 Sidecar wired into Ringer** (L). QR pairing, then workspaces, themes, file drop, media from the iPhone (fork already in `sidecar/`). Overlaps Shepr and the nixweb.app method: reuse that web-app approach. Test in Test Drive first. *Done when:* the phone switches a workspace and applies a theme on gus.

### Phase 4: messages and calendar
- [x] **4.1 DECIDED (Fred, 2026-10-09): link Blip, skip Pear Messages.** Blip (`~/Projects/blip`, v2.3, already on the bar, public) already gives iMessage through fnix, with a window, pinned chats, photos and replies. A second copy of the same design is not worth maintaining.
- [ ] **4.2 Link Blip into Ringer** (S). A Messages button and unread badge in Ringer's panel that opens Blip (via Blip's plugin IPC). No Bluetooth fallback (Fred chose the plain link). Blip and Ringer both depend on fnix being awake, which 0.2 handles.
- [ ] **4.3 CalDAV calendar sync with the iPhone** (M) **needs an Apple app-specific password from Fred**. Caution: the plugin replaces the built-in clock, so check it against the bar's current clock plugin in Test Drive before touching the live bar.

### Phase 5: camera
- [ ] **5.1 iPhone as a webcam on gus** (L). `v4l2loopback` kernel module on the Omarchy kernel (check headers/dkms first, via pacman), a user service, Safari on the phone over Tailscale. Cannot be tested in a VM (needs the camera). Reference: `boraoku/iOSCamForOmarchyLinux`.

### Phase 6: large and optional (decide after Phase 3)
- [ ] **6.1 Omodachi: Omarchy on the iPhone as an app** (L). Extra screen and touch-driven desktop on the iPhone. Needs an iOS app built with Xcode on fnix (its App Store review is pending). Overlaps Shepr and Sidecar, so assess first and probably adopt only the parts Shepr lacks.

## Not doing (and why)
- [-] Pear Messages and iMsg (Bluetooth texts): Blip already covers messages through the same Mac; decided 2026-10-09.
- [-] Camera roll / photo import over USB (dicemans iPhone): not selected; USB-only so it does not fit the wireless setup.
- [-] LensLink to OBS: needs a separate paid iPhone app.
- [-] AirPlay mirroring plugins (omarchy-phone, OmaGlass, omarchy-airplay): view-only and redundant with the touch window.
- [-] OmaDrop (Apple Silicon Macs only), Devices / KDE Connect clones (Android).

## Needs from Fred
1. A number to call for 1.1, or a second phone to call this one.
2. Ears for 0.1: play something on the phone and say whether you hear it on gus.
3. An Apple app-specific password for 4.3 (only when we get there).
4. fnix logged in (it is kept awake by Ringer while the window is open).

## Housekeeping
- `~/.config/omarchy/shell.json` holds other sessions' uncommitted widget changes. I do not commit it. Ringer widgets are placed through `omarchy plugin enable`.
- Keep `README.md` and this file in step with every shipped item (commit message names the TODO id).
