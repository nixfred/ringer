import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import qs.Commons
import qs.Ui

// Calls tab of the Ringer panel: dial pad with contact search, answer / decline, in-call controls, recents.
//
// Everything goes through `bin/ringer ic ...`, which is the iphone-connect backend (calls over Bluetooth HFP).
// Live state comes from the panel's `iphone-connect watch` feed (host.phoneStatus), so there is no polling here.
// Nothing dials by itself: a call is placed only when the Call button (or Enter in the field) is pressed.
ColumnLayout {
  id: calls
  required property var host

  spacing: Style.space(8)

  readonly property var st: host.phoneStatus
  readonly property var call: st && st.call ? st.call : null
  readonly property var cap: st && st.capabilities ? st.capabilities : ({})
  readonly property bool linked: !!(st && st.phone && st.phone.connected && st.hfp)
  readonly property string cstate: call ? call.state : "idle"
  readonly property bool inCall: cstate !== "idle" && cstate !== "disconnected"
  readonly property bool ringing: cstate === "incoming" || cstate === "waiting"
  readonly property bool fieldFocus: field.activeFocus
  readonly property color red: host.urgent
  readonly property color green: host.liveGreen

  property var history: []
  property var contacts: []
  property string filter: "all"
  property bool padOpen: false
  property string note: ""
  property double callSince: 0
  property double now: Date.now()
  property var suggestions: []

  // ------------------------------------------------------------------ helpers

  function digitsOf(s) { return String(s).replace(/[^0-9*#+]/g, "") }
  function plainName(c) { return c ? (c.name && c.name !== "" ? c.name : c.number) : "" }
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000))
    var m = Math.floor(s / 60)
    return m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60)
  }
  function when(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ""
    var t = new Date()
    if (d.toDateString() === t.toDateString()) return Qt.formatDateTime(d, "h:mm")
    if (t.getTime() - d.getTime() < 6 * 86400000) return Qt.formatDateTime(d, "ddd h:mm")
    return Qt.formatDateTime(d, "MMM d")
  }
  function run(args) {
    if (act.running) return
    act.command = [host.script, "ic"].concat(args)
    act.running = true
  }

  function dial(number) {
    var n = digitsOf(number)
    if (n === "" || !linked || inCall) return
    note = ""
    run(["call", n])
  }
  function press(key) {
    if (inCall) { if (cap.canSendTones) tones.run(key) }
    else field.text = field.text + key
  }
  function pickSuggestion(i) {
    var s = suggestions[i]
    if (s) { field.text = s.number; suggestions = [] }
  }

  // Name matches rank by where the query sits: start of the name, start of another word, then anywhere.
  function nameScore(name, q) {
    var n = name.toLowerCase()
    if (n.indexOf(q) === 0) return 0
    if (n.indexOf(" " + q) >= 0) return 1
    return n.indexOf(q) >= 0 ? 2 : 9
  }

  function refreshSuggestions() {
    var q = field.text.trim().toLowerCase()
    var out = []
    if (q.length >= 2 && contacts.length) {
      var d = digitsOf(q)
      var byName = /[a-z]/.test(q)
      var scored = []
      for (var i = 0; i < contacts.length; i++) {
        var c = contacts[i]
        if (!c.numbers || c.numbers.length === 0) continue
        if (byName) {
          var sc = nameScore(c.name, q)
          if (sc < 9) scored.push({ sc: sc, i: i, name: c.name, number: c.numbers[0] })
        } else if (d.length >= 3) {
          for (var j = 0; j < c.numbers.length; j++) {
            if (digitsOf(c.numbers[j]).indexOf(d) >= 0) { scored.push({ sc: 0, i: i, name: c.name, number: c.numbers[j] }); break }
          }
        }
      }
      scored.sort(function (a, b) { return a.sc !== b.sc ? a.sc - b.sc : a.i - b.i })
      out = scored.slice(0, 4).map(function (x) { return { name: x.name, number: x.number } })
    }
    suggestions = out
  }

  function answer() { if (cap.canAnswer) run(["answer"]) }
  function decline() { if (cap.canReject) run(["reject"]) }
  function hangup() { if (cap.canHangup) run(["hangup"]) }

  function setNumber(n) { field.text = n }   // for scripted use and tests (IPC: number)

  function loadHistory() { histProc.running = true }
  function loadContacts() { if (contacts.length === 0 && !contactsProc.running) contactsProc.running = true }
  function markSeen() { if (host.phoneStatus && host.phoneStatus.missedUnseen > 0) run(["history", "seen"]) }

  Component.onCompleted: { loadHistory(); loadContacts() }
  onLinkedChanged: if (linked) { loadHistory(); loadContacts() }
  onCstateChanged: {
    if (cstate === "active" && callSince === 0) callSince = Date.now()
    if (!inCall) { callSince = 0; padOpen = false; loadHistory() }
  }
  onFilterChanged: if (filter === "missed") markSeen()

  Timer { interval: 1000; running: calls.cstate === "active"; repeat: true; onTriggered: calls.now = Date.now() }

  // --------------------------------------------------------------- processes

  Process { id: act
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: if (text.trim() !== "" && calls.note === "") calls.note = text.trim().split("\n")[0] }
  }
  Process {
    id: tones
    function run(key) { command = [host.script, "ic", "tones", key]; running = true }
  }
  Process {
    id: histProc
    command: [host.script, "ic", "history", "--json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { try { calls.history = JSON.parse(text).entries || [] } catch (e) { calls.history = [] } }
    }
  }
  Process {
    id: contactsProc
    command: [host.script, "ic", "contacts", "list", "--json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { try { var d = JSON.parse(text); calls.contacts = d.contacts || d } catch (e) { calls.contacts = [] } }
    }
  }

  // ------------------------------------------------------------------- state line

  RowLayout {
    Layout.fillWidth: true
    spacing: Style.space(8)
    Text {
      text: calls.linked ? "●" : "○"
      color: calls.linked ? calls.green : host.dim
      font.family: host.fontFamily; font.pixelSize: Style.font.bodySmall
    }
    Text {
      Layout.fillWidth: true
      elide: Text.ElideRight
      text: calls.linked
        ? (st.phone.name || "iPhone") + "  ·  calls over Bluetooth" + (st.phone.battery != null ? "  ·  " + st.phone.battery + "%" : "")
        : "iPhone not connected over Bluetooth"
      color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.bodySmall
    }
    Rectangle {
      visible: !calls.linked
      implicitWidth: cText.implicitWidth + Style.space(16); implicitHeight: cText.implicitHeight + Style.space(8)
      radius: height / 2; color: "transparent"; border.width: 1; border.color: host.accent
      Text { id: cText; anchors.centerIn: parent; text: "CONNECT"; color: host.accent; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
      TapHandler { onTapped: calls.run(["connect"]) }
    }
  }

  // ------------------------------------------------------------------- call card

  Rectangle {
    id: card
    visible: calls.inCall
    Layout.fillWidth: true
    implicitHeight: cardCol.implicitHeight + Style.space(20)
    radius: Style.space(8)
    color: Qt.rgba(host.foreground.r, host.foreground.g, host.foreground.b, 0.06)
    border.width: 1
    border.color: calls.ringing ? calls.red : calls.green

    ColumnLayout {
      id: cardCol
      anchors.fill: parent; anchors.margins: Style.space(10)
      spacing: Style.space(8)

      Text {
        Layout.fillWidth: true; elide: Text.ElideRight
        text: calls.call ? (calls.call.name && calls.call.name !== "" ? calls.call.name : (calls.call.number || "Unknown")) : ""
        color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.heading; font.bold: true
      }
      Text {
        text: calls.cstate === "incoming" ? "Incoming call"
          : calls.cstate === "waiting" ? "Call waiting"
          : calls.cstate === "dialing" ? "Calling…"
          : calls.cstate === "alerting" ? "Ringing…"
          : calls.cstate === "held" ? "On hold"
          : (calls.callSince > 0 ? calls.clock(calls.now - calls.callSince) : "Connected")
        color: calls.ringing ? calls.red : calls.green; font.family: host.fontFamily; font.pixelSize: Style.font.body
      }

      RowLayout {
        Layout.fillWidth: true
        spacing: Style.space(8)
        // answer / decline
        Rectangle {
          visible: calls.ringing
          Layout.fillWidth: true; implicitHeight: Style.space(34); radius: height / 2; color: calls.green
          Text { anchors.centerIn: parent; text: "ANSWER"; color: "#06210a"; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
          TapHandler { enabled: calls.cap.canAnswer === true; onTapped: calls.run(["answer"]) }
        }
        Rectangle {
          visible: calls.ringing
          Layout.fillWidth: true; implicitHeight: Style.space(34); radius: height / 2; color: calls.red
          Text { anchors.centerIn: parent; text: "DECLINE"; color: Color.background; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
          TapHandler { enabled: calls.cap.canReject === true; onTapped: calls.run(["reject"]) }
        }
        // in a call
        Rectangle {
          visible: !calls.ringing
          implicitWidth: mText.implicitWidth + Style.space(22); implicitHeight: Style.space(34); radius: height / 2
          color: "transparent"; border.width: 1; border.color: host.dim; opacity: calls.cap.canMute ? 1 : 0.4
          Text { id: mText; anchors.centerIn: parent; text: "MUTE"; color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
          TapHandler { enabled: calls.cap.canMute === true; onTapped: calls.run(["mute"]) }
        }
        Rectangle {
          visible: !calls.ringing
          implicitWidth: kText.implicitWidth + Style.space(22); implicitHeight: Style.space(34); radius: height / 2
          color: calls.padOpen ? host.accent : "transparent"; border.width: 1; border.color: calls.padOpen ? host.accent : host.dim
          Text { id: kText; anchors.centerIn: parent; text: "KEYPAD"; color: calls.padOpen ? Color.background : host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
          TapHandler { onTapped: calls.padOpen = !calls.padOpen }
        }
        Rectangle {
          visible: !calls.ringing && calls.cap.canTakeOver === true
          implicitWidth: tText.implicitWidth + Style.space(22); implicitHeight: Style.space(34); radius: height / 2
          color: "transparent"; border.width: 1; border.color: host.accent
          Text { id: tText; anchors.centerIn: parent; text: "TAKE ON PC"; color: host.accent; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
          TapHandler { onTapped: calls.run(["take"]) }
        }
        Item { Layout.fillWidth: true; visible: !calls.ringing }
        Rectangle {
          visible: !calls.ringing
          implicitWidth: hText.implicitWidth + Style.space(26); implicitHeight: Style.space(34); radius: height / 2; color: calls.red
          Text { id: hText; anchors.centerIn: parent; text: "HANG UP"; color: Color.background; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
          TapHandler { enabled: calls.cap.canHangup === true; onTapped: calls.run(["hangup"]) }
        }
      }
    }
  }

  // ------------------------------------------------------------------- number field

  Rectangle {
    visible: !calls.inCall
    Layout.fillWidth: true
    implicitHeight: Style.space(38)
    radius: Style.space(6)
    color: "transparent"; border.width: 1; border.color: field.activeFocus ? host.accent : host.dim

    RowLayout {
      anchors.fill: parent; anchors.leftMargin: Style.space(10); anchors.rightMargin: Style.space(6)
      TextInput {
        id: field
        Layout.fillWidth: true
        color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.body
        selectionColor: host.accent; clip: true
        inputMethodHints: Qt.ImhNoPredictiveText
        onTextChanged: calls.refreshSuggestions()
        Keys.onReturnPressed: calls.dial(text)
        Keys.onEnterPressed: calls.dial(text)
        Text {
          visible: field.text === "" && !field.activeFocus
          anchors.verticalCenter: parent.verticalCenter
          text: "Number or contact name"
          color: host.dim; font: field.font
        }
      }
      Text {
        visible: field.text !== ""
        text: "⌫"; color: host.dim; font.family: host.fontFamily; font.pixelSize: Style.font.body
        TapHandler { onTapped: field.text = field.text.slice(0, -1) }
      }
    }
  }

  // contact suggestions (at most four rows, no scrolling)
  Repeater {
    model: calls.inCall ? [] : calls.suggestions
    delegate: Rectangle {
      required property var modelData
      required property int index
      Layout.fillWidth: true
      implicitHeight: Style.space(30)
      radius: Style.space(5)
      color: sHover.hovered ? Qt.rgba(host.foreground.r, host.foreground.g, host.foreground.b, 0.08) : "transparent"
      HoverHandler { id: sHover }
      TapHandler { onTapped: calls.pickSuggestion(index) }
      RowLayout {
        anchors.fill: parent; anchors.leftMargin: Style.space(8); anchors.rightMargin: Style.space(8)
        Text { Layout.fillWidth: true; elide: Text.ElideRight; text: modelData.name; color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.bodySmall }
        Text { text: modelData.number; color: host.dim; font.family: host.fontFamily; font.pixelSize: Style.font.caption }
      }
    }
  }

  // ------------------------------------------------------------------- keypad

  GridLayout {
    visible: !calls.ringing && (!calls.inCall || calls.padOpen)
    Layout.alignment: Qt.AlignHCenter
    columns: 3
    rowSpacing: Style.space(6); columnSpacing: Style.space(6)
    Repeater {
      model: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]
      delegate: Rectangle {
        required property string modelData
        implicitWidth: Style.space(84); implicitHeight: Style.space(34)
        radius: Style.space(6)
        color: kHover.hovered ? Qt.rgba(host.foreground.r, host.foreground.g, host.foreground.b, 0.12) : Qt.rgba(host.foreground.r, host.foreground.g, host.foreground.b, 0.05)
        border.width: 1; border.color: Qt.rgba(host.foreground.r, host.foreground.g, host.foreground.b, 0.18)
        HoverHandler { id: kHover }
        TapHandler { onTapped: calls.press(modelData) }
        Text { anchors.centerIn: parent; text: modelData; color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.body; font.bold: true }
      }
    }
  }

  RowLayout {
    visible: !calls.inCall
    Layout.fillWidth: true
    spacing: Style.space(8)
    Rectangle {
      Layout.fillWidth: true; implicitHeight: Style.space(36); radius: height / 2
      color: calls.linked && digitsOf(field.text) !== "" ? calls.green : "transparent"
      border.width: 1; border.color: calls.linked ? calls.green : host.dim
      opacity: calls.linked ? 1 : 0.5
      Text { anchors.centerIn: parent; text: "CALL"; color: (calls.linked && digitsOf(field.text) !== "") ? "#06210a" : host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
      TapHandler { onTapped: calls.dial(field.text) }
    }
    Rectangle {
      implicitWidth: rdText.implicitWidth + Style.space(24); implicitHeight: Style.space(36); radius: height / 2
      color: "transparent"; border.width: 1; border.color: host.dim; opacity: calls.linked ? 1 : 0.5
      Text { id: rdText; anchors.centerIn: parent; text: "REDIAL"; color: host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
      TapHandler { onTapped: if (calls.linked) calls.run(["redial"]) }
    }
  }

  // ------------------------------------------------------------------- recents

  RowLayout {
    visible: !calls.inCall
    Layout.fillWidth: true
    spacing: Style.space(8)
    PanelSectionHeader { text: "RECENTS"; foreground: host.foreground; fontFamily: host.fontFamily }
    Item { Layout.fillWidth: true }
    Repeater {
      model: [{ k: "all", t: "ALL" }, { k: "missed", t: "MISSED" }]
      delegate: Rectangle {
        required property var modelData
        implicitWidth: ftx.implicitWidth + Style.space(16); implicitHeight: ftx.implicitHeight + Style.space(6)
        radius: height / 2
        color: calls.filter === modelData.k ? host.accent : "transparent"
        border.width: 1; border.color: calls.filter === modelData.k ? host.accent : host.dim
        Text { id: ftx; anchors.centerIn: parent; text: modelData.t; color: calls.filter === modelData.k ? Color.background : host.foreground; font.family: host.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
        TapHandler { onTapped: calls.filter = modelData.k }
      }
    }
  }

  ListView {
    id: list
    visible: !calls.inCall
    Layout.fillWidth: true
    Layout.preferredHeight: Style.space(132)   // the list scrolls inside this box; the panel never does (Law 17)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    model: calls.history.filter(function (e) { return calls.filter === "all" || e.type === "missed" }).slice(0, 60)
    delegate: Rectangle {
      required property var modelData
      width: list.width
      height: Style.space(28)
      radius: Style.space(5)
      color: rHover.hovered ? Qt.rgba(host.foreground.r, host.foreground.g, host.foreground.b, 0.08) : "transparent"
      HoverHandler { id: rHover }
      TapHandler { onTapped: field.text = modelData.number }
      RowLayout {
        anchors.fill: parent; anchors.leftMargin: Style.space(6); anchors.rightMargin: Style.space(6); spacing: Style.space(8)
        Text {
          text: modelData.type === "missed" ? "✕" : modelData.type === "dialed" ? "↗" : "↙"
          color: modelData.type === "missed" ? calls.red : host.dim
          font.family: host.fontFamily; font.pixelSize: Style.font.bodySmall
        }
        Text {
          Layout.fillWidth: true; elide: Text.ElideRight
          text: modelData.name && modelData.name !== "" ? modelData.name : modelData.number
          color: modelData.type === "missed" ? calls.red : host.foreground
          font.family: host.fontFamily; font.pixelSize: Style.font.bodySmall
        }
        Text { text: calls.when(modelData.time); color: host.dim; font.family: host.fontFamily; font.pixelSize: Style.font.caption }
      }
    }
    Text {
      anchors.centerIn: parent
      visible: list.count === 0
      text: calls.linked ? "No calls to show" : "Connect the iPhone to see recents"
      color: host.dim; font.family: host.fontFamily; font.pixelSize: Style.font.caption
    }
  }

  Text {
    Layout.fillWidth: true
    visible: calls.note !== ""
    text: calls.note; color: host.dim; wrapMode: Text.WordWrap
    font.family: host.fontFamily; font.pixelSize: Style.font.caption
    TapHandler { onTapped: calls.note = "" }
  }
}
