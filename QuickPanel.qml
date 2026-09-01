import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Model

// Quick-reference dropdown for the sysmonitor bar widget: a condensed,
// non-scrolling snapshot (CPU/GPU/mem/temp/network headline numbers plus the
// top few processes by CPU), distinct from the full SUPER+CTRL+SHIFT+T panel
// (Panel.qml), which stays the deep-dive view untouched by this file.
//
// Named QuickPanel rather than the more common "Panel.qml" seen on other
// bar-widget dropdowns in this shell (Weather, Quadrant) because this
// plugin already has a Panel.qml — the panel-kind FloatingWindow entry
// point, an entirely different base type (FloatingWindow, not this file's
// qs.Ui Panel). Two unrelated things happening to share the word "panel".
//
// Polls continuously, not just while the dropdown is open, so the bar
// cell's own per-segment text (read by BarWidget.qml) always has a current
// reading — the same shape as the first-party Weather plugin's
// BarWidget/Panel pair.
Panel {
  id: root
  moduleName: "jharrison.sysmonitor"
  manageIpc: false   // the full panel (Panel.qml) owns this plugin's IPC surface

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property int pollInterval: {
    var v = Number(setting("pollInterval", 2000))
    return isFinite(v) && v >= 500 ? v : 2000
  }

  // ---- CPU (same delta approach as the full panel's cpuProc) ----
  property var cpuStatPrev: null
  property bool cpuPrimed: false
  property real cpuTotalPercent: 0
  property int cpuCount: 1

  // ---- memory ----
  property var memInfo: null
  readonly property real memPercent: memInfo && memInfo.memTotal > 0
    ? (memInfo.memUsed / memInfo.memTotal) * 100 : 0

  // ---- GPU (AMD only — same detection COLLECT_GPU_PATH the full panel uses) ----
  property string gpuPath: ""
  property real gpuUtil: 0
  property real gpuTempC: 0

  // ---- CPU package temperature (same sensor filtering the full panel uses —
  // "coretemp" is the driver name filterSensors already narrows to "package") ----
  property real cpuTempC: 0

  // ---- disk (root filesystem headline only — the full panel's Disk section
  // covers every mount; this is a glance, not an inventory) ----
  property real diskPercent: 0

  // ---- network (same delta approach as the full panel's netProc, one
  // interface — the default route, detected once) ----
  property string primaryIface: ""
  property var netPrev: null
  property real netPrevAt: 0
  property var netRates: null   // { rxRate, txRate } for primaryIface, once primed

  // ---- top processes (same COLLECT_PROC_SNAPSHOT pipeline the full panel's
  // process list uses, limited to 4 rows) ----
  property var procTicksPrev: null
  property real procTicksAt: 0
  property var topProcesses: []

  // ---- per-segment bar text, read directly by BarWidget.qml ----
  readonly property string cpuBarText: cpuPrimed ? Math.round(cpuTotalPercent) + "%" : "…"
  readonly property string gpuBarText: Math.round(gpuUtil) + "%"
  readonly property string memBarText: memInfo ? Math.round(memPercent) + "%" : "…"
  readonly property string tempBarText: cpuTempC > 0 ? Math.round(cpuTempC) + "°" : "…°"
  readonly property string netBarText: {
    if (!netRates) return "↑…  ↓…"
    return "↑" + _compactRate(netRates.txRate) + "  ↓" + _compactRate(netRates.rxRate)
  }
  // Bar-scale rate text: formatRate's "12.3 KB/s" is right for the spacious
  // full panel; the bar arrow already says "rate", so drop the redundant unit
  // suffix and keep just the number+prefix ("12.3 KB").
  function _compactRate(bps) {
    return Model.formatRate(bps).replace("/s", "")
  }

  // Read by BarWidget.qml as a single fallback string (tooltip, or in case a
  // future layout wants one combined cell instead of several).
  readonly property string label: cpuBarText + "  " + memBarText

  function pollAll() {
    cpuProc.running = true
    memProc.running = true
    diskProc.running = true
    procProc.running = true
    sensorProc.running = true
    if (gpuPath !== "") gpuProc.running = true
    if (primaryIface !== "") netProc.running = true
  }

  Component.onCompleted: {
    gpuDetectProc.running = true
    ifaceDetectProc.running = true
    pollAll()
  }

  Timer {
    interval: root.pollInterval
    running: true
    repeat: true
    onTriggered: root.pollAll()
  }

  Process {
    id: gpuDetectProc
    command: ["bash", "-c", Model.COLLECT_GPU_PATH]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.gpuPath = String(text || "").trim()
    }
  }

  Process {
    id: ifaceDetectProc
    command: ["bash", "-c", "ip -o -4 route show default 2>/dev/null | awk '{print $5}' | head -1"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.primaryIface = String(text || "").trim()
    }
  }

  Process {
    id: cpuProc
    command: ["cat", "/proc/stat"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var curr = Model.parseCpuStat(text)
        if (curr.cores.length > 0) root.cpuCount = curr.cores.length
        if (root.cpuStatPrev) {
          var p = Model.calcCpuPercents(root.cpuStatPrev, curr)
          root.cpuTotalPercent = p.total
          root.cpuPrimed = true
        }
        root.cpuStatPrev = curr
      }
    }
  }

  Process {
    id: memProc
    command: ["bash", "-c", "free -b"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.memInfo = Model.parseFree(text)
    }
  }

  Process {
    id: diskProc
    command: ["bash", "-c", "df -h --output=source,size,used,avail,pcent,target"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var entries = Model.parseDfOutput(text)
        var rootEntry = null
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].mount === "/") { rootEntry = entries[i]; break }
        }
        root.diskPercent = rootEntry ? rootEntry.percent
                          : (entries.length > 0 ? entries[0].percent : 0)
      }
    }
  }

  Process {
    id: gpuProc
    command: ["bash", "-c", Model.collectGpuDetail(root.gpuPath)]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var g = Model.parseGpuDetail(text)
        root.gpuUtil = g.busy
        var edge = 0
        for (var i = 0; i < g.temps.length; i++)
          if (g.temps[i].label === "edge") edge = g.temps[i].tempC
        root.gpuTempC = edge > 0 ? edge : (g.temps.length > 0 ? g.temps[0].tempC : 0)
      }
    }
  }

  Process {
    id: sensorProc
    command: ["bash", "-c", Model.COLLECT_SENSORS]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var filtered = Model.filterSensors(Model.parseSensors(text), false)
        for (var i = 0; i < filtered.length; i++) {
          if (filtered[i].name === "coretemp") { root.cpuTempC = filtered[i].tempC; return }
        }
        // No coretemp on this machine (non-Intel-named driver, VM, etc.) —
        // fall back to whatever reading came first rather than showing
        // nothing when a real number exists under a different driver name.
        if (filtered.length > 0) root.cpuTempC = filtered[0].tempC
      }
    }
  }

  Process {
    id: netProc
    command: ["cat", "/proc/net/dev"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var curr = Model.parseNetDev(text)
        var now = Date.now()
        if (root.netPrev && root.netPrevAt > 0) {
          var dt = (now - root.netPrevAt) / 1000
          if (dt > 0) {
            var rates = Model.calcNetRate(root.netPrev, curr, dt)
            root.netRates = rates[root.primaryIface] || null
          }
        }
        root.netPrev = curr
        root.netPrevAt = now
      }
    }
  }

  Process {
    id: procProc
    command: ["bash", "-c", Model.COLLECT_PROC_SNAPSHOT]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var snap = Model.parseProcSnapshot(text)
        var now = Date.now()
        if (root.procTicksPrev && root.procTicksAt > 0) {
          var dt = (now - root.procTicksAt) / 1000
          var cpuByPid = Model.calcProcCpu(root.procTicksPrev, snap.ticks, dt, root.cpuCount, 100)
          root.topProcesses = Model.mergeProcRows(snap.rows, cpuByPid, "cpu", 4)
        }
        root.procTicksPrev = snap.ticks
        root.procTicksAt = now
      }
    }
  }

  // One-shot: hands off to the full panel and does not track its own state —
  // the existing keybinding (SUPER+CTRL+SHIFT+T) already runs this exact
  // command, so this button is just a mouse-reachable version of the same
  // door, not a second implementation of opening the panel.
  Process {
    id: openFullProc
    command: ["omarchy-shell", "shell", "toggle", "jharrison.sysmonitor"]
  }

  KeyboardPanel {
    id: popup
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(280))
    contentHeight: popup.fittedContentHeight(card.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTextKey: function(t) { if (t === "r") root.pollAll() }

      ColumnLayout {
        id: card
        width: parent.width
        spacing: Style.space(10)

        GridLayout {
          Layout.fillWidth: true
          columns: 3
          rowSpacing: Style.space(10)
          columnSpacing: Style.space(14)

          QuickStat { label: "CPU"; value: root.cpuPrimed ? Math.round(root.cpuTotalPercent) + "%" : "…" }
          QuickStat { visible: root.gpuPath !== ""; label: "GPU"; value: Math.round(root.gpuUtil) + "%" }
          QuickStat { label: "MEM"; value: root.memInfo ? Math.round(root.memPercent) + "%" : "…" }
          QuickStat { label: "TEMP"; value: root.cpuTempC > 0 ? Math.round(root.cpuTempC) + "°C" : "…" }
          QuickStat { label: "DISK"; value: Math.round(root.diskPercent) + "%" }
          QuickStat {
            label: "NET"
            value: root.netRates
              ? "↑" + root._compactRate(root.netRates.txRate) + " ↓" + root._compactRate(root.netRates.rxRate)
              : "…"
          }
        }

        Rectangle {
          Layout.fillWidth: true
          height: 1
          color: Color.muted
          opacity: 0.4
        }

        Text {
          text: "TOP PROCESSES"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        ColumnLayout {
          Layout.fillWidth: true
          spacing: Style.space(4)
          visible: root.topProcesses.length > 0

          Repeater {
            model: root.topProcesses
            delegate: RowLayout {
              Layout.fillWidth: true
              Text {
                Layout.fillWidth: true
                text: modelData.command || ""
                color: Color.foreground
                elide: Text.ElideRight
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                text: modelData.cpu === undefined ? "new" : Math.round(modelData.cpu) + "%"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
        }

        Text {
          Layout.fillWidth: true
          Layout.topMargin: Style.space(4)
          text: "Open full monitor →"
          color: Color.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: {
              openFullProc.running = true
              root.close()
            }
          }
        }
      }
    }
  }

  // One stat cell: a small caption label over a larger value. Local to this
  // file — the full panel has its own similarly-named `Stat` component in
  // Panel.qml, but the two files load independently (separate kinds), so
  // there is no collision and no shared-component extraction to do here.
  component QuickStat: ColumnLayout {
    property string label: ""
    property string value: ""
    spacing: 0

    Text {
      text: parent.label
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
    Text {
      text: parent.value
      color: Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
  }
}
