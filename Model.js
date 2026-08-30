// Pure parsing/formatting helpers for the sysmonitor panel.
//
// Every function here is stateless: raw text in, plain object out. No QML
// types, no side effects, no I/O. That keeps the whole data layer testable
// under node (`node test-model.js`) without a running shell, which is the
// only practical way to check the parsers against real /proc and sysfs
// samples.
//
// Deliberately NOT `.pragma library`: that directive is not valid JavaScript
// and would break node parsing. Panel.qml is the single importer, so the
// per-component copy this costs is one copy.

// ------------------------------------------------- collector shell scripts
//
// Defined here so Panel.qml and test-model.js run byte-identical commands —
// a parser tested against one script and fed by a slightly different one is
// the easiest way for this layer to drift.
//
// Every script ends in a construct that exits 0. A trailing `[ x ] && echo`
// makes the whole script inherit the failed test's exit status when the last
// iteration does not match, which reads as a collector failure and would
// wrongly gate a section off. `if ... fi` returns 0 either way.

// Emits `name|label|celsius` per reading. Reading temp*_label is what makes
// the 9 coretemp readings distinguishable (Package id 0, Core 0..Core 7).
var COLLECT_SENSORS =
  'for h in /sys/class/hwmon/hwmon*/; do ' +
    'n=$(cat "$h/name" 2>/dev/null); ' +
    'for t in "$h"temp*_input; do ' +
      'if [ -f "$t" ]; then ' +
        'v=$(cat "$t" 2>/dev/null); ' +
        'l=$(cat "${t%_input}_label" 2>/dev/null); ' +
        'if [ -n "$v" ]; then echo "$n|${l:-${t##*/}}|$((v/1000))"; fi; ' +
      'fi; ' +
    'done; ' +
  'done'

// Emits `name|rpm` per fan.
var COLLECT_FANS =
  'for f in /sys/class/hwmon/hwmon*/fan1_input; do ' +
    'if [ -f "$f" ]; then ' +
      'echo "$(cat "$(dirname "$f")/name" 2>/dev/null)|$(cat "$f" 2>/dev/null)"; ' +
    'fi; ' +
  'done'

// Prefixes each PSI line with its resource. The raw files carry no filename
// marker, so plain concatenation makes cpu/io/memory indistinguishable.
var COLLECT_PRESSURE =
  'for r in cpu io memory; do ' +
    'if [ -f "/proc/pressure/$r" ]; then ' +
      'while read -r line; do echo "$r $line"; done < "/proc/pressure/$r"; ' +
    'fi; ' +
  'done'

// Prints the sysfs device path of the first AMD GPU (vendor 0x1002).
// card indices are enumeration-order dependent and shift across reboots, so
// this probes by vendor rather than hard-coding a card number.
var COLLECT_GPU_PATH =
  'for c in /sys/class/drm/card*/device/vendor; do ' +
    'if [ -f "$c" ] && [ "$(cat "$c" 2>/dev/null)" = "0x1002" ]; then ' +
      'echo "${c%/vendor}"; break; ' +
    'fi; ' +
  'done'

// Probes the three tools whose mere presence on PATH does not mean they work
// here: bandwhich needs CAP_NET_RAW, smartctl needs root. Each line is
// emitted only when the capability genuinely exists.
var COLLECT_TOOL_PROBE =
  'if command -v bandwhich >/dev/null 2>&1 && ' +
     'getcap "$(command -v bandwhich)" 2>/dev/null | grep -q cap_net_raw; ' +
     'then echo bandwhich-ok; fi; ' +
  'if command -v smartctl >/dev/null 2>&1; then ' +
     'if smartctl -j -a /dev/nvme0n1 >/dev/null 2>&1; then echo smartctl-ok; ' +
     'elif sudo -n smartctl -j -a /dev/nvme0n1 >/dev/null 2>&1; then echo smartctl-sudo; fi; ' +
   'fi; ' +
  'true'

// Enumerates the NVMe block devices so SMART is not hard-coded to one drive.
var COLLECT_NVME_LIST =
  'for d in /dev/nvme?n1; do if [ -b "$d" ]; then echo "$d"; fi; done'

