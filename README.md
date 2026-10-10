<p align="center"><img src="docs/hero.svg" alt="Ringer"></p>

# Ringer

> # ALPHA
> **Ringer is ALPHA software.** It runs on the author's own setup, and several features are built but not yet
> verified on a live phone. Remote control needs a Mac running its engine, the phone must share that Mac's
> Wi-Fi, and the phone accepts one finger only. Expect rough edges and breaking changes. [`todo.md`](todo.md)
> says exactly what is done, what is built but unverified, and what is not started.

One iPhone plugin for Omarchy, assembled from the best of the plugins.omarchy.org catalog.
Licensing: Ringer's own code is MIT, and the five vendored projects keep their own licences. See [`NOTICE`](NOTICE).

![what talks to what](docs/architecture.svg)

## Parts (full-history subtrees, each tracking its upstream)

| Dir | Source (our fork) | Role |
|---|---|---|
| `iphone-connect/` | nixfred/omarchy-iphone-connect (Badr-Emil, MIT) | BASE. Calls, contacts, recents, DTMF, notifications, now-playing, battery, noise suppression, all over Bluetooth HFP + PipeWire telephony. No app on the phone. |
| `omyphone/` | nixfred/omyphone (boyidzham, MIT) | Borrow: call card, contacts and missed-call UI, reconnect logic. Tested on iPhone 13. |
| `sidecar/` | nixfred/omarchy-sidecar (mtolhuys, MIT) | iPhone controls Omarchy: QR pairing, tailnet only, lock-aware workspace / theme / drop / media. |
| `phone-airplay/` | nixfred/omarchy-phone (AdamMusa, MIT) | View the iPhone screen via UxPlay AirPlay (view-only, Apple blocks touch). |
| `blueferry/` | nixfred/omarchy-blueferry (erikwb, GPL-2.0-only) | iMessage/SMS panel. Needs the separate blueferry-backend. Kept as a dependency, not merged, because of the GPL. |

## The engine: pymobiledevice3 CoreDevice (not in the catalog, so Ringer wraps it)
Target (Fred, 2026-10-09): the last 2-3 iPhones on the latest iOS. iOS version and model are NOT a question; assume iOS 27+, which is the gate for remote control.
`pymobiledevice3` (doronz88, 2.8k stars, v11.26.0 on 2026-10-08, **GPL-3.0**) speaks Apple's own CoreDevice protocol, same as Xcode's Device Hub. No Mac, no jailbreak, no WDA, no signing. Verified in source 2026-10-09:
- **Screen + touch + keyboard**: `developer core-device display serve-vnc` (bind `--host 127.0.0.1`) + `universal-hid-service tap|drag|swipe|type`.
- **Clipboard, both ways**: `pasteboard_service.py` (PULL, SET, AUTONOTIFY change events, text and images) and `serve-vnc --share-clipboard`. Caveat: a copy from Apple Notes can stall the device pasteboard for about 64 s.
- **Audio**: decode exists (`aac_eld.py`) but the player is macOS-only, so Ringer must route it to PipeWire. This is the main thing left to build.
- Setup: Developer Mode on the phone, one USB pairing, then the Wi-Fi tunnel. Wireless is unverified on a Linux host.
- GPL-3.0: keep it an external dependency (`uv tool install pymobiledevice3`; the AUR package is stale). Never vendor its code into the MIT subtrees.

