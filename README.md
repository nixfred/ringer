# iphone.control.in.omarchy

One iPhone plugin for Omarchy, assembled from the best of the plugins.omarchy.org catalog.
For Fred only. Private. Working title until Fred names it.

## Parts (full-history subtrees, each tracking its upstream)

| Dir | Source (our fork) | Role |
|---|---|---|
| `iphone-connect/` | nixfred/omarchy-iphone-connect (Badr-Emil, MIT) | BASE. Calls, contacts, recents, DTMF, notifications, now-playing, battery, noise suppression, all over Bluetooth HFP + PipeWire telephony. No app on the phone. |
| `omyphone/` | nixfred/omyphone (boyidzham, MIT) | Borrow: call card, contacts and missed-call UI, reconnect logic. Tested on iPhone 13. |
| `sidecar/` | nixfred/omarchy-sidecar (mtolhuys, MIT) | iPhone controls Omarchy: QR pairing, tailnet only, lock-aware workspace / theme / drop / media. |
| `phone-airplay/` | nixfred/omarchy-phone (AdamMusa, MIT) | View the iPhone screen via UxPlay AirPlay (view-only, Apple blocks touch). |
| `blueferry/` | nixfred/omarchy-blueferry (erikwb, GPL-2.0-only) | iMessage/SMS panel. Needs the separate blueferry-backend. Kept as a dependency, not merged, because of the GPL. |

## Not in the catalog, so we build it
- **Clipboard.** iOS blocks background clipboard. Plan: iOS Shortcut (Action Button / Back Tap) POSTs to a signed tailnet endpoint (Shepr's ECDSA signed-request design) + a "copy from PC" button. Reuse `~/Projects/clipboard.from.apple` clipsync logic on the PC side.
- **iPhone touch control.** Nothing in the catalog does it. Candidates: pymobiledevice3 CoreDevice (iOS 27+), WebDriverAgent + go-ios, or relay via fnix iPhone Mirroring. Needs Fred's iOS version first.

## Decisions (Fred, 2026-10-09)
- Fork 5, subtree into one private repo (not all ~11).
- Remote control means BOTH directions.

## Git rules
- `origin` = nixfred/iphone-control-omarchy (PRIVATE).
- `upstream-*` remotes are fetch-only, push URL DISABLED. Never push to a source repo.