// Full AMD GPU readout. Emits key=value lines so adding a field later does not
// disturb the positional meaning of the others.
function collectGpuDetail(gpuPath) {
  var g = String(gpuPath || "")
  if (!g) return "true"
  var q = "'" + g.replace(/'/g, "") + "'"
  return (
    'g=' + q + '; h=$(echo "$g"/hwmon/hwmon*); ' +
    'r() { if [ -r "$1" ]; then echo "$2=$(cat "$1" 2>/dev/null)"; fi; }; ' +
    'r "$g/gpu_busy_percent" busy; ' +
    'r "$g/mem_busy_percent" membusy; ' +
    'r "$g/mem_info_vram_used" vramused; ' +
    'r "$g/mem_info_vram_total" vramtotal; ' +
    'r "$h/power1_average" power; ' +
    'r "$h/power1_cap" powercap; ' +
    'r "$h/fan1_input" fan; ' +
    'for i in 1 2; do ' +
      'if [ -r "$h/freq${i}_input" ]; then ' +
        'echo "freq:$(cat "$h/freq${i}_label" 2>/dev/null || echo $i)=$(cat "$h/freq${i}_input")"; ' +
      'fi; ' +
    'done; ' +
    'for t in "$h"/temp*_input; do ' +
      'if [ -r "$t" ]; then ' +
        'echo "temp:$(cat "${t%_input}_label" 2>/dev/null || basename "$t")=$(cat "$t")"; ' +
      'fi; ' +
    'done'
  )
}

// Per-process detail beyond what `ps` gives: binary path, working directory,
// thread and descriptor counts, and the ancestry chain btop shows.
// exe/cwd resolve only for processes the caller owns; they come back empty for
// everyone else's, which the panel renders as a dash rather than an error.
function collectProcDetail(pid) {
  var n = parseInt(pid, 10)
  if (!isFinite(n) || n <= 0) return "true"
  return (
    'p=' + n + '; ' +
    'echo "exe=$(readlink /proc/$p/exe 2>/dev/null)"; ' +
    'echo "cwd=$(readlink /proc/$p/cwd 2>/dev/null)"; ' +
    'echo "threads=$(awk \'/^Threads:/{print $2}\' /proc/$p/status 2>/dev/null)"; ' +
    'echo "fds=$(ls /proc/$p/fd 2>/dev/null | wc -l)"; ' +
    'echo "started=$(ps -o lstart= -p $p 2>/dev/null | sed \'s/^ *//\')"; ' +
    'c=$p; d=0; ' +
    'while [ -n "$c" ] && [ "$c" -gt 0 ] 2>/dev/null && [ "$d" -lt 8 ]; do ' +
      'echo "chain=$c|$(ps -o comm= -p $c 2>/dev/null)"; ' +
      'if [ "$c" = "1" ]; then break; fi; ' +
      'c=$(ps -o ppid= -p $c 2>/dev/null | tr -d " "); ' +
      'd=$((d+1)); ' +
    'done'
  )
}

// Per-process CPU snapshot plus the metadata rows, in one invocation.
//
// `ps %cpu` is NOT what a monitor wants: it is cputime/realtime averaged over
// the process's whole lifetime, and it is scaled to one core. A scanner that
// has held one core of sixteen since boot reports "98.1%", which reads as
// nearly the whole machine while the headline CPU figure says 12%. Both were
// right and they measured different things.
//
// So CPU% is computed here the way btop does it — utime+stime deltas between
// polls — and normalised against all cores, so the column sums toward the
// headline number instead of contradicting it.
//
// Field 2 of /proc/PID/stat is the command in parens and may itself contain
// spaces or parens, so everything is indexed after the LAST ") " rather than
// by naive whitespace splitting. Once the pid and comm are behind us, original
// field N is f[N-2]: utime 14→f[12], stime 15→f[13], num_threads 20→f[18],
// starttime 22→f[20]. Thread count and start time ride along free — the file
// is already open.
var COLLECT_PROC_SNAPSHOT =
  "awk '{ n=index($0, \") \"); if (n == 0) next; " +
       "rest = substr($0, n + 2); split(rest, f, \" \"); " +
       "print $1, f[12], f[13], f[18], f[20] }' /proc/[0-9]*/stat 2>/dev/null; " +
  "echo '@@PS'; " +
  "ps -eo pid,ppid,user:20,%mem,stat,nice,rss,comm --no-headers 2>/dev/null"

// ---------------------------------------------------------------- helpers

function _num(value) {
  var n = Number(value)
  return isFinite(n) ? n : 0
}

function _int(value) {
  var n = parseInt(value, 10)
  return isFinite(n) ? n : 0
}

function _lines(raw) {
  if (!raw) return []
  return String(raw).split("\n")
}

// ---------------------------------------------------------------- CPU

// One `cpu`/`cpuN` line from /proc/stat. Fields after `steal` (guest,
// guest_nice) are deliberately ignored: the kernel already counts guest time
// inside user and guest_nice inside nice, so adding them double-counts.
function parseCpuLine(line) {
  var parts = String(line || "").trim().split(/\s+/)
  if (parts.length < 5 || parts[0].indexOf("cpu") !== 0) return null
  return {
    name: parts[0],
    user: _int(parts[1]),
    nice: _int(parts[2]),
    system: _int(parts[3]),
    idle: _int(parts[4]),
    iowait: _int(parts[5]),
    irq: _int(parts[6]),
    softirq: _int(parts[7]),
    steal: _int(parts[8])
  }
}

// Busy percentage between two samples. iowait counts as idle — the CPU is not
// executing during it, and folding it into busy makes a disk-bound machine
// look CPU-bound.
function calcCpuPercent(prev, curr) {
  if (!prev || !curr) return 0
  var prevIdle = prev.idle + prev.iowait
  var currIdle = curr.idle + curr.iowait
  var prevTotal = prev.user + prev.nice + prev.system + prev.idle
                + prev.iowait + prev.irq + prev.softirq + prev.steal
  var currTotal = curr.user + curr.nice + curr.system + curr.idle
                + curr.iowait + curr.irq + curr.softirq + curr.steal
  var totalDelta = currTotal - prevTotal
  var idleDelta = currIdle - prevIdle
  // Counters are monotonic; a non-positive delta means a wrapped counter, a
  // repeated sample, or a CPU that went offline. Report 0 rather than a
  // negative or divide-by-zero.
  if (totalDelta <= 0) return 0
  var pct = (1 - (idleDelta / totalDelta)) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

function parseCpuStat(raw) {
  var out = { total: null, cores: [] }
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf("cpu") !== 0) continue
    var parsed = parseCpuLine(line)
    if (!parsed) continue
    if (parsed.name === "cpu") out.total = parsed
    else out.cores.push(parsed)
  }
  return out
}

