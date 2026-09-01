import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Model

// System monitor — a large floating window in the spirit of btop's, but
// native to the shell and keyboard-driven.
//
// Summon it with:
//   omarchy-shell shell toggle jharrison.sysmonitor
//
// Notes for anyone editing this:
//
// 1. All parsing lives in Model.js and is tested under node
//    (`node test-model.js` — 102 checks against this machine's real /proc,
//    sysfs, ps and df output). This file is wiring and layout only.
//
// 2. One master tick drives every collector rather than eight independent
//    Timers. Independent timers on 2s/3s/5s/10s periods align periodically
//    and fire eight subprocesses in one frame — a visible CPU spike inside
//    the very panel measuring CPU. Each source claims a distinct phase.
//
// 3. A `panel` kind gets no `bar` object injected (only `shell` and
//    `manifest`), so theme values come from the Color singleton directly
//    rather than through `bar.foreground`.
Item {
  id: root

  // ─────────────────────────────────────────────── plugin lifecycle
  property var shell: null
  property var manifest: null
  property bool closingFromHost: false

  readonly property bool live: window.visible

  function open(payloadJson) {
    closingFromHost = false
    window.visible = true
    Qt.callLater(function() {
      if (keyCatcher) keyCatcher.forceActiveFocus()
    })
  }

  // Host-initiated close (`shell hide`): flip visibility without telling the
  // host, which already knows.
  function close() {
    closingFromHost = true
    window.visible = false
    closingFromHost = false
  }

  // User-initiated close (Esc, window button): tell the shell so its
  // open-panel map stays consistent and the next `toggle` behaves.
  function requestClose() {
    if (shell && typeof shell.hide === "function") shell.hide("jharrison.sysmonitor")
    else window.visible = false
  }

  // Panel kinds receive no `settings` injection, so the manifest's own
  // defaults block is the config surface — edit manifest.json to tune.
  function setting(name, fallback) {
    var d = manifest && manifest.panel && manifest.panel.defaults
            ? manifest.panel.defaults : null
    var v = d ? d[name] : undefined
    return v === undefined || v === null ? fallback : v
  }

  readonly property int pollInterval: setting("pollInterval", 2000)
  readonly property bool showCpuPerCore: setting("showCpuPerCore", true)
  readonly property bool showSmartHealth: setting("showSmartHealth", true)
  readonly property bool showBandwhich: setting("showBandwhich", true)
  readonly property int processCount: setting("processCount", 14)
  readonly property bool showAllSensors: setting("showAllSensors", false)
  // Multiplier over the theme's font tokens. This is a dense readout meant to
  // be scanned from a normal seating distance, and the shell's bar-sized
  // defaults are too small for it. Tunable in manifest.json.
  readonly property real fontScale: setting("fontScale", 1.25)

  // ─────────────────────────────────────────────── theme
  readonly property color foreground: Color.foreground
  readonly property color background: Color.background
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  readonly property color dim: Qt.darker(Color.foreground, 1.45)
  readonly property color dimmer: Qt.darker(Color.foreground, 1.75)
  // Monospace throughout: this is a wall of numbers, and proportional digits
  // make the columns jitter as values change.
  readonly property string fontFamily: "monospace"

  // Every size in the panel goes through these, so one number rescales the
  // whole thing without hunting for literals.
  function fs(token) { return Math.round(token * root.fontScale) }
  readonly property int fsCaption: fs(Style.font.caption)
  readonly property int fsSmall: fs(Style.font.bodySmall)
  readonly property int fsBody: fs(Style.font.body)
  readonly property int fsTitle: fs(Style.font.title)
  readonly property int fsHeading: fs(Style.font.heading)
  // The top strip is the focal point — at body size it read as just more of
  // the same text. Sits between body and the title so it leads without
  // competing with the panel name.
  readonly property int fsStat: fs(Style.font.title)

  // ─────────────────────────────────────────────── state
  property var cpuStatPrev: null
  property int cpuTotalPercent: 0
  property var cpuCorePercents: []
  property bool cpuPrimed: false
  property var loadInfo: null
  property string cpuModel: ""

  property var memInfo: null
  property var zramInfo: null
  property var pressureInfo: ({})

  property var netPrev: null
  property real netPrevAt: 0
  property var netRates: ({})
  property var bandwhichRows: []
  property var bandwhichAccum: null
  property string primaryIface: ""

  property var diskData: []
  property var smartData: null

  property string gpuPath: ""
  property int gpuUtil: 0
  property real gpuTemp: 0
  property var gpuInfo: null           // full readout — VRAM, power, clocks, temps
  property var nvmeDevices: []
  property var smartList: []           // one entry per NVMe drive
  property bool smartNeedsSudo: false
  property var procDetail: null        // exe / cwd / ancestry for selectedProcess
  property int detailTick: 0           // seconds since the detail view opened

  property var sensorData: []
  property var fanData: []

  property var processData: []
  // Frozen copy shown while paused, so the live poll keeps running underneath
  // (CPU deltas stay continuous) but the table stops moving under the cursor.
  property bool processPaused: false
  property var processFrozen: []
  readonly property var processView: processPaused ? processFrozen : processData
  property var procTicksPrev: null
  property real procTicksAt: 0
  property int cpuCount: 1
  property string processSortBy: "cpu"
  // Non-empty while a search narrows the process list. Distinct from
  // searchingProcesses (below): the filter text survives after the field
  // closes, so "/" then Enter leaves the list filtered with the keyboard
  // cursor free to move again.
  property string processFilter: ""
  // True only while the search field itself is open/focused — governs its
  // visibility and, via PanelKeyCatcher's blocked property, whether typed
  // characters go into the field instead of triggering shortcuts.
  property bool searchingProcesses: false
  property var selectedProcess: null
  property int confirmKillPid: -1
  property string actionError: ""

  property string uptimeText: ""
  property real uptimeSeconds: 0
  readonly property string currentUser: Quickshell.env("USER") || ""

  // "11th Gen Intel(R) Core(TM) i9-11900K @ 3.50GHz" is mostly decoration.
  readonly property string cpuModelShort: {
    var s = String(root.cpuModel)
    if (s === "") return ""
    s = s.replace(/\(R\)|\(TM\)|\(tm\)/g, "")
    s = s.replace(/\s*@.*$/, "")
    s = s.replace(/^\d+th Gen\s+/i, "")
    return s.replace(/\s+/g, " ").trim()
  }

  // Both tools sit on PATH but neither works unprivileged here, so presence
  // is not the test — the probe runs the real command.
  property bool bandwhichAvailable: false
  property bool smartAvailable: false

  // ─────────────────────────────────────────────── responsive breakpoints
  //
  // This is a tiling environment: the window can be resized to anything, or
  // tiled into a half- or quarter-screen column. Nothing below may assume the
  // 1180px it opens at. `contentWidth` is the real usable width inside the
  // scroll view, and every layout decision keys off it.
  //
  // The thresholds are where a layout actually stops being readable, measured
  // against the monospace column widths below — not round numbers.
  readonly property real contentWidth: scrollArea.availableWidth

  readonly property int coreColumns: contentWidth >= 960 ? 4
                                   : contentWidth >= 620 ? 2 : 1
  readonly property bool twoColumnDash: contentWidth >= 700
  readonly property int detailColumns: contentWidth >= 640 ? 4 : 2

  // Process-table columns, dropped right-to-left as width runs out. COMMAND
  // takes whatever is left, so it never disappears.
  readonly property bool showProcUser: contentWidth >= 700
  readonly property bool showProcState: contentWidth >= 560
  readonly property bool showProcPid: contentWidth >= 440
  readonly property bool showProcTime: contentWidth >= 820
  readonly property bool showProcThreads: contentWidth >= 960

  // Fixed widths for the numeric columns. Monospace makes these predictable,
  // and anchoring them right-to-left keeps the header and rows aligned at
  // every width without percentage arithmetic that collides when narrow.
  readonly property real colPid: Style.space(58)
  readonly property real colUser: Style.space(92)
  readonly property real colState: Style.space(74)
  readonly property real colCpu: Style.space(54)
  readonly property real colMem: Style.space(70)
  readonly property real colTime: Style.space(60)
  readonly property real colThreads: Style.space(44)
  readonly property real colGap: Style.space(10)

  // The CPU package reading, pulled out of the sensor list now that the
  // standalone SENSORS section is gone.
  readonly property real cpuTemp: {
    for (var i = 0; i < sensorData.length; i++)
      if (sensorData[i].name === "coretemp" || sensorData[i].name === "k10temp"
          || sensorData[i].name === "zenpower") return sensorData[i].tempC
    return 0
  }

  // The single most useful temperature to surface at a glance: whatever is
  // currently hottest, named. Which component that is changes with load, so
  // pinning it to the CPU would hide a GPU or drive running away.
  readonly property var hottest: {
    var best = null
    for (var i = 0; i < sensorData.length; i++)
      if (!best || sensorData[i].tempC > best.tempC) best = sensorData[i]
    return best
  }

  // ─────────────────────────────────────────────── navigation
  readonly property var visibleSections: {
    var s = ["cpu", "memory"]
    if (gpuPath !== "") s.push("gpu")
    s.push("disk", "network", "processes")
    return s
  }
  property string focusSection: "processes"
  property int selectedIndex: 0
  property bool cursorActive: false

  function sectionCount(name) {
    if (name === "disk") return diskData.length
    if (name === "processes") return processView.length
    return 1
  }

  function clampCursor() {
    var max = sectionCount(focusSection) - 1
    if (selectedIndex > max) selectedIndex = max
    if (selectedIndex < 0) selectedIndex = 0
  }

  function moveCursor(dy) {
    if (selectedProcess) return
    var sections = visibleSections
    var sIdx = sections.indexOf(focusSection)
    if (sIdx < 0) { focusSection = sections[0]; selectedIndex = 0; return }
    if (dy > 0) {
      if (selectedIndex < sectionCount(focusSection) - 1) selectedIndex++
      else if (sIdx < sections.length - 1) { focusSection = sections[sIdx + 1]; selectedIndex = 0 }
    } else {
      if (selectedIndex > 0) selectedIndex--
      else if (sIdx > 0) {
        focusSection = sections[sIdx - 1]
        selectedIndex = sectionCount(sections[sIdx - 1]) - 1
      }
    }
  }

  // Rows within a section are one vertical list, so h/l stepping whole
  // sections is more useful than a no-op.
  function moveCursorH(dx) {
    if (selectedProcess) return
    var sections = visibleSections
    var sIdx = sections.indexOf(focusSection)
    if (sIdx < 0) return
    var next = sIdx + (dx > 0 ? 1 : -1)
    if (next < 0 || next >= sections.length) return
    focusSection = sections[next]
    selectedIndex = 0
  }

  function activateCursor() {
    if (focusSection === "processes" && selectedIndex >= 0
        && selectedIndex < processView.length)
      selectProcess(processView[selectedIndex])
  }

  function jumpToSection(n) {
    var sections = visibleSections
    if (n < 1 || n > sections.length) return
    cursorActive = true
    focusSection = sections[n - 1]
    selectedIndex = 0
  }

  // ─────────────────────────────────────────────── actions
  function selectProcess(proc) {
    if (!proc) return
    actionError = ""
    confirmKillPid = -1
    // A mouse click can land here while the search field is still open (it
    // never had to pass through the field's own Enter handler). Clearing the
    // flag here too means the keyboard is never left blocked behind a field
    // that is no longer visible.
    searchingProcesses = false
    selectedProcess = proc
    procDetail = null
    detailTick = 0
    detailProc.command = ["bash", "-c",
      "ps -p " + proc.pid + " -o pid,ppid,user:20,%cpu,%mem,stat,nice,rss,args --no-headers"]
    detailProc.running = true
    procDetailProc.command = ["bash", "-c", Model.collectProcDetail(proc.pid)]
    procDetailProc.running = true
  }

  function backToList() {
    selectedProcess = null
    procDetail = null
    confirmKillPid = -1
    actionError = ""
  }

  function ownsProcess(proc) {
    return proc ? Model.userMatches(proc.user, root.currentUser) : false
  }

  // Signals go through a Process rather than execDetached so a refusal is
  // visible: killing another user's process fails with EPERM, and the row
  // merely not disappearing reads as a broken button.
  function killProcess(pid, signal) {
    if (pid <= 0) return
    actionError = ""
    actionProc.pendingLabel = "kill -" + signal + " " + pid
    actionProc.command = ["kill", "-" + signal, String(pid)]
    actionProc.running = true
  }

  function reniceProcess(pid, nice) {
    if (pid <= 0) return
    actionError = ""
    actionProc.pendingLabel = "renice " + nice + " " + pid
    actionProc.command = ["renice", "-n", String(nice), "-p", String(pid)]
    actionProc.running = true
  }

  function openProcessLsof(pid) {
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
                             "lsof -p " + pid])
  }

  property string grantBusy: ""
  property string grantError: ""

  // Privilege grants run through pkexec, so the polkit agent raises its own
  // password dialog and this panel never sees the credential. Nothing is
  // granted silently — each is a distinct button the user presses.
  //
  // bandwhich needs packet-capture capability on the binary. smartctl needs to
  // open a root-owned block device; a narrow sudoers entry allows exactly the
  // SMART read without putting the account in the `disk` group, which would
  // grant raw read/write to every disk rather than one command.
  function grantBandwhich() {
    grantBusy = "bandwhich"; grantError = ""
    grantProc.command = ["pkexec", "setcap",
                         "cap_net_raw,cap_net_admin+eip", "/usr/bin/bandwhich"]
    grantProc.running = true
  }

  function grantSmart() {
    grantBusy = "smartctl"; grantError = ""
    var rule = (Quickshell.env("USER") || "")
             + " ALL=(root) NOPASSWD: /usr/bin/smartctl -j -a /dev/nvme*n1\n"
    // Written to a temp file and validated with `visudo -c` before it is put
    // in place: a malformed sudoers drop-in can lock sudo out entirely.
    grantProc.command = ["pkexec", "sh", "-c",
      "t=$(mktemp) && printf '%s' " + Util.shellQuote(rule) + " > \"$t\""
      + " && chmod 0440 \"$t\""
      + " && visudo -cf \"$t\""
      + " && install -m 0440 -o root -g root \"$t\" /etc/sudoers.d/10-sysmonitor-smartctl"
      + "; rc=$?; rm -f \"$t\"; exit $rc"]
    grantProc.running = true
  }

  function togglePause() {
    if (!processPaused) processFrozen = processData.slice()
    processPaused = !processPaused
  }

  // Opens the process search field and moves keyboard focus into it. A
  // paused view is a frozen top-N slice — exactly what search exists to see
  // past — so searching always resumes the live poll first.
  function startProcessSearch() {
    if (processPaused) togglePause()
    searchingProcesses = true
    cursorActive = true
    focusSection = "processes"
    followCursor()
    Qt.callLater(function() {
      if (procSearchField) { procSearchField.forceActiveFocus(); procSearchField.selectAll() }
    })
  }

  // Enter in the field: stop editing but keep the filter applied, cursor on
  // the best match, ready for x to kill it or j/k to look at the rest.
  function commitProcessSearch() {
    searchingProcesses = false
    selectedIndex = 0
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  // Escape in the field, or the clear button: drop the filter entirely.
  function clearProcessSearch() {
    processFilter = ""
    searchingProcesses = false
    selectedIndex = 0
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  function refreshAll() { tick = 0; runCollectors(true) }

  // Each section registers the item to scroll to when the cursor lands in it.
  property var sectionAnchors: ({})
  function registerAnchor(name, item) {
    var a = sectionAnchors
    a[name] = item
    sectionAnchors = a
  }
  function followCursor() {
    var item = sectionAnchors[focusSection]
    if (item) focusScope.ensureVisible(item)
  }

  // Re-order what is already on screen the moment the sort flips, instead of
  // leaving the old order until the next poll lands.
  onProcessSortByChanged: {
    if (processData.length > 0)
      processData = Model.mergeProcRows(processData, null, processSortBy, processCount)
    start(procProc)
  }

  // Same instant-then-confirmed shape as the sort toggle above: re-filter
  // whatever is already on screen so typing feels immediate, then force a
  // fresh poll straight away. That second step matters here in a way it
  // does not for sort — the rows on screen right now may still be the old
  // capped top-N and simply not contain a match this filter would find, so
  // a real snapshot has to land before the result is trustworthy.
  onProcessFilterChanged: {
    if (processData.length > 0)
      processData = Model.mergeProcRows(processData, null, processSortBy, processCount,
                                        processFilter)
    selectedIndex = 0
    start(procProc)
  }

  // ─────────────────────────────────────────────── polling
  property int tick: 0
  readonly property int baseTick: 250
  readonly property int mainPeriod: Math.max(1, Math.round(pollInterval / baseTick))

  function due(period, phase, force) {
    return force ? true : (tick % period) === (phase % period)
  }
  function start(proc) { if (!proc.running) proc.running = true }

  function runCollectors(force) {
    if (due(mainPeriod, 0, force)) start(cpuProc)
    if (due(mainPeriod, 1, force)) start(memProc)
    if (due(mainPeriod, 2, force)) start(netProc)
    if (due(mainPeriod, 3, force)) start(procProc)
    if (due(mainPeriod, 4, force)) start(loadProc)
    if (due(mainPeriod * 2, 5, force)) start(pressureProc)
    if (gpuPath !== "" && due(mainPeriod * 2, 6, force)) start(gpuProc)
    if (due(mainPeriod * 2, 7, force)) start(sensorProc)
    if (due(mainPeriod * 2, 9, force)) start(fanProc)
    if (due(mainPeriod * 10, 11, force)) start(diskProc)
    if (smartAvailable && showSmartHealth && due(mainPeriod * 20, 13, force)) start(smartProc)
  }

  Timer {
    interval: root.baseTick
    running: root.live
    repeat: true
    onTriggered: {
      root.tick++
      if (root.uptimeSeconds > 0) root.uptimeSeconds += root.baseTick / 1000
      root.runCollectors(false)
    }
  }

  // Drives the running-time readout in the detail view once a second, so the
  // figure advances between the slower data polls.
  Timer {
    interval: 1000
    running: root.live && root.selectedProcess !== null
    repeat: true
    onTriggered: root.detailTick++
  }

  onLiveChanged: {
    if (live) {
      tick = 0
      cursorActive = false
      selectedProcess = null
      confirmKillPid = -1
      actionError = ""
      // A stale sample would make the first delta cover however long the
      // window was closed.
      cpuStatPrev = null
      cpuPrimed = false
      netPrev = null
      procTicksPrev = null
      probeProc.running = true
      gpuDetectProc.running = true
      staticInfoProc.running = true
      runCollectors(true)
    } else {
      bandwhichAccum = null
    }
  }

  // ─────────────────────────────────────────────── collectors
  Process {
    id: probeProc
    command: ["bash", "-c", Model.COLLECT_TOOL_PROBE]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var t = String(text || "")
        root.bandwhichAvailable = t.indexOf("bandwhich-ok") >= 0
        // Two ways SMART can work: readable directly (user in the disk group,
        // or a udev rule), or via a NOPASSWD sudoers entry. Neither is assumed.
        root.smartNeedsSudo = t.indexOf("smartctl-sudo") >= 0
        root.smartAvailable = t.indexOf("smartctl-ok") >= 0 || root.smartNeedsSudo
        if (root.smartAvailable) nvmeListProc.running = true
      }
    }
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
    id: staticInfoProc
    command: ["bash", "-c",
      "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//'; " +
      "cut -d' ' -f1 /proc/uptime; " +
      "ip -o -4 route show default 2>/dev/null | awk '{print $5}' | head -1"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var lines = String(text || "").split("\n")
        root.cpuModel = (lines[0] || "").trim()
        root.uptimeSeconds = parseFloat(lines[1] || "0")
        root.uptimeText = Model.formatUptime(root.uptimeSeconds)
        root.primaryIface = (lines[2] || "").trim()
      }
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
          root.cpuCorePercents = p.cores
          root.cpuPrimed = true
        }
        root.cpuStatPrev = curr
      }
    }
  }

  Process {
    id: loadProc
    command: ["cat", "/proc/loadavg"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.loadInfo = Model.parseLoadAvg(text)
    }
  }

  Process {
    id: memProc
    command: ["bash", "-c", "free -b; echo '---'; cat /sys/block/zram0/mm_stat 2>/dev/null"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parts = String(text || "").split("---")
        root.memInfo = Model.parseFree(parts[0])
        root.zramInfo = parts.length > 1 ? Model.parseZram(parts[1]) : null
      }
    }
  }

  Process {
    id: pressureProc
    command: ["bash", "-c", Model.COLLECT_PRESSURE]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.pressureInfo = Model.parsePressure(text)
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
          if (dt > 0) root.netRates = Model.calcNetRate(root.netPrev, curr, dt)
        }
        root.netPrev = curr
        root.netPrevAt = now
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
        root.gpuInfo = g
        root.gpuUtil = g.busy
        // "edge" is the die-surface reading and the closest analogue to a
        // single CPU package temperature; junction runs hotter by design.
        for (var i = 0; i < g.temps.length; i++)
          if (g.temps[i].label === "edge") root.gpuTemp = g.temps[i].tempC
        if (root.gpuTemp === 0 && g.temps.length > 0) root.gpuTemp = g.temps[0].tempC
      }
    }
  }

  Process {
    id: nvmeListProc
    command: ["bash", "-c", Model.COLLECT_NVME_LIST]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var list = String(text || "").trim().split("\n").filter(function(d) { return d })
        root.nvmeDevices = list
        if (list.length > 0) root.start(smartProc)
      }
    }
  }

  Process {
    id: diskProc
    command: ["bash", "-c", "df -h --output=source,size,used,avail,pcent,target"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { root.diskData = Model.parseDfOutput(text); root.clampCursor() }
    }
  }

  Process {
    id: smartProc
    // One invocation per drive, separated by a marker, so both NVMe devices
    // report rather than only the first. `sudo -n` never prompts: if the
    // sudoers entry is missing it fails immediately and the row says so.
    command: ["bash", "-c", (function() {
      var pre = root.smartNeedsSudo ? "sudo -n " : ""
      var parts = []
      for (var i = 0; i < root.nvmeDevices.length; i++)
        parts.push("echo '@@" + root.nvmeDevices[i] + "'; "
                   + pre + "smartctl -j -a '" + root.nvmeDevices[i] + "' 2>/dev/null")
      return parts.length ? parts.join("; ") : "true"
    })()]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var chunks = String(text || "").split("@@")
        var out = []
        for (var i = 1; i < chunks.length; i++) {
          var nl = chunks[i].indexOf("\n")
          if (nl < 0) continue
          var dev = chunks[i].substring(0, nl).trim()
          var parsed = Model.parseSmartHealth(chunks[i].substring(nl + 1))
          if (parsed) { parsed.device = dev; out.push(parsed) }
        }
        root.smartList = out
        root.smartData = out.length > 0 ? out[0] : null
      }
    }
  }

  Process {
    id: sensorProc
    command: ["bash", "-c", Model.COLLECT_SENSORS]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.sensorData = Model.filterSensors(Model.parseSensors(text), root.showAllSensors)
        root.clampCursor()
      }
    }
  }

  Process {
    id: fanProc
    command: ["bash", "-c", Model.COLLECT_FANS]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.fanData = Model.parseFans(text)
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
          var cpuByPid = Model.calcProcCpu(root.procTicksPrev, snap.ticks,
                                           dt, root.cpuCount, 100)
          root.processData = Model.mergeProcRows(snap.rows, cpuByPid,
                                                 root.processSortBy, root.processCount,
                                                 root.processFilter)
          root.clampCursor()
        }
        root.procTicksPrev = snap.ticks
        root.procTicksAt = now
      }
    }
  }

  Process {
    id: procDetailProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.procDetail = Model.parseProcDetail(text)
    }
  }

  Process {
    id: detailProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var r = Model.parseProcDetailPs(String(text || "").split("\n")[0])
        // Empty means it exited between selection and query — drop back
        // rather than freezing on a dead row.
        if (!r) { root.backToList(); return }
        // `ps` hands back its lifetime-average %cpu here, which is the exact
        // number that made a one-core scanner look like a whole-machine one.
        // The measured values and the short name come from the list row.
        if (root.selectedProcess) {
          r.cpu = root.selectedProcess.cpu
          r.cpuCore = root.selectedProcess.cpuCore
          r.elapsed = root.selectedProcess.elapsed
          r.threads = root.selectedProcess.threads
          r.command = root.selectedProcess.command
        }
        root.selectedProcess = r
      }
    }
  }

  // bandwhich streams continuously in raw mode and never exits, so it cannot
  // use StdioCollector (which waits for an end that never comes) and needs no
  // timer — `running` is bound to the window being open.
  Process {
    id: bandwhichProc
    running: root.live && root.showBandwhich && root.bandwhichAvailable
             && root.primaryIface !== ""
    command: ["bash", "-c",
      "bandwhich -r -p -i " + (root.primaryIface || "lo") + " 2>/dev/null"]
    stdout: SplitParser {
      onRead: function(line) {
        // Rows are summed per process and keyed on bandwhich's refresh
        // timestamp, so a process that stopped transmitting drops out instead
        // of sitting at its last rate forever. Unattributed traffic sorts last.
        root.bandwhichAccum = Model.bandwhichAccumulate(root.bandwhichAccum,
                                                        Model.parseBandwhichLine(line))
        root.bandwhichRows = Model.bandwhichTop(root.bandwhichAccum, 6)
      }
    }
  }

  Process {
    id: grantProc
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var m = String(text || "").trim()
        if (m !== "") root.grantError = m
      }
    }
    onExited: function(exitCode) {
      root.grantBusy = ""
      if (exitCode === 0) {
        root.grantError = ""
        probeProc.running = true          // re-probe; the section lights up
      } else if (exitCode === 126 || exitCode === 127) {
        // pkexec's "dismissed" and "not authorised" — a cancelled password
        // prompt is a decision, not a failure to report.
        root.grantError = ""
      } else if (root.grantError === "") {
        root.grantError = "grant failed (exit " + exitCode + ")"
      }
    }
  }

  Process {
    id: actionProc
    property string pendingLabel: ""
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var msg = String(text || "").trim()
        if (msg !== "") root.actionError = msg
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0 && root.actionError === "")
        root.actionError = actionProc.pendingLabel + " failed (exit " + exitCode + ")"
      if (exitCode === 0) {
        root.confirmKillPid = -1
        if (root.selectedProcess) root.backToList()
        root.start(procProc)
      }
    }
  }

  // ═══════════════════════════════════════════════ window
  FloatingWindow {
    id: window
    title: "System Monitor"
    color: root.background
    implicitWidth: 1180
    implicitHeight: 900
    // Low floor on purpose: tiled into a quarter-screen column this can get
    // genuinely narrow, and the layout collapses to one column rather than
    // clipping. Below ~360 even a single column stops being readable.
    minimumSize: Qt.size(360, 280)

    onVisibleChanged: {
      if (!visible && !root.closingFromHost && root.shell
          && typeof root.shell.hide === "function")
        root.shell.hide("jharrison.sysmonitor")
    }

    FocusScope {
      id: focusScope
      anchors.fill: parent
      focus: true

      // ScrollView's contentItem IS the Flickable. Driving contentY directly is
      // reliable; nudging ScrollBar.position was not, and left End/PageDown
      // doing nothing.
      function flick() { return scrollArea.contentItem }
      function maxY() {
        var f = flick()
        return f ? Math.max(0, f.contentHeight - f.height) : 0
      }
      function scrollTo(y) {
        var f = flick()
        if (f) f.contentY = Math.max(0, Math.min(maxY(), y))
      }
      function scrollBy(dy) { scrollTo((flick() ? flick().contentY : 0) + dy) }

      // Keeps the keyboard cursor on screen as it walks across sections; the
      // per-section rows are plain Columns, so nothing else scrolls for them.
      function ensureVisible(item) {
        var f = flick()
        if (!f || !item || !item.visible) return
        var pos = item.mapToItem(page, 0, 0)
        if (!pos) return
        var top = pos.y
        var bottom = top + item.height
        var pad = Style.space(12)
        if (top < f.contentY) scrollTo(top - pad)
        else if (bottom > f.contentY + f.height) scrollTo(bottom - f.height + pad)
      }

      // Page/Home/End bubble past the key catcher, which only consumes
      // Esc / Enter / jkhl / x / text keys.
      Keys.priority: Keys.AfterItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_PageDown) {
          focusScope.scrollBy(focusScope.flick() ? focusScope.flick().height * 0.9 : 400)
          event.accepted = true
        } else if (event.key === Qt.Key_PageUp) {
          focusScope.scrollBy(focusScope.flick() ? -focusScope.flick().height * 0.9 : -400)
          event.accepted = true
        } else if (event.key === Qt.Key_Home) {
          focusScope.scrollTo(0); event.accepted = true
        } else if (event.key === Qt.Key_End) {
          focusScope.scrollTo(focusScope.maxY()); event.accepted = true
        }
      }

      PanelKeyCatcher {
        id: keyCatcher
        anchors.fill: parent
        // The process search field is the one inline editor this panel has.
        // While it is open, typed characters must reach it rather than
        // firing the r/s/p/1-9 shortcuts below.
        blocked: root.searchingProcesses

        onMoveRequested: function(dx, dy) {
          if (!root.cursorActive) { root.cursorActive = true; if (dy >= 0) return }
          if (dy !== 0) root.moveCursor(dy)
          if (dx !== 0) root.moveCursorH(dx)
          root.followCursor()
        }
        onActivateRequested: if (root.cursorActive) root.activateCursor()
        onCloseRequested: {
          // Esc backs out of the detail view first, then closes the window.
          if (root.selectedProcess) root.backToList()
          else root.requestClose()
        }
        // x/X is bound inside PanelKeyCatcher and never reaches onTextKey.
        onDeleteRequested: {
          if (root.selectedProcess) root.killProcess(root.selectedProcess.pid, "TERM")
          else if (root.focusSection === "processes" && root.selectedIndex >= 0
                   && root.selectedIndex < root.processView.length)
            root.killProcess(root.processView[root.selectedIndex].pid, "TERM")
        }
        onTextKey: function(t) {
          if (t === "r" || t === "R") root.refreshAll()
          else if (t === "s" || t === "S")
            root.processSortBy = root.processSortBy === "cpu" ? "mem" : "cpu"
          else if (t === "p" || t === "P") root.togglePause()
          else if (t === "/") root.startProcessSearch()
          else if (t >= "1" && t <= "9") { root.jumpToSection(parseInt(t, 10)); root.followCursor() }
        }

        // Pinned to the top so the title and the at-a-glance figures stay
        // visible however far the content is scrolled. Same reasoning as the
        // hint bar at the bottom.
        // Pinned to the top so the title and the at-a-glance figures stay
        // visible however far the content is scrolled. Same reasoning as the
        // hint bar at the bottom.
        //
        // The CPU model is static identity, not a metric — it lives in the CPU
        // section. What earns the top strip is the handful of numbers worth
        // reading before anything else: how hard each resource is working, the
        // hottest thing in the box, and whether the network is busy.
        Rectangle {
          id: headerBar
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          height: headerContent.implicitHeight + Style.space(26)
          color: root.background
          z: 2

          Item {
            id: headerContent
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(16)
            anchors.rightMargin: Style.space(16)
            implicitHeight: Math.max(titleText.implicitHeight, summaryRow.implicitHeight)

            Text {
              id: titleText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "System Monitor"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: root.fsHeading
              font.bold: true
            }

            Row {
              id: summaryRow
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              // These are six unrelated figures; packed tight they read as one
              // run-on string. The gap scales with available width so a wide
              // window gets real separation without the strip colliding with
              // the title once the window narrows — the stats themselves drop
              // out at the breakpoints below before that can happen.
              spacing: root.contentWidth >= 1080 ? Style.space(50)
                     : root.contentWidth >= 900 ? Style.space(36)
                     : Style.space(24)

              Stat {
                label: "CPU"
                value: root.cpuPrimed ? root.cpuTotalPercent + "%" : "--"
                warn: root.cpuTotalPercent >= 85
              }
              Stat {
                label: "MEM"
                value: root.memInfo && root.memInfo.memTotal > 0
                       ? Math.round((root.memInfo.memTotal - root.memInfo.memAvail)
                                    / root.memInfo.memTotal * 100) + "%" : "--"
                warn: root.memInfo && root.memInfo.memTotal > 0
                      && (root.memInfo.memTotal - root.memInfo.memAvail)
                         / root.memInfo.memTotal > 0.9
              }
              Stat {
                visible: root.gpuPath !== ""
                label: "GPU"
                value: root.gpuUtil + "%"
                warn: root.gpuUtil >= 90
              }
              // Labelled TEMP rather than by device: with the device name as
              // the label it renders a second "CPU" beside the usage stat and
              // reads as a duplicate. The device belongs in the value.
              Stat {
                visible: root.hottest !== null
                label: "TEMP"
                value: root.hottest
                       ? root.hottest.display + " " + Model.formatTemp(root.hottest.tempC)
                       : ""
                warn: root.hottest ? root.hottest.tempC >= 80 : false
              }
              Stat {
                visible: root.contentWidth >= 900
                label: "NET"
                value: {
                  var r = root.netRates[root.primaryIface]
                  if (!r) return "--"
                  return "↓" + Model.formatRate(r.rxRate).replace(" ", "")
                       + "  ↑" + Model.formatRate(r.txRate).replace(" ", "")
                }
              }
              Stat {
                visible: root.contentWidth >= 660
                label: "UPTIME"
                value: root.uptimeText
              }
            }
          }

          Rectangle {
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            height: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
          }
        }

        // Between the two pinned bars.
        ScrollView {
          id: scrollArea
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: headerBar.bottom
          anchors.bottom: hintBar.top
          anchors.margins: Style.space(16)
          anchors.topMargin: Style.space(10)
          anchors.bottomMargin: Style.space(8)
          clip: true
          ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
          // The vertical scrollbar is an overlay: it does not shrink
          // availableWidth, so right-aligned values ("4 filesystems",
          // "enp7s0", the load figures) render underneath it and get clipped.
          // Reserve the gutter as constant padding rather than keying off the
          // bar's visibility, which would loop content width -> content height
          // -> bar visible -> content width.
          rightPadding: Style.space(14)

          Column {
            id: page
            width: scrollArea.availableWidth
            spacing: Style.space(20)

            // An action that failed has to say so — PanelActionButton has no
            // error state, and a silent no-op reads as a broken button.
            Rectangle {
              width: parent.width
              visible: root.actionError !== ""
              height: visible ? errText.implicitHeight + Style.space(12) : 0
              color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.15)
              radius: Style.cornerRadius

              Text {
                id: errText
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                text: root.actionError
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: root.fsSmall
                wrapMode: Text.WordWrap
              }
            }

            // ═══ process detail replaces the dashboard ═══
            Column {
              width: parent.width
              spacing: Style.space(10)
              visible: root.selectedProcess !== null

              Row {
                spacing: Style.space(10)
                PanelActionButton {
                  iconText: "󰁍"
                  tooltipText: "Back (Esc)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.backToList()
                }
                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.selectedProcess ? root.selectedProcess.command : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: root.fsTitle
                  font.bold: true
                }
              }

              Grid {
                columns: root.detailColumns
                columnSpacing: Style.space(20)
                rowSpacing: Style.space(6)

                DetailLabel { text: "PID" }
                DetailValue { text: root.selectedProcess ? String(root.selectedProcess.pid) : "" }
                DetailLabel { text: "Parent" }
                DetailValue { text: root.selectedProcess ? String(root.selectedProcess.ppid) : "" }

                DetailLabel { text: "User" }
                DetailValue { text: root.selectedProcess ? root.selectedProcess.user : "" }
                DetailLabel { text: "State" }
                DetailValue { text: root.selectedProcess ? Model.formatState(root.selectedProcess.stat) : "" }

                DetailLabel { text: "CPU" }
                DetailValue {
                  text: root.selectedProcess
                        ? (root.selectedProcess.cpu !== undefined
                           ? root.selectedProcess.cpu.toFixed(1) + "% of "
                             + root.cpuCount + " threads   ("
                             + (root.selectedProcess.cpuCore || 0).toFixed(0)
                             + "% of one core)"
                           : "not measured yet (process appeared since the last poll)")
                        : ""
                }
                DetailLabel { text: "Memory" }
                DetailValue {
                  text: root.selectedProcess
                        ? root.selectedProcess.mem + "%  ("
                          + Model.formatBytes(root.selectedProcess.rss) + ")" : ""
                }

                DetailLabel { text: "Nice" }
                DetailValue { text: root.selectedProcess ? String(root.selectedProcess.nice) : "" }
                DetailLabel { text: "" }
                DetailValue { text: "" }
              }

              Grid {
                columns: root.detailColumns
                columnSpacing: Style.space(20)
                rowSpacing: Style.space(6)
                visible: root.procDetail !== null

                DetailLabel { text: "Threads" }
                DetailValue { text: root.procDetail ? String(root.procDetail.threads) : "" }
                DetailLabel { text: "Open files" }
                DetailValue { text: root.procDetail ? String(root.procDetail.fds) : "" }


                DetailLabel { text: "Running for" }
                DetailValue {
                  // Ticks on its own rather than waiting for the next poll —
                  // a stopwatch that only moves every two seconds reads as
                  // broken.
                  text: root.selectedProcess && root.selectedProcess.elapsed !== undefined
                        ? Model.formatUptime(root.selectedProcess.elapsed + root.detailTick)
                          + "   (since " + (root.procDetail ? root.procDetail.started : "") + ")"
                        : ""
                }
                DetailLabel { text: "" }
                DetailValue { text: "" }
              }

              // Binary path and working directory resolve only for processes
              // you own — the kernel hides another user's /proc/PID/exe, so a
              // dash here means "not permitted", not "missing".
              DetailLabel { text: "Executable" }
              Text {
                width: page.width
                text: root.procDetail && root.procDetail.exe !== ""
                      ? root.procDetail.exe
                      : (root.selectedProcess && !root.ownsProcess(root.selectedProcess)
                         ? "— not readable for another user's process" : "—")
                color: root.procDetail && root.procDetail.exe !== "" ? root.foreground : root.dimmer
                font.family: root.fontFamily
                font.pixelSize: root.fsSmall
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }

              DetailLabel { text: "Working directory" }
              Text {
                width: page.width
                text: root.procDetail && root.procDetail.cwd !== ""
                      ? root.procDetail.cwd
                      : (root.selectedProcess && !root.ownsProcess(root.selectedProcess)
                         ? "— not readable for another user's process" : "—")
                color: root.procDetail && root.procDetail.cwd !== "" ? root.foreground : root.dimmer
                font.family: root.fontFamily
                font.pixelSize: root.fsSmall
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }

              // Ancestry, nearest parent first, walking up to pid 1. This is
              // what makes a bare "brave" or "python3" identifiable — what
              // launched it usually says what it is.
              DetailLabel {
                text: "Ancestry"
                visible: root.procDetail !== null && root.procDetail.chain.length > 1
              }
              Column {
                width: page.width
                spacing: Style.space(2)
                visible: root.procDetail !== null && root.procDetail.chain.length > 1

                Repeater {
                  model: root.procDetail ? root.procDetail.chain : []
                  delegate: Text {
                    required property var modelData
                    required property int index
                    text: (index === 0 ? "" : "  ".repeat(index) + "└ ")
                          + modelData.comm + "  (" + modelData.pid + ")"
                    color: index === 0 ? root.foreground : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: root.fsSmall
                    elide: Text.ElideRight
                    width: page.width
                  }
                }
              }

              DetailLabel { text: "Command line" }
              Text {
                width: page.width
                text: root.selectedProcess ? root.selectedProcess.fullCommand : ""
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: root.fsSmall
                wrapMode: Text.Wrap
                maximumLineCount: 4
                elide: Text.ElideRight
              }

              Text {
                width: page.width
                visible: root.selectedProcess !== null && !root.ownsProcess(root.selectedProcess)
                text: "Owned by " + (root.selectedProcess ? root.selectedProcess.user : "")
                      + " — signals require elevated privileges."
                color: root.urgent
                opacity: 0.85
                font.family: root.fontFamily
                font.pixelSize: root.fsSmall
                wrapMode: Text.WordWrap
              }

              Row {
                spacing: Style.space(10)
                visible: root.confirmKillPid < 0

                PanelActionButton {
                  iconText: "󰅚"; tooltipText: "Terminate (SIGTERM)"
                  foreground: root.foreground; fontFamily: root.fontFamily
                  hoverColor: root.urgent
                  enabled: root.ownsProcess(root.selectedProcess)
                  onClicked: root.killProcess(root.selectedProcess.pid, "TERM")
                }
                PanelActionButton {
                  iconText: "󰚌"; tooltipText: "Force kill (SIGKILL)"
                  foreground: root.foreground; fontFamily: root.fontFamily
                  hoverColor: root.urgent
                  enabled: root.ownsProcess(root.selectedProcess)
                  onClicked: root.confirmKillPid = root.selectedProcess.pid
                }
                PanelActionButton {
                  iconText: "󰓅"; tooltipText: "Lower priority (renice +10)"
                  foreground: root.foreground; fontFamily: root.fontFamily
                  enabled: root.ownsProcess(root.selectedProcess)
                  onClicked: root.reniceProcess(root.selectedProcess.pid, 10)
                }
                PanelActionButton {
                  iconText: "󰈔"; tooltipText: "Open files (lsof)"
                  foreground: root.foreground; fontFamily: root.fontFamily
                  onClicked: root.openProcessLsof(root.selectedProcess.pid)
                }
              }

              // SIGKILL denies the process any cleanup, so it confirms.
              Row {
                spacing: Style.space(10)
                visible: root.confirmKillPid >= 0

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Force kill?"
                  color: root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: root.fsBody
                }
                PanelActionButton {
                  iconText: "󰄬"; tooltipText: "Confirm SIGKILL"
                  foreground: root.foreground; fontFamily: root.fontFamily
                  hoverColor: root.urgent
                  onClicked: root.killProcess(root.confirmKillPid, "KILL")
                }
                PanelActionButton {
                  iconText: "󰜺"; tooltipText: "Cancel"
                  foreground: root.foreground; fontFamily: root.fontFamily
                  onClicked: root.confirmKillPid = -1
                }
              }
            }

            // ═══ dashboard ═══
            Column {
              id: dash
              width: parent.width
              spacing: Style.space(18)
              visible: root.selectedProcess === null

              // ── CPU, full width, cores in four columns ──
              SectionHeader {
                width: parent.width
                title: "CPU"
                Component.onCompleted: root.registerAnchor("cpu", this)
                value: (root.cpuTemp > 0 ? Model.formatTemp(root.cpuTemp) + "     " : "")
                       + (root.cpuPrimed ? Model.formatPercent(root.cpuTotalPercent) : "--")
                       + (root.loadInfo
                          ? "     load " + root.loadInfo.load1.toFixed(2)
                            + " " + root.loadInfo.load5.toFixed(2)
                            + " " + root.loadInfo.load15.toFixed(2)
                          : "")
              }

              MeterBar {
                width: parent.width
                value: root.cpuPrimed ? root.cpuTotalPercent / 100 : 0
                warn: root.cpuTotalPercent >= 85
              }

              // Core columns reflow with width: four across at full size, two
              // when tiled to half a screen, one when narrower. A fixed four
              // would squeeze each cell's bar to nothing.
              Grid {
                id: coreGrid
                width: parent.width
                visible: root.showCpuPerCore && root.cpuCorePercents.length > 0
                columns: root.coreColumns
                columnSpacing: Style.space(18)
                rowSpacing: Style.space(3)

                Repeater {
                  model: root.cpuCorePercents.length
                  delegate: CoreCell {
                    required property int index
                    coreIndex: index
                    width: (coreGrid.width - Style.space(18) * (root.coreColumns - 1))
                           / root.coreColumns
                  }
                }
              }

              Text {
                width: parent.width
                visible: root.cpuModelShort !== ""
                text: root.cpuModelShort
                      + (root.cpuCorePercents.length > 0
                         ? "     " + root.cpuCorePercents.length + " threads" : "")
                color: root.dimmer
                elide: Text.ElideRight
                font.family: root.fontFamily
                font.pixelSize: root.fsCaption
              }

              Text {
                width: parent.width
                visible: root.pressureInfo && root.pressureInfo.cpu !== undefined
                text: {
                  var p = root.pressureInfo
                  if (!p || !p.cpu) return ""
                  var t = "pressure   cpu " + p.cpu.some.toFixed(1)
                        + "     io " + (p.io ? p.io.full.toFixed(1) : "--")
                        + "     mem " + (p.memory ? p.memory.full.toFixed(1) : "--")
                  // The running count is the first thing to go when narrow —
                  // it is also on the CPU header's load figures.
                  if (root.loadInfo && root.contentWidth >= 520)
                    t += "        " + root.loadInfo.running + "/"
                       + root.loadInfo.total + " running"
                  return t
                }
                color: root.dimmer
                elide: Text.ElideRight
                font.family: root.fontFamily
                font.pixelSize: root.fsSmall
              }

              // ── two columns: memory+gpu+sensors | disk+network ──
              //
              // GridLayout rather than a Row so the two halves stack into one
              // column when the window is too narrow to carry both. A Row with
              // width/2 children would just crush them.
              GridLayout {
                width: parent.width
                columns: root.twoColumnDash ? 2 : 1
                columnSpacing: Style.space(36)
                rowSpacing: Style.space(18)

                Column {
                  id: leftCol
                  Layout.fillWidth: true
                  Layout.preferredWidth: 1
                  Layout.alignment: Qt.AlignTop
                  spacing: Style.space(14)

                  PanelSeparator { width: parent.width; foreground: root.foreground }

                  SectionHeader {
                    width: parent.width
                    title: "MEMORY"
                    Component.onCompleted: root.registerAnchor("memory", this)
                    value: root.memInfo
                           ? Model.formatBytes(root.memInfo.memTotal - root.memInfo.memAvail)
                             + " / " + Model.formatBytes(root.memInfo.memTotal) : "--"
                  }

                  MeterBar {
                    width: parent.width
                    value: root.memInfo && root.memInfo.memTotal > 0
                           ? (root.memInfo.memTotal - root.memInfo.memAvail) / root.memInfo.memTotal : 0
                    warn: root.memInfo && root.memInfo.memTotal > 0
                          && (root.memInfo.memTotal - root.memInfo.memAvail) / root.memInfo.memTotal > 0.9
                  }

                  LabelledMeter {
                    width: parent.width
                    visible: root.memInfo !== null && root.memInfo.swapTotal > 0
                    label: "swap"
                    value: root.memInfo && root.memInfo.swapTotal > 0
                           ? root.memInfo.swapUsed / root.memInfo.swapTotal : 0
                    detail: root.memInfo
                            ? Model.formatBytes(root.memInfo.swapUsed) + " / "
                              + Model.formatBytes(root.memInfo.swapTotal) : ""
                  }

                  Text {
                    width: parent.width
                    visible: root.zramInfo !== null
                    text: root.zramInfo
                          ? "zram    " + Model.formatBytes(root.zramInfo.origSize) + " → "
                            + Model.formatBytes(root.zramInfo.comprSize) + "   ("
                            + Model.formatCompressionRatio(root.zramInfo.origSize,
                                                           root.zramInfo.comprSize) + ")" : ""
                    color: root.dimmer
                    font.family: root.fontFamily
                    font.pixelSize: root.fsSmall
                  }

                  PanelSeparator {
                    width: parent.width
                    visible: root.gpuPath !== ""
                    foreground: root.foreground
                  }

                  SectionHeader {
                    width: parent.width
                    visible: root.gpuPath !== ""
                    title: "GPU"
                    Component.onCompleted: root.registerAnchor("gpu", this)
                    value: root.gpuInfo
                           ? Model.formatWatts(root.gpuInfo.watts) + " / "
                             + Model.formatWatts(root.gpuInfo.wattsCap)
                           : ""
                  }

                  LabelledMeter {
                    width: parent.width
                    visible: root.gpuPath !== ""
                    label: "core"
                    value: root.gpuUtil / 100
                    warn: root.gpuUtil >= 90
                    detail: root.gpuUtil + "%"
                  }

                  // The memory controller runs its own utilisation, separate
                  // from how full VRAM is — a texture-thrashing workload pins
                  // this while VRAM usage sits still.
                  LabelledMeter {
                    width: parent.width
                    visible: root.gpuInfo !== null
                    label: "mem"
                    value: root.gpuInfo ? root.gpuInfo.memBusy / 100 : 0
                    warn: root.gpuInfo ? root.gpuInfo.memBusy >= 90 : false
                    detail: root.gpuInfo ? root.gpuInfo.memBusy + "%" : ""
                  }

                  LabelledMeter {
                    width: parent.width
                    visible: root.gpuInfo !== null && root.gpuInfo.vramTotal > 0
                    label: "vram"
                    value: root.gpuInfo && root.gpuInfo.vramTotal > 0
                           ? root.gpuInfo.vramUsed / root.gpuInfo.vramTotal : 0
                    warn: root.gpuInfo && root.gpuInfo.vramTotal > 0
                          && root.gpuInfo.vramUsed / root.gpuInfo.vramTotal > 0.9
                    detail: root.gpuInfo
                            ? Model.formatBytes(root.gpuInfo.vramUsed) + " / "
                              + Model.formatBytes(root.gpuInfo.vramTotal) : ""
                  }

                  LabelledMeter {
                    width: parent.width
                    visible: root.gpuInfo !== null && root.gpuInfo.wattsCap > 0
                    label: "power"
                    value: root.gpuInfo && root.gpuInfo.wattsCap > 0
                           ? root.gpuInfo.watts / root.gpuInfo.wattsCap : 0
                    warn: root.gpuInfo && root.gpuInfo.wattsCap > 0
                          && root.gpuInfo.watts / root.gpuInfo.wattsCap > 0.9
                    detail: root.gpuInfo ? Model.formatWatts(root.gpuInfo.watts) : ""
                  }

                  Text {
                    width: parent.width
                    visible: root.gpuInfo !== null
                             && (root.gpuInfo.clocks.length > 0 || root.gpuInfo.fanRpm > 0)
                    text: {
                      if (!root.gpuInfo) return ""
                      var bits = []
                      for (var i = 0; i < root.gpuInfo.clocks.length; i++)
                        bits.push(root.gpuInfo.clocks[i].name + " "
                                  + Model.formatMHz(root.gpuInfo.clocks[i].mhz))
                      if (root.gpuInfo.fanRpm > 0) bits.push(root.gpuInfo.fanRpm + " RPM")
                      return bits.join("     ")
                    }
                    color: root.dimmer
                    elide: Text.ElideRight
                    font.family: root.fontFamily
                    font.pixelSize: root.fsCaption
                  }

                  // edge / junction / mem are genuinely different sensors, and
                  // junction is the one that throttles the card.
                  Text {
                    width: parent.width
                    visible: root.gpuInfo !== null && root.gpuInfo.temps.length > 0
                    text: {
                      if (!root.gpuInfo) return ""
                      var bits = []
                      for (var i = 0; i < root.gpuInfo.temps.length; i++)
                        bits.push(root.gpuInfo.temps[i].label + " "
                                  + Model.formatTemp(root.gpuInfo.temps[i].tempC))
                      return bits.join("     ")
                    }
                    color: root.gpuInfo && root.gpuInfo.temps.some(function(t) {
                             return t.tempC >= 90 }) ? root.urgent : root.dimmer
                    elide: Text.ElideRight
                    font.family: root.fontFamily
                    font.pixelSize: root.fsCaption
                  }

                  // The SENSORS list was removed: GPU temperatures already sit in
                  // the GPU section, drive temperatures in the health rows, and
                  // the CPU package temperature is now on the CPU header — the
                  // section had become a second copy of all three. Sensors are
                  // still collected, for the CPU reading and the header stat.
                }

                Column {
                  id: rightCol
                  Layout.fillWidth: true
                  Layout.preferredWidth: 1
                  Layout.alignment: Qt.AlignTop
                  spacing: Style.space(14)

                  PanelSeparator { width: parent.width; foreground: root.foreground }

                  SectionHeader {
                    width: parent.width
                    title: "DISK"
                    Component.onCompleted: root.registerAnchor("disk", this)
                    value: root.diskData.length + " filesystems"
                  }

                  Repeater {
                    model: root.diskData
                    delegate: DiskRow {
                      required property var modelData
                      required property int index
                      width: rightCol.width
                      disk: modelData
                      rowIndex: index
                    }
                  }

                  Repeater {
                    model: root.showSmartHealth ? root.smartList : []
                    delegate: Text {
                      required property var modelData
                      width: rightCol.width
                      text: modelData.device.replace("/dev/", "") + "   "
                            + Model.formatTemp(modelData.temp)
                            + "   wear " + modelData.wearPercent + "%"
                            + "   " + modelData.powerOnHours + "h"
                            + "   " + modelData.mediaErrors + " err"
                      color: modelData.mediaErrors > 0 || modelData.wearPercent >= 80
                             ? root.urgent : root.dimmer
                      font.family: root.fontFamily
                      font.pixelSize: root.fsCaption
                      elide: Text.ElideRight
                    }
                  }

                  // Says exactly what is missing and how to grant it, rather
                  // than leaving an empty row that reads as a broken panel.
                  Text {
                    width: parent.width
                    visible: root.showSmartHealth && root.smartList.length === 0
                             && root.smartAvailable
                    text: "drive health: reading…"
                    color: root.dimmer
                    font.family: root.fontFamily
                    font.pixelSize: root.fsCaption
                  }

                  GrantRow {
                    width: parent.width
                    visible: root.showSmartHealth && !root.smartAvailable
                    explain: "Drive health (temperature, wear, error count) needs root."
                    busy: root.grantBusy === "smartctl"
                    onTriggered: root.grantSmart()
                  }

                  PanelSeparator { width: parent.width; foreground: root.foreground }

                  SectionHeader {
                    width: parent.width
                    title: "NETWORK"
                    Component.onCompleted: root.registerAnchor("network", this)
                    value: root.primaryIface
                  }

                  Text {
                    width: parent.width
                    text: {
                      var r = root.netRates[root.primaryIface]
                      if (!r) return "↓ --      ↑ --"
                      return "↓ " + Model.formatRate(r.rxRate)
                           + "      ↑ " + Model.formatRate(r.txRate)
                    }
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: root.fsBody
                  }

                  Repeater {
                    model: root.bandwhichRows
                    delegate: Item {
                      required property var modelData
                      width: rightCol.width
                      height: Style.space(15)

                      Text {
                        id: bwRates
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        text: "↓ " + Model.formatRate(modelData.rxRate)
                              + "   ↑ " + Model.formatRate(modelData.txRate)
                        color: root.dimmer
                        font.family: root.fontFamily
                        font.pixelSize: root.fsSmall
                      }
                      Text {
                        anchors.left: parent.left
                        anchors.right: bwRates.left
                        anchors.rightMargin: Style.space(8)
                        anchors.verticalCenter: parent.verticalCenter
                        // bandwhich's own label for traffic it could not map to
                        // a process: without root it cannot inspect another
                        // user's sockets. Named plainly rather than left raw.
                        text: Model.isUnattributed(modelData.process)
                              ? "unattributed" : modelData.process
                        color: root.dimmer
                        opacity: Model.isUnattributed(modelData.process) ? 0.7 : 1.0
                        font.family: root.fontFamily
                        font.pixelSize: root.fsSmall
                        elide: Text.ElideRight
                      }
                    }
                  }

                  GrantRow {
                    width: parent.width
                    visible: root.showBandwhich && !root.bandwhichAvailable
                    explain: "Per-process network needs packet-capture permission."
                    busy: root.grantBusy === "bandwhich"
                    onTriggered: root.grantBandwhich()
                  }
                }
              }

              // ── processes, full width ──
              PanelSeparator { width: parent.width; foreground: root.foreground }

              Item {
                width: parent.width
                implicitHeight: Math.max(procHdr.implicitHeight, sortBtn.height)

                PanelSectionHeader {
                  id: procHdr
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  text: (root.processPaused ? "PROCESSES — PAUSED" : "PROCESSES")
                        + (root.processFilter !== ""
                           ? " (" + root.processView.length
                             + (root.processView.length === 1 ? " MATCH)" : " MATCHES)")
                           : "")
                  Component.onCompleted: root.registerAnchor("processes", this)
                  foreground: root.accent
                  fontFamily: root.fontFamily
                  fontSize: root.fsBody
                }

                PanelActionButton {
                  id: pauseBtn
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: root.processPaused ? "󰐊" : "󰏤"
                  tooltipText: root.processPaused
                               ? "Paused — click or press p to resume"
                               : "Pause the list so rows stop moving (p)"
                  foreground: root.processPaused ? root.accent : root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.togglePause()
                }

                PanelActionButton {
                  id: sortBtn
                  anchors.right: pauseBtn.left
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: root.processSortBy === "cpu" ? "󰓅" : "󰍛"
                  tooltipText: "Sorted by " + (root.processSortBy === "cpu" ? "CPU" : "memory")
                               + " — click or press s to switch"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.processSortBy = root.processSortBy === "cpu" ? "mem" : "cpu"
                }

                // Idle-state flags in accent the same way pauseBtn does, so a
                // filter left applied after Enter stays visible even once the
                // field itself has closed.
                PanelActionButton {
                  id: searchBtn
                  anchors.right: sortBtn.left
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: "󰍉"
                  tooltipText: root.processFilter !== ""
                               ? "Filtering “" + root.processFilter + "” — click to edit (/)"
                               : "Search processes by name or pid (/)"
                  foreground: root.processFilter !== "" ? root.accent : root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.startProcessSearch()
                }
              }

              // Full-width search strip, shown only while editing — narrow
              // window widths have no room to share this row with the title
              // and buttons above, so it gets one of its own instead.
              Item {
                id: procSearchRow
                width: parent.width
                implicitHeight: procSearchField.implicitHeight
                visible: root.searchingProcesses

                TextField {
                  id: procSearchField
                  anchors.left: parent.left
                  anchors.right: clearSearchBtn.left
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  placeholderText: "Search processes by name or pid…"
                  foreground: root.foreground
                  text: root.processFilter
                  onTextChanged: root.processFilter = text

                  Keys.onPressed: function(event) {
                    if (event.key === Qt.Key_Escape) {
                      root.clearProcessSearch()
                      event.accepted = true
                    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                      root.commitProcessSearch()
                      event.accepted = true
                    }
                  }
                }

                PanelActionButton {
                  id: clearSearchBtn
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: "󰜺"
                  tooltipText: "Clear search (esc)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.clearProcessSearch()
                }
              }

              // Column header. Mirrors ProcessRow's anchor chain exactly —
              // same constants, same gaps, same visibility rules — so header
              // and rows stay aligned at every width.
              Item {
                id: procHeaderRow
                width: parent.width
                height: Style.space(16)

                Text {
                  id: hMem
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(4) + sortBtn.width + root.colGap
                  anchors.verticalCenter: parent.verticalCenter
                  width: root.colMem
                  horizontalAlignment: Text.AlignRight
                  text: "MEM"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  id: hTime
                  anchors.right: hMem.left
                  anchors.rightMargin: root.colGap
                  anchors.verticalCenter: parent.verticalCenter
                  visible: root.showProcTime
                  width: visible ? root.colTime : 0
                  horizontalAlignment: Text.AlignRight
                  text: "TIME"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  id: hThreads
                  anchors.right: hTime.left
                  anchors.rightMargin: hTime.visible ? root.colGap : 0
                  anchors.verticalCenter: parent.verticalCenter
                  visible: root.showProcThreads
                  width: visible ? root.colThreads : 0
                  horizontalAlignment: Text.AlignRight
                  text: "THR"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  id: hCpu
                  anchors.right: hThreads.left
                  anchors.rightMargin: hThreads.visible ? root.colGap : 0
                  anchors.verticalCenter: parent.verticalCenter
                  width: root.colCpu
                  horizontalAlignment: Text.AlignRight
                  text: "CPU"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  id: hState
                  anchors.right: hCpu.left
                  anchors.rightMargin: visible ? root.colGap : 0
                  anchors.verticalCenter: parent.verticalCenter
                  visible: root.showProcState
                  width: visible ? root.colState : 0
                  text: "STATE"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  id: hUser
                  anchors.right: hState.left
                  anchors.rightMargin: visible ? root.colGap : 0
                  anchors.verticalCenter: parent.verticalCenter
                  visible: root.showProcUser
                  width: visible ? root.colUser : 0
                  text: "USER"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  id: hPid
                  anchors.right: hUser.left
                  anchors.rightMargin: visible ? root.colGap : 0
                  anchors.verticalCenter: parent.verticalCenter
                  visible: root.showProcPid
                  width: visible ? root.colPid : 0
                  horizontalAlignment: Text.AlignRight
                  text: "PID"; color: root.dimmer
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
                Text {
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(6)
                  anchors.right: hPid.left
                  anchors.rightMargin: root.colGap
                  anchors.verticalCenter: parent.verticalCenter
                  text: "COMMAND"; color: root.dimmer
                  elide: Text.ElideRight
                  font.family: root.fontFamily; font.pixelSize: root.fsCaption
                }
              }

              Repeater {
                model: root.processView
                delegate: ProcessRow {
                  required property var modelData
                  required property int index
                  width: dash.width
                  proc: modelData
                  rowIndex: index
                }
              }

            }
          }
        }

        // Pinned to the window, outside the scroll view, so the shortcuts stay
        // visible wherever the content is scrolled to.
        Rectangle {
          id: hintBar
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: hintText.implicitHeight + Style.space(16)
          color: root.background

          // A hairline instead of a hard edge — the content scrolls up behind
          // this, and without a divider the last row looks truncated.
          Rectangle {
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
          }

          Text {
            id: hintText
            anchors.centerIn: parent
            width: parent.width - Style.space(32)
            horizontalAlignment: Text.AlignHCenter
            text: "j/k move    h/l section    1-9 jump    / search    enter detail    "
                  + "x kill    s sort    p pause    r refresh    PgUp/PgDn scroll    esc close"
            color: root.dimmer
            font.family: root.fontFamily
            font.pixelSize: root.fsCaption
            elide: Text.ElideRight
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════ components

  component ProcessRow: CursorSurface {
    id: pr
    property var proc: null
    property int rowIndex: 0
    implicitHeight: Style.space(20)
    foreground: root.foreground
    hasCursor: root.cursorActive && root.focusSection === "processes"
               && root.selectedIndex === pr.rowIndex

    HoverHandler {
      onHoveredChanged: if (hovered) {
        root.cursorActive = true
        root.focusSection = "processes"
        root.selectedIndex = pr.rowIndex
      }
    }

    MouseArea {
      anchors.fill: parent
      anchors.rightMargin: prKill.width + Style.space(10)
      cursorShape: Qt.PointingHandCursor
      onClicked: root.selectProcess(pr.proc)
    }

    // Columns anchor right-to-left from the kill button, each a fixed
    // monospace width, and COMMAND takes whatever is left. That keeps the
    // table aligned at any window width and lets columns drop out cleanly:
    // a hidden column collapses to zero width, so the chain closes up rather
    // than leaving a gap. Percentage positions collided when narrow.
    PanelActionButton {
      id: prKill
      anchors.right: parent.right
      anchors.rightMargin: Style.space(4)
      anchors.verticalCenter: parent.verticalCenter
      iconText: "󰅚"
      foreground: root.foreground
      fontFamily: root.fontFamily
      hoverColor: root.urgent
      // Disabled rather than left to fail: kill returns EPERM on another
      // user's process and the row merely not vanishing reads as a bug.
      enabled: pr.proc ? root.ownsProcess(pr.proc) : false
      tooltipText: pr.proc && root.ownsProcess(pr.proc)
                   ? "Terminate (SIGTERM)"
                   : "Owned by " + (pr.proc ? pr.proc.user : "") + " — needs privileges"
      onClicked: root.killProcess(pr.proc.pid, "TERM")
    }

    Text {
      id: prMem
      anchors.right: prKill.left
      anchors.rightMargin: root.colGap
      anchors.verticalCenter: parent.verticalCenter
      width: root.colMem
      horizontalAlignment: Text.AlignRight
      text: pr.proc ? Model.formatBytes(pr.proc.rss) : ""
      color: root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
    }
    // How long it has been running. Always available (from the same procfs
    // read), needs no privilege, and answers a question the other columns
    // cannot: whether this just started or has been up for days.
    Text {
      id: prTime
      anchors.right: prMem.left
      anchors.rightMargin: root.colGap
      anchors.verticalCenter: parent.verticalCenter
      visible: root.showProcTime
      width: visible ? root.colTime : 0
      horizontalAlignment: Text.AlignRight
      text: pr.proc && pr.proc.elapsed !== undefined
            ? Model.formatElapsed(pr.proc.elapsed) : ""
      color: root.dimmer
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
    }
    Text {
      id: prThreads
      anchors.right: prTime.left
      anchors.rightMargin: prTime.visible ? root.colGap : 0
      anchors.verticalCenter: parent.verticalCenter
      visible: root.showProcThreads
      width: visible ? root.colThreads : 0
      horizontalAlignment: Text.AlignRight
      text: pr.proc && pr.proc.threads ? String(pr.proc.threads) : ""
      color: root.dimmer
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
    }
    Text {
      id: prCpu
      anchors.right: prThreads.left
      anchors.rightMargin: prThreads.visible ? root.colGap : 0
      anchors.verticalCenter: parent.verticalCenter
      width: root.colCpu
      horizontalAlignment: Text.AlignRight
      text: pr.proc
            ? (pr.proc.cpu !== undefined ? pr.proc.cpu.toFixed(1) + "%" : "new")
            : ""
      color: pr.proc && pr.proc.cpu !== undefined && pr.proc.cpu >= 25 ? root.urgent : root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
    }
    Text {
      id: prState
      anchors.right: prCpu.left
      anchors.rightMargin: visible ? root.colGap : 0
      anchors.verticalCenter: parent.verticalCenter
      visible: root.showProcState
      width: visible ? root.colState : 0
      text: pr.proc ? Model.formatState(pr.proc.stat).split(" (")[0] : ""
      color: root.dimmer
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
      elide: Text.ElideRight
    }
    Text {
      id: prUser
      anchors.right: prState.left
      anchors.rightMargin: visible ? root.colGap : 0
      anchors.verticalCenter: parent.verticalCenter
      visible: root.showProcUser
      width: visible ? root.colUser : 0
      text: pr.proc ? pr.proc.user : ""
      color: pr.proc && root.ownsProcess(pr.proc) ? root.dim : root.dimmer
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
      elide: Text.ElideRight
    }
    Text {
      id: prPid
      anchors.right: prUser.left
      anchors.rightMargin: visible ? root.colGap : 0
      anchors.verticalCenter: parent.verticalCenter
      visible: root.showProcPid
      width: visible ? root.colPid : 0
      horizontalAlignment: Text.AlignRight
      text: pr.proc ? String(pr.proc.pid) : ""
      color: root.dim
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
    }
    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(6)
      anchors.right: prPid.left
      anchors.rightMargin: root.colGap
      anchors.verticalCenter: parent.verticalCenter
      text: pr.proc ? pr.proc.command : ""
      color: root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fsSmall
      elide: Text.ElideRight
    }
  }

  component DiskRow: CursorSurface {
    id: dr
    property var disk: null
    property int rowIndex: 0
    implicitHeight: Math.max(diskRing.height, drCol.implicitHeight) + Style.space(6)
    foreground: root.foreground
    hasCursor: root.cursorActive && root.focusSection === "disk"
               && root.selectedIndex === dr.rowIndex

    HoverHandler {
      onHoveredChanged: if (hovered) {
        root.cursorActive = true
        root.focusSection = "disk"
        root.selectedIndex = dr.rowIndex
      }
    }

    DiskRing {
      id: diskRing
      anchors.left: parent.left
      anchors.leftMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(38)
      height: Style.space(38)
      percent: dr.disk ? dr.disk.percent : 0
      warn: dr.disk ? dr.disk.percent >= 90 : false
    }

    Column {
      id: drCol
      anchors.verticalCenter: parent.verticalCenter
      anchors.left: diskRing.right
      anchors.leftMargin: Style.space(10)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(3)

      Item {
        width: parent.width
        height: drMount.implicitHeight

        Text {
          id: drMount
          anchors.left: parent.left
          text: dr.disk
                ? dr.disk.mount + (dr.disk.mounts.length > 1
                    ? "  (+" + (dr.disk.mounts.length - 1) + ")" : "") : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.fsSmall
        }
        Text {
          anchors.right: parent.right
          text: dr.disk ? dr.disk.used + " / " + dr.disk.size : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: root.fsSmall
        }
      }
    }
  }

  // Circular disk-usage gauge: a stroked ring rather than disk-lens's
  // filled pie slice (PieGauge.qml, checked directly) — at this size a ring
  // reads more clearly as "percentage used" and leaves the center free for
  // the number itself. Eases toward each new reading via the same
  // Behavior/NumberAnimation shape MeterBar already uses elsewhere in this
  // file, rather than a third animation approach.
  component DiskRing: Item {
    id: dring
    property real percent: 0
    property bool warn: false
    property real animPercent: percent
    Behavior on animPercent { NumberAnimation { duration: 450; easing.type: Easing.OutQuad } }

    onAnimPercentChanged: ringCanvas.requestPaint()
    onWarnChanged: ringCanvas.requestPaint()
    onWidthChanged: ringCanvas.requestPaint()
    onHeightChanged: ringCanvas.requestPaint()

    Canvas {
      id: ringCanvas
      anchors.fill: parent
      Component.onCompleted: requestPaint()

      onPaint: {
        var ctx = getContext("2d")
        var size = Math.min(width, height)
        var lineWidth = Math.max(2, size * 0.14)
        var radius = Math.max(0, size / 2 - lineWidth / 2)
        var cx = width / 2
        var cy = height / 2
        var start = -Math.PI / 2
        var frac = Math.max(0, Math.min(100, dring.animPercent)) / 100

        ctx.clearRect(0, 0, width, height)
        ctx.lineCap = "round"

        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2, false)
        ctx.lineWidth = lineWidth
        ctx.strokeStyle = Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
        ctx.stroke()

        if (frac > 0) {
          ctx.beginPath()
          ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * frac, false)
          ctx.lineWidth = lineWidth
          ctx.strokeStyle = String(dring.warn ? root.urgent : root.accent)
          ctx.stroke()
        }
      }
    }

    Text {
      anchors.centerIn: parent
      text: Math.round(dring.animPercent) + "%"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fsCaption
      font.bold: true
    }
  }

  // A capability the panel cannot use yet, paired with the button that grants
  // it. States what is missing in plain terms rather than naming the syscall,
  // and authenticates through polkit when pressed.
  component GrantRow: Column {
    id: gr
    property string explain: ""
    property bool busy: false
    signal triggered()
    spacing: Style.space(8)

    Text {
      width: gr.width
      text: gr.explain
      color: root.dimmer
      font.family: root.fontFamily
      font.pixelSize: root.fsCaption
      wrapMode: Text.WordWrap
    }

    Row {
      spacing: Style.space(12)

      Button {
        text: gr.busy ? "Authorising…" : "Enable"
        enabled: !gr.busy
        onClicked: gr.triggered()
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.grantError !== ""
        width: Math.max(0, gr.width - Style.space(140))
        text: root.grantError
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: root.fsCaption
        elide: Text.ElideRight
      }
    }
  }

  // One figure in the top summary strip: small dim label over a large value.
  component Stat: Column {
    property string label: ""
    property string value: ""
    property bool warn: false
    spacing: 0

    // The label stays small on purpose: the size gap between a quiet caption
    // and a large figure is what makes the value read as the headline.
    Text {
      text: parent.label
      color: root.dimmer
      font.family: root.fontFamily
      font.pixelSize: root.fsCaption
    }
    Text {
      text: parent.value
      color: parent.warn ? root.urgent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fsStat
      font.bold: true
    }
  }

  component CoreCell: Item {
    id: cell
    property int coreIndex: 0
    readonly property bool present: coreIndex < root.cpuCorePercents.length
    readonly property int pct: present ? root.cpuCorePercents[coreIndex] : 0
    height: Style.space(14)

    Text {
      id: coreLabel
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      visible: cell.present
      text: "c" + cell.coreIndex
      color: root.dimmer
      font.family: root.fontFamily
      font.pixelSize: root.fsSmall
    }
    MeterBar {
      anchors.left: coreLabel.right
      anchors.leftMargin: Style.space(6)
      anchors.right: corePct.left
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      visible: cell.present
      value: cell.pct / 100
      warn: cell.pct >= 85
      thin: true
    }
    Text {
      id: corePct
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      visible: cell.present
      text: cell.pct + "%"
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: root.fsSmall
    }
  }

  component SectionHeader: Item {
    id: sh
    property string title: ""
    property string value: ""
    implicitHeight: Math.max(shHdr.implicitHeight, shVal.implicitHeight)

    // Section titles take the theme accent and a larger size. Previously they
    // were the same dim grey at the same size as the values beside them, so
    // headings and data read as one undifferentiated wall.
    PanelSectionHeader {
      id: shHdr
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      text: sh.title
      foreground: root.accent
      fontFamily: root.fontFamily
      fontSize: root.fsBody
    }
    // Bounded by the title rather than free-floating: at minimum width the
    // value ("13%   load 2.91 2.48 1.85") would otherwise run left underneath
    // the heading instead of eliding.
    Text {
      id: shVal
      anchors.left: shHdr.right
      anchors.leftMargin: Style.space(12)
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      horizontalAlignment: Text.AlignRight
      text: sh.value
      color: root.dim
      elide: Text.ElideRight
      font.family: root.fontFamily
      font.pixelSize: root.fsSmall
      font.bold: true
    }
  }

  // Horizontal fill meter. `warn` flips the fill to the theme's urgent
  // colour so a saturated resource reads without parsing the number.
  component MeterBar: Item {
    id: mb
    property real value: 0
    property bool warn: false
    property bool thin: false
    property string trailing: ""
    implicitHeight: thin ? Style.space(5) : Style.space(9)
    height: implicitHeight

    Rectangle {
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      anchors.right: mbTrail.visible ? mbTrail.left : parent.right
      anchors.rightMargin: mbTrail.visible ? Style.space(8) : 0
      height: parent.height
      radius: height / 2
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)

      Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: parent.width * Math.max(0, Math.min(1, mb.value))
        radius: parent.radius
        color: mb.warn ? root.urgent : root.accent
        Behavior on width { NumberAnimation { duration: 180; easing.type: Easing.OutQuad } }
      }
    }

    Text {
      id: mbTrail
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      visible: mb.trailing !== ""
      text: mb.trailing
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fsSmall
    }
  }

  component LabelledMeter: Item {
    id: lm
    property string label: ""
    property real value: 0
    property string detail: ""
    property bool warn: false
    implicitHeight: Style.space(17)

    Text {
      id: lmLabel
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      text: lm.label
      color: root.dimmer
      font.family: root.fontFamily
      font.pixelSize: root.fsSmall
    }
    MeterBar {
      anchors.left: lmLabel.right
      anchors.leftMargin: Style.space(8)
      anchors.right: lmDetail.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      value: lm.value
      warn: lm.warn
      thin: true
    }
    Text {
      id: lmDetail
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: lm.detail
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: root.fsSmall
    }
  }

  component DetailLabel: Text {
    color: root.foreground
    opacity: 0.6
    font.family: root.fontFamily
    font.pixelSize: root.fsBody
  }

  component DetailValue: Text {
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: root.fsBody
  }
}
