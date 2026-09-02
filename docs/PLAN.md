# System Monitoring Panel — Omarchy Plugin

## Project: `jharrison.sysmonitor`

A comprehensive system monitoring panel for Omarchy that aggregates CPU, memory, GPU, disk, network, process, and sensor data into a single keyboard-and-mouse-navigable popup panel attached to the status bar.

**Status:** Planning  
**Created:** 2026-08-30  
**Target:** Omarchy plugin (`bar-widget` kind)  
**Last reviewed:** 2026-08-30 (verification pass against the installed Omarchy shell + live system)

> **Superseded in part, 2026-09-02.** Everything below describing privileged features is now
> history, not current behaviour. The plugin no longer asks for any privilege at all: the
> bandwhich per-process network rows, the `smartctl` drive-health rows, and the whole
> privilege grant-and-revoke subsystem built around them were removed. Drive
> temperature survives, read unprivileged from `hwmon` and shown under DISK; per-process network
> bandwidth is gone, having no unprivileged equivalent on Linux. This document is kept as the
> design record, including the five rounds of adversarial review that subsystem went through and
> the defects each one found, since that is the reasoning that led to removing it. For what the
> plugin actually does now, read `README.md`.

> **Review note.** This revision corrects errors found by checking every claim against the shell source in `/usr/share/omarchy/shell/` and by running the commands on this machine. Five items would have broken on contact: an inverted `manageIpc`, a `Bytes` component that does not exist, an invalid `bandwhich` invocation incompatible with the collector pattern, `smartctl` requiring root, and a false "no ScrollView" rule masking a panel that overflows its own height cap. Sections 4.4b, 4.13, 4.14 and the Overflow Strategy in Section 11 are new. Verified-correct API usage is listed at the end of Section 15.

---

## AS BUILT — v2.0 (supersedes the bar-widget design below)

**Built and installed 2026-08-30.** The plan below was written for a `bar-widget` popup anchored to the status bar. That surface proved too cramped for this much data, so the implementation is a **`panel` kind** instead: a large `FloatingWindow` in the spirit of btop's `SUPER + CTRL + T` window.