// Pairs a previous parseCpuStat() with a current one.
// → { total: <pct>, cores: [<pct>, ...] }
function calcCpuPercents(prev, curr) {
  var out = { total: 0, cores: [] }
  if (!prev || !curr) return out
  out.total = calcCpuPercent(prev.total, curr.total)
  var n = Math.min(prev.cores.length, curr.cores.length)
  for (var i = 0; i < n; i++) out.cores.push(calcCpuPercent(prev.cores[i], curr.cores[i]))
  return out
}

// /proc/loadavg → "3.40 2.51 2.69 2/1835 1272876"
function parseLoadAvg(raw) {
  var parts = String(raw || "").trim().split(/\s+/)
  if (parts.length < 3) return null
  var procs = String(parts[3] || "").split("/")
  return {
    load1: _num(parts[0]),
    load5: _num(parts[1]),
    load15: _num(parts[2]),
    running: _int(procs[0]),
    total: _int(procs[1])
  }
}

// ---------------------------------------------------------------- memory

function parseFree(raw) {
  var out = { memTotal: 0, memUsed: 0, memFree: 0, memAvail: 0, swapTotal: 0, swapUsed: 0 }
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts[0] === "Mem:") {
      out.memTotal = _num(parts[1])
      out.memUsed = _num(parts[2])
      out.memFree = _num(parts[3])
      // `available` (field 6) is the honest number — it counts reclaimable
      // page cache that `free` does not. Fall back to `free` on the short
      // 4-column layout some busybox builds emit.
      out.memAvail = parts.length > 6 ? _num(parts[6]) : out.memFree
    } else if (parts[0] === "Swap:") {
      out.swapTotal = _num(parts[1])
      out.swapUsed = _num(parts[2])
    }
  }
  return out
}

// /sys/block/zram0/mm_stat — whitespace separated, first three fields:
//   orig_data_size  compr_data_size  mem_used_total
function parseZram(raw) {
  var parts = String(raw || "").trim().split(/\s+/)
  if (parts.length < 3) return null
  var orig = _num(parts[0])
  var compr = _num(parts[1])
  if (orig <= 0 || compr <= 0) return null
  return {
    origSize: orig,
    comprSize: compr,
    memUsed: _num(parts[2]),
    ratio: orig / compr
  }
}

// ---------------------------------------------------------------- pressure

// Expects the labelled form emitted by the collector script:
//   cpu some avg10=0.00 avg60=0.00 avg300=0.21 total=438666489
// The raw files carry no filename marker, so concatenating them without a
// label makes cpu/io/memory indistinguishable.
function parsePressure(raw) {
  var out = {}
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length < 3) continue
    var resource = parts[0]
    var kind = parts[1]
    if (kind !== "some" && kind !== "full") continue
    if (!out[resource]) out[resource] = {}
    for (var j = 2; j < parts.length; j++) {
      var kv = parts[j].split("=")
      if (kv.length === 2 && kv[0] === "avg10") out[resource][kind] = _num(kv[1])
    }
  }
  return out
}

// ---------------------------------------------------------------- network

function parseNetDev(raw) {
  var out = {}
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var colon = line.indexOf(":")
    if (colon < 0) continue
    var iface = line.substring(0, colon).trim()
    if (!iface || iface.indexOf("|") >= 0) continue
    var parts = line.substring(colon + 1).trim().split(/\s+/)
    if (parts.length < 10) continue
    out[iface] = {
      rxBytes: _num(parts[0]),
      rxPackets: _num(parts[1]),
      txBytes: _num(parts[8]),
      txPackets: _num(parts[9])
    }
  }
  return out
}

function calcNetRate(prev, curr, dtSeconds) {
  var rates = {}
  if (!prev || !curr || !(dtSeconds > 0)) return rates
  for (var iface in curr) {
    if (!prev[iface]) continue
    var rx = (curr[iface].rxBytes - prev[iface].rxBytes) / dtSeconds
    var tx = (curr[iface].txBytes - prev[iface].txBytes) / dtSeconds
    // Interface counters reset when a link drops; clamp rather than showing
    // a negative throughput.
    rates[iface] = { rxRate: Math.max(0, rx), txRate: Math.max(0, tx) }
  }
  return rates
}

