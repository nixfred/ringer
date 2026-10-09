import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Ringer: your iPhone from the bar.
//
// The bar shows a phone glyph: dim when no iPhone is attached, normal when it is
// attached, green while its window is open. Left-click opens the phone's screen as
// a window you can tap, type and swipe on (or focuses it if it is already open).
// Right-click opens this status panel, where S stops the Ringer services.
//
// Like Mirror, nothing here talks to the phone directly: every action is a
// `bin/ringer` command that prints one JSON object, so what you see is what the
// script found and the script can be driven from a terminal the same way. The
// widget is self-contained (no plugin service) because services are null under a
// third-party bar.
Panel {
  id: root
  moduleName: "nixfred.ringer"
  ipcTarget: "nixfred.ringer"
  manageIpc: false

  // The bar sizes a widget from its implicit size; without these it is zero-wide and invisible.
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")
  readonly property string script: root.pluginDir + "bin/ringer"

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  // A live indicator is green in every theme (same reasoning as the Mirror plugin).
  readonly property color liveGreen: "#4caf50"

  // nf-md-cellphone (U+F011C). One glyph for every state: the colour carries the state (dim = no
  // phone, normal = attached, green = window open). U+F011D is NOT a phone-link: it renders as an
  // upload arrow in JetBrainsMono Nerd Font.
  readonly property string phoneGlyph: "󰄜"
  readonly property string phoneLiveGlyph: phoneGlyph

  readonly property int pollSeconds: Math.max(2, Number(root.setting("pollSeconds", 4)))

  property bool usb: false
  property string phone: ""
  property bool core: false
  property bool view: false
  property bool window: false
  property bool engine: true
  property string statusError: ""
  property string actionNote: ""

  readonly property bool busy: openProc.running || stopProc.running
  readonly property bool live: root.usb && root.window

  readonly property string metaText: root.busy ? "Working…"
    : !root.usb ? "iPhone not detected"
    : root.window ? "Window open"
    : "Ready"
  readonly property string detailText: !root.engine ? "Ringer engine not found"
    : !root.usb ? "Plug in over USB, tap Trust"
    : (!root.core || !root.view) ? "Stopped. Click the icon to start"
    : "Click the icon to open it"

  function plain(s) { return String(s).replace(/\s+/g, " ") }

  function applyStatus(s) {
    if (s.ok !== true) { root.statusError = s.error || "status failed"; return }
    root.statusError = ""
    root.usb = s.usb === true
    root.phone = s.phone || ""
    root.core = s.core === true
    root.view = s.view === true
    root.window = s.window === true
    root.engine = s.engine !== false
  }

  function refresh() { if (!statusProc.running) statusProc.running = true }
  function openPhone() { if (root.busy) return; root.actionNote = ""; openProc.running = true }
  function stopAll() { if (root.busy) return; root.actionNote = ""; stopProc.running = true }

  Component.onCompleted: root.refresh()

  // --------------------------------------------------------------- processes

  Process {
    id: statusProc
    command: [root.script, "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.applyStatus(JSON.parse(text)) } catch (e) { root.statusError = "status: " + root.plain(text).trim() }
      }
    }
  }

  Process {
    id: openProc
    command: [root.script, "open"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var d = JSON.parse(text)
          if (d.ok === true) { root.applyStatus(d); root.actionNote = "" }
          else root.actionNote = d.error || "could not open"
        } catch (e) { root.actionNote = "open: " + root.plain(text).trim() }
      }
    }
  }

  Process {
    id: stopProc
    command: [root.script, "stop"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.applyStatus(JSON.parse(text)); root.actionNote = "Stopped" } catch (e) { root.actionNote = "stop: " + root.plain(text).trim() }
      }
    }
  }

  Timer {
    interval: root.pollSeconds * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function phone(): string { root.openPhone(); return "ok" }
    function stop(): string { root.stopAll(); return "ok" }
    function status(): string {
      return (root.usb ? "iPhone attached" : "no iPhone") + ", core " + (root.core ? "up" : "down")
        + ", view " + (root.view ? "up" : "down") + ", window " + (root.window ? "open" : "closed")
    }
  }

  // --------------------------------------------------------------------- bar

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.live ? "iPhone: window open. Click to focus, right-click for status"
      : root.usb ? "iPhone attached. Click to open its screen, right-click for status"
      : "No iPhone detected. Click to try, right-click for status"
    iconComponent: Component {
      Item {
        Text {
          anchors.centerIn: parent
          text: root.live ? root.phoneLiveGlyph : root.phoneGlyph
          color: root.statusError !== "" ? root.urgent : root.live ? root.liveGreen : root.usb ? root.foreground : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.bar.iconFont
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.toggle()
      else root.openPhone()
    }
  }

  // ------------------------------------------------------------------- panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(420))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "o" || t === "O") root.openPhone()
        else if (t === "s" || t === "S") root.stopAll()
        else if (t === "r" || t === "R") root.refresh()
      }

      ColumnLayout {
        id: content
        width: parent.width
        spacing: Style.space(12)

        PanelHero {
          Layout.fillWidth: true
          title: "iPhone"
          meta: root.metaText
          detail: root.detailText
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Text {
              text: root.live ? root.phoneLiveGlyph : root.phoneGlyph
              color: root.live ? root.liveGreen : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

        // Four state rows: a filled dot is on, a hollow one is off.
        Repeater {
          model: [
            { label: "iPhone on USB", on: root.usb, value: root.usb ? (root.phone !== "" ? root.phone : "attached") : "not detected" },
            { label: "Ringer core", on: root.core, value: root.core ? "running" : "stopped" },
            { label: "Ringer view", on: root.view, value: root.view ? "running" : "stopped" },
            { label: "Phone window", on: root.window, value: root.window ? "open" : "closed" }
          ]
          delegate: RowLayout {
            required property var modelData
            Layout.fillWidth: true
            spacing: Style.space(10)
            Text {
              text: modelData.on ? "●" : "○"
              color: modelData.on ? root.liveGreen : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
            Text {
              Layout.fillWidth: true
              text: modelData.label
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
            Text {
              text: modelData.value
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

        // Actions: OPEN is filled; STOP only has an effect while something runs.
        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(8)
          Repeater {
            model: [
              { label: "OPEN", key: "O", primary: true, hint: "Open or focus the iPhone window" },
              { label: "STOP", key: "S", primary: false, hint: "Close the window and stop the Ringer services" }
            ]
            delegate: Rectangle {
              id: pill
              required property var modelData
              implicitWidth: pillRow.implicitWidth + Style.space(22)
              implicitHeight: pillRow.implicitHeight + Style.space(10)
              radius: height / 2
              color: modelData.primary ? root.accent : "transparent"
              border.width: 1
              border.color: modelData.primary ? root.accent : root.dim
              opacity: root.busy ? 0.5 : 1
              Row {
                id: pillRow
                anchors.centerIn: parent
                spacing: Style.space(8)
                Text {
                  text: pill.modelData.label
                  color: pill.modelData.primary ? Color.background : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
                Text {
                  text: pill.modelData.key
                  color: pill.modelData.primary ? Color.background : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
              HoverHandler { id: pillHover }
              TapHandler { onTapped: pill.modelData.primary ? root.openPhone() : root.stopAll() }
              PanelToolTip { visible: pillHover.hovered; text: pill.modelData.hint }
            }
          }
          Item { Layout.fillWidth: true }
        }

        Text {
          Layout.fillWidth: true
          visible: root.statusError !== "" || root.actionNote !== ""
          text: root.statusError !== "" ? root.statusError : root.actionNote
          color: root.statusError !== "" ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