| | Planned (below) | As built |
|---|---|---|
| Plugin kind | `bar-widget` | **`panel`** |
| Surface | `KeyboardPanel` popup, ~420px wide | **`FloatingWindow` 1180×900**, floats + centers |
| Entry point | bar icon click | **`SUPER + CTRL + SHIFT + T`** (btop's `SUPER+CTRL+T` untouched) |
| Registered in | `shell.json` `bar.layout.right[]` | `shell.json` `plugins[]` |
| Theme source | `root.bar.foreground` | `Color` singleton — a panel kind gets no `bar` injected |
| Overflow | capped per-section ListViews | one `ScrollView`; sections laid out in two columns |
| Host injects | `bar`, `settings` | **only `shell` and `manifest`** — settings read from `manifest.panel.defaults` |

`Model.js` and every collector carried over **unchanged**, and its test suite still passes (102 checks, 2 legitimately skipped).

### Files

| Path | Role |
|---|---|
| `plugin/Model.js` | All parsing + the collector shell scripts. Pure, node-testable. |
| `plugin/Panel.qml` | Window, layout, collectors, keyboard/mouse wiring. |
| `plugin/manifest.json` | `kinds: ["panel"]`; `panel.defaults` is the config surface. |
| `plugin/test-model.js` | `node test-model.js` — runs parsers against this machine's live `/proc`, sysfs, `ps`, `df`. |

Installed to `~/.config/omarchy/plugins/jharrison.sysmonitor/` by copying those three files (the manifest validator rejects symlinks).

### Things that cost time — worth knowing before editing

- **A bar-widget root with no `implicitWidth`/`implicitHeight` renders at 0×0 with no error logged.** `Bar.qml:1487` sizes each widget via `width: item ? item.implicitWidth : 0`. Every first-party bar widget sets it (`network/Panel.qml:804`). The plan below omitted it. Moot for the panel kind, but the same trap applies to any future bar widget.
- **A newly registered bar widget is not picked up by hot reload** — the file watcher reloads an *existing* plugin's QML fine, but registering a new widget id needs `omarchy-restart-shell`.
- **`omarchy-refresh-shell` is not a reload — it resets `shell.json` to Omarchy defaults.** It wiped the bar layout mid-build; recovered from the `shell.json.bak.<epoch>` it writes. Use `omarchy-restart-shell` to reload.
- **Restarting the shell and then letting the session lock crashed Quickshell once** (`FATAL: Tried to show lockscreen surfaces without active lock`). The fresh instance holds no lock, and the lock plugin's timer hits a fatal path. It auto-restarted and re-acquired a secure lock. Avoid restarting the shell if the session is about to idle-lock.
- **`ps` truncates the user column to 8 chars with a `+`** (`jharris+`), so an ownership check against `$USER` fails on *every* one of your own processes. Collectors use `user:20`; `Model.userMatches()` is the fallback.
- **A collector script ending in `[ x ] && echo` inherits the failed test's exit status**, which reads as a broken collector. Every script in `Model.js` ends in `if ... fi`.
- **`qmllint` needs a `qs/` import root** to resolve `qs.Ui`/`qs.Commons`: symlink `Ui` and `Commons` under a `qs/` dir and pass `-I <that dir>`. Warning counts then land close to the first-party network panel's, which is the useful baseline.
- **`omarchy plugin validate` is a weak gate** — it accepted `"kinds":["not-a-real-kind"]` and a bogus schema type at exit 0. Treat it as a JSON/path check only.

### Responsive layout — verified at four widths

The window is resizable and tileable, so nothing assumes the 1180px it opens at. Every layout decision keys off `contentWidth` (the real usable width inside the scroll view), and the breakpoints sit where a layout actually stops being readable:

| Window width | Cores | Dashboard | Process columns | Header |
|---|---|---|---|---|
| 1180 | 4 across | two columns | COMMAND PID USER STATE CPU MEM | model + uptime |
| 900 | 2 across | two columns | all six | model + uptime |
| 660 | 1 | stacked | drops USER | uptime only |
| 450 | 1 | stacked | drops USER, STATE | uptime only |

Process-table columns anchor **right-to-left** from the kill button at fixed monospace widths, with COMMAND absorbing the slack — a hidden column collapses to zero width so the chain closes up. The header mirrors the same chain, so header and rows stay aligned at every width. The earlier percentage positions (`x: parent.width * 0.58`) collided when narrow.

`minimumSize` is `360×280`, low on purpose so the window can be tiled into a quarter-screen column rather than refusing to shrink.

Confirmed by resizing the live window and screenshotting each width. Three real defects were found and fixed this way:

- **Right-edge clipping.** A `ScrollView`'s vertical scrollbar is an overlay and does **not** reduce `availableWidth`, so right-aligned values ("4 filesystems", "enp7s0", the load figures) rendered underneath it. Fixed with a constant `rightPadding` gutter — keying it off the bar's visibility would loop content width → content height → bar visible → content width.
- **Pressure line and section-header values overflowed** at minimum width. Both now elide, and the running count drops below 520px.
- **The window was translucent.** Omarchy tags every window `+default-opacity` and applies `0.985 0.96` (`default/hypr/windows.lua:6,25`). On a dense grid of small numbers that cost real legibility, so the panel opts out via `-default-opacity` + `opacity = "1 1"`, the same pattern retroarch and davinci-resolve use.

### v2.1 — round of changes from live use

| Ask | How it landed |
|---|---|
| GPU metric with CPU-like depth | `core` / `mem` / `vram` / `power` bars, plus sclk+mclk clocks, fan RPM, and all three die temps (edge / junction / mem). AMD exposes far more than `gpu_busy_percent`. |
| Sensors named for what they measure | `friendlySensorName()` maps driver names to sensors: coretemp→CPU, amdgpu→GPU, acpitz→Motherboard, iwlwifi→Wi-Fi, ucsi_*→USB-C. Meaningless labels (`temp1_input`, NVMe `Composite`) are dropped; `Package id 0`→`package`. Unknown drivers are capitalised, never invented. |
| Hotkeys pinned | The hint bar moved out of the `ScrollView` and anchors to the window bottom; the scroll view now ends at `hintBar.top`. |
| Disk health needing root | *(Describes the removed drive-health feature; see the banner at the top.)* The probe tried an unprivileged read first, fell back to an elevated one, and reported which had worked, enumerating every NVMe drive rather than a hard-coded first one. |
| CPU model off the top | Moved into the CPU section beside the thread count. The top strip is now live stats: CPU / MEM / GPU / hottest TEMP / NET / UP. |
| btop-style process data | The detail view gained executable path, working directory, thread and open-file counts, start time, and the full ancestry chain walking up to pid 1. |
| Larger text | Every size goes through `root.fs(token)` with a `fontScale` (default `1.25`) in `manifest.panel.defaults` — one number rescales the panel. |

**The hottest-temperature stat is labelled TEMP, not by device.** Labelling it with the device name renders a second "CPU" next to the usage stat and reads as a duplicate; the device belongs in the value ("CPU 58°C").

### v2.2 — the CPU% correction, and presentation

**The process CPU column was measuring the wrong thing.** `ps %cpu` is *cputime ÷ realtime averaged over the process's entire lifetime*, scaled to one core. A scanner holding one core of sixteen since boot reported "98.1%", which reads as nearly the whole machine while the headline said 12%. Both figures were correct and they measured different things.

CPU% is now computed the way btop does it — `utime+stime` deltas between polls, read straight from `/proc/[0-9]*/stat` — and the table shows two columns:

- **CPU** — share of the whole machine, so the column sums toward the headline figure instead of contradicting it.
- **1-CORE** — the same measurement scaled to one core, which is what top/htop/btop print and what reveals a process pinning a single thread.

That same scanner now reads `CPU 6.1%` and `1-CORE 98%`. The detail view spells it out: "6.1% of 16 threads (98% of one core)".

Sampling all ~500 processes costs **7 ms** (`awk` over the procfs glob), so it runs every poll. Field 2 of `/proc/PID/stat` is the command in parens and can itself contain spaces or parens, so fields are indexed after the **last** `") "` rather than by naive whitespace splitting.

Instantaneous CPU has one side effect worth knowing: most processes sit at exactly 0.0%, so a plain CPU sort leaves the tail as an arbitrary run of idle kernel threads. Ties break on memory to keep those rows informative.

**Presentation changes in the same pass:**

- The header bar (title + summary stats) is **pinned to the top**, mirroring the hint bar at the bottom. The scroll view sits between the two.
- Section titles take the **theme accent colour** at `fsBody`. Previously they were the same dim grey at the same size as the values beside them, so headings and data read as one wall.
- Summary-strip spacing went to `Style.space(30)`, and section/column gaps opened up — six unrelated figures packed tight read as one run-on string.
- Scrolling drives `scrollArea.contentItem.contentY` directly. Nudging `ScrollBar.position` was unreliable and left End/PageDown doing nothing. Cursor movement now calls `followCursor()`, which scrolls the focused section into view via registered anchors.

### Permissions were buttons, not instructions (removed 2026-09-02)

**This describes a subsystem that no longer exists.** Two optional sections
once asked for a persistent privilege behind an in-panel consent button, one
for per-process network attribution and one for drive health. Both features
and the whole grant-and-revoke machinery around them were deleted; see the
banner at the top of this document for what replaced them and why. The
operational detail that used to sit here has gone with the code, since
documenting how to use a removed feature is worse than not documenting it.

What is worth keeping from the episode is the reasoning, not the commands.
The design put a consent button in the panel rather than telling the reader
to go run something themselves, raised the password prompt through the
desktop's own authentication agent so the panel never handled a credential,
and preferred a single narrow grant over adding the account to a group that
would have opened far more than the one thing needed. That instinct was
right. What it could not fix is that the feature still needed the privilege
at all, and five rounds of adversarial review on the machinery kept finding
worse defects in it, which is what eventually settled the question.

### v2.3 — round three

**The bandwhich names were my bug, not the tool's.** The real raw format is:

```
process: <1788094173> "claude" up/down Bps: 0/628 connections: 3
```

The angle-bracketed number is a **per-refresh timestamp, not a pid** — my regex was reading it as the process name, which is why the panel showed bare numbers. The name is the quoted field after it.

`<UNKNOWN>` rows, by contrast, are genuinely bandwhich's: without root it cannot map another user's socket back to a process. Those are real traffic, so they are kept, relabelled **unattributed**, dimmed, and sorted last regardless of volume — the least actionable row should not displace a named one. Running bandwhich as root resolves nearly all of them, which is the trade-off.

Two related fixes: bandwhich emits several rows per process, and my code was *overwriting* rather than summing them, so a process's traffic was under-reported. Rows are now summed per name and keyed on the refresh timestamp, so a process that stops transmitting drops out instead of sitting at its last rate forever.

**The 1-CORE column is gone.** In its place, two columns that come free from the procfs read already being done (`num_threads` is field 20, `starttime` field 22):

- **TIME** — how long the process has been running. Needs no privilege and answers what the other columns cannot: whether this just started or has been up for days.
- **THR** — thread count, which reveals thread explosions.

Per-process disk I/O was considered and rejected: `/proc/PID/io` is unreadable for other users' processes, and `read_bytes`/`write_bytes` count only block I/O, so they read 0 for anything served from page cache.

**The SENSORS section was removed** — it had become a second copy of readings already shown elsewhere. GPU temperatures live in the GPU section, drive temperatures in the health rows, and the CPU package temperature moved onto the CPU section header. Sensors are still *collected*, for that CPU reading and the header's hottest-temperature stat.

**The detail view was showing `ps`'s number.** It re-queried with `ps -o %cpu`, which is the lifetime average — the very figure that caused the original confusion. It now carries the measured values in from the list row and reads "12.6% of 16 threads (201% of one core)". Over 100% of one core is correct and expected for a multi-threaded process.

**Running time ticks live** — a 1-second timer advances it between the slower data polls, since a stopwatch that only moves every two seconds reads as broken.

**The process list pauses** — `p`, or the button beside the sort toggle. The poll keeps running underneath so CPU deltas stay continuous; only the displayed copy is frozen, and the header reads "PROCESSES — PAUSED".

**Top-strip figures use `fsStat`** (`Style.font.title` scaled), between body and the panel title — at body size they read as just more of the same text despite being the focal point. Labels stay at caption size on purpose: the size gap is what makes the value read as the headline.

**Top-strip spacing scales with width** — `Style.space(50)` above 1080px, 36 above 900, 24 below, with NET and UPTIME dropping out at 900 and 660. The larger figures need the strip to give up slightly earlier than before. A fixed generous gap would collide with the title as the window narrows; the stats drop out at their own breakpoints before that happens.

**A `ps` parsing bug surfaced while testing this.** The detail query asked for both `comm` and `args`; both can contain spaces, which makes positional parsing ambiguous. A process named `Fell & Sell.exe` split into a comm of "Fell" and an args string starting at "&". The detail query no longer requests `comm` at all — every field is fixed-width except `args`, which is last — and the short name comes from the list row.

### Testing the layout again after a change

`hyprctl dispatch` uses Lua now, and the dispatchers are namespaced — the old string form fails silently if stderr is discarded:

```bash
ADDR=$(hyprctl clients -j | jq -r '.[]|select(.title=="System Monitor")|.address')
hyprctl dispatch "hl.dsp.window.resize({ x = 660, y = 820, relative = false, window = \"address:$ADDR\" })"
hyprctl dispatch "hl.dsp.focus({ window = \"address:$ADDR\" })"   # then wtype -k End to reach the process table
```

**A QML edit needs `omarchy-restart-shell` to take effect** — the `FloatingWindow` object survives hide/show, so closing and reopening the panel keeps the old one (this is how a stale `minimumSize` of 760 survived an install and briefly looked like the window refusing to resize).

---

## Table of Contents---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Files to Create](#3-files-to-create)
4. [Data Sources](#4-data-sources)
5. [Panel Sections](#5-panel-sections)
6. [Process Interaction](#6-process-interaction)
7. [Mouse Interaction](#7-mouse-interaction)
8. [Keyboard Navigation](#8-keyboard-navigation)
9. [Theming](#9-theming)
10. [Model.js API](#10-modeljs-api)
11. [Panel.qml Structure](#11-panelqml-structure)
12. [Keybinding](#12-keybinding)
13. [Implementation Order](#13-implementation-order)
14. [Testing & Verification](#14-testing--verification)
15. [Reference: Existing Plugins](#15-reference-existing-plugins)

---

## 1. Overview

### Goal

Create an Omarchy `bar-widget` plugin that provides a unified system monitoring dashboard accessible from the status bar. The panel aggregates data from multiple system sources into one accessible view — without requiring the user to open a terminal or TUI.

### Motivation

The user wants deeper system visibility beyond btop (TUI), combining multiple data sources into a single panel. The panel should:

- Show real-time CPU, memory, GPU, disk, network, and temperature data
- List top processes with the ability to kill or inspect them
- Integrate bandwhich for per-process network usage
- Integrate smartctl for NVMe health data
- Support both keyboard and mouse interaction
- Follow all Omarchy theming conventions automatically

### Context: bpftrace vs btop

**btop** is a TUI dashboard showing current resource usage (what is using CPU/memory/disk right now). It is a snapshot view.

**bpftrace** is a programmable kernel tracing tool. It lets you write scripts to trace events at the syscall level (why things happen). It is a debugging/troubleshooting tool, not a dashboard.

| Tool | Purpose | Analogy |
|------|---------|---------|
| btop | Dashboard — shows current state | Car dashboard |
| bpftrace | Diagnostic probe — traces events | OBD-II scanner |
| This panel | At-a-glance monitoring popup | Heads-up display |

bpftrace remains available as a separate CLI tool for deep debugging. This panel focuses on the dashboard use case.

---

## 2. Architecture

### Plugin Type

- **Kind:** `bar-widget` (icon in bar + popup panel)
- **Entry point:** `Panel.qml` extending the `Panel` base class
- **Data parsing:** `Model.js` (pure JavaScript, Node-testable)
- **Language:** QML/JavaScript only (no embedded Python/Lua)
- **Data fetching:** `Quickshell.Io.Process` + `StdioCollector` (subprocess calls)
- **Polling:** `Timer` elements, only active when panel is open

### Data Flow

```
System Sources                 QML Process              UI
─────────────                 ───────────              ──
/proc/stat         ──┐
/proc/meminfo        │   Process { command: [...] }
/sys/class/hwmon/*   ├──► StdioCollector ──► Model.js parse ──► QML properties ──► Text/Rectangle
/sys/block/zram0     │   onStreamFinished        (one-shot commands)
/proc/pressure/*     │
df -h                │
smartctl -j *        │   * requires root — see 4.7
ps -eo ...        ──┘

bandwhich -r -p  ────►   SplitParser ──────► Model.js parse ──► QML properties
                         onRead              (streaming, never exits — see 4.9)
```

### Key Pattern (from existing plugins)

All panels follow this data-fetching pattern:

```qml
Process {
  id: dataProc
  command: ["bash", "-c", "some-command"]
  stdout: StdioCollector {
    waitForEnd: true
    onStreamFinished: root.updateData(text)
  }
}

Timer {
  interval: 2000
  running: root.opened    // ← only poll when panel is open
  repeat: true
  onTriggered: if (!dataProc.running) dataProc.running = true
}
```

### File Structure

```
~/.config/omarchy/plugins/jharrison.sysmonitor/
├── manifest.json     # Plugin metadata, settings schema
├── Panel.qml         # Main panel UI (~1500-2000 lines)
└── Model.js          # Data parsing functions (~300 lines)
```

---

## 3. Files to Create

### manifest.json

```json
{
  "schemaVersion": 1,
  "id": "jharrison.sysmonitor",
  "name": "System Monitor",
  "version": "1.0.0",
  "author": "jharrison",
  "description": "CPU, memory, GPU, disk, network, process, and temperature monitoring panel",
  "kinds": ["bar-widget"],
  "entryPoints": {
    "barWidget": "Panel.qml"
  },
  "barWidget": {
    "displayName": "System Monitor",
    "description": "CPU, memory, GPU, disk, network, processes, and temperatures",
    "category": "Info",
    "allowMultiple": false,
    "defaultSection": "right",
    "defaults": {
      "pollInterval": 2000,
      "showCpuPerCore": true,
      "showSmartHealth": true,
      "showBandwhich": true,
      "processCount": 8,
      "showAllSensors": false
    },
    "schema": [
      {
        "key": "pollInterval",
        "type": "integer",
        "label": "Refresh interval (ms)",
        "min": 1000,
        "max": 10000,
        "step": 500,
        "defaultValue": 2000
      },
      {
        "key": "showCpuPerCore",
        "type": "boolean",
        "label": "Show per-core CPU breakdown",
        "defaultValue": true
      },
      {
        "key": "showSmartHealth",
        "type": "boolean",
        "label": "Show NVMe SMART health data",
        "defaultValue": true
      },
      {
        "key": "showBandwhich",
        "type": "boolean",
        "label": "Show per-process network (bandwhich)",
        "defaultValue": true
      },
      {
        "key": "processCount",
        "type": "integer",
        "label": "Number of processes to show",
        "min": 3,
        "max": 15,
        "defaultValue": 8
      },
      {
        "key": "showAllSensors",
        "type": "boolean",
        "label": "Show all temperature sensors",
        "description": "Off shows one row per device (6). On shows every hwmon reading (18), including all 8 CPU cores.",
        "defaultValue": false
      }
    ]
  }
}
```

### Panel.qml

Main panel UI file. Extends `Panel` base class. See [Section 11](#11-panelqml-structure) for full structure.

### Model.js

Pure JavaScript module with parsing functions. Imported as `"Model.js" as Model`. All functions are stateless and take raw input, returning parsed objects. See [Section 10](#10-modeljs-api) for full API.

---

## 4. Data Sources

### 4.1 CPU Usage

**Source:** `/proc/stat` (two samples, 1 second apart)

**Command:**
```bash
cat /proc/stat | head -17  # "cpu" + "cpu0" through "cpu15"
```

**Format:**
```
cpu  user nice system idle iowait irq softirq steal guest guest_nice
cpu0 416685 926 64492 11940570 4319 10235 15460 0 0
cpu1 434624 920 97818 11848020 3685 58996 7353 0 0
...
```

**Calculation:**
```javascript
// CPU percent = (1 - (idle_delta / total_delta)) * 100
function calcCpuPercent(prev, curr) {
  var prevIdle = prev.idle + prev.iowait
  var currIdle = curr.idle + curr.iowait
  var prevTotal = prev.user + prev.nice + prev.system + prev.idle + prev.iowait + prev.irq + prev.softirq + prev.steal
  var currTotal = curr.user + curr.nice + curr.system + curr.idle + curr.iowait + curr.irq + curr.softirq + curr.steal
  var totalDelta = currTotal - prevTotal
  var idleDelta = currIdle - prevIdle
  if (totalDelta === 0) return 0
  return Math.round((1 - idleDelta / totalDelta) * 100)
}
```

**Note:** CPU usage requires two samples. The panel stores `prevCpuStat` and computes the delta against the previous poll — so the delta window is the **poll interval itself (2s default)**, not a separate 1-second sub-sample. The first poll after open produces no reading (no previous sample); display `--` until the second poll lands.

This supersedes the earlier "two samples, 1 second apart" framing, which conflicted with the 2s interval in Section 5's refresh table. One timer, one read per tick, delta against the prior tick — no staggered second sample and no `sleep` inside the command.

### 4.2 CPU Info

**Source:** `/proc/cpuinfo`, `nproc`

**Commands:**
```bash
nproc                           # → "16"
grep "cpu MHz" /proc/cpuinfo    # → "cpu MHz : 4800.000" (per core)
grep "model name" /proc/cpuinfo # → "model name : 11th Gen Intel(R) Core(TM) i9-11900K"
```

### 4.3 Load Average

**Source:** `/proc/loadavg`

**Format:**
```
3.40 2.51 2.69 2/1835 1272876
```

**Parse:** Split on spaces → `{ load1, load5, load15, running, total, pid }`

### 4.4 Memory

**Source:** `free -b`

**Command:**
```bash
free -b
```

**Format:**
```
               total        used        free      shared  buff/cache   available
Mem:     33442549760 13188538368 10179977216   494673920 12505636864 20254011392
Swap:    66884775936  1888190464 64996585472
```

**Parse:** Extract `Mem:` and `Swap:` lines → `{ memTotal, memUsed, memAvail, swapTotal, swapUsed }`

**Note:** `memAvail` is more accurate than `free` for "available memory" (includes reclaimable cache).

### 4.4b Zram Compression

**Source:** `/sys/block/zram0/mm_stat`

Section 5's layout renders `Zram: 1.4 GB → 347 MB (4.1:1)` and Model.js declares `formatCompressionRatio(diskSize, comprSize)`, but no data source was listed. This fills that gap.

**Command:**
```bash
cat /sys/block/zram0/mm_stat 2>/dev/null
```

**Format** — whitespace-separated, first three fields are what matter:
```
1416839168 306943387 325959680 0 723492864 28344 44240 7041 19437
│          │         └─ mem_used_total (actual RAM consumed)
│          └─ compr_data_size (compressed size)
└─ orig_data_size (uncompressed size)
```

Ratio is `orig_data_size / compr_data_size` — here 1416839168 / 306943387 = **4.6:1**.

**Parse:** `parseZram(raw)` → `{ origSize, comprSize, memUsed, ratio }`. Return `null` if the file is absent (no zram configured) and hide the row.

**Alternative:** `zramctl` gives the same data pre-formatted, but it is an extra subprocess for a value that is one cheap sysfs read. Prefer `mm_stat`.

**Note:** swap on this machine is split across **two** backends — `/dev/zram0` (31.1G, zstd) and `/swap/swapfile` (32.6G). The `free -b` Swap line in 4.4 reports their **combined** total, so the swap bar and the zram ratio describe different things. Label the zram row explicitly so the two are not read as contradictory.

### 4.5 GPU

**Source:** `/sys/class/drm/card2/device/gpu_busy_percent` (AMD GPU), `/sys/class/hwmon/hwmon3/temp1_input` (GPU temp)

**Commands:**
```bash
cat /sys/class/drm/card2/device/gpu_busy_percent  # → "6" (AMD only)
cat /sys/class/hwmon/hwmon3/temp1_input           # → "46000" (÷1000 = 46°C)
```

**Note:** `card2` is the AMD GPU (`amdgpu`, vendor `0x1002`) and is the only card exposing `gpu_busy_percent`. The Intel iGPU is **`card1`** (vendor `0x8086`) — the plan previously said `card0`, which does not exist on this machine:

```
$ for c in /sys/class/drm/card*/device/vendor; do echo "$c = $(cat $c)"; done
/sys/class/drm/card1/device/vendor = 0x8086
/sys/class/drm/card2/device/vendor = 0x1002
```

Both the `card*` and `hwmon*` indices are kernel-enumeration-order dependent and can shift across reboots, so the dynamic vendor probe in Section 11 is the correct approach — do not hard-code either index.

### 4.6 Disk Usage

**Source:** `df -h`

**Command:**
```bash
df -h --output=source,size,used,avail,pcent,target | grep ^/dev
```

**Actual output on this machine (7 rows, not 2):**
```
/dev/mapper/root     930G  126G  804G  14% /
/dev/mapper/root     930G  126G  804G  14% /home
/dev/mapper/root     930G  126G  804G  14% /var/cache/pacman/pkg
/dev/mapper/root     930G  126G  804G  14% /var/log
/dev/nvme0n1p1       2.0G  249M  1.8G  13% /boot
/dev/nvme1n1p1       916G  176G  740G  20% /games
/dev/mapper/storage  932G  6.1M  930G   1% /storage
```

**Deduplication is required.** `/dev/mapper/root` appears **four times** — these are btrfs subvolumes (`/`, `/home`, `/var/cache/pacman/pkg`, `/var/log`) sharing one 930G filesystem. Rendering them as-is shows the same device and the same 126G/930G bar four times, which reads as four separate disks.

`parseDfOutput()` should group by `source` and keep one entry per filesystem, collecting the mount points:

```javascript
// → [{ source, size, used, avail, percent, mounts: ["/", "/home", ...] }]
```

Display the shortest mount point as the primary label (`/` for the root group) and surface the rest in a tooltip or the detail view. That reduces 7 rows to 4 real filesystems: `/` (930G btrfs), `/boot` (2.0G), `/games` (916G), `/storage` (932G).

### 4.7 NVMe SMART Health

**Source:** `smartctl -j -a /dev/nvme0n1`

**Command:**
```bash
smartctl -j -a /dev/nvme0n1 | jq '.nvme_smart_health_information_log'
```

**Key fields:**
```json
{
  "temperature": 42,
  "percentage_used": 3,
  "data_units_read": 12345678,
  "data_units_written": 9876543,
  "power_on_hours": 5432,
  "power_cycles": 123,
  "unsafe_shutdowns": 2,
  "media_errors": 0
}
```

**BLOCKER — `smartctl` requires root and fails as your user.** Verified on this machine:

```
$ smartctl -j -a /dev/nvme0n1
Smartctl open device: /dev/nvme0n1 failed: Permission denied     (exit 2)
$ smartctl -j -a /dev/nvme0n1 | jq '.nvme_smart_health_information_log'
null
```

`smartctl` is installed and on PATH, so a `command -v smartctl` gate **passes while the data never arrives** — the section would render permanently empty. Pick one of three resolutions before implementing:

1. **Drop SMART, keep NVMe temperature (recommended for v1).** NVMe temps are already readable unprivileged from hwmon — `hwmon1` and `hwmon2` are both `nvme` (see 4.11). This loses wear-level / power-on-hours / media-errors but costs no privilege escalation and no new failure mode.
2. **Grant a narrow policy exemption.** A passwordless rule admitting only the one read-only SMART command against the two NVMe devices, invoked so a missing rule failed immediately rather than blocking on a password prompt inside the shell process. *(This is the option that was taken, and it is the one removed on 2026-09-02. Option 1 above is what the plugin does now, which makes this section's own recommendation the one that held up.)*
3. **Out-of-band collection.** A systemd timer writes `smartctl -j` output to a world-readable cache file; the panel reads the file. Highest setup cost, cleanest privilege boundary, and the panel never spawns a privileged process.

**`smartAvailable` must gate on a real probe, not `command -v`.** Run the actual command once on open and set the flag from the **exit code** (`0` = usable, `2` = permission denied), not from binary presence.

**Refresh:** 10s interval, not 2s, due to `smartctl` access time. On non-zero exit set `smartData` to null and hide the SMART row.

**Note:** there are **two** NVMe drives here (`/dev/nvme0n1`, `/dev/nvme1n1`). The plan's single hard-coded `/dev/nvme0n1` covers only one — enumerate `/dev/nvme?n1` if both are wanted.

### 4.8 Network Throughput

**Source:** `/proc/net/dev` (two samples, 1 second apart)

**Format:**
```
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
enp7s0: 62091761096 48525464    0 62313    0     0          0         0 3021780853 8297383    0 0    0       0          0
```

**Calculation:**
```javascript
// Rate = (bytes_current - bytes_previous) / time_delta
function calcNetRate(prev, curr, dtSeconds) {
  var rates = {}
  for (var iface in curr) {
    if (prev[iface]) {
      rates[iface] = {
        rxRate: (curr[iface].rxBytes - prev[iface].rxBytes) / dtSeconds,
        txRate: (curr[iface].txBytes - prev[iface].txBytes) / dtSeconds
      }
    }
  }
  return rates
}
```

### 4.9 Per-Process Network (bandwhich)

**Source:** `bandwhich -r -p -i enp7s0` (streaming, long-lived)

**Command:**
```bash
bandwhich -r -p -i enp7s0 2>/dev/null
```

**Verified against bandwhich 0.23.1 (`/usr/bin/bandwhich`).** There is **no `-t` / sample-duration flag** — passing one aborts immediately with `error: unexpected argument '1' found`. Valid flags are `-i/--interface`, `-r/--raw`, `-n/--no-resolve`, `-s/--show-dns`, `-d/--dns-server`, `-p/--processes`, `-c/--connections`, `-a/--addresses`, `-u/--unit-family`.

**This changes the process model.** In raw mode bandwhich **streams continuously and never exits**, so the `StdioCollector { waitForEnd: true }` pattern used everywhere else in this plan will never fire `onStreamFinished` — it would hang and leak one process per poll. Two workable shapes:

**Preferred — long-lived process + `SplitParser`** (in-tree precedent: `plugins/bar/indicators/Dictation.qml:29`). One process for the whole panel session, parsed line by line, no polling timer:

```qml
Process {
  id: bandwhichProc
  command: ["bash", "-c", "bandwhich -r -p -i " + root.primaryIface + " 2>/dev/null"]
  running: root.opened && root.showBandwhich && root.bandwhichAvailable
  stdout: SplitParser {
    onRead: function(line) { root.ingestBandwhichLine(line) }
  }
}
```

`running` is bound to `root.opened`, so the process starts on open and is torn down on close — no `Timer` needed for this section, and `Component.onDestruction` does not need to stop it.

**Fallback — bounded one-shot:** `timeout 2 bandwhich -r -p -i enp7s0` keeps the `StdioCollector` pattern by forcing an exit, at the cost of respawning every poll.

**Privilege requirement (gates the whole section).** bandwhich needs `CAP_NET_RAW` + `CAP_NET_ADMIN` to capture, which an unprivileged user does not have, so the entire section depended on granting the binary a file capability. *(This is exactly why the feature was removed on 2026-09-02: per-process bandwidth has no unprivileged equivalent on Linux, confirmed by checking that /proc/net/tcp carries queue depth rather than cumulative per-socket byte counters. See the banner at the top.)*

**`bandwhichAvailable` must not be a `command -v` check.** `command -v bandwhich` succeeds on this machine even though capture fails, which would render a permanently empty section. Gate on an actual trial run — probe with `timeout 2 bandwhich -r -p -i <iface> >/dev/null 2>&1` and set the flag from the exit code, or check `getcap` output is non-empty. Set `bandwhichData` to `[]` and hide the sub-section when the probe fails.

### 4.10 Top Processes

**Source:** `ps`

**Commands:**
```bash
# Top CPU
ps -eo pid,ppid,user,%cpu,%mem,stat,nice,rss,comm --sort=-%cpu --no-headers | head -8

# Top MEM
ps -eo pid,ppid,user,%cpu,%mem,stat,nice,rss,comm --sort=-rss --no-headers | head -8

# Process detail — note `args`, not `comm`
ps -p <pid> -o pid,ppid,user,%cpu,%mem,stat,nice,rss,vsz,comm,args --no-headers
```

**`comm` is not the full command line.** The list queries use `comm`, which yields only the executable name (`brave`, `wineserver`, `Mechabellum.exe`). The detail view in Section 6 renders `selectedProcess.fullCommand`, which has **no data source** unless `args` is added — that is the field carrying the full invocation:

```
$ ps -eo pid,args --no-headers | head -2
1309755 S:\common\Mechabellum\Mechabellum.exe
1309656 /home/jharrison/.local/share/Steam/steamapps/common/Proton - Experimental/files/li...
```

Keep `comm` for the list (short, column-aligned) and add `args` only to the per-PID detail query. `args` must be the **last** field in the `-o` list — it contains spaces and would otherwise break positional parsing. `parsePsLine()` must therefore split on whitespace for the first N fields and take the remainder verbatim as `fullCommand`.

**Format (ps -eo ...):**
```
1264209 1264183 jharris+ 23.5  3.0 Rsl+   0 991668 opencode
 28260   28203 jharris+  6.3  5.5 Sl     0 1801532 brave
```

**Columns:** PID, PPID, USER, %CPU, %MEM, STAT, NI, RSS, COMMAND

### 4.11 Temperatures (all hwmon sensors)

**Source:** `/sys/class/hwmon/hwmon*/temp*_input` + `/sys/class/hwmon/hwmon*/name` + `temp*_label`

**Command:**
```bash
for hwmon in /sys/class/hwmon/hwmon*/; do
  name=$(cat "$hwmon/name" 2>/dev/null)
  for temp in "$hwmon"temp*_input; do
    [ -f "$temp" ] || continue
    value=$(cat "$temp" 2>/dev/null)
    label=$(cat "${temp%_input}_label" 2>/dev/null)
    if [ -n "$value" ]; then
      echo "$name|${label:-${temp##*/}}|$((value / 1000))"
    fi
  done
done
```

Emit `name|label|celsius` rather than a pre-formatted string — `parseSensors()` should receive fields, and `formatTemp()` owns the `°C` suffix. Reading `temp*_label` is what makes 9 coretemp readings distinguishable (`Package id 0`, `Core 0`…`Core 7`).

**This script produces 18 readings on this machine, not 5.** The plan previously listed one row per hwmon; the script actually iterates every `temp*_input`. Verified counts:

| hwmon | Name | `temp*_input` count |
|-------|------|---------------------|
| hwmon0 | acpitz | 1 |
| hwmon1 | nvme | 1 |
| hwmon2 | nvme | 3 |
| hwmon3 | amdgpu | 3 |
| hwmon4 | ucsi_source_psy_0_00081 | 0 |
| hwmon5 | coretemp | **9** (package + 8 cores) |
| hwmon6 | iwlwifi_1 | 1 |

Total: **18 rows.** Rendering all of them unfiltered is the single largest contributor to the overflow described in Section 11's Overflow Strategy, and 8 near-identical per-core rows are low-value next to the CPU section's own per-core bars.

**Recommended default filter** — one representative row per device, with the rest opt-in:

- `coretemp` → `Package id 0` only (the 8 `Core N` rows duplicate the CPU section)
- `amdgpu` → `edge` (the primary die temp)
- `nvme` → `Composite` per drive
- `acpitz`, `iwlwifi_1` → keep, 1 row each

That yields 6 rows by default. Add a `showAllSensors` boolean to the manifest schema (default `false`) to expose the full 18 for anyone who wants them.

**Note:** `hwmon4` (`ucsi_source_psy_0_00081`) exposes no temperature inputs — the loop must skip hwmon directories with no matches rather than emitting a blank row. The `[ -f "$temp" ] || continue` guard handles the unmatched-glob case.

**The hwmon indices are not stable across reboots.** Match on the `name` file, never on a hard-coded `hwmonN` path.

### 4.12 Fan Speeds

**Source:** `/sys/class/hwmon/hwmon*/fan1_input`

**Command:**
```bash
for fan in /sys/class/hwmon/hwmon*/fan1_input; do
  [ -f "$fan" ] || continue
  echo "$(cat "$(dirname "$fan")/name" 2>/dev/null)|$(cat "$fan" 2>/dev/null)"
done
```

**Current:** exactly one fan sensor exists — `hwmon3`, name `amdgpu`, ~530 RPM. **This is the GPU fan.**

The plan previously attributed this to `hwmon5` / `coretemp` and labelled it "CPU fan." Both were wrong: `coretemp` exposes no `fan*_input` at all, and there is **no CPU fan reading available** on this system. Render the fan speed in the GPU section, not the CPU section, and do not show a CPU fan row.

---

### 4.13 Timer Staggering (required)

Eight sections polling on 2s / 3s / 5s / 10s boundaries align periodically — at t=30s every timer fires at once, spawning eight concurrent subprocesses. That produces a visible CPU spike in the very panel that is measuring CPU, which is both a self-inflicted artifact and a jitter source.

Offset each timer's first fire so the load spreads across the interval:

```qml
Timer {
  id: memTimer
  interval: root.pollInterval
  running: root.opened
  repeat: true
  triggeredOnStart: false
  onTriggered: if (!memProc.running) memProc.running = true
}

// On open, stagger the starts rather than firing all timers together.
onOpenedChanged: if (opened) {
  var timers = [cpuTimer, memTimer, gpuTimer, diskTimer, netTimer, procTimer, sensorTimer]
  for (var i = 0; i < timers.length; i++) {
    startDelay.start(timers[i], i * 120)   // ~120ms apart
  }
}
```

The existing `if (!proc.running)` guard is already correct and should be kept on every timer — it prevents a slow source (smartctl, df on a cold cache) from queueing overlapping processes.

### 4.14 Pressure Stall Information (recommended addition)

**Source:** `/proc/pressure/{cpu,io,memory}`

Load average answers "how many things are runnable," which conflates a busy machine with a stalled one. PSI answers "how much time was actually lost to contention," which is the question a monitoring panel is usually being opened to settle.

**Command:**
```bash
cat /proc/pressure/cpu /proc/pressure/io /proc/pressure/memory 2>/dev/null
```

**Format:**
```
some avg10=0.00 avg60=0.00 avg300=0.00 total=0
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

`some` = at least one task stalled; `full` = every task stalled (the serious one — for `io` and `memory` it is the clearest "the machine is thrashing" signal available). Read `avg10` for a responsive display.

Cheap (three sysfs reads, no subprocess) and it pairs naturally with the existing load-average row in the CPU section. Worth adding once the core sections work.

## 5. Panel Sections

### Layout

```
┌──────────────────────────────────────────────┐
│  󰍛  System Monitor                          │  ← Hero
│  Uptime: 3d 14h 22m                         │
├──────────────────────────────────────────────┤
│  CPU                            4800 MHz     │  ← Section header
│  ████████████░░░░░░░░░  42%                 │  ← Total CPU bar
│  Core 0: ██████░░░░  35%   Core 1: ████░░  │  ← Per-core (if enabled)
│  Core 2: ████████░░  52%   Core 3: ███░░░  │
│  ...                                        │
│  Load: 3.40 / 2.51 / 2.69                  │  ← Load average
├──────────────────────────────────────────────┤
│  MEMORY                                     │
│  RAM: ████████████████░░░░  12.4 / 31.1 GB  │  ← RAM bar
│  Swap: ██░░░░░░░░░░░░░░░░░  1.8 / 62.0 GB  │  ← Swap bar
│  Zram: 1.4 GB → 347 MB (4.1:1)             │  ← Compression ratio
├──────────────────────────────────────────────┤
│  GPU                    amdgpu  46°C         │
│  Utilization: ██████░░░░  6%                │
├──────────────────────────────────────────────┤
│  DISK                                       │
│  /dev/mapper/root    ██████░░░░  126/930 GB  │  ← Per-mount bars
│  /games              █████████░  380/500 GB  │
│  NVMe Health: 42°C  Wear: 3%  POH: 5432    │  ← SMART data
├──────────────────────────────────────────────┤
│  NETWORK                                    │
│  enp7s0  ↓ 45.2 MB/s  ↑ 2.1 MB/s          │  ← Throughput
│  ── Top Processes ──                        │
│  brave       ↓ 12.3 MB/s                    │  ← bandwhich
│  opencode    ↓  1.1 MB/s                    │
│  Hyprland    ↓  0.3 MB/s                    │
├──────────────────────────────────────────────┤
│  PROCESSES (sorted by CPU)     [Sort: CPU]  │
│  ▶ opencode    PID 1264209  23.5%  3.0%  ✕ │  ← clickable, kill button
│    brave       PID 28260     6.3%  5.5%  ✕ │
│    claude      PID 1270926   4.7%  1.5%  ✕ │
│    Hyprland    PID 2123      2.5%  0.6%  ✕ │
├──────────────────────────────────────────────┤
│  SENSORS                                    │
│  coretemp   CPU     52°C  ████░░  Fan: 532  │
│  amdgpu     GPU     46°C  ███░░░            │
│  nvme       NVMe 1  43°C  ███░░░            │
│  nvme       NVMe 2  36°C  ██░░░░            │
│  acpitz     Board   28°C  ██░░░░            │
└──────────────────────────────────────────────┘
```

### Section Details

| Section | Data Source | Refresh Interval | Columns |
|---------|------------|-----------------|---------|
| Hero | `uptime` | on open | Icon + title + uptime |
| CPU | `/proc/stat` (2 samples) | 2s | Total bar, per-core grid, load avg, freq |
| Memory | `free -b` + `/sys/block/zram0/mm_stat` | 2s | RAM bar, swap bar, zram ratio |
| GPU | sysfs + hwmon | 3s | Utilization bar, temperature, **GPU fan RPM** |
| Disk | `df -h` (deduped) + `smartctl -j` | 5s (df), 10s (SMART) | Per-filesystem bars, SMART row *(SMART needs root — 4.7)* |
| Network | `/proc/net/dev` + `bandwhich` | 2s (throughput); bandwhich **streams, no timer** | Per-interface rates, top processes |
| Processes | `ps` | 2s | PID, user, CPU%, MEM%, kill button |
| Sensors | `/sys/class/hwmon/*` | 3s | Name, temp, bar (filtered — 18 raw readings, 4.11) |
| Pressure | `/proc/pressure/*` | 2s | PSI avg10 for cpu/io/memory (4.14) |

---

## 6. Process Interaction

### Process Row

Each process row is a `CursorSurface` with:
- **Left side:** Command name, PID, CPU%, MEM%
- **Right side:** Kill button (PanelActionButton with urgent hover color)

```qml
CursorSurface {
  id: processRow
  hasCursor: root.cursorActive && root.focusSection === "processes" && root.selectedIndex === rowIndex
  foreground: root.bar.foreground
  
  // Hover updates panel cursor state
  HoverHandler {
    onHoveredChanged: if (hovered) {
      root.cursorActive = true
      root.focusSection = "processes"
      root.selectedIndex = rowIndex
    }
  }
  
  // Left click → expand detail view
  MouseArea {
    anchors.fill: parent
    anchors.rightMargin: killButton.width
    onClicked: root.selectProcess(process)
    cursorShape: Qt.PointingHandCursor
  }
  
  // Process info row content
  Row {
    Text { text: process.command; font.family: root.bar.fontFamily; color: root.bar.foreground }
    Text { text: "PID " + process.pid; color: Color.muted }
    Text { text: process.cpu + "%"; color: cpuColor }
    Text { text: process.mem + "%"; color: root.bar.foreground }
  }
  
  // Kill button (right edge)
  PanelActionButton {
    id: killButton
    iconText: "󰆃"
    hoverColor: Color.urgent
    tooltipText: "Kill process (SIGTERM)"
    onClicked: root.killProcess(process.pid, "TERM")
  }
}
```

### Process Detail View

When a process row is clicked, the panel transitions to a detail view replacing the main scroll content:

```qml
// Detail view (shown when selectedProcess is set)
Column {
  visible: root.selectedProcess !== null
  
  // Back button
  Row {
    PanelActionButton {
      iconText: "󰁠"
      tooltipText: "Back to list"
      onClicked: root.selectedProcess = null
    }
    Text { text: root.selectedProcess ? root.selectedProcess.command : "" }
  }
  
  // Detail fields
  GridLayout {
    columns: 2
    InfoLabel { text: "PID" }       DetailValue { text: selectedProcess.pid }
    InfoLabel { text: "User" }      DetailValue { text: selectedProcess.user }
    InfoLabel { text: "CPU" }       DetailValue { text: selectedProcess.cpu + "%" }
    InfoLabel { text: "MEM" }       DetailValue { text: selectedProcess.mem + "% (" + formatBytes(selectedProcess.rss) + " RSS)" }
    InfoLabel { text: "State" }     DetailValue { text: formatState(selectedProcess.stat) }
    InfoLabel { text: "Nice" }      DetailValue { text: selectedProcess.nice }
    InfoLabel { text: "Parent" }    DetailValue { text: selectedProcess.ppid }
    InfoLabel { text: "Command" }   DetailValue { text: selectedProcess.fullCommand }
  }
  
  // Action buttons
  Row {
    spacing: Style.space(8)
    
    PanelActionButton {
      iconText: "󰆃"
      tooltipText: "Kill (SIGTERM)"
      hoverColor: Color.urgent
      onClicked: root.killProcess(selectedProcess.pid, "TERM")
    }
    
    PanelActionButton {
      iconText: "󰆞"
      tooltipText: "Force kill (SIGKILL)"
      hoverColor: Color.urgent
      onClicked: root.killProcess(selectedProcess.pid, "KILL")
    }
    
    PanelActionButton {
      iconText: "󰏗"
      tooltipText: "Renice (+10)"
      onClicked: root.reniceProcess(selectedProcess.pid, 10)
    }
    
    PanelActionButton {
      iconText: "󰅺"
      tooltipText: "Open files (lsof)"
      onClicked: root.openProcessLsof(selectedProcess.pid)
    }
    
    PanelActionButton {
      iconText: "󰙀"
      tooltipText: "Trace (strace)"
      onClicked: root.traceProcess(selectedProcess.pid)
    }
  }
}
```

### Process Actions

| Action | Command | Availability | UI Feedback |
|--------|---------|--------------|-------------|
| Kill (SIGTERM) | `kill -TERM <pid>` | ✓ own processes only | Row fades, list refreshes |
| Force kill (SIGKILL) | `kill -KILL <pid>` | ✓ own processes only | Row fades, list refreshes |
| Renice | `renice -n 10 -p <pid>` | ✓ increase only | Toast notification |
| Open files | `omarchy-launch-floating-terminal-with-presentation "lsof -p <pid>"` | ✓ `/usr/bin/lsof` | Floating terminal opens |
| Trace | `omarchy-launch-floating-terminal-with-presentation "strace -p <pid> -f"` | ✗ **blocked — see below** | Floating terminal opens |

**Trace is unavailable on this machine and must be cut or gated.** Two independent blockers:

1. **`strace` is not installed.** `command -v strace` returns nothing, and installing it is a system package operation.
2. **`ptrace_scope` is `1`** (`/proc/sys/kernel/yama/ptrace_scope`). Even once installed, `strace -p <pid>` on a process that is not a descendant of the tracer fails with `EPERM` — which is every process in this list. It would need to run elevated, or need `ptrace_scope` relaxed machine-wide, which is a system-wide security downgrade and not recommended.

Either drop the Trace button from v1, or render it `enabled: false` with a tooltip stating why. Do not ship a button that silently opens a terminal showing a permission error.

**Kill and renice fail silently on processes you do not own.** `ps -eo` lists every user's processes, including root-owned ones, so the kill button will be visible on rows where it cannot work. `kill` returns `EPERM` and the row simply does not disappear, which reads as the button being broken.

Two things are needed:

- **Capture stderr** on the action `Process` and surface failures. `PanelActionButton` has no error state, so route it to a short-lived toast or an inline message in the row.
- **Disable rather than fail.** Compare `process.user` against the shell's own user and set `enabled: false` on the kill/renice buttons for processes owned by anyone else, with a tooltip explaining why.

`renice -n 10` (lowering priority) works unprivileged. **Negative nice values require root** — if a "boost priority" action is ever added, it needs the same treatment as Trace.

### Kill Confirmation

For SIGKILL (destructive), show a brief confirmation inline:

```qml
// When kill button is pressed, set confirmation state
property int confirmKillPid: -1

// In the row, if confirmKillPid matches, show confirm/cancel buttons
Row {
  visible: root.confirmKillPid === process.pid
  PanelActionButton {
    iconText: "󰄬"
    tooltipText: "Confirm kill"
    hoverColor: Color.urgent
    onClicked: { root.confirmKill(process.pid, "KILL"); root.confirmKillPid = -1 }
  }
  PanelActionButton {
    iconText: "󰜉"
    tooltipText: "Cancel"
    onClicked: root.confirmKillPid = -1
  }
  Text { text: "Force kill?"; color: Color.urgent }
}
```

### Sort Toggle

The process section header includes a sort toggle:

```qml
// Clicking toggles between CPU and MEM sort
PanelActionButton {
  iconText: root.processSortBy === "cpu" ? "󰈐" : "󰈐"
  tooltipText: "Sort by " + (root.processSortBy === "cpu" ? "Memory" : "CPU")
  onClicked: root.processSortBy = root.processSortBy === "cpu" ? "mem" : "cpu"
}
```

When sort changes, re-run `ps` with the appropriate `--sort` flag.

---

## 7. Mouse Interaction

### Pattern

Every interactive row uses the standard Omarchy cursor model:

1. **`CursorSurface`** wraps the row content
2. **`HoverHandler`** updates panel cursor state on hover
3. **`MouseArea`** handles click actions
4. **No `containsMouse` for visual styling** — visuals derive from `hasCursor`/`current`

```qml
CursorSurface {
  hasCursor: root.cursorActive && root.focusSection === sectionName && root.selectedIndex === rowIndex
  current: root.currentProcess && root.currentProcess.pid === process.pid
  foreground: root.bar.foreground
  // CursorSurface internally applies: Style.hoverFillFor() / Style.selectedFillFor()
  
  HoverHandler {
    onHoveredChanged: if (hovered) {
      root.cursorActive = true
      root.focusSection = sectionName
      root.selectedIndex = rowIndex
    }
  }
}
```

### Click Actions by Section

| Section | Left Click | Right Click |
|---------|-----------|-------------|
| Process row | Expand detail view | — |
| Kill button | Kill process (SIGTERM) | — |
| Disk row | Show SMART details (if enabled) | — |
| CPU core | Show core details | — |
| All other rows | — (hover only) | — |

### Bar Widget Mouse

The bar icon itself supports:
- **Left click:** Open/close panel (standard)
- **Scroll wheel:** Not used (no action)

---

## 8. Keyboard Navigation

### Key Bindings (inside panel)

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down to next row/section |
| `k` / `↑` | Move cursor up to previous row/section |
| `h` / `←` | Move cursor left (within horizontal rows like per-core CPU) |
| `l` / `→` | Move cursor right |
| `Enter` / `Space` | Activate selected item (expand process, toggle sort) |
| `Backspace` | Return from detail view to main list |
| `Escape` | Close panel |
| `Tab` | Switch to next panel (standard Panel behavior) |
| `Shift+Tab` | Switch to previous panel |
| `x` / `X` | Kill selected process (SIGTERM) — **built into PanelKeyCatcher** |
| `r` | Force refresh all data |
| `1-9` | Jump to section N (CPU=1, Memory=2, GPU=3, etc.) |

**`x` is already bound by the base component and must be handled.** `PanelKeyCatcher` hardcodes `x`/`X` → `deleteRequested()` before any `textKey` dispatch. The plan never mentioned it, which leaves a signal firing into nothing. Wire it:

```qml
onDeleteRequested: if (root.focusSection === "processes" && root.selectedIndex >= 0)
                     root.killProcess(root.processData[root.selectedIndex].pid, "TERM")
```

Because `x` is intercepted first, it can never reach `onTextKey` — do not attempt to bind it there.

**Signals available and unused:** `returnRequested()` fires on Enter/Return *in addition to* `activateRequested()` (Space fires only the latter). If Enter and Space should differ — Enter opens the process detail, Space toggles a section — use `returnRequested` for the Enter-specific path.

**Backspace does not have a dedicated signal.** `PanelKeyCatcher` has no Backspace case, so it falls through to the final `event.text.length === 1` branch and arrives at `onTextKey` as `"\b"`. That works but relies on undocumented Qt text-encoding behavior. Prefer an explicit key handler on the panel root, or reuse `Escape`-style semantics: since `onCloseRequested` already closes the panel, route back-navigation through `activateCursor()` state instead of a raw character comparison.

### Focus Sections

```
"hero"      → uptime/summary
"cpu"       → CPU bars and load
"memory"    → RAM/swap bars
"gpu"       → GPU utilization
"disk"      → Disk usage rows
"network"   → Network throughput + bandwhich
"processes" → Process rows (sub-selection: row index)
"sensors"   → Temperature rows
```

### Cursor State

```qml
property string focusSection: "hero"    // Current section
property int selectedIndex: -1          // Row index within section (-1 = section header)
property bool cursorActive: false       // Whether cursor is visible
```

### Move Logic

```qml
function moveCursor(delta) {
  var sections = visibleSections
  var sIdx = sections.indexOf(focusSection)
  
  if (delta > 0) {
    // Moving down: try next row in section, then next section
    if (selectedIndex < sectionCount(focusSection) - 1) {
      selectedIndex++
    } else if (sIdx < sections.length - 1) {
      focusSection = sections[sIdx + 1]
      selectedIndex = 0
    }
  } else {
    // Moving up: try previous row, then previous section
    if (selectedIndex > 0) {
      selectedIndex--
    } else if (sIdx > 0) {
      focusSection = sections[sIdx - 1]
      selectedIndex = sectionCount(sections[sIdx - 1]) - 1
    }
  }
}
```

---

## 9. Theming

### Automatic Theme Compliance

The panel follows the active Omarchy theme automatically by using:

1. **`qs.Commons`** imports → provides `Color` and `Style` singletons
2. **`qs.Ui`** imports → provides themed UI components

### Color Usage

| Element | Color Source | Notes |
|---------|-------------|-------|
| All text | `root.bar.foreground` | From theme's colors.toml |
| Progress bar fill | `Color.accent` | Theme's accent color |
| Progress bar background | `Color.muted` | Theme's muted color |
| Kill button hover | `Color.urgent` | Theme's urgent/red color |
| Row hover | `Style.hoverFillFor(fg, accent)` | Automatic via CursorSurface |
| Row selected | `Style.selectedFillFor(fg, accent)` | Automatic via CursorSurface |
| Panel background | Handled by KeyboardPanel | Uses Color.popups.background |

### Font Usage

| Element | Font Source |
|---------|------------|
| All text | `root.bar.fontFamily` |
| Section headers | `Style.font.subtitle` (bold) |
| Body text | `Style.font.body` |
| Caption/small text | `Style.font.caption` |
| Icons | `Style.font.icon` (Nerd Font glyphs) |

### Spacing

All spacing uses `Style.space(px)` which scales with the theme's spacing scale:
- Section gaps: `Style.space(14)` (panelGap)
- Row padding: `Style.space(12)` (rowPaddingX)
- Element spacing: `Style.space(8)` (lg)
- Inner padding: `Style.space(6)` (md)

### Corner Rounding

All rounded rectangles use `Style.cornerRadius` which matches Hyprland's `decoration:rounding`.

### What Happens on Theme Switch

1. User runs `omarchy theme set <name>`
2. Shell receives IPC message
3. `Color.loadColors()` re-reads `colors.toml` → foreground, background, accent, urgent update
4. `Color.loadShell()` re-reads `shell.toml` → Style tokens update
5. Every binding in Panel.qml re-evaluates → all visuals update instantly

### Required Imports

```qml
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui          // Panel, KeyboardPanel, CursorSurface, PanelActionButton, PanelSlider, etc.
import qs.Commons     // Color, Style, Util singletons
import "Model.js" as Model
```

### Zero Hardcoded Colors

The plugin contains NO hardcoded color values. Every color reference goes through:
- `root.bar.foreground` / `root.bar.fontFamily`
- `Color.accent`, `Color.urgent`, `Color.muted`, `Color.foreground`
- `Style.hoverFillFor()`, `Style.selectedFillFor()`
- `PanelActionButton { hoverColor: Color.urgent }`

---

## 10. Model.js API

Pure JavaScript module. All functions are stateless. Imported as `"Model.js" as Model`.

### CPU Functions

```javascript
/**
 * Parse a /proc/stat line into component values.
 * @param {string} line - A single line from /proc/stat
 * @returns {object} { user, nice, system, idle, iowait, irq, softirq, steal }
 */
function parseCpuLine(line)

/**
 * Calculate CPU percentage from two samples.
 * @param {object} prev - Previous sample (from parseCpuLine)
 * @param {object} curr - Current sample (from parseCpuLine)
 * @returns {number} CPU usage percentage (0-100)
 */
function calcCpuPercent(prev, curr)

/**
 * Parse all CPU lines from /proc/stat.
 * @param {string} raw - Full /proc/stat content
 * @returns {object} { total: {…}, cores: [{…}, …] }
 */
function parseCpuStat(raw)
```

### Memory Functions

```javascript
/**
 * Parse free -b output.
 * @param {string} raw - Output of `free -b`
 * @returns {object} { memTotal, memUsed, memAvail, swapTotal, swapUsed }
 */
function parseFree(raw)
```

### Network Functions

```javascript
/**
 * Parse /proc/net/dev content.
 * @param {string} raw - Full /proc/net/dev content
 * @returns {object} { [iface]: { rxBytes, txBytes, rxPackets, txPackets } }
 */
function parseNetDev(raw)

/**
 * Calculate network throughput rates.
 * @param {object} prev - Previous sample
 * @param {object} curr - Current sample
 * @param {number} dt - Time delta in seconds
 * @returns {object} { [iface]: { rxRate, txRate } } in bytes/sec
 */
function calcNetRate(prev, curr, dt)

/**
 * Parse ONE line of streaming `bandwhich -r -p` output.
 * bandwhich never exits in raw mode, so lines arrive via SplitParser.onRead
 * rather than a single collected buffer — see 4.9.
 * @param {string} line - a single raw-mode output line
 * @returns {object|null} { process, rxRate, txRate } or null if not a process row
 */
function parseBandwhichLine(line)
```

### Process Functions

```javascript
/**
 * Parse ps output line.
 * @param {string} line - A single line from ps -eo pid,ppid,user,%cpu,%mem,stat,nice,rss,comm
 * @returns {object} { pid, ppid, user, cpu, mem, stat, nice, rss, command }
 */
function parsePsLine(line)

/**
 * Parse full ps output.
 * @param {string} raw - Full ps output
 * @returns {array} [{ pid, ppid, user, cpu, mem, stat, nice, rss, command }, …]
 */
function parsePsOutput(raw)

/**
 * Format process state code to human-readable.
 * @param {string} stat - Process state code (R, S, D, Z, T, etc.)
 * @returns {string} e.g., "running", "sleeping", "disk sleep", "zombie"
 */
function formatState(stat)
```

### SMART Functions

```javascript
/**
 * Parse smartctl JSON output for NVMe health.
 * @param {string} raw - JSON output of `smartctl -j -a /dev/nvme0n1`
 * @returns {object|null} { temp, wearPercent, powerOnHours, dataRead, dataWritten, powerCycles, unsafeShutdowns, mediaErrors }
 */
function parseSmartHealth(raw)
```

### Disk Functions

```javascript
/**
 * Parse df -h output, deduplicated by source filesystem.
 * /dev/mapper/root appears 4x (btrfs subvols) — group them. See 4.6.
 * @param {string} raw - Output of `df -h --output=source,size,used,avail,pcent,target`
 * @returns {array} [{ source, size, used, avail, percent, mounts: [string] }, …]
 */
function parseDfOutput(raw)
```

### Zram Functions

```javascript
/**
 * Parse /sys/block/zram0/mm_stat. See 4.4b.
 * @param {string} raw - whitespace-separated mm_stat line
 * @returns {object|null} { origSize, comprSize, memUsed, ratio } or null if absent
 */
function parseZram(raw)
```

### Pressure Functions

```javascript
/**
 * Parse /proc/pressure/{cpu,io,memory}. See 4.14.
 * @param {string} raw - concatenated pressure files
 * @returns {object} { cpu: {some10, full10}, io: {…}, memory: {…} }
 */
function parsePressure(raw)
```

### Sensor Functions

```javascript
/**
 * Parse hwmon readings emitted as `name|label|celsius` (see 4.11).
 * @param {string} raw - Output of the hwmon scanning script
 * @returns {array} [{ name, label, tempC }, …]
 */
function parseSensors(raw)

/**
 * Reduce 18 raw hwmon readings to the default display set (see 4.11):
 * coretemp→Package id 0, amdgpu→edge, nvme→Composite, acpitz/iwlwifi→as-is.
 * @param {array} sensors - output of parseSensors
 * @param {boolean} showAll - bypass filtering
 * @returns {array} filtered sensor list
 */
function filterSensors(sensors, showAll)

/**
 * Parse fan RPM readings emitted as `name|rpm` (see 4.12).
 * Only amdgpu reports a fan on this machine — there is no CPU fan.
 * @param {string} raw
 * @returns {array} [{ name, rpm }, …]
 */
function parseFans(raw)
```

### Formatting Helpers

**Byte / rate formatting:** there is no `Bytes` component in `qs.Ui` — use `Model.formatBytes()` and `Model.formatRate()` everywhere. The in-tree convention (network panel, `Panel.qml:556`) is a thin panel-local wrapper that delegates to Model.js, so QML bindings can call it unqualified:

```qml
// Panel-local wrapper (matches network/Panel.qml:556)
function formatBytes(bytes) { return Model.formatBytes(bytes) }
function formatRate(bytesPerSec) { return Model.formatRate(bytesPerSec) }

// Standalone display
Text { text: root.formatBytes(root.memInfo.memUsed); color: root.bar.foreground; font.family: root.bar.fontFamily }
Text { text: root.formatRate(root.netRates.rxRate); color: root.bar.foreground; font.family: root.bar.fontFamily }

// Inline string concatenation
DetailValue { text: selectedProcess.mem + "% (" + root.formatBytes(selectedProcess.rss) + " RSS)" }
```

```javascript
/**
 * Format bytes to human-readable (for inline string use only).
 * @param {number} bytes
 * @returns {string} e.g., "1.2 GB", "347 MB"
 */
function formatBytes(bytes)

/**
 * Format bytes/sec to human-readable rate (for inline string use only).
 * @param {number} bytesPerSec
 * @returns {string} e.g., "45.2 MB/s", "1.2 KB/s"
 */
function formatRate(bytesPerSec)

/**
 * Format temperature.
 * @param {number} celsius
 * @returns {string} e.g., "52°C"
 */
function formatTemp(celsius)

/**
 * Format percentage.
 * @param {number} value
 * @returns {string} e.g., "67%"
 */
function formatPercent(value)

/**
 * Format uptime seconds to human-readable.
 * @param {number} seconds
 * @returns {string} e.g., "3d 14h 22m"
 */
function formatUptime(seconds)

/**
 * Calculate zram compression ratio.
 * @param {number} diskSize - Original data size
 * @param {number} comprSize - Compressed size
 * @returns {string} e.g., "4.1:1"
 */
function formatCompressionRatio(diskSize, comprSize)
```

---

## 11. Panel.qml Structure

### Top-Level Structure

```qml
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Model

Panel {
  id: root
  moduleName: "jharrison.sysmonitor"
  ipcTarget: "jharrison.sysmonitor"
  // manageIpc is intentionally left at its default (true). The base Panel
  // creates the IpcHandler only when manageIpc is true:
  //   IpcHandler { enabled: root.manageIpc && root.ipcTarget !== "" ... }
  // Setting it false DISABLES IPC and breaks the Section 12 keybinding.
  
  // ─── State ───
  property var cpuStatPrev: null
  property var cpuStatCurr: null
  property var cpuTotalPercent: 0
  property var cpuCorePercents: []
  property string loadAvg: ""
  property string cpuFreq: ""
  property string cpuModel: ""
  
  property var memInfo: ({})
  property var netPrev: null
  property var netRates: ({})
  property var bandwhichData: []
  property var diskData: []
  property var smartData: null
  property bool smartAvailable: false  // gate SMART section
  property bool bandwhichAvailable: false  // gate bandwhich section
  property var gpuUtil: 0
  property var gpuTemp: 0
  property string gpuPath: ""  // dynamic AMD GPU sysfs path
  property var sensorData: []
  property var fanData: []             // amdgpu only — no CPU fan exists (4.12)
  property var zramInfo: null          // /sys/block/zram0/mm_stat (4.4b)
  property var pressureInfo: ({})      // /proc/pressure/* (4.14)
  property var processData: []
  property string primaryIface: "enp7s0"   // used by the bandwhich stream command
  property string uptime: ""
  property string processSortBy: "cpu"  // FIXED: string type, not int
  property var selectedProcess: null
  property int confirmKillPid: -1
  
  // ─── Settings ───
  readonly property int pollInterval: setting("pollInterval", 2000)
  readonly property bool showCpuPerCore: setting("showCpuPerCore", true)
  readonly property bool showSmartHealth: setting("showSmartHealth", true)
  readonly property bool showBandwhich: setting("showBandwhich", true)
  readonly property int processCount: setting("processCount", 8)
  readonly property bool showAllSensors: setting("showAllSensors", false)  // 18 raw readings if true (4.11)
  
  // ─── Sections ───
  readonly property var visibleSections: ["hero", "cpu", "memory", "gpu", "disk", "network", "processes", "sensors"]
  property string focusSection: "hero"
  property int selectedIndex: -1
  property bool cursorActive: false
  
  // ─── IPC ───
  // FIXED: Removed manual IpcHandler — base Panel creates one via ipcTarget.
  // The base class default IpcHandler exposes open/close/toggle/show/hide.
  
  // ─── Tool availability checks (run once on open) ───
  Process {
    id: toolCheckProc
    command: ["bash", "-c", "command -v bandwhich >/dev/null 2>&1 && echo bandwhich-ok; command -v smartctl >/dev/null 2>&1 && echo smartctl-ok"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.bandwhichAvailable = String(text).indexOf("bandwhich-ok") >= 0
        root.smartAvailable = String(text).indexOf("smartctl-ok") >= 0
      }
    }
  }
  
  // ─── GPU path detection (run once on open) ───
  Process {
    id: gpuDetectProc
    command: ["bash", "-c", "for card in /sys/class/drm/card*/device/vendor; do vendor=$(cat \"$card\" 2>/dev/null); if [ \"$vendor\" = \"0x1002\" ]; then echo \"${card%/vendor}\"; break; fi; done"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var path = String(text || "").trim()
        root.gpuPath = path
        if (path) {
          gpuUtilProc.command = ["cat", path + "/gpu_busy_percent"]
          gpuUtilProc.running = true
        }
      }
    }
  }
  
  // ─── Data fetching processes ───
  // (see Section 4 for each Process { ... } block)
  
  // ─── Polling timers ───
  // (see Section 4 for each Timer { ... } block)
  
  // ─── UI ───
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰍛"
    onPressed: function(b) { root.toggle() }
  }
  
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(700))
    
    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { ... }
      onActivateRequested: { ... }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshAll()
        else if (t === "\b" && root.selectedProcess) root.selectedProcess = null  // FIXED: Backspace back-nav
      }
      
      // Scrolling IS supported inside PanelKeyCatcher and IS required here.
      // PanelKeyCatcher sets `Keys.priority: Keys.BeforeItem` specifically so it
      // wins keys over an inner Flickable — its own header comment says so:
      //   "That's what lets Up/Down arrows drive the cursor instead of being
      //    consumed by an inner Flickable's built-in scroll handling."
      // The network panel proves it: PanelKeyCatcher at Panel.qml:991 contains a
      // ListView + ScrollBar at Panel.qml:1474.
      // Long sections (processes, sensors, per-core CPU, disk) use capped ListViews —
      // see "Overflow strategy" below. fittedContentHeight clamps the card itself.
      Column {
        id: panelColumn
        width: parent.width
        spacing: Style.space(14)
        
        // Hero section
        // CPU section
        // Memory section
        // GPU section
        // Disk section
        // Network section
        // Process section (or detail view)
        // Sensors section
      }
    }
  }
  
  // ─── Cleanup on destruction ───
  Component.onDestruction: {
    // Stop all timers and running processes on plugin unload
    cpuTimer.stop()
    memTimer.stop()
    netTimer.stop()
    // ... etc
  }
  
  // ─── Functions ───
  function refreshAll() { ... }
  function selectProcess(process) { ... }
  function killProcess(pid, signal) { ... }
  function reniceProcess(pid, nice) { ... }
  function openProcessLsof(pid) { ... }
  function traceProcess(pid) { ... }
  function moveCursor(delta) { ... }          // vertical: dy from onMoveRequested
  function moveCursorH(delta) { ... }         // horizontal: dx — REQUIRED, was missing.
                                              // Section 8 binds h/l and Section 15's
                                              // reference calls root.moveCursorH(dx).
  function activateCursor() { ... }
  function killSelectedProcess() { ... }      // bound to onDeleteRequested (x/X)
  
  // ─── Local component declarations ───
  // FIXED: These are NOT in qs.Ui — must be declared locally
  component InfoLabel: Text {
    color: root.bar.foreground
    opacity: 0.6
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
  
  component DetailValue: Text {
    color: root.bar.foreground
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
```

### Overflow Strategy (required — content does not fit)

The panel does not fit on screen at real row counts, so scrolling is a requirement, not an option.

**Measured row counts on this machine:**

| Section | Rows | Source |
|---|---|---|
| CPU per-core | 16 | `nproc` = 16 |
| Disk | 7 | `df` rows matching `^/dev` |
| Processes | 8 | `processCount` default |
| Sensors | **18** | all `temp*_input` across hwmon (see 4.11) |
| Memory / GPU / Network / Hero | ~10 | fixed |

That is roughly 59 content rows plus 8 section headers and 8 separators. The card height is capped by `fittedContentHeight(panelColumn.implicitHeight, Style.space(700))` at ~700px, and `availableCardHeight` on this display (2560x1440 @ scale 1.25 → 2048x1152 logical, minus bar and gaps) is ~1080px. Either bound clips well before the content ends, so **Processes and Sensors would be rendered but unreachable** — no scroll, no way to get to them.

**Fix — cap long sections with ListViews, following the network panel (`Panel.qml:1474`):**

```qml
ListView {
  id: processList
  width: parent.width
  height: Math.min(contentHeight, Style.space(200))
  spacing: Style.space(4)
  clip: true
  boundsBehavior: Flickable.StopAtBounds
  interactive: contentHeight > height

  ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

  model: root.processData
  // Keeps the j/k-selected row scrolled into view once the cursor
  // walks past the visible window — the reason to prefer ListView
  // over Repeater+Column.
  currentIndex: root.focusSection === "processes" ? root.selectedIndex : -1
  onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)

  delegate: Item { /* wrapper — see network/Panel.qml:1493 for why */ }
}
```

Apply the same shape to Sensors, Disk, and the per-core CPU grid. `positionViewAtIndex` is the reason to use `ListView` rather than `Repeater` + `Column`: it is what keeps keyboard navigation coherent once a section scrolls.

**Delegate wrapper caveat:** ListView's delegate context does not bind into nested `component` declarations. The network panel wraps its delegate in a plain `Item` that takes the required properties explicitly and passes them down (`Panel.qml:1490-1493`). Do the same for the process row.

**Also reduce the source rows** — see 4.11 on filtering 18 sensor readings down to a useful set, and 4.6 on deduplicating the four `/dev/mapper/root` btrfs rows. Scrolling and filtering are complementary here, not alternatives.

---

### Section Component Pattern

Each section follows this pattern:

```qml
// ---------- SECTION NAME ----------
PanelSeparator { foreground: root.bar.foreground }

Column {
  width: parent.width
  spacing: Style.space(6)
  
  // Section header
  Item {
    width: parent.width
    implicitHeight: Math.max(headerText.implicitHeight, valueText.implicitHeight)
    
    PanelSectionHeader {
      id: headerText
      text: "SECTION NAME"
      foreground: root.bar.foreground
      fontFamily: root.bar.fontFamily
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
    }
    
    Text {
      id: valueText
      text: "summary value"
      color: Qt.darker(root.bar.foreground, 1.4)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
    }
  }
  
  // Section content rows
  CursorSurface {
    width: parent.width
    hasCursor: root.cursorActive && root.focusSection === "sectionName" && root.selectedIndex === 0
    foreground: root.bar.foreground
    
    HoverHandler {
      onHoveredChanged: if (hovered) {
        root.cursorActive = true
        root.focusSection = "sectionName"
        root.selectedIndex = 0
      }
    }
    
    // Row content...
  }
}
```

---

## 12. Keybinding

Add to `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + CTRL + SHIFT + T", "System Monitor Panel", "omarchy-shell shell toggle jharrison.sysmonitor")
```

This opens the panel via IPC. The existing `SUPER + CTRL + T` binding (btop) remains unchanged.

---

## 13. Implementation Order

**Step 0 — run the pre-flight checks in Section 14 first.** Three data sources are blocked on this machine (`strace` absent, `bandwhich` uncapped, `smartctl` needs root). Resolve or cut each before building the UI that consumes it.

| Step | Task | Dependencies |
|------|------|-------------|
| 0 | **Pre-flight: verify data sources (Section 14)** — decide the SMART resolution (4.7), grant bandwhich caps or cut 4.9, cut or gate Trace | — |
| 1 | Create directory structure | — |
| 2 | Write `manifest.json` (incl. `showAllSensors`) | Step 1 |
| 3 | Write `Model.js` — CPU parsing functions | — |
| 4 | Write `Model.js` — Memory + **zram** parsing (`parseZram`) | — |
| 5 | Write `Model.js` — Network parsing (`parseBandwhichLine`, line-at-a-time) | — |
| 6 | Write `Model.js` — Process parsing (`comm` for list, `args` for detail) | — |
| 7 | Write `Model.js` — SMART parsing functions | Step 0 |
| 8 | Write `Model.js` — Disk parsing **with source dedup** | — |
| 9 | Write `Model.js` — Sensor parsing + `filterSensors` + `parseFans` | — |
| 10 | Write `Model.js` — Formatting helpers (`formatBytes`, `formatRate`, …) | — |
| 11 | Write `Panel.qml` — Skeleton (Panel, **no `manageIpc` override**, KeyboardPanel, timers) | Step 2 |
| 12 | Write `Panel.qml` — Hero section | Step 11 |
| 13 | Write `Panel.qml` — CPU section (delta vs previous poll) | Steps 3, 11 |
| 14 | Write `Panel.qml` — Memory section (RAM, swap, zram) | Steps 4, 11 |
| 15 | Write `Panel.qml` — GPU section (dynamic vendor probe + **GPU fan RPM**) | Step 11 |
| 16 | Write `Panel.qml` — Disk section (deduped df; SMART only if Step 0 resolved) | Steps 7, 8, 11 |
| 17 | Write `Panel.qml` — Network section (throughput timer + bandwhich **SplitParser stream**) | Steps 5, 11 |
| 18 | Write `Panel.qml` — Process section (**ListView**, kill button, ownership gating) | Steps 6, 11 |
| 19 | Write `Panel.qml` — Process detail view (`fullCommand` from `args`) | Step 18 |
| 20 | Write `Panel.qml` — Sensors section (**ListView**, filtered to 6 rows) | Steps 9, 11 |
| 21 | **Implement the Overflow Strategy** — capped ListViews + `positionViewAtIndex` on all long sections | Steps 18, 20 |
| 22 | Wire up all Timer-based polling **with stagger (4.13)** | Steps 12-20 |
| 23 | Add keyboard navigation (`moveCursor`, **`moveCursorH`**, `activateCursor`, **`onDeleteRequested`**) | Step 11 |
| 24 | Add mouse interaction (HoverHandler on all rows) | Steps 12-20 |
| 25 | Add error surfacing for kill/renice EPERM | Step 18 |
| 26 | *(Optional)* Add PSI section (4.14) | Step 11 |
| 27 | Enable plugin: `omarchy plugin enable jharrison.sysmonitor` | Steps 1-25 |
| 28 | Add keybinding to bindings.lua | Step 27 |
| 29 | Test all sections against Section 14, fix any issues | Step 28 |

---

## 14. Testing & Verification

### Enable Plugin

```bash
omarchy plugin enable jharrison.sysmonitor
```

### Verify Plugin Loads

```bash
omarchy plugin list | grep sysmonitor
```

### Validate the manifest (weak gate — read this)

```bash
omarchy plugin validate ~/.config/omarchy/plugins/jharrison.sysmonitor
```

**A pass here means very little.** `omarchy-plugin-validate` checks only: `schemaVersion === 1`, required fields present, entry points are safe relative paths that exist, an entry point per kind, no symlinks, and a non-reserved id. It does **not** validate `barWidget.schema` at all. Confirmed by testing:

| Input | Expected | Actual |
|---|---|---|
| `"kinds": ["not-a-real-kind"]` | reject | **exit 0** |
| `"schema": [{"type": "BOGUS_TYPE"}]` | reject | **exit 0** |

Treat it as a JSON/path syntax check, not a schema gate. The settings schema in Section 3 is nonetheless well-formed — its `integer` / `boolean` types with `min` / `max` / `step` / `defaultValue` match the shape the shell actually consumes (`shell.qml:696` reads `meta.schema`, and `plugins/agents/manifest.json` uses the same fields, plus `enum` with `options[]` and `string` if more types are needed later).

**The real verification is loading the plugin and watching the log** — see "Check for Errors" below. A QML type error (a nonexistent component, a bad property name) surfaces there and nowhere else.

### Pre-flight: confirm data sources before building UI

Several sources in Section 4 are privileged or absent. Run these first so no section is built against data that will never arrive:

```bash
command -v strace  || echo "MISSING: strace — cut the Trace button (4.10 / Section 6)"
getcap "$(command -v bandwhich)" | grep -q cap_net_raw || echo "MISSING: bandwhich caps — section 4.9 will render empty"
smartctl -j -a /dev/nvme0n1 >/dev/null 2>&1  || echo "MISSING: smartctl needs root — see 4.7 resolutions"
```

### Test Each Section

1. **Open panel:** Click bar icon or press `SUPER+CTRL+SHIFT+T`
2. **CPU:** Verify total % updates every 2s, per-core shows, load average displays
3. **Memory:** Verify RAM/swap bars show correct usage
4. **GPU:** Verify temperature and utilization display
5. **Disk:** Verify mount points show, SMART data loads (10s delay)
6. **Network:** Verify throughput rates update, bandwhich shows top processes
7. **Processes:** Verify top CPU processes list, click to expand detail, kill button works
8. **Sensors:** Verify all hwmon temperatures display

### Test Keyboard Navigation

- `j`/`k` moves between sections and rows
- `Enter` on process row → detail view
- `Backspace` in detail view → back to list
- `r` → force refresh
- `Tab` → switch to next panel
- `Escape` → close panel

### Test Mouse Interaction

- Hover on rows → highlight appears
- Click on process row → detail view opens
- Click kill button → process terminated
- Hover on kill button → red/urgent tint

### Test Theming

```bash
omarchy theme set catppuccin
# Verify panel colors update
omarchy theme set tokyo-night
# Verify panel colors update again
```

### Check for Errors

```bash
# If panel doesn't load, check Quickshell logs
journalctl --user -u omarchy-shell -n 50
```

### Reset if Needed

```bash
omarchy plugin disable jharrison.sysmonitor
# Or delete the plugin directory
rm -rf ~/.config/omarchy/plugins/jharrison.sysmonitor
```

---

## 15. Reference: Existing Plugins

### Files to Study

| File | Purpose |
|------|---------|
| `/usr/share/omarchy/shell/plugins/panels/network/Panel.qml` | Canonical example of a complex bar-widget panel with data fetching, mouse interaction, and action buttons |
| `/usr/share/omarchy/shell/plugins/panels/monitor/Panel.qml` | Good example of slider-based UI and section navigation |
| `/usr/share/omarchy/shell/plugins/panels/audio/Panel.qml` | Reference for mouse interaction pattern and PanelSlider usage |
| `/usr/share/omarchy/shell/Ui/Panel.qml` | Base class for all panels |
| `/usr/share/omarchy/shell/Ui/CursorSurface.qml` | Row hover/select visual component |
| `/usr/share/omarchy/shell/Ui/PanelActionButton.qml` | Inline action button (kill, info, etc.) |
| `/usr/share/omarchy/shell/Ui/PanelSlider.qml` | Slider with right-click support |
| `/usr/share/omarchy/shell/Ui/KeyboardPanel.qml` | Keyboard-navigable panel wrapper |
| `/usr/share/omarchy/shell/Ui/PanelKeyCatcher.qml` | Keyboard event capture |
| `/usr/share/omarchy/shell/Ui/PanelSectionHeader.qml` | Section header styling |
| `/usr/share/omarchy/shell/Ui/PanelSeparator.qml` | Section separator |
| `/usr/share/omarchy/shell/Ui/PanelToolTip.qml` | Tooltip component |
| `/usr/share/omarchy/shell/Commons/Color.qml` | Color singleton (theme colors) |
| `/usr/share/omarchy/shell/Commons/Style.qml` | Style singleton (fonts, spacing, states) |
| `~/.config/omarchy/plugins/jharrison.speedtest/` | Existing custom plugin (simple panel) |

### Key Patterns from Existing Plugins

**Data fetching (from network panel):**
```qml
Process {
  id: detailsProc
  command: ["omarchy-network-status", "--verbose"]
  stdout: StdioCollector {
    waitForEnd: true
    onStreamFinished: root.updateDetails(text)
  }
}

Timer {
  interval: 1500
  repeat: true
  running: root.opened
  onTriggered: if (!detailsProc.running) detailsProc.running = true
}
```

**Cursor navigation (from network panel):**
```qml
PanelKeyCatcher {
  onMoveRequested: function(dx, dy) {
    if (!root.cursorActive) { root.cursorActive = true; return }
    if (dy !== 0) root.moveCursor(dy)
    if (dx !== 0) root.moveCursorH(dx)
  }
  onActivateRequested: if (root.cursorActive) root.activateCursor()
  onCloseRequested: root.close()
  onTabRequested: function(direction) { root.switchPanel(direction) }
  onTextKey: function(t) {
    if (t === "r" || t === "R") root.refresh()
  }
}
```

**Action button with urgent hover (from network panel):**
```qml
PanelActionButton {
  iconText: "󰆃"
  hoverColor: Color.urgent
  tooltipText: "Forget network"
  enabled: row.canForget && !root.busy
  onClicked: root.forget(row.net)
}
```

---

### Verified-Correct API Usage (do not re-litigate)

Checked against `/usr/share/omarchy/shell/` on 2026-08-30. These are confirmed present and correctly used in this plan:

| API | Verified at |
|---|---|
| `root.bar.foreground` / `.fontFamily` / `.urgent` | `plugins/panels/network/Panel.qml:1094,1095,1234` |
| `setting()`, `opened`, `toggle()`, `open()`, `close()`, `switchPanel()` | `Ui/Panel.qml` — all base-class members |
| `BarIconButton { text: …; onPressed: function(b) }` | inherits `text` from `WidgetButton`; `network/Panel.qml:956-960` |
| `CursorSurface` — `hasCursor`, `current`, `foreground`, `accent` | `Ui/CursorSurface.qml:17-25` |
| `PanelActionButton` — `iconText`, `tooltipText`, `hoverColor`, `clicked()` | `Ui/PanelActionButton.qml:30-42` |
| `PanelSectionHeader` — `foreground`, `fontFamily`, `fontSize` | `Ui/PanelSectionHeader.qml:10-12` |
| `PanelSeparator` — `foreground`, `strength` | `Ui/PanelSeparator.qml:10-11` |
| `fittedContentWidth(w, cap)` / `fittedContentHeight(h, cap)` | `Ui/KeyboardPanel.qml:161,168` — 2-arg form used correctly |
| `Color.accent` / `.urgent` / `.muted` / `.foreground` | `Commons/Color.qml:19-23` |
| `Style.font.{caption,bodySmall,body,subtitle,icon}` | `Commons/Style.qml:327-338` |
| `Style.space()`, `Style.cornerRadius`, `hoverFillFor()`, `selectedFillFor()` | `Commons/Style.qml:219,31` |
| Locally-declared `InfoLabel` / `DetailValue` | correct — network panel does the same, `Panel.qml:1948,1955` |
| `Process` + `Timer { running: root.opened }` + `if (!proc.running)` guard | `network/Panel.qml`, canonical pattern |
| `barWidget.schema` types `integer` / `boolean` (+ `enum`, `string`) | `shell.qml:696`; `plugins/agents/manifest.json:33-37` |

**PanelKeyCatcher signal reference** (`Ui/PanelKeyCatcher.qml`) — the full set, including the two the plan originally missed:

| Signal | Fires on |
|---|---|
| `moveRequested(dx, dy)` | arrows, `h` `j` `k` `l` |
| `activateRequested()` | Enter, Return, **Space** |
| `returnRequested()` | Enter, Return **only** (fires alongside `activateRequested`) |
| `closeRequested()` | Escape |
| `deleteRequested()` | **`x` / `X`** — hardcoded, intercepted before `textKey` |
| `tabRequested(direction)` | Tab / Shift+Tab / Backtab |
| `textKey(text)` | any other single character (`r`, `1`-`9`, `\b`) |
| `blocked` (property) | set true while an inline editor has focus |

---

## Appendix: System Info (This Machine)

| Component | Value |
|-----------|-------|
| CPU | 11th Gen Intel Core i9-11900K @ 3.50GHz — **8 cores / 16 threads** (`nproc` = 16) |
| GPU | AMD `card2` (amdgpu, `0x1002`) — Intel iGPU is `card1` (`0x8086`) |
| RAM | 31.1 GB |
| Swap | ~64 GB total across **two** backends: `/dev/zram0` 31.1G (zstd, ~4.6:1) + `/swap/swapfile` 32.6G |
| Root | /dev/mapper/root (btrfs, 930G) — 4 subvol mounts: `/`, `/home`, `/var/cache/pacman/pkg`, `/var/log` |
| Boot | /dev/nvme0n1p1, 2.0G |
| Games | **/dev/nvme1n1p1, 916G** (not 500G) |
| Storage | /dev/mapper/storage, 932G |
| NVMe | 2 drives — `/dev/nvme0n1`, `/dev/nvme1n1` (hwmon1, hwmon2) |
| Network | enp7s0 (Ethernet), wlp8s0 (Wi-Fi, inactive) |
| Fans | **hwmon3 (amdgpu) ~530 RPM — GPU fan. No CPU fan sensor exists.** |
| Temps | 18 `temp*_input` readings across 6 hwmon devices (see 4.11) |
| Display | 2× DP 2560x1440 @ scale 1.25 → 2048x1152 logical |
| Missing tools | `strace` not installed; `bandwhich` has no capabilities set; `smartctl` needs root |