// One line of streaming `bandwhich -r -p` output. The real format is:
//
//   process: <1788094173> "claude" up/down Bps: 0/628 connections: 3
//
// The angle-bracketed number is a per-refresh timestamp, NOT a pid — reading
// it as the process name is what put bare numbers in the panel. The name is
// the quoted field after it.
//
// bandwhich emits several rows per process (one per connection group) and
// re-emits the whole set each refresh, so rows are summed per name and keyed
// on the timestamp, which is how a new batch is detected.
//
// "<UNKNOWN>" is bandwhich's own output, not a parse failure: without root it
// cannot map another user's socket back to a process. Those rows are real
// traffic and are kept, labelled as unattributed.
function parseBandwhichLine(line) {
  var text = String(line || "").trim()
  if (text.indexOf("process:") !== 0) return null
  var m = text.match(/^process:\s*<([^>]*)>\s*"([^"]*)"\s+up\/down\s+Bps:\s*(\d+)\s*\/\s*(\d+)(?:\s+connections:\s*(\d+))?/)
  if (m) {
    return { cycle: m[1], process: m[2],
             txRate: _num(m[3]), rxRate: _num(m[4]), connections: _int(m[5]) }
  }
  // Older releases omitted the timestamp and bracketed the name directly.
  var alt = text.match(/^process:\s*[<"]?(.*?)[>"]?\s+up\/down\s+Bps:\s*(\d+)\s*\/\s*(\d+)(?:\s+connections:\s*(\d+))?/)
  if (!alt) return null
  return { cycle: "", process: alt[1],
           txRate: _num(alt[2]), rxRate: _num(alt[3]), connections: _int(alt[4]) }
}

// Folds one parsed row into the running per-refresh tally. A changed cycle id
// starts a fresh batch, so a process that stopped transmitting drops off
// instead of lingering at its last rate forever.
function bandwhichAccumulate(state, row) {
  if (!row) return state
  var st = state
  if (!st || st.cycle !== row.cycle) st = { cycle: row.cycle, byName: {} }
  var e = st.byName[row.process]
  if (e) {
    e.rxRate += row.rxRate
    e.txRate += row.txRate
    e.connections += row.connections
  } else {
    st.byName[row.process] = { process: row.process, rxRate: row.rxRate,
                               txRate: row.txRate, connections: row.connections }
  }
  return st
}

// Busiest talkers first, unattributed traffic last regardless of volume — it
// is the least actionable row and should not displace a named process.
function bandwhichTop(state, limit) {
  if (!state || !state.byName) return []
  var list = []
  for (var k in state.byName) list.push(state.byName[k])
  list.sort(function(a, b) {
    var au = isUnattributed(a.process), bu = isUnattributed(b.process)
    if (au !== bu) return au ? 1 : -1
    return (b.rxRate + b.txRate) - (a.rxRate + a.txRate)
  })
  return limit > 0 ? list.slice(0, limit) : list
}

function isUnattributed(name) {
  return /^<?unknown>?$/i.test(String(name || ""))
}

// ---------------------------------------------------------------- processes// ---------------------------------------------------------------- processes

// `ps -eo pid,ppid,user,%cpu,%mem,stat,nice,rss,comm[,args]`
// `args` must be last in the -o list: it contains spaces, so everything from
// field 9 onward is the command line and is taken verbatim.
function parsePsLine(line) {
  var text = String(line || "").trim()
  if (!text) return null
  var parts = text.split(/\s+/)
  if (parts.length < 9) return null
  return {
    pid: _int(parts[0]),
    ppid: _int(parts[1]),
    user: parts[2],
    cpu: _num(parts[3]),
    mem: _num(parts[4]),
    stat: parts[5],
    nice: _int(parts[6]),
    rss: _num(parts[7]) * 1024,          // ps reports RSS in KiB
    command: parts[8],
    fullCommand: parts.length > 9 ? parts.slice(9).join(" ") : parts[8]
  }
}

// Does a `ps` USER field refer to the given account?
//
// Plain `ps -eo user` truncates to 8 characters and appends `+`
// (jharrison → "jharris+"), so a direct equality test fails on every one of
// the current user's own processes — which would disable the kill button on
// exactly the rows where it works. The collectors use `user:20` to avoid the
// truncation, but this stays as a fallback for any narrower output.
function userMatches(psUser, currentUser) {
  var a = String(psUser || "")
  var b = String(currentUser || "")
  if (!a || !b) return false
  if (a === b) return true
  if (a.charAt(a.length - 1) === "+") return b.indexOf(a.slice(0, -1)) === 0
  return false
}

function parsePsOutput(raw) {
  var out = []
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var parsed = parsePsLine(lines[i])
    if (parsed) out.push(parsed)
  }
  return out
}

function formatState(stat) {
  var code = String(stat || "").charAt(0)
  var names = {
    R: "running",
    S: "sleeping",
    D: "disk sleep",
    Z: "zombie",
    T: "stopped",
    t: "tracing stop",
    X: "dead",
    I: "idle"
  }
  var base = names[code] || "unknown"
  var flags = []
  var rest = String(stat || "").substring(1)
  if (rest.indexOf("s") >= 0) flags.push("session leader")
  if (rest.indexOf("l") >= 0) flags.push("multi-threaded")
  if (rest.indexOf("+") >= 0) flags.push("foreground")
  if (rest.indexOf("<") >= 0) flags.push("high priority")
  if (rest.indexOf("N") >= 0) flags.push("low priority")
  return flags.length ? base + " (" + flags.join(", ") + ")" : base
}

