<p align="center"><img src="docs/hero.svg" alt="Ringer"></p>

# Ringer

One iPhone plugin for Omarchy, assembled from the best of the plugins.omarchy.org catalog.
For Fred only. Private. Named by Fred 2026-10-09. Project dir stays iphone.control.in.omarchy (session dir).

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
- **Known limit: the screen, touch and clipboard link needs the USB cable.** Tested 2026-10-09 with the phone unlocked and awake on the same LAN (iPhone 16 Pro Max, iOS 27.0.1): `usbmuxd` 1.1.1 is USB-only; `remote start-tunnel -t wifi` finds no `_remotepairing._tcp` advertisement and `remote pair` finds nothing to pair; `remote tunneld --mobdev2` finds the phone and the Wi-Fi lockdown session plus the CoreDeviceProxy service start fine, but the phone then terminates the tunnel handshake (ConnectionResetError / "Connection was terminated abruptly"), also from a no-root Wi-Fi fallback patched into the launcher. Bluetooth (calls, contacts) is unaffected. Wireless view-only would have to be AirPlay (UxPlay).
- Known gap: no audio on Linux (the upstream AAC-ELD decoder is macOS-only).

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