## Run it (gus)
```bash
engine/ringer-view-open        # starts ringer-core + ringer-view user services, opens the phone window
```
- `engine/systemd/ringer-core.service` runs `pymobiledevice3 ... display serve-web` on 127.0.0.1:18091 with a password from `~/.config/ringer/vnc.pw` (mode 600).
- `engine/ringer-view.ts` (bun) is the front on 127.0.0.1:18092: injects a chromeless stylesheet so only the phone shows, adds the upstream login, and requires a SameSite=Strict cookie (issued only for `?k=<token>`), so other web pages cannot send touches.
- Units are symlinked into `~/.config/systemd/user/`. Phone must be plugged in once over USB with Developer Mode on.
- `engine/ringer-core.py` launches pymobiledevice3 with ONE in-memory patch: 5 s after your last desktop keystroke the virtual hardware keyboard is released, so the phone's own on-screen keyboard works again (iOS hides it while any hardware keyboard is attached). Fails loudly if the pinned 11.26.0 internals move.
- `engine/ringer-clip.ts` (bun) is the ONE clipboard sync: phone <-> desktop, text and PNG images, only while Ringer runs (`ringer-clip.service` is PartOf ringer-core). Skips password-manager copies, takes both sides' current content as a baseline (starting changes nothing), and a last-content hash stops echo loops. The viewer page's own Sync is patched off so there is never a second writer.
- **Mouse in the Ringer window** (engine/ringer-gestures.js, injected by the proxy; all single-finger strokes because the phone's HID touchscreen takes ONE contact: no pinch or rotate is possible): left button = tap/drag; **right button = long press** (down at least 0.8 s, longer if held); **wheel** = scroll (fast spins get a fling for momentum), and rolling up past the top = **pull to refresh**; **Shift+wheel** = horizontal scroll; **Ctrl+wheel** = zoom by double-tap-and-drag (Maps style); **mouse back/forward** = iOS back/forward edge swipes; **middle click** = App Switcher; hover toolbar adds Apps, Control, Notices, Refresh next to Swipe/Home/Siri; Home also = **Ctrl+H**; lock/volume/mute = the buttons on the phone frame or Ctrl+L / Ctrl+[ / Ctrl+] / Ctrl+\\.
- **Wireless (no cable) works through fnix, the Mac.** Linux alone cannot do it: `usbmuxd` is USB-only, and the phone only offers its remote-pairing service to hosts that Apple's own stack has paired (tested four ways from gus, all reset by the phone). So the core runs on **fnix** (macOS 27, Xcode 27): Device Hub's *File > Pair Nearby Device* pairs the phone once, after which the phone advertises `_remotepairing._tcp` and `devicectl` shows it `transport=localNetwork`. On fnix, `~/.ringer/venv` (pymobiledevice3 11.26.0) runs `ringer-core.py ... serve-web --native --bind <tailnet IP> --password ...` as the launchd agent `com.nixfred.ringer-core`. On gus, `~/.config/ringer/upstream` holds `http://<mac-tailnet-ip>:18091`; `engine/ringer-view-open` then needs no USB and no local core (remote mode). Because macOS has AudioToolbox, the phone's **audio decodes** there ("audio decoder ready: AudioToolbox AAC-ELD").
- `ringer-awake.service` (gus) runs `ssh -tt fnix caffeinate -i sleep ...` while Ringer is open, so fnix does not idle-sleep and drop the link; stopping Ringer releases it. The plugin panel shows an fnix row and says whether fnix or the phone is unreachable. The window reopens where it was last seen (`~/.config/ringer/window.pos`).
- **Off means off.** The Mac engine lives in `fnix:~/.ringer/com.nixfred.ringer-core.plist` (not in LaunchAgents, so it never starts at login) and only runs while Ringer is on: the launcher starts it over ssh, STOP boots it out, and closing the phone window switches everything off after `autoOffSeconds` (default 120). The virtual keyboard that desktop typing registers on the phone is released 5 s after the last key report (a missing key-up cannot pin it).
- **The window follows you across workspaces.** `ringer-view-open` pins it (Hyprland `pin`), so it stays in the same spot on every workspace of its monitor.
- **Landscape follows the phone.** The engine reports the phone's orientation on port 18093; the page rotates the picture upright and the proxy resizes the window to match (portrait 470x1005, landscape 1006x471).
- **Limits of the wireless mode:** gus to fnix goes over Tailscale and works from anywhere, but fnix to the phone is local-network discovery, so the phone must be on the same Wi-Fi as fnix (not on cellular). fnix must stay awake and logged in. With no `upstream` file the old USB mode is used.
- Audio: decoded on fnix in wireless mode; in USB mode on gus there is still no audio (the AAC-ELD decoder is macOS-only).

## Bar plugin (nixfred.ringer, gus only)
`plugin/` is an Omarchy bar widget: a phone icon that is dim with no iPhone, normal when one is attached, and green while its window is open. Left-click opens or focuses the phone window; right-click opens a compact status panel (OPEN / STOP). `plugin/bin/ringer` is bash + jq and prints JSON, so `plugin/bin/ringer status|open|stop` works from a terminal too.
Install on gus (staged, one `mv`, never edit the live dir file by file):
```bash
omarchy plugin validate plugin
cp -a plugin/. ~/.config/omarchy/.ringer-stage && mv ~/.config/omarchy/.ringer-stage ~/.config/omarchy/plugins/nixfred.ringer
sleep 5; omarchy plugin enable nixfred.ringer right
```
Tested in Test Drive first (idle and connected states, panel, IPC). Gus-only: the phone is plugged into gus and vic has no phone.

## Decisions (Fred, 2026-10-09)
- Fork 5, subtree into one private repo (not all ~11).
- Remote control means BOTH directions.
- Device target: last 2-3 iPhones on latest iOS; no per-version support matrix.

## Git rules
- `origin` = nixfred/ringer (PRIVATE).
- `upstream-*` remotes are fetch-only, push URL DISABLED. Never push to a source repo.