// Splits COLLECT_PROC_SNAPSHOT into the tick table and the metadata rows.
// → { ticks: { pid: utime+stime }, rows: [ …parsePsLine without cpu… ] }
// Detail-view `ps` row: every field is fixed-width except `args`, which is
// last and takes the remainder.
//
// `comm` is deliberately NOT queried here. Both comm and args can contain
// spaces, and with both present positional parsing is ambiguous — a process
// named "Fell & Sell.exe" split into a comm of "Fell" and an args string
// starting at "&". The short name is carried in from the list row instead.
function parseProcDetailPs(line) {
  var text = String(line || "").trim()
  if (!text) return null
  var parts = text.split(/\s+/)
  if (parts.length < 9) return null
  return {
    pid: _int(parts[0]),
    ppid: _int(parts[1]),
    user: parts[2],
    cpu: _num(parts[3]),
    mem: _num(parts[4]),
    stat: parts[5],
    nice: _int(parts[6]),
    rss: _num(parts[7]) * 1024,
    fullCommand: parts.slice(8).join(" ")
  }
}

function parseProcSnapshot(raw) {
  var out = { ticks: {}, meta: {}, rows: [] }
  var parts = String(raw || "").split("@@PS")
  var lines = _lines(parts[0])
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].trim().split(/\s+/)
    if (f.length < 3) continue
    var pid = _int(f[0])
    if (pid <= 0) continue
    out.ticks[pid] = _int(f[1]) + _int(f[2])
    out.meta[pid] = { threads: _int(f[3]), startTicks: _int(f[4]) }
  }
  if (parts.length > 1) {
    var rows = _lines(parts[1])
    for (var j = 0; j < rows.length; j++) {
      var r = parseNoCpuPsLine(rows[j])
      if (r) out.rows.push(r)
    }
  }
  return out
}

// `ps -eo pid,ppid,user:20,%mem,stat,nice,rss,comm` — same as parsePsLine but
// without the %cpu column, which now comes from the tick deltas instead.
function parseNoCpuPsLine(line) {
  var text = String(line || "").trim()
  if (!text) return null
  var parts = text.split(/\s+/)
  if (parts.length < 8) return null
  return {
    pid: _int(parts[0]),
    ppid: _int(parts[1]),
    user: parts[2],
    mem: _num(parts[3]),
    stat: parts[4],
    nice: _int(parts[5]),
    rss: _num(parts[6]) * 1024,
    command: parts.slice(7).join(" "),
    cpu: 0,
    cpuCore: 0
  }
}

// Turns two tick snapshots into a per-pid CPU percentage.
//
// `cpu` is the share of the WHOLE machine (all cores) — the figure that lines
// up with the headline CPU number. `cpuCore` is the same measurement scaled to
// a single core, which is what top/htop/btop print and what lets you see that
// something is saturating one thread. Both are kept; the list shows the first.
function calcProcCpu(prevTicks, currTicks, dtSeconds, ncpu, clkTck) {
  var out = {}
  if (!prevTicks || !currTicks || !(dtSeconds > 0)) return out
  var cores = ncpu > 0 ? ncpu : 1
  var hz = clkTck > 0 ? clkTck : 100
  var elapsed = dtSeconds * hz
  if (elapsed <= 0) return out
  for (var pid in currTicks) {
    var prev = prevTicks[pid]
    if (prev === undefined) continue          // started since the last poll
    var delta = currTicks[pid] - prev
    if (delta < 0) delta = 0                  // pid reused
    var core = (delta / elapsed) * 100
    out[pid] = {
      cpu: Math.max(0, Math.min(100, core / cores)),
      cpuCore: Math.max(0, core)
    }
  }
  return out
}

// Merges computed CPU onto the metadata rows, sorts, and truncates.
// Rows with no CPU reading yet (first poll, or newly started) sort last rather
// than being dropped — a process that just appeared is still worth seeing.
//
// filterText, when non-empty, matches command, the full command line, and pid
// (all as case-insensitive substrings) and — this is the point of it —
// REPLACES the truncation rather than narrowing it: every match comes back
// regardless of limit. The limit is exactly what hides a process in the first
// place, and the process worth searching for is usually the one with nothing
// to earn it a place in the plain top-N view (a window that stopped
// responding is idle, not busy).
function mergeProcRows(rows, cpuByPid, sortBy, limit, meta, uptimeSeconds, filterText) {
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i]
    // A null map means "re-sort what is already here" (the sort toggle), so
    // the readings on the rows must survive; only a supplied map overwrites.
    if (cpuByPid) {
      var c = cpuByPid[r.pid]
      r.cpu = c ? c.cpu : 0
      r.cpuCore = c ? c.cpuCore : 0
    }
    if (meta && meta[r.pid]) {
      r.threads = meta[r.pid].threads
      // starttime is measured in clock ticks since boot, so elapsed is
      // uptime minus that — no dependence on wall-clock or timezone.
      r.elapsed = uptimeSeconds > 0
                ? Math.max(0, uptimeSeconds - meta[r.pid].startTicks / 100) : 0
    }
    out.push(r)
  }
  // Instantaneous CPU means most processes sit at exactly 0.0%, so a plain
  // CPU sort leaves the tail as an arbitrary run of idle kernel threads.
  // Breaking ties on memory keeps those rows informative.
  out.sort(sortBy === "mem"
    ? function(a, b) { return (b.rss - a.rss) || (b.cpu - a.cpu) }
    : function(a, b) { return (b.cpu - a.cpu) || (b.rss - a.rss) })

  var needle = String(filterText || "").trim().toLowerCase()
  if (needle) {
    return out.filter(function(r) {
      var hay = (String(r.command || "") + " " + String(r.fullCommand || "")).toLowerCase()
      return hay.indexOf(needle) >= 0 || String(r.pid).indexOf(needle) >= 0
    })
  }

  var n = limit > 0 ? limit : out.length
  return out.slice(0, n)
}

