import QtQuick
import QtQuick.Layouts
import Quickshell
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

  // The dropdown was rendering at the shell's raw font tokens while the full
  // panel multiplied the same tokens by its own fontScale, so the two views
  // disagreed by about a quarter and the dropdown read noticeably small. It
  // now takes the same treatment and the same 1.25 default, which is what
  // makes them look like one plugin at two sizes rather than two plugins.
  readonly property real fontScale: {
    var v = Number(setting("fontScale", 1.25))
    return isFinite(v) && v > 0 ? v : 1.25
  }
  function fs(token) { return Math.round(token * root.fontScale) }

  // Widened to match: larger text in a box sized for the smaller text would
  // just wrap more. Scales with the same factor rather than being a second
  // number to keep in step by hand.
  readonly property int dropdownWidth: {
    var v = Number(setting("dropdownWidth", Math.round(280 * root.fontScale)))
    return isFinite(v) && v >= 200 ? v : Math.round(280 * root.fontScale)
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
  // process list uses, limited to 4 rows each). Both lists are drawn from the
  // same snapshot — the cpu-sorted call merges the live cpuByPid map onto
  // snap.rows in place, and the mem-sorted call re-sorts those same
  // (already-merged) row objects with a null map ("re-sort what's here" —
  // see mergeProcRows), so memory sorting never recomputes or duplicates the
  // CPU delta work. ----
  property var procTicksPrev: null
  property real procTicksAt: 0
  property var topProcessesCpu: []
  property var topProcessesMem: []

  // ---- animated headline values. Each eases toward the true polled number
  // instead of snapping on every 2-second tick — the meter bars below read
  // as gauges settling rather than a number flickering, which is the point:
  // motion should communicate "this is live," not just decorate the numbers. ----
  property real animCpu: cpuTotalPercent
  property real animGpu: gpuUtil
  property real animMem: memPercent
  property real animDisk: diskPercent
  property real animTemp: cpuTempC
  Behavior on animCpu { NumberAnimation { duration: 450; easing.type: Easing.OutQuad } }
  Behavior on animGpu { NumberAnimation { duration: 450; easing.type: Easing.OutQuad } }
  Behavior on animMem { NumberAnimation { duration: 450; easing.type: Easing.OutQuad } }
  Behavior on animDisk { NumberAnimation { duration: 450; easing.type: Easing.OutQuad } }
  Behavior on animTemp { NumberAnimation { duration: 450; easing.type: Easing.OutQuad } }

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

  // ── collector watchdog (same design as the full panel's — see Panel.qml
  // for the rationale) ──
  readonly property int collectorDeadlineMs: 8000
  property var collectorStarts: ({})

  function start(proc, name) {
    if (proc.running) return
    proc.running = true
    if (name) collectorStarts[name] = Date.now()
  }

  function collectorByName(name) {
    switch (name) {
      case "gpuDetectProc": return gpuDetectProc
      case "ifaceDetectProc": return ifaceDetectProc
      case "themeProc": return themeProc
      case "cpuProc": return cpuProc
      case "memProc": return memProc
      case "diskProc": return diskProc
      case "gpuProc": return gpuProc
      case "sensorProc": return sensorProc
      case "netProc": return netProc
      case "procProc": return procProc
      default: return null
    }
  }

  function sweepHungCollectors() {
    var tracked = []
    for (var name in collectorStarts) {
      var p = root.collectorByName(name)
      if (!p || !p.running) { delete collectorStarts[name]; continue }
      tracked.push({ name: name, startedAt: collectorStarts[name], deadlineMs: root.collectorDeadlineMs })
    }
    var overdue = Model.overdueCollectors(tracked, Date.now())
    for (var i = 0; i < overdue.length; i++) {
      var n = overdue[i]
      var proc = root.collectorByName(n)
      if (proc) {
        var pid = proc.processId
        if (pid) Quickshell.execDetached(["bash", "-c", Model.buildGroupKillCommand(pid)])
        if (proc.running) proc.running = false
      }
      delete collectorStarts[n]
    }
  }

  function pollAll() {
    start(cpuProc, "cpuProc")
    start(memProc, "memProc")
    start(diskProc, "diskProc")
    start(procProc, "procProc")
    start(sensorProc, "sensorProc")
    if (gpuPath !== "") start(gpuProc, "gpuProc")
    if (primaryIface !== "") start(netProc, "netProc")
  }

  // The same per-section colours the full panel uses, read from the active
  // theme's own colors.toml, so the dropdown and the panel are recognisably
  // one plugin rather than two things that happen to show similar numbers.
  // See Model.COLLECT_THEME_PALETTE for why that file is read directly
  // rather than taken from the Color singleton, which keeps only four of its
  // values.
  //
  // Every reader goes through themeColor() and names its own fallback, so
  // this renders correctly both in the moment before the file has loaded and
  // on a theme that omits a key.
  property var themePalette: ({})
  function themeColor(key, fallback) {
    var v = themePalette[key]
    return v ? v : fallback
  }
  readonly property color secCpu: themeColor("blue", Color.accent)
  readonly property color secMem: themeColor("green", Color.accent)
  readonly property color secGpu: themeColor("magenta", Color.accent)
  readonly property color secDisk: themeColor("cyan", Color.accent)
  readonly property color secNet: themeColor("orange", Color.accent)
  readonly property color secThermal: themeColor("brown", Color.accent)

  Component.onCompleted: {
    start(gpuDetectProc, "gpuDetectProc")
    start(ifaceDetectProc, "ifaceDetectProc")
    start(themeProc, "themeProc")
    pollAll()
  }

  // Static: a theme change restarts the shell, so one read at startup is
  // enough and this never joins the poll cycle.
  Process {
    id: themeProc
    command: Model.wrapCollectorCommand(Model.COLLECT_THEME_PALETTE, Model.OUTPUT_CAP_MEDIUM)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.themePalette = Model.parseThemePalette(text)
    }
  }

  Timer {
    interval: root.pollInterval
    running: true
    repeat: true
    onTriggered: root.pollAll()
  }

  Timer {
    interval: 2000
    running: true
    repeat: true
    onTriggered: root.sweepHungCollectors()
  }

  Process {
    id: gpuDetectProc
    command: Model.wrapCollectorCommand(Model.COLLECT_GPU_PATH, Model.OUTPUT_CAP_TINY)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.gpuPath = String(text || "").trim()
    }
  }

  Process {
    id: ifaceDetectProc
    command: Model.wrapCollectorCommand(
      "ip -o -4 route show default 2>/dev/null | awk '{print $5}' | head -1", Model.OUTPUT_CAP_TINY)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.primaryIface = String(text || "").trim()
    }
  }

  Process {
    id: cpuProc
    command: Model.wrapCollectorCommand("cat /proc/stat", Model.OUTPUT_CAP_MEDIUM)
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
    command: Model.wrapCollectorCommand("free -b", Model.OUTPUT_CAP_TINY)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.memInfo = Model.parseFree(text)
    }
  }

  Process {
    id: diskProc
    command: Model.wrapCollectorCommand(
      "df -h --output=source,size,used,avail,pcent,target", Model.OUTPUT_CAP_LARGE)
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
    command: Model.wrapCollectorCommand(Model.collectGpuDetail(root.gpuPath), Model.OUTPUT_CAP_MEDIUM)
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
    command: Model.wrapCollectorCommand(Model.COLLECT_SENSORS, Model.OUTPUT_CAP_MEDIUM)
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
    command: Model.wrapCollectorCommand("cat /proc/net/dev", Model.OUTPUT_CAP_MEDIUM)
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
    command: Model.wrapCollectorCommand(Model.COLLECT_PROC_SNAPSHOT, Model.OUTPUT_CAP_XLARGE)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var snap = Model.parseProcSnapshot(text)
        var now = Date.now()
        if (root.procTicksPrev && root.procTicksAt > 0) {
          var dt = (now - root.procTicksAt) / 1000
          var cpuByPid = Model.calcProcCpu(root.procTicksPrev, snap.ticks, dt, root.cpuCount, 100)
          root.topProcessesCpu = Model.mergeProcRows(snap.rows, cpuByPid, "cpu", 4)
          root.topProcessesMem = Model.mergeProcRows(snap.rows, null, "mem", 4)
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
    contentWidth: popup.fittedContentWidth(Style.space(root.dropdownWidth))
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
          columns: 2
          rowSpacing: Style.space(12)
          columnSpacing: Style.space(18)

          QuickStat {
            label: "CPU"; fraction: root.animCpu / 100; hot: root.cpuTotalPercent >= 90
            valueText: root.cpuPrimed ? Math.round(root.animCpu) + "%" : "…"
            accent: root.secCpu
          }
          QuickStat {
            visible: root.gpuPath !== ""
            label: "GPU"; fraction: root.animGpu / 100; hot: root.gpuUtil >= 90
            valueText: Math.round(root.animGpu) + "%"
            accent: root.secGpu
          }
          QuickStat {
            label: "MEM"; fraction: root.animMem / 100; hot: root.memPercent >= 90
            valueText: root.memInfo ? Math.round(root.animMem) + "%" : "…"
            accent: root.secMem
          }
          QuickStat {
            label: "DISK"; fraction: root.animDisk / 100; hot: root.diskPercent >= 90
            valueText: Math.round(root.animDisk) + "%"
            accent: root.secDisk
          }
          // No natural 0-1 scale for temperature or an open-ended network
          // rate, so these two skip the meter bar rather than force one onto
          // an arbitrary cap that would quietly mislead — the animated
          // number still carries the "this is live" motion on its own.
          QuickStat {
            // The CPU package, matching the full panel's own TEMP figure.
            label: "TEMP"; hot: root.cpuTempC >= 85
            valueText: root.cpuTempC > 0 ? Math.round(root.animTemp) + "°C" : "…"
            accent: root.secThermal
          }
          QuickStat {
            label: "NET"
            valueText: root.netRates
              ? "↑" + root._compactRate(root.netRates.txRate) + " ↓" + root._compactRate(root.netRates.rxRate)
              : "…"
            accent: root.secNet
          }
        }

        Rectangle {
          Layout.fillWidth: true
          height: 1
          color: Color.muted
          opacity: 0.4
        }

        ProcessSection {
          title: "TOP PROCESSES — CPU"
          rows: root.topProcessesCpu
          valueFor: function(p) { return p.cpu === undefined ? "new" : Math.round(p.cpu) + "%" }
        }

        ProcessSection {
          title: "TOP PROCESSES — MEMORY"
          rows: root.topProcessesMem
          valueFor: function(p) { return Model.formatBytes(p.rss) }
        }

        Text {
          id: openLink
          Layout.fillWidth: true
          Layout.topMargin: Style.space(4)
          text: "Open full monitor →"
          color: openLinkHover.hovered ? Color.foreground : Color.accent
          font.family: Style.font.family
          font.pixelSize: root.fs(Style.font.bodySmall)
          Behavior on color { ColorAnimation { duration: 120 } }

          HoverHandler { id: openLinkHover }
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

  // One stat cell: caption label, animated value, and — where a stat has a
  // natural 0-1 scale — a slim meter bar beneath it (fraction < 0 hides the
  // bar entirely; see the GridLayout above for which stats get one). Local
  // to this file — the full panel has its own similarly-named `Stat`
  // component in Panel.qml, but the two files load independently (separate
  // kinds), so there is no collision and no shared-component extraction to
  // do here.
  component QuickStat: ColumnLayout {
    id: stat
    property string label: ""
    property string valueText: ""
    property real fraction: -1
    property bool hot: false
    // The stat's own colour, carried by its label and its meter fill. Six
    // identically-accented blocks read as one undifferentiated grid; giving
    // each the hue its section has in the full panel is what tells them
    // apart at a glance and ties the two views together. Defaults to the
    // theme accent so a stat that names no colour renders as it always did.
    property color accent: Color.accent
    spacing: Style.space(2)
    Layout.fillWidth: true

    Text {
      text: stat.label
      color: stat.accent
      font.family: Style.font.family
      font.pixelSize: root.fs(Style.font.caption)
    }
    Text {
      text: stat.valueText
      color: stat.hot ? Color.urgent : Color.foreground
      font.family: Style.font.family
      font.pixelSize: root.fs(Style.font.body)
      Behavior on color { ColorAnimation { duration: 200 } }
    }
    MeterBar {
      Layout.fillWidth: true
      visible: stat.fraction >= 0
      value: stat.fraction
      warn: stat.hot
      accent: stat.accent
    }
  }

  // Slim animated meter: a rounded track plus a fill that eases to its new
  // width instead of snapping, the same pattern (down to the easing curve)
  // as the full panel's own MeterBar in Panel.qml — kept as a separate local
  // copy rather than a shared import for the same reason QuickStat is:
  // panel and bar-widget kinds are two independent QML component trees, so
  // there is nothing to actually share, only a look worth matching.
  component MeterBar: Item {
    id: mb
    property real value: 0
    property bool warn: false
    property color accent: Color.accent
    implicitHeight: Style.space(5)
    height: implicitHeight

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.15)

      Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: parent.width * Math.max(0, Math.min(1, mb.value))
        radius: parent.radius
        color: mb.warn ? Color.urgent : mb.accent
        Behavior on width { NumberAnimation { duration: 220; easing.type: Easing.OutQuad } }
      }
    }
  }

  // One labelled block of process rows — the CPU and memory sections are
  // identical in shape and differ only in which rows they're handed and how
  // the trailing value is computed, so both go through this rather than two
  // copies of the same Repeater.
  component ProcessSection: ColumnLayout {
    id: psec
    property string title: ""
    property var rows: []
    property var valueFor: function(p) { return "" }
    Layout.fillWidth: true
    spacing: Style.space(4)
    visible: psec.rows.length > 0

    Text {
      text: psec.title
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: root.fs(Style.font.caption)
    }

    Repeater {
      model: psec.rows
      delegate: ProcessRow {
        Layout.fillWidth: true
        commandText: Model.truncateDisplay(modelData.command, 128)
        // A Repeater's delegates are reparented to the Repeater's OWN
        // parent, not the Repeater itself, so a bare `parent` here already
        // means psec — explicit id, not a parent-chain guess, on purpose
        // after getting exactly that wrong once already in this file.
        valueText: psec.valueFor(modelData)
      }
    }
  }

  // One process row: command name, trailing value, and a hover highlight —
  // a small "this is interactive-feeling, not a static label" touch even
  // though clicking a row does nothing yet (the full panel is where a
  // process actually gets acted on).
  component ProcessRow: Rectangle {
    id: pr
    property string commandText: ""
    property string valueText: ""
    implicitHeight: prRow.implicitHeight + Style.space(4)
    radius: Style.cornerRadius
    color: prHover.hovered ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.08) : "transparent"
    Behavior on color { ColorAnimation { duration: 120 } }

    HoverHandler { id: prHover }

    RowLayout {
      id: prRow
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(4)
      anchors.rightMargin: Style.space(4)

      Text {
        Layout.fillWidth: true
        textFormat: Text.PlainText
        text: pr.commandText
        color: Color.foreground
        elide: Text.ElideRight
        font.family: Style.font.family
        font.pixelSize: root.fs(Style.font.bodySmall)
      }
      Text {
        text: pr.valueText
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: root.fs(Style.font.bodySmall)
      }
    }
  }
}
