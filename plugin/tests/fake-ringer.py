#!/usr/bin/env python3
"""Fake `bin/ringer` for Test Drive: plays scripted call scenarios with invented people (numbers in the 555-01xx
fiction range). Used to test the Calls tab without a phone. NOT shipped as the helper; copy it over bin/ringer in a VM.

Scenario file /tmp/ringer-fake-state holds: idle | incoming | active | dialing | missed. `ic watch` prints a status
line whenever it changes. Actions are logged to /tmp/ringer-fake-actions.log and move the scenario on."""
import json, os, sys, time, datetime

STATE = "/tmp/ringer-fake-state"
LOG = "/tmp/ringer-fake-actions.log"
now = datetime.datetime.now()
iso = lambda mins: (now - datetime.timedelta(minutes=mins)).strftime("%Y-%m-%dT%H:%M:%S")

CONTACTS = [{"name": n, "numbers": [x]} for n, x in [
    ("Alice Harper", "+15555550101"), ("Alan Brooks", "+15555550102"), ("Maria Santos", "+15555550103"),
    ("Mike Dawson", "+15555550104"), ("Casey", "+15555550105"), ("Dr. Avery Quinn", "+15555550106"),
    ("Pizza Palace", "+15555550107"), ("Tom", "+15555550108")]]
HISTORY = [
    {"type": "missed", "time": iso(12), "number": "+15555550103", "name": "Maria Santos"},
    {"type": "received", "time": iso(95), "number": "+15555550105", "name": "Casey"},
    {"type": "dialed", "time": iso(300), "number": "+15555550107", "name": "Pizza Palace"},
    {"type": "missed", "time": iso(1500), "number": "+15555550199", "name": ""},
    {"type": "received", "time": iso(2900), "number": "+15555550108", "name": "Tom"},
    {"type": "dialed", "time": iso(4300), "number": "+15555550101", "name": "Alice Harper"},
    {"type": "received", "time": iso(9000), "number": "+15555550104", "name": "Mike Dawson"},
]

def scenario():
    try: return open(STATE).read().strip() or "idle"
    except OSError: return "idle"

def set_scenario(v): open(STATE, "w").write(v)

def status_line():
    sc = scenario()
    call = None
    if sc in ("incoming", "active", "dialing"):
        call = {"state": sc, "number": "+15555550101" if sc != "incoming" else "+15555550103",
                "name": "Alice Harper" if sc != "incoming" else "Maria Santos", "path": "/fake/call1"}
    can = lambda *states: bool(call and call["state"] in states)
    return {"phone": {"name": "Spike iPhone", "address": "AA:BB:CC:DD:EE:FF", "battery": 76, "connected": True,
                      "hfp": True, "paired": True, "path": "/fake", "phone": "", "trusted": True},
            "hfp": True, "bluetooth": {"powered": True}, "calls": [call] if call else [], "call": call,
            "capabilities": {"canDial": True, "canAnswer": can("incoming"), "canReject": can("incoming"),
                             "canHangup": can("active", "dialing"), "canSendTones": can("active"), "canMute": can("active"),
                             "canTakeOver": False},
            "audio": {"routed": sc == "active"}, "mirror": {"state": "off", "enabled": False},
            "missedUnseen": 2 if sc != "seen" else 0, "errors": [], "service": "active", "transport": {}, "volume": {}}

args = sys.argv[1:]
if not args or args[0] in ("status",):
    print(json.dumps({"ok": True, "usb": True, "phone": "iPhone via fake", "core": True, "view": True, "window": False,
                      "engine": True, "fnix": True, "remote": True}))
elif args[0] in ("open", "stop"):
    print(json.dumps({"ok": True, "usb": True, "phone": "iPhone via fake", "core": True, "view": True, "window": False,
                      "engine": True, "fnix": True, "remote": True}))
elif args[0] == "ic":
    a = args[1:]
    if a[:1] == ["watch"]:
        last = None
        while True:
            line = json.dumps(status_line())
            if line != last:
                print(line, flush=True); last = line
            time.sleep(0.3)
    elif a[:2] == ["history", "--json"]:
        print(json.dumps({"entries": HISTORY, "unseenMissed": 2}))
    elif a[:3] == ["contacts", "list", "--json"]:
        print(json.dumps(CONTACTS))
    else:
        open(LOG, "a").write(" ".join(a) + "\n")
        if a[0] == "call": set_scenario("dialing"); time.sleep(1.2); set_scenario("active")
        elif a[0] == "answer": set_scenario("active")
        elif a[0] in ("hangup", "reject"): set_scenario("idle")
        elif a[0] == "history" and a[1:2] == ["seen"]: pass
        print("ok")