// ---------------------------------------------------------------- SMART

function parseSmartHealth(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return null
  }
  if (!data) return null
  var log = data.nvme_smart_health_information_log
  // smartctl emits valid JSON even when the device open fails — the health
  // log is simply absent. Treat that as unavailable, not as zeroes.
  if (!log) return null
  return {
    temp: _num(log.temperature),
    wearPercent: _num(log.percentage_used),
    powerOnHours: _num(log.power_on_hours),
    powerCycles: _num(log.power_cycles),
    unsafeShutdowns: _num(log.unsafe_shutdowns),
    mediaErrors: _num(log.media_errors),
    // NVMe data units are 1000 x 512-byte blocks.
    dataRead: _num(log.data_units_read) * 512000,
    dataWritten: _num(log.data_units_written) * 512000
  }
}

// ---------------------------------------------------------------- disk

// `df -h --output=source,size,used,avail,pcent,target`, deduplicated by
// source. On btrfs one filesystem is mounted many times (subvolumes), so the
// raw output repeats an identical device row per mount; rendering those
// as-is reads as several separate disks.
function parseDfOutput(raw) {
  var bySource = {}
  var order = []
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length < 6) continue
    if (parts[0].indexOf("/dev") !== 0) continue
    var source = parts[0]
    if (!bySource[source]) {
      bySource[source] = {
        source: source,
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        percent: _int(String(parts[4]).replace("%", "")),
        mounts: []
      }
      order.push(source)
    }
    bySource[source].mounts.push(parts[5])
  }
  var out = []
  for (var j = 0; j < order.length; j++) {
    var entry = bySource[order[j]]
    // Shortest mount reads as the primary one ("/" for the root group).
    entry.mounts.sort(function(a, b) { return a.length - b.length || (a < b ? -1 : 1) })
    entry.mount = entry.mounts[0]
    out.push(entry)
  }
  return out
}

// ---------------------------------------------------------------- sensors

// Collector emits `name|label|celsius` per reading.
function parseSensors(raw) {
  var out = []
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split("|")
    if (parts.length < 3) continue
    var temp = _num(parts[2])
    if (!parts[0] || !isFinite(temp)) continue
    out.push({ name: parts[0], label: parts[1] || "", tempC: temp })
  }
  return out
}

// The unfiltered scan yields ~18 readings on a typical desktop — 9 of them
// coretemp alone (package + one per core). The per-core values duplicate the
// CPU section's own bars, so the default view keeps one representative
// reading per device.
function filterSensors(sensors, showAll) {
  if (showAll) return sensors || []
  var out = []
  var seen = {}
  var preferred = {
    coretemp: /^package/i,
    amdgpu: /^edge$/i,
    nvme: /^composite$/i
  }
  for (var i = 0; i < (sensors || []).length; i++) {
    var s = sensors[i]
    var rule = preferred[s.name]
    if (rule) {
      if (!rule.test(s.label)) continue
    } else {
      // Devices with no rule (acpitz, iwlwifi) keep their first reading only.
      if (seen[s.name]) continue
    }
    seen[s.name] = true
    out.push(s)
  }
  // A kernel that labels things differently would filter to nothing; showing
  // everything beats showing an empty section.
  return _numberDuplicates(out.length ? out : (sensors || []))
}

// Two NVMe drives both report device name `nvme` with label `Composite`, so
// without a discriminator the panel shows two identical rows. Number only the
// names that actually repeat: a lone nvme stays "nvme", a pair becomes
// "nvme 1" / "nvme 2".
function _numberDuplicates(sensors) {
  var counts = {}
  var i
  for (i = 0; i < sensors.length; i++) counts[sensors[i].name] = (counts[sensors[i].name] || 0) + 1
  var seen = {}
  var out = []
  for (i = 0; i < sensors.length; i++) {
    var s = sensors[i]
    var display = friendlySensorName(s.name)
    if (counts[s.name] > 1) {
      seen[s.name] = (seen[s.name] || 0) + 1
      display = display + " " + seen[s.name]
    }
    out.push({ name: s.name, label: s.label, tempC: s.tempC,
               display: display, detail: friendlySensorLabel(s.name, s.label) })
  }
  return out
}

// Collector emits `name|rpm` per fan.
function parseFans(raw) {
  var out = []
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split("|")
    if (parts.length < 2) continue
    var rpm = _num(parts[1])
    if (!parts[0] || rpm <= 0) continue
    out.push({ name: parts[0], rpm: rpm })
  }
  return out
}

// ---------------------------------------------------------------- GPU

function parseGpuBusy(raw) {
  var text = String(raw || "").trim()
  if (!text) return 0
  return Math.max(0, Math.min(100, _int(text)))
}

// hwmon temp*_input values are millidegrees.
function parseMilliCelsius(raw) {
  var text = String(raw || "").trim()
  if (!text) return 0
  return _num(text) / 1000
}

// ---------------------------------------------------------------- GPU detail

// Parses the key=value output of collectGpuDetail().
// → { busy, memBusy, vramUsed, vramTotal, watts, wattsCap, fanRpm,
//     clocks: [{name, mhz}], temps: [{label, tempC}] }
function parseGpuDetail(raw) {
  var out = { busy: 0, memBusy: 0, vramUsed: 0, vramTotal: 0,
              watts: 0, wattsCap: 0, fanRpm: 0, clocks: [], temps: [] }
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    var eq = line.indexOf("=")
    if (eq < 0) continue
    var key = line.substring(0, eq)
    var val = line.substring(eq + 1)
    if (key === "busy") out.busy = Math.max(0, Math.min(100, _int(val)))
    else if (key === "membusy") out.memBusy = Math.max(0, Math.min(100, _int(val)))
    else if (key === "vramused") out.vramUsed = _num(val)
    else if (key === "vramtotal") out.vramTotal = _num(val)
    // power and freq are reported in micro-units.
    else if (key === "power") out.watts = _num(val) / 1000000
    else if (key === "powercap") out.wattsCap = _num(val) / 1000000
    else if (key === "fan") out.fanRpm = _num(val)
    else if (key.indexOf("freq:") === 0)
      out.clocks.push({ name: key.substring(5), mhz: Math.round(_num(val) / 1000000) })
    else if (key.indexOf("temp:") === 0)
      out.temps.push({ label: key.substring(5), tempC: _num(val) / 1000 })
  }
  return out
}

// ---------------------------------------------------------------- proc detail

// Parses collectProcDetail() output.
// → { exe, cwd, threads, fds, started, chain: [{pid, comm}] }
// chain[0] is the process itself; the rest walk up toward pid 1.
function parseProcDetail(raw) {
  var out = { exe: "", cwd: "", threads: 0, fds: 0, started: "", chain: [] }
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var eq = line.indexOf("=")
    if (eq < 0) continue
    var key = line.substring(0, eq)
    var val = line.substring(eq + 1).trim()
    if (key === "exe") out.exe = val
    else if (key === "cwd") out.cwd = val
    else if (key === "threads") out.threads = _int(val)
    else if (key === "fds") out.fds = _int(val)
    else if (key === "started") out.started = val
    else if (key === "chain") {
      var bar = val.indexOf("|")
      if (bar > 0) out.chain.push({ pid: _int(val.substring(0, bar)),
                                    comm: val.substring(bar + 1) })
    }
  }
  return out
}

// ---------------------------------------------------------------- sensor names

// hwmon device names are kernel driver names, not something a human reads.
// Map the common ones to what the sensor actually measures.
var SENSOR_NAMES = {
  coretemp: "CPU",
  k10temp: "CPU",
  zenpower: "CPU",
  amdgpu: "GPU",
  nouveau: "GPU",
  i915: "iGPU",
  nvme: "NVMe",
  acpitz: "Motherboard",
  iwlwifi_1: "Wi-Fi",
  iwlwifi: "Wi-Fi",
  mt7921_phy0: "Wi-Fi",
  nct6798: "Board",
  it8688: "Board",
  BAT0: "Battery"
}

function friendlySensorName(name) {
  var n = String(name || "")
  if (SENSOR_NAMES[n]) return SENSOR_NAMES[n]
  // USB-C power delivery controllers enumerate as ucsi_source_psy_*.
  if (n.indexOf("ucsi") === 0) return "USB-C"
  if (n.indexOf("nvme") === 0) return "NVMe"
  if (n.indexOf("iwlwifi") === 0) return "Wi-Fi"
  // Fall back to the raw name capitalised rather than inventing something.
  return n.charAt(0).toUpperCase() + n.slice(1)
}

// The label is only worth showing when it adds something the name does not.
// "temp1_input" is the filename fallback and says nothing; "Composite" is the
// only reading an NVMe drive has.
function friendlySensorLabel(name, label) {
  var l = String(label || "")
  if (l === "" || /^temp\d+_input$/.test(l)) return ""
  if (String(name).indexOf("nvme") === 0 && /^composite$/i.test(l)) return ""
  if (/^package id \d+$/i.test(l)) return "package"
  return l
}

// ---------------------------------------------------------------- formatting

function formatBytes(bytes) {
  var n = _num(bytes)
  if (n <= 0) return "0 B"
  var units = ["B", "KB", "MB", "GB", "TB", "PB"]
  var i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  // Raw bytes never need a decimal. Above that, keep one digit below 100 so
  // the main readouts match the panel design ("12.3 / 31.1 GB") and a bar
  // does not visibly jump a whole gigabyte at a time; drop it at 100+ where
  // the extra digit is noise ("347 MB").
  var decimals = (i === 0 || n >= 100) ? 0 : 1
  return n.toFixed(decimals) + " " + units[i]
}

function formatRate(bytesPerSec) {
  var n = _num(bytesPerSec)
  if (n <= 0) return "0 B/s"
  return formatBytes(n) + "/s"
}

function formatWatts(w) {
  var n = _num(w)
  return (n >= 100 ? Math.round(n) : n.toFixed(1)) + " W"
}

function formatMHz(mhz) {
  var n = _num(mhz)
  if (n >= 1000) return (n / 1000).toFixed(2) + " GHz"
  return Math.round(n) + " MHz"
}

function formatTemp(celsius) {
  return Math.round(_num(celsius)) + "°C"
}

function formatPercent(value) {
  return Math.round(_num(value)) + "%"
}

// Compact fixed-width runtime for a table column: 45s / 12m / 3h20 / 5d14
function formatElapsed(seconds) {
  var s = Math.floor(_num(seconds))
  if (s < 0) s = 0
  if (s < 60) return s + "s"
  var m = Math.floor(s / 60)
  if (m < 60) return m + "m"
  var h = Math.floor(m / 60)
  if (h < 24) return h + "h" + _pad2(m % 60)
  var d = Math.floor(h / 24)
  return d + "d" + _pad2(h % 24)
}

function _pad2(n) { return (n < 10 ? "0" : "") + n }

function formatUptime(seconds) {
  var s = Math.floor(_num(seconds))
  if (s <= 0) return "0m"
  var d = Math.floor(s / 86400)
  var h = Math.floor((s % 86400) / 3600)
  var m = Math.floor((s % 3600) / 60)
  var parts = []
  if (d > 0) parts.push(d + "d")
  if (h > 0) parts.push(h + "h")
  // Always show minutes unless days+hours already carry the magnitude.
  if (m > 0 || parts.length === 0) parts.push(m + "m")
  return parts.join(" ")
}

function formatCompressionRatio(diskSize, comprSize) {
  var orig = _num(diskSize)
  var compr = _num(comprSize)
  if (orig <= 0 || compr <= 0) return "--"
  return (orig / compr).toFixed(1) + ":1"
}

// Node-only export hook. `module` is undefined inside QML, so the guard makes
// this a no-op there while letting test-model.js require the file directly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    COLLECT_SENSORS: COLLECT_SENSORS,
    COLLECT_FANS: COLLECT_FANS,
    COLLECT_PRESSURE: COLLECT_PRESSURE,
    COLLECT_GPU_PATH: COLLECT_GPU_PATH,
    COLLECT_TOOL_PROBE: COLLECT_TOOL_PROBE,
    COLLECT_NVME_LIST: COLLECT_NVME_LIST,
    COLLECT_PROC_SNAPSHOT: COLLECT_PROC_SNAPSHOT,
    parseProcSnapshot: parseProcSnapshot,
    parseNoCpuPsLine: parseNoCpuPsLine,
    parseProcDetailPs: parseProcDetailPs,
    calcProcCpu: calcProcCpu,
    mergeProcRows: mergeProcRows,
    collectGpuDetail: collectGpuDetail,
    collectProcDetail: collectProcDetail,
    parseGpuDetail: parseGpuDetail,
    parseProcDetail: parseProcDetail,
    friendlySensorName: friendlySensorName,
    friendlySensorLabel: friendlySensorLabel,
    formatWatts: formatWatts,
    formatMHz: formatMHz,
    formatElapsed: formatElapsed,
    bandwhichAccumulate: bandwhichAccumulate,
    bandwhichTop: bandwhichTop,
    isUnattributed: isUnattributed,
    parseCpuLine: parseCpuLine,
    calcCpuPercent: calcCpuPercent,
    parseCpuStat: parseCpuStat,
    calcCpuPercents: calcCpuPercents,
    parseLoadAvg: parseLoadAvg,
    parseFree: parseFree,
    parseZram: parseZram,
    parsePressure: parsePressure,
    parseNetDev: parseNetDev,
    calcNetRate: calcNetRate,
    parseBandwhichLine: parseBandwhichLine,
    parsePsLine: parsePsLine,
    parsePsOutput: parsePsOutput,
    userMatches: userMatches,
    formatState: formatState,
    parseSmartHealth: parseSmartHealth,
    parseDfOutput: parseDfOutput,
    parseSensors: parseSensors,
    filterSensors: filterSensors,
    parseFans: parseFans,
    parseGpuBusy: parseGpuBusy,
    parseMilliCelsius: parseMilliCelsius,
    formatBytes: formatBytes,
    formatRate: formatRate,
    formatTemp: formatTemp,
    formatPercent: formatPercent,
    formatUptime: formatUptime,
    formatCompressionRatio: formatCompressionRatio
  }
}
