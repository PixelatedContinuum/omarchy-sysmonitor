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
//
// A function, not a plain string constant, specifically so it can
// reference SMART_HELPER_PATH (declared much later in this file): a
// forward reference inside a function body is fine, since nothing calls
// this until every top-level var in the module has already been assigned;
// the same reference inside a plain string-concatenation constant
// evaluated at module-load time would have silently captured `undefined`.
//
// The elevated smartctl branch tests the fixed helper via sudo, not
// smartctl directly: an earlier version of this probe (and of smartProc's
// own collector, below) kept testing/running `sudo -n smartctl ...`
// directly even after the sudoers grant was redesigned to permit only the
// helper with no arguments, so the probe and the actual collector were
// both silently testing and using a command the new sudoers rule no
// longer grants. Found only by checking what the currently-active grant
// on this machine actually permits (`sudo -n -l`), not by reading the
// code that builds the grant, since the plugin's own generated sudoers
// rule was never actually exercised end to end before that check.
function collectToolProbe() {
  return 'if command -v bandwhich >/dev/null 2>&1 && ' +
       'getcap "$(command -v bandwhich)" 2>/dev/null | grep -q cap_net_raw; ' +
       'then echo bandwhich-ok; fi; ' +
     'if command -v smartctl >/dev/null 2>&1; then ' +
       'if smartctl -j -a /dev/nvme0n1 >/dev/null 2>&1; then echo smartctl-ok; ' +
       'elif sudo -n ' + SMART_HELPER_PATH + ' >/dev/null 2>&1; then echo smartctl-sudo; fi; ' +
     'fi; ' +
     'true'
}

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
// headline number instead of contradicting it. That delta is the one thing
// `ps` cannot give at tick resolution, so it is still read straight from
// /proc/PID/stat.
//
// Thread count and elapsed time used to ride along on that same /proc read
// (num_threads and starttime were two more fields in the line below). They
// no longer do: this command is really two independent snapshots of the
// process table — the awk pass and the ps pass — taken microseconds apart,
// not atomically, and a process born or reaped in that gap lands in one and
// not the other. For CPU that is unavoidable (nothing else supplies tick
// deltas), but for threads/elapsed there is no need to accept the same race:
// `ps` reports both directly (`nlwp`, `etimes`), so they now come from the
// SAME invocation as state/mem/rss/comm below, closing the gap for those two
// fields entirely. See parseNoCpuPsLine.
//
// Field 2 of /proc/PID/stat is the command in parens and may itself contain
// spaces or parens, so everything is indexed after the LAST ") " rather than
// by naive whitespace splitting. Once the pid and comm are behind us, original
// field N is f[N-2]: utime 14→f[12], stime 15→f[13].
var COLLECT_PROC_SNAPSHOT =
  "awk '{ n=index($0, \") \"); if (n == 0) next; " +
       "rest = substr($0, n + 2); split(rest, f, \" \"); " +
       "print $1, f[12], f[13] }' /proc/[0-9]*/stat 2>/dev/null; " +
  "echo '@@PS'; " +
  "ps -eo pid,ppid,user:20,%mem,stat,nice,rss,nlwp,etimes,comm --no-headers 2>/dev/null"

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

// Strict allow-list for a network interface name before it can be used to
// build a privileged command (bandwhich runs under a granted capability).
// The kernel's own dev_valid_name() (net/core/dev.c) already rejects '/',
// whitespace, and names >= IFNAMSIZ (16, so 15 usable chars) at interface
// creation time — but relying on an upstream data source's assumed-safe
// character set is exactly the kind of thing that stops being true the
// moment any part of the chain (ip route's output shape, an unusual virtual
// interface, a parsing edge case) changes. An allow-list checked at the one
// point this name is about to be used to build a command is cheap and does
// not depend on any of that continuing to hold.
function isValidIfaceName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,14}$/.test(String(name || ""))
}

// Same reasoning, same shape of fix, for the NVMe device paths smartProc's
// non-elevated branch splices into a shell string with no `sq()` quoting
// and no allow-list, the one collector command review point 3 named the
// pattern for (bandwhich's interface name) that did not actually get it.
// Not reachable today, COLLECT_NVME_LIST's own source is a fixed
// `for d in /dev/nvme?n1; do [ -b "$d" ] && echo "$d"; done`, so poisoning
// it needs root to mknod a device named with a quote, but an upstream
// data source's assumed-safe character set is exactly the kind of thing
// that stops being true the moment any part of that chain changes, the
// same argument isValidIfaceName's own comment makes. `?` in that glob
// matches exactly one character, so this only ever needs to accept
// single-digit controller numbers in practice, but the digit run is left
// unbounded rather than pinned to one, so a future widening of the source
// glob does not silently start failing every real device again.
function isValidNvmeDevice(path) {
  return /^\/dev\/nvme[0-9]+n[0-9]+$/.test(String(path || ""))
}

// Checked even though the value normally comes straight from $USER for
// the already-logged-in account, not attacker input in the ordinary case,
// the same reasoning as isValidIfaceName above: relying on an upstream
// source's assumed-safe character set is exactly the assumption that
// stops holding the moment anything upstream changes. Here the value is
// concatenated directly into a root-owned sudoers principal field
// (smartSudoersRule below), where a `#`-comment or a second
// `ALL=(ALL) NOPASSWD:` clause smuggled through the "username" would
// grant far more than the one narrow command this plugin intends, and
// unlike a malformed sudoers line, an INJECTED one is syntactically
// valid, so `visudo -cf` cannot catch it downstream.
//
// The shape matches useradd(8)'s own CAVEATS section, checked against the
// actual man page on this system, not assumed: letters in EITHER case,
// digits, underscore, dash, or dot; an optional trailing $; no leading
// dash; not fully numeric; not literally "." or ".."; up to 256 chars. An
// earlier, narrower version of this function (lowercase-only, no dots, 32
// chars) rejected real Arch usernames like "John" or "john.doe", and
// since none of the characters an injection actually needs (space, #, =,
// parens, colon, slash) were ever in the useradd-allowed set to begin
// with, that narrowing bought no extra safety, just false rejections.
function isValidUsername(name) {
  var s = String(name || "")
  if (s.length === 0 || s.length > 256) return false
  if (s === "." || s === "..") return false
  if (s.charAt(0) === "-") return false
  if (!/^[A-Za-z0-9_.-]+\$?$/.test(s)) return false
  var core = s.charAt(s.length - 1) === "$" ? s.slice(0, -1) : s
  if (/^[0-9]+$/.test(core)) return false   // "fully numeric" usernames are disallowed
  // ALL is composed entirely of letters useradd would happily accept, but
  // in the User_List position of a sudoers rule specifically, ALL is a
  // reserved alias meaning "every user on the system", not a name at
  // all. No real useradd-created account is named exactly this, so
  // rejecting it costs nothing and closes the one case where a
  // "syntactically fine as a username" value still broadens the grant.
  return core !== "ALL"
}

// Bounds a string before it reaches a Text element, for every value on this
// panel that ultimately comes from outside the plugin — a process name, a
// mount path, a device or sensor label, subprocess stderr. None of those
// sources is under this plugin's control, so none of them gets to grow a UI
// element without a limit just because a real system has not (yet) produced
// one that long. Cutting the STRING here, not just eliding it visually,
// matters: an elided Text still holds the full value in memory and in
// anything downstream (a tooltip, a copy, a future binding) that reads the
// same property — this is the one place the length actually stops.
//
// maxLen is required, not defaulted — every call site names the bound it
// chose for that field, which is easier to review than one hidden global.
function truncateDisplay(str, maxLen) {
  var s = String(str === undefined || str === null ? "" : str)
  var n = maxLen > 0 ? maxLen : 1
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s
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

// Builds a single shell command that re-reads a pid's current owner, comm,
// and elapsed time and only runs `actionCmd` if all three still match what
// was on screen when the user acted. The process list is a snapshot up to
// pollInterval old, and choosing a row, then pressing a key or confirming a
// force-kill, adds real human time on top of that. If the original process
// exited in that window the kernel is free to hand its pid to something
// else entirely, and a signal sent on pid alone would land on whatever that
// is — not what the user selected. Elapsed time only ever grows for a
// process that kept running, so a fresh reading that comes back lower than
// expected is itself evidence of reuse, not measurement noise; a small
// tolerance absorbs polling/extrapolation rounding without opening the
// window back up. Reading and acting happen inside one `ps` + one shell
// process, so there is no second gap between the check and the act for a
// reuse to land in.
//
// actionCmd must not itself depend on anything other than the pid/signal/
// nice-value literals the caller already embedded in it (e.g. "kill -TERM
// 1234") — this only wraps a guard around it, it does not sanitize it.
function buildGuardedSignalCommand(pid, actionCmd, expectedUser, expectedComm, expectedElapsed) {
  var p = _int(pid)
  var user = String(expectedUser || "")
  var comm = String(expectedComm || "")
  var elapsed = _num(expectedElapsed)
  var tolerance = 3 // seconds of slack for polling/extrapolation rounding
  var floor = Math.max(0, Math.floor(elapsed - tolerance))
  // Single-quote for POSIX sh; a literal single quote inside a value (rare
  // in a username or comm, but comm can hold nearly anything) is escaped by
  // closing the quote, emitting an escaped quote, and reopening it.
  var sq = function(s) { return "'" + s.replace(/'/g, "'\\''") + "'" }
  return "u=$(ps -o user:20= -p " + p + " 2>/dev/null | tr -d ' '); " +
         "c=$(ps -o comm= -p " + p + " 2>/dev/null); " +
         "e=$(ps -o etimes= -p " + p + " 2>/dev/null | tr -d ' '); " +
         "if [ \"$u\" = " + sq(user) + " ] && [ \"$c\" = " + sq(comm) + " ] " +
         "&& [ -n \"$e\" ] && [ \"$e\" -ge " + floor + " ]; then " +
         actionCmd + "; " +
         "else echo " + sq("REFUSED: pid " + p + " no longer matches the selected process") + " >&2; exit 3; fi"
}

// ------------------------------------------------- collector process safety
//
// Every periodic collector is a short read-only shell one-liner over /proc
// and /sys that should complete in well under a second — but nothing stops
// a corrupted sysfs value, an unusual device node, or a blocked read from
// turning one of them into a subprocess that never exits. The three
// functions below back the three things that need to be true regardless:
// output cannot grow without bound, a hang cannot run forever, and killing
// a hung collector cannot leave any of its own children behind as orphans.

// Output-cap tiers for wrapCollectorCommand, named rather than passed as
// bare numbers at each of the ~15 call sites: TINY for a handful of fixed
// short lines (load average, a probe result, a device list), MEDIUM for
// readings that scale with hardware (cores, sensors, interfaces) but stay
// bounded by what one machine actually has, LARGE for readings that scale
// with mounted filesystems or JSON-formatted drive health, and XLARGE only
// for the process snapshot, the one collector whose output genuinely scales
// with how busy the machine is (hundreds of processes on a loaded system).
var OUTPUT_CAP_TINY = 8192
var OUTPUT_CAP_MEDIUM = 65536
var OUTPUT_CAP_LARGE = 262144
var OUTPUT_CAP_XLARGE = 1048576

// Wraps a collector script as a full argv command: run under `setsid` so
// the whole pipeline (every stage — awk, cat, ps, whatever the script
// forks) lands in ONE process group distinct from the plugin's own, and
// piped through `head -c` so total output is bounded no matter how much a
// pathological /proc/sysfs read would otherwise produce. The subshell
// `( ... )` wrapper makes piping safe regardless of the script's own
// internal structure (loops, conditionals, multiple statements) — POSIX
// guarantees a subshell's combined stdout is one pipeable stream.
//
// Verified empirically (not just by reading setsid's manual): a plain
// pipeline launched this way puts every stage in a process group distinct
// from the launching shell's own, confirmed with `ps -o pgid=` before and
// after — see buildGroupKillCommand for how that group is torn down.
function wrapCollectorCommand(script, maxOutputBytes) {
  var n = maxOutputBytes > 0 ? _int(maxOutputBytes) : 65536
  return ["setsid", "--", "bash", "-c", "( " + String(script || "true") + " ) | head -c " + n]
}

// Given the tracked {name, startedAt, deadlineMs} for every collector
// currently believed to be running and the current time, returns the names
// of any that have run past their deadline. Pure decision logic — actually
// killing a process is a QML-side effect (Process.signal / execDetached),
// this only decides which ones qualify.
function overdueCollectors(tracked, nowMs) {
  var now = _num(nowMs)
  return (tracked || [])
    .filter(function(t) { return t && now - _num(t.startedAt) >= _num(t.deadlineMs) })
    .map(function(t) { return t.name })
}

// Builds a fire-and-forget shell command that looks up pid's CURRENT
// process group and kills the whole group, not just pid itself. A hung
// collector launched via wrapCollectorCommand is the group LEADER (setsid
// guarantees that), so this reaches every pipeline stage it forked, even
// ones that would otherwise be reparented to init and keep running after
// the leader alone was killed. Re-reads the pgid fresh rather than
// assuming it equals pid — correct regardless of exactly how setsid's own
// fork/exec played out for a given process.
function buildGroupKillCommand(pid) {
  var p = _int(pid)
  if (p <= 0) return "true"
  return "pgid=$(ps -o pgid= -p " + p + " 2>/dev/null | tr -d ' '); " +
         "[ -n \"$pgid\" ] && kill -KILL -- \"-$pgid\" 2>/dev/null; true"
}

// ------------------------------------------------- privilege-grant safety
//
// Two sections (bandwhich's capability, smartctl's sudoers rule) ask for a
// persistent privilege the panel does not itself hold. All of it runs
// through the functions below, for four reasons a marketplace reviewer
// named directly: what we are about to grant a privilege TO needs checking
// before we grant it (provenance), a grant that already exists needs
// noticing rather than silently overwriting (collision), what was there
// before needs saving so a revoke can restore it rather than guessing at a
// bare "off" state (backup), and there needs to be an actual "off" a user
// can reach without uninstalling the whole plugin (rollback).

// Unprivileged — no pkexec needed to answer "is this the binary we think it
// is". Emits one KEY=value line per fact so parseExecutableValidation can
// name exactly which check failed rather than a single opaque yes/no.
// Deliberately run and checked BEFORE ever prompting for a password: if
// this already fails, elevating would just ask for credentials to do
// something we are not going to do anyway.
function buildExecutableValidationScript(path) {
  var sq = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
  var p = sq(String(path || ""))
  return "real=$(readlink -f -- " + p + " 2>/dev/null); echo \"REAL=$real\"; " +
    "case \"$real\" in " +
    "  /usr/bin/*|/usr/sbin/*|/usr/local/bin/*|/usr/local/sbin/*) echo 'PATHOK=1' ;; " +
    "  *) echo 'PATHOK=0' ;; " +
    "esac; " +
    "if [ -n \"$real\" ] && [ -f \"$real\" ] && [ ! -L \"$real\" ]; then echo 'TYPEOK=1'; else echo 'TYPEOK=0'; fi; " +
    "owner=$(stat -c '%U' -- \"$real\" 2>/dev/null); echo \"OWNER=${owner:-unknown}\"; " +
    "if command -v pacman >/dev/null 2>&1; then " +
    "  if [ -n \"$real\" ] && pacman -Qo -- \"$real\" >/dev/null 2>&1; then echo 'PKGOK=1'; else echo 'PKGOK=0'; fi; " +
    "else echo 'PKGOK=SKIP'; fi"
}

// Pure parser for the script above — the actual pass/fail decision, kept
// separate from the shell text so it is testable without a subprocess.
// PKGOK=SKIP (no pacman on this system) does not fail validation on its
// own; every other check does.
function parseExecutableValidation(output) {
  var lines = String(output || "").split("\n")
  var kv = {}
  for (var i = 0; i < lines.length; i++) {
    var eq = lines[i].indexOf("=")
    if (eq > 0) kv[lines[i].substring(0, eq)] = lines[i].substring(eq + 1)
  }
  var reasons = []
  if (!kv.REAL) reasons.push("could not resolve a real path")
  if (kv.PATHOK !== "1") reasons.push("resolved path is outside trusted system directories")
  if (kv.TYPEOK !== "1") reasons.push("not a regular file")
  if (kv.OWNER !== "root") reasons.push("not owned by root (owner: " + (kv.OWNER || "unknown") + ")")
  if (kv.PKGOK === "0") reasons.push("not tracked by any installed package")
  return { ok: reasons.length === 0, realPath: kv.REAL || "", reasons: reasons }
}

// The privileged half of granting bandwhich's capability: re-resolves the
// path (never trusts the unprivileged validation pass alone — this is the
// invocation that actually matters), records whatever capability string
// was already set before overwriting it (so revokeBandwhich can restore
// exactly that instead of guessing "probably nothing"), then applies the
// new one. backupPath lives under the plugin's own directory, not /etc —
// this plugin is a per-user install and the backup is per-user state, not
// system configuration.
function buildGrantCapabilityScript(path, capString, backupPath) {
  var sq = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
  var bp = sq(String(backupPath || ""))
  var bdirRaw = String(backupPath || "").replace(/\/[^/]*$/, "")
  var bdir = sq(bdirRaw)
  // Every ancestor of the backup directory, not just its immediate parent.
  // Round-4 adversarial review found the previous guard checked only bdir
  // itself and bp (the leaf file) for -L, and demonstrated the gap directly:
  // replacing ~/.local/state itself with a symlink, two levels above bdir,
  // sails straight past both checks, since bdir's own name is a perfectly
  // ordinary directory once its parent has already been swapped, and
  // `mkdir -p` silently follows a symlinked intermediate component rather
  // than refusing it. Walking every prefix of bdir's path and refusing if
  // any one of them is a symlink closes that gap regardless of which level
  // the plant happens at, not just the bottom two.
  //
  // Verified empirically, not assumed from the shape alone: a fresh
  // install where no ancestor exists yet still passes (`-L` on a path that
  // does not exist is false, not an error, so this does not wrongly refuse
  // every first-ever grant), a normal install with real directories at
  // every level passes, and a symlink planted at the leaf, at the
  // immediate parent, and two levels up are all three refused. An earlier
  // draft of this fix compared readlink -f's resolution of the whole
  // directory against the literal expected path in one shot, which is
  // simpler but wrong: readlink -f requires every component but the last
  // to already exist, so it fails outright (and would have refused) on
  // the fresh-install case, which is the most common case this code path
  // actually runs. Found by testing that draft against a genuinely empty
  // ancestor chain before shipping it, not by reasoning about it.
  var bdirParts = bdirRaw.split("/").filter(function(p) { return p !== "" })
  var ancestorGuard = ""
  var prefix = ""
  for (var i = 0; i < bdirParts.length; i++) {
    prefix += "/" + bdirParts[i]
    ancestorGuard += "[ ! -L " + sq(prefix) + " ] || exit 25; "
  }
  return "real=$(readlink -f -- " + sq(String(path || "")) + "); " +
    "case \"$real\" in /usr/bin/*|/usr/sbin/*|/usr/local/bin/*|/usr/local/sbin/*) : ;; *) exit 20 ;; esac; " +
    "[ -f \"$real\" ] && [ ! -L \"$real\" ] || exit 21; " +
    "[ \"$(stat -c '%U' -- \"$real\")\" = root ] || exit 22; " +
    // getcap's own output is "PATH CAPSPEC", not a bare capability string
    // (confirmed directly: `getcap -- /usr/bin/bandwhich` prints
    // "/usr/bin/bandwhich cap_net_admin,cap_net_raw=eip"), and setcap
    // refuses that whole line verbatim as its own first argument with a
    // clean parse error. Storing getcap's raw output as the backup, then
    // replaying it straight back into setcap on revoke, meant the restore
    // path never actually worked in its own intended, legitimate case,
    // found while checking a separate, adjacent concern, not by either
    // adversarial pass. `${raw#"$real "}` strips the known prefix via
    // parameter expansion, not a regex: the pattern is fully quoted, so a
    // glob-special character anywhere in $real (verified with a literal
    // `[...]` in a test path) is matched literally, not as a wildcard.
    "raw=$(getcap -- \"$real\" 2>/dev/null || true); old=${raw#\"$real \"}; " +
    // This whole script runs as root (pkexec), and backupPath lives under
    // the invoking user's own writable home directory (see the comment
    // above), a directory the user, or anything running as them, could
    // have pre-planted a symlink in, at any level, not just the immediate
    // parent (see the ancestor-walk comment above bdirParts). `printf >
    // backupPath` would follow that symlink and let a root-privileged
    // write land wherever it points. `-L` (not `-e`) is what actually
    // catches this: `-e` follows a symlink to check whether ITS TARGET
    // exists, so a dangling symlink reads as "nothing here yet" and would
    // sail through an `-e`-based check straight into mkdir/the write. `-L`
    // uses lstat semantics and reports "this path is a symlink" regardless
    // of whether it resolves. Verified directly: a plain `>` redirect
    // follows a symlink to its target, and `mv` replaces the symlink
    // itself instead of writing through it, so the actual write goes
    // through a freshly mktemp'd file and mv, not a redirect into the
    // destination path.
    ancestorGuard +
    "mkdir -p -- " + bdir + " || exit 25; " +
    "[ ! -L " + bp + " ] || exit 25; " +
    "bt=$(mktemp) && printf '%s' \"$old\" > \"$bt\" && mv -f \"$bt\" " + bp + " && " +
    // No `--` before "$real": found only by actually running this command
    // privileged (unshare -Ur, matching the survey method used elsewhere in
    // this file) rather than trusting that `--` means what it means for
    // every other tool used here. setcap has no getopt-style option
    // terminator at all; its own usage string pairs arguments strictly
    // positionally, (capsOrFlag, filename) repeating, so `--` is consumed
    // as the FILENAME of the current pair, not as a separator, and the
    // real target is left as an orphaned, silently-ignored extra argument.
    // Confirmed directly: `setcap 'cap_net_raw=ep' -- /path/to/target`
    // fails with "Failed to set capabilities on file '--': No such file or
    // directory" and getcap on the real target afterward shows no change,
    // while the identical command with `--` simply omitted succeeds and
    // getcap confirms it. This plugin's own first eleven commits invoked
    // setcap correctly, as a direct argv array with no `--` at all; a
    // fifth adversarial pass found, via `git log -S` against this repo's
    // own history, that `--` was introduced by the hardening commit that
    // first answered a maintainer's review of this plugin, not present
    // from the start as an earlier version of this comment claimed. It
    // then survived four more adversarial rounds of review, because every
    // one of them, and every prior test, ran unprivileged, where setcap
    // fails at the permission check before argument parsing is ever
    // reached, so no prior run could have told this apart from an
    // ordinary unprivileged failure. Dropping `--` is safe, not just
    // necessary: setcap's filename slot is positional regardless of its
    // own content (verified separately against a real target file named
    // with a leading hyphen), and the caps/flag slot immediately before it
    // is either a fixed string literal at each call site (capString here)
    // or, on the revoke side, a value that cannot begin with a hyphen at
    // all once it has matched buildRevokeCapabilityScript's own capRe
    // (see its own comment).
    "setcap " + sq(String(capString || "")) + " \"$real\""
}

// Restores whatever capability string buildGrantCapabilityScript backed
// up — a full "off" (no capability at all) only when there is no backup to
// restore, e.g. a fresh grant that had nothing before it. Reading the
// backup and clearing it happen in the same script as the restore so a
// revoke cannot partially apply and then be re-run against a backup file
// that no longer describes the true prior state.
// Refuses to touch the capability at all when no backup file exists (exit
// 23) rather than defaulting to "strip everything". A missing backup means
// this plugin never actually recorded a grant at this path — most likely
// because the capability predates this plugin (bandwhich's own docs
// recommend the exact same setcap line as a manual install step) — and
// stripping a capability this plugin never granted, with no record to
// restore it from, is exactly the kind of silent, unrecoverable action
// backup/rollback exists to prevent. Only a real backup file (even one
// holding an empty string, meaning "there was genuinely nothing before
// this plugin's own grant") authorizes a change here.
function buildRevokeCapabilityScript(path, backupPath) {
  var sq = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
  var bp = sq(String(backupPath || ""))
  // Structural validator for $old, not a charset. A charset only asks
  // whether a string is built from safe characters; it cannot ask which
  // capabilities it names. A fifth adversarial pass found that this
  // function's own prior charset guard accepted "all=eip" (the reserved
  // cap_from_text(3) keyword, built entirely from ordinary letters) and,
  // verified end to end against this plugin's own generated scripts under
  // real privilege, root's setcap then granted the complete capability
  // set to a world-executable binary through a button whose only
  // advertised purpose is to reduce a privilege. This grammar instead
  // requires one or more whitespace-separated clauses, each a
  // comma-separated list of names shaped like a real capability name
  // (cap_ followed by lowercase letters and underscores, the only shape
  // getcap's own output ever takes, verified directly, never the bare
  // "all" keyword), followed by =/+/- and zero or more of the three
  // lowercase flag characters. A bare "=" is also accepted: it is getcap's
  // own rendering of an explicitly-empty capability set, confirmed
  // directly, distinct from no attribute at all. This still authorizes
  // restoring any real, specific prior capability this account never
  // chose, which is the backup mechanism's actual purpose; it excludes
  // only the one keyword that expands to every capability in existence,
  // which getcap itself never emits as output and no legitimate backup
  // content could ever need. setcap's own parser remains the final,
  // stricter gate underneath this, the same division of labor visudo -cf
  // has elsewhere in this codebase.
  var clause = "cap_[a-z_]+(,cap_[a-z_]+)*[=+-][eip]*"
  var capRe = "^(=|" + clause + ")( " + clause + ")*$"
  return "real=$(readlink -f -- " + sq(String(path || "")) + "); " +
    "[ -n \"$real\" ] || exit 20; " +
    // `-f` alone is not enough: it follows a symlink to check whether ITS
    // TARGET is a regular file, so a symlink planted at backupPath
    // pointing at some other regular file would still pass `-f` and get
    // `cat`'d, feeding root's setcap whatever that file holds. `-L`
    // (lstat, does not follow) refuses outright if backupPath is a
    // symlink at all, same reasoning as the grant side above.
    "[ -f " + bp + " ] && [ ! -L " + bp + " ] || exit 23; " +
    "old=$(cat " + bp + " 2>/dev/null || true); " +
    // The symlink guard above protects the PATH; this protects the
    // CONTENT, and this is the part that mattered most: backupPath lives
    // in a location this account can write to by design, so nothing stops
    // it (or anything running as it) from overwriting the file directly
    // with some other syntactically-shaped capability string, which an
    // unguarded restore would hand straight to root's setcap. See capRe
    // above for what actually happened here across two prior rounds of
    // review before this fix, and why the check is a grammar now, not a
    // charset.
    //
    // rc is captured explicitly in every branch, including the empty-backup
    // one, rather than assumed or left to whatever the trailing cleanup
    // command returns: a failed setcap (wrong privilege, or a
    // structurally-valid string setcap's own parser still rejects) needs
    // to be reported as the failure it is, not masked as success because
    // cleanup ran last and cleanup usually succeeds. The cleanup itself
    // runs only on success: a failed restore, whichever branch it failed
    // in, leaves the backup file in place rather than deleting the one
    // record of what to restore, so a retry after the underlying problem
    // is fixed still has something to restore from.
    //
    // Neither setcap call below has a `--` in front of "$real" (an earlier
    // version of both this comment and the code had one, on the mistaken
    // assumption that it protects $real the way it would for a coreutils
    // command): see buildGrantCapabilityScript's setcap line for why that
    // assumption is wrong for setcap specifically, and why $real does not
    // need that protection anyway.
    //
    // [[ =~ ]] is used for the non-empty branch rather than a case/glob
    // pattern, what every other guard in this file uses: POSIX glob
    // patterns have no way to express alternation or the repeated
    // "clause, clause, clause" structure capRe needs. The pattern is
    // passed unquoted after =~, required for bash to treat it as a regular
    // expression rather than a literal string match, verified directly.
    // capRe already requires the string to start with "cap_" or a bare
    // "=", so nothing starting with a hyphen (setcap's own flags all
    // begin with one, confirmed directly against setcap's exact-strcmp
    // flag handling) can reach the catch-all branch at all; no separate
    // leading-hyphen guard is needed on top of it.
    //
    // The empty-backup branch's rc=$? is the literal exit status of
    // `setcap -r`, which is not quite the same question as "did the
    // restore succeed": setcap -r on a file that already has no
    // capability to remove exits nonzero too (confirmed directly, under
    // real privilege, against a file with nothing on it), and that is
    // this branch's single most common case, a user whose bandwhich had
    // no capability before this plugin's own grant. Rather than pattern
    // match setcap's own error text, which is not guaranteed stable
    // across libcap versions or locales, a failed attempt is followed by
    // one more getcap on the same target: if it now reports no capability
    // at all, the end state this branch exists to reach was already
    // reached (this plugin's own grant may have simply never taken, or a
    // package upgrade replaced the binary with a fresh, capability-less
    // inode since the grant, both real scenarios, not just theoretical),
    // and rc is corrected to 0. If getcap still shows a capability, the
    // failure was real (wrong privilege, read-only filesystem, an
    // immutable bit) and rc is left exactly as setcap reported it.
    "case \"$old\" in " +
    "  '') setcap -r \"$real\" 2>/dev/null; rc=$?; " +
    "      if [ \"$rc\" -ne 0 ] && [ -z \"$(getcap -- \"$real\" 2>/dev/null)\" ]; then rc=0; fi ;; " +
    "  *) if [[ \"$old\" =~ " + capRe + " ]]; then setcap \"$old\" \"$real\"; rc=$?; else rc=26; fi ;; " +
    "esac; " +
    "[ \"$rc\" -eq 0 ] && rm -f " + bp + "; " +
    "exit $rc"
}

// Installs `content` at targetPath, but never as a blind overwrite:
// pre-existing content that DIFFERS from what we are about to write is
// copied aside with a timestamped .bak suffix first, so a file that was
// already there — from a previous version of this plugin, or coincidence —
// is not silently lost with no way back. Re-running with identical
// content is a no-op backup-wise (there is nothing to lose). validateCmd,
// when given, must pass against the staged temp file before install is
// even attempted — a validation failure leaves the existing target
// completely untouched. Verified by hand against all three outcomes
// (fresh install, differing-content collision, failing validation) before
// being encoded here — see the session's own scratch verification.
function buildCollisionSafeInstallScript(targetPath, content, mode, owner, group, validateCmd) {
  var sq = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
  var tp = sq(String(targetPath || ""))
  var m = String(mode || "0644")
  var o = String(owner || "root")
  var g = String(group || "root")
  var validate = validateCmd ? (validateCmd + " \"$t\" && ") : ""
  // The backup name is reserved with mktemp (which creates the file
  // atomically), not a second-resolution timestamp: two collisions inside
  // the same second used to reuse the same `.bak-$(date +%s)` name and the
  // second `cp -p` silently overwrote the first backup, exactly the
  // silent-overwrite this function exists to prevent.
  //
  // The `-L` check on the target itself is defense in depth rather than a
  // response to a reachable path on this specific plugin's two callers
  // (/usr/local/bin and /etc/sudoers.d are both root:root and not
  // user-writable, checked directly, not assumed): if targetPath were
  // ever a symlink, `cp -p` would read through it into the backup rather
  // than recognizing it as one. `install`, the actual write at the end,
  // already replaces a symlink destination rather than following it
  // (verified directly, the same way `mv` does), so no equivalent guard
  // is needed there.
  //
  // The ancestor walk below is the same reasoning, extended to match: a
  // fifth adversarial pass found that a comment describing this
  // function's guard alongside buildGrantCapabilityScript's own ancestor
  // walk claimed both covered "any ancestor", when this one covered only
  // the destination itself. Demonstrated (against a caller other than
  // this plugin's own two, since neither of those two is reachable here):
  // a symlinked parent directory is followed, and the file lands outside
  // it, exit 0. Still not reachable through this plugin's own two callers
  // today, for the same reason the leaf check already was defense in
  // depth rather than a response to a live path, but the guard now
  // actually matches what it was already believed to do, for any future
  // caller as much as this one.
  var targetDir = String(targetPath || "").replace(/\/[^/]*$/, "")
  var dirParts = targetDir.split("/").filter(function(p) { return p !== "" })
  var ancestorGuard = ""
  var prefix = ""
  for (var i = 0; i < dirParts.length; i++) {
    prefix += "/" + dirParts[i]
    ancestorGuard += "[ ! -L " + sq(prefix) + " ] || exit 1; "
  }
  return ancestorGuard +
    "t=$(mktemp) && printf '%s' " + sq(String(content || "")) + " > \"$t\" && chmod " + m + " \"$t\" && " +
    validate +
    "[ ! -L " + tp + " ] && " +
    "{ [ -e " + tp + " ] && ! cmp -s \"$t\" " + tp + " && bak=$(mktemp " + tp + ".bak-XXXXXX 2>/dev/null) && cp -p " + tp + " \"$bak\" 2>/dev/null; true; } && " +
    "install -m " + m + " -o " + o + " -g " + g + " \"$t\" " + tp + "; " +
    "rc=$?; rm -f \"$t\"; exit $rc"
}

// Fixed install locations for the smartctl helper — a root-owned script
// the sudoers rule below grants with NO arguments at all, in place of a
// sudoers command glob (`smartctl -j -a /dev/nvme*n1`) that has to be
// matched against whatever the caller actually typed. Nothing about
// SMART_HELPER_PATH is user-influenced, so there is nothing here for a
// caller to widen.
var SMART_HELPER_PATH = "/usr/local/bin/jharrison-sysmonitor-smart-helper"
var SMART_SUDOERS_PATH = "/etc/sudoers.d/10-sysmonitor-smartctl"

// The helper itself does the device enumeration that used to live in the
// sudoers glob — in trusted, root-owned code instead of in a permission
// grant. `set -euo pipefail` means a device that fails partway (a drive
// that dropped out mid-query) stops that one iteration cleanly rather than
// printing a truncated JSON blob the parser would choke on.
// smartctlPath should be the already-validated realPath from
// parseExecutableValidation — baked in at generation time rather than the
// helper resolving a bare `smartctl` off root's PATH at run time, so the
// same provenance check this plugin applies before granting bandwhich's
// capability also decides which binary the sudoers grant can ever reach.
// Falls back to the bare command only if no validated path was supplied,
// which callers should treat as "validation was skipped", not "safe".
function smartHelperScript(smartctlPath) {
  var sq = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
  var bin = smartctlPath ? sq(String(smartctlPath)) : "smartctl"
  return "#!/bin/bash\n" +
    "# Installed by the jharrison.sysmonitor Omarchy plugin. Root-owned,\n" +
    "# not writable by the invoking user. Takes no arguments — the\n" +
    "# sudoers rule permitting this grants exactly this bare command,\n" +
    "# nothing left to parameterize. Device enumeration happens here, in\n" +
    "# trusted code, instead of being encoded in the grant itself.\n" +
    "set -euo pipefail\n" +
    "for d in /dev/nvme*n1; do\n" +
    "  [ -e \"$d\" ] || continue\n" +
    "  echo \"@@$d\"\n" +
    "  " + bin + " -j -a \"$d\" 2>/dev/null || true\n" +
    "done\n"
}

// Returns "" (not a rule) for a username that fails isValidUsername — never
// a best-effort rule built from unchecked input. "" is itself a fail-safe
// value: visudo -cf already rejects an empty principal line with a syntax
// error, but buildGrantSmartScript below does not even rely on that; it
// checks isValidUsername directly and refuses to build an install attempt
// at all, since an injected "username" produces syntactically VALID
// sudoers content that visudo -cf cannot distinguish from a real one.
function smartSudoersRule(username) {
  if (!isValidUsername(username)) return ""
  // A Cmnd with no argument spec at all lets the invoking user run it with
  // ANY arguments they choose (sudoers(5)); the helper itself ignores
  // $@, so this was not currently exploitable, but "no arguments at all"
  // was a claim the rule did not actually enforce. The trailing `""` is
  // sudoers' own syntax for "no arguments accepted", verified against the
  // real visudo -cf on this system.
  return String(username) + " ALL=(root) NOPASSWD: " + SMART_HELPER_PATH + " \"\"\n"
}

// Full grant script: install the helper (0755, root:root) then the
// sudoers rule that names it (0440, root:root, visudo-validated) — both
// through buildCollisionSafeInstallScript, so an unexpected pre-existing
// file at either path is backed up rather than clobbered, and a helper
// that fails to install correctly never leaves a sudoers rule pointing at
// a script that is not what this plugin actually shipped.
//
// username is validated here, not just inside smartSudoersRule, so a bad
// value stops the whole grant (helper install included) rather than
// producing a helper with no sudoers rule able to reach it.
function buildGrantSmartScript(username, smartctlPath) {
  if (!isValidUsername(username))
    return "echo 'invalid username, refusing to install a sudoers rule' >&2; exit 24"
  var helper = buildCollisionSafeInstallScript(SMART_HELPER_PATH, smartHelperScript(smartctlPath), "0755", "root", "root", null)
  var sudoers = buildCollisionSafeInstallScript(SMART_SUDOERS_PATH, smartSudoersRule(username), "0440", "root", "root", "visudo -cf")
  return "(" + helper + ") && (" + sudoers + ")"
}

// Reverses buildGrantSmartScript — removes both the sudoers rule and the
// helper it names. Backups made along the way (the .bak-* files) are left
// in place deliberately: they are evidence of what was there before this
// plugin touched the system, and deleting them on revoke would be exactly
// the kind of silent data loss backup/rollback exists to prevent.
function buildRevokeSmartScript() {
  var sq = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
  return "rm -f -- " + sq(SMART_SUDOERS_PATH) + " " + sq(SMART_HELPER_PATH)
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

// Splits COLLECT_PROC_SNAPSHOT into the tick table and the ps-derived rows.
// → { ticks: { pid: utime+stime }, rows: [ …parseNoCpuPsLine… ] }
// Thread count and elapsed time travel on the rows themselves now, not a
// separate meta table keyed off the /proc scan — see the comment above
// COLLECT_PROC_SNAPSHOT for why that used to race.
function parseProcSnapshot(raw) {
  var out = { ticks: {}, rows: [] }
  var parts = String(raw || "").split("@@PS")
  var lines = _lines(parts[0])
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].trim().split(/\s+/)
    if (f.length < 3) continue
    var pid = _int(f[0])
    if (pid <= 0) continue
    out.ticks[pid] = _int(f[1]) + _int(f[2])
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

// `ps -eo pid,ppid,user:20,%mem,stat,nice,rss,nlwp,etimes,comm` — same as
// parsePsLine but without %cpu (that still comes from the tick deltas — see
// COLLECT_PROC_SNAPSHOT) and with thread count and elapsed seconds read
// straight off this same invocation instead of a separate /proc pass, so
// they can never land on one side of that race and not the other.
//
// cpu/cpuCore start `undefined`, not 0 — this row has not been through a CPU
// delta yet, and 0 would claim "measured, and idle" when the truth is
// "not measured". mergeProcRows is what actually assigns a real reading (or
// leaves it undefined for a process too new to have one).
function parseNoCpuPsLine(line) {
  var text = String(line || "").trim()
  if (!text) return null
  var parts = text.split(/\s+/)
  if (parts.length < 10) return null
  return {
    pid: _int(parts[0]),
    ppid: _int(parts[1]),
    user: parts[2],
    mem: _num(parts[3]),
    stat: parts[4],
    nice: _int(parts[5]),
    rss: _num(parts[6]) * 1024,
    threads: _int(parts[7]),
    elapsed: _num(parts[8]),
    command: parts.slice(9).join(" "),
    cpu: undefined,
    cpuCore: undefined
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

// A pid absent from cpuByPid has not been through a CPU delta yet — most
// often because it was born since the last poll. Treated as -1 here, one
// notch below even a genuine, measured 0.0%, so it sorts last rather than
// competing on equal footing with a process actually confirmed idle.
function cpuSortValue(r) {
  return r.cpu === undefined ? -1 : r.cpu
}

// Merges computed CPU onto the ps-derived rows, sorts, and truncates.
// Threads and elapsed time are already on each row (parseNoCpuPsLine reads
// them straight off `ps`); this function no longer touches them. Rows with
// no CPU reading yet (first poll, or newly started) are left `undefined`
// rather than forced to 0 and sort last rather than being dropped — a
// process that just appeared is still worth seeing, and "not yet measured"
// should not look identical to "confirmed idle" (see cpuSortValue).
//
// filterText, when non-empty, matches command, the full command line, and pid
// (all as case-insensitive substrings) and — this is the point of it —
// REPLACES the truncation rather than narrowing it: every match comes back
// regardless of limit. The limit is exactly what hides a process in the first
// place, and the process worth searching for is usually the one with nothing
// to earn it a place in the plain top-N view (a window that stopped
// responding is idle, not busy).
var FILTER_RESULT_CAP = 500

function mergeProcRows(rows, cpuByPid, sortBy, limit, filterText) {
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i]
    // A null map means "re-sort what is already here" (the sort toggle), so
    // the readings on the rows must survive; only a supplied map overwrites.
    if (cpuByPid) {
      var c = cpuByPid[r.pid]
      r.cpu = c ? c.cpu : undefined
      r.cpuCore = c ? c.cpuCore : undefined
    }
    out.push(r)
  }
  // Instantaneous CPU means most processes sit at exactly 0.0%, so a plain
  // CPU sort leaves the tail as an arbitrary run of idle kernel threads.
  // Breaking ties on memory keeps those rows informative.
  out.sort(sortBy === "mem"
    ? function(a, b) { return (b.rss - a.rss) || (cpuSortValue(b) - cpuSortValue(a)) }
    : function(a, b) { return (cpuSortValue(b) - cpuSortValue(a)) || (b.rss - a.rss) })

  var needle = String(filterText || "").trim().toLowerCase()
  if (needle) {
    var matches = out.filter(function(r) {
      var hay = (String(r.command || "") + " " + String(r.fullCommand || "")).toLowerCase()
      return hay.indexOf(needle) >= 0 || String(r.pid).indexOf(needle) >= 0
    })
    // Deliberately not `limit` here — see above, that would defeat the point
    // of search. FILTER_RESULT_CAP is a much larger safety ceiling instead:
    // a real desktop's process count is in the hundreds, so this never
    // trims a genuine search, but a Repeater model still cannot grow
    // without bound if something pathological (a fork bomb, an unusual
    // namespace) puts thousands of matching rows on the table at once.
    return matches.slice(0, FILTER_RESULT_CAP)
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
    collectToolProbe: collectToolProbe,
    COLLECT_NVME_LIST: COLLECT_NVME_LIST,
    COLLECT_PROC_SNAPSHOT: COLLECT_PROC_SNAPSHOT,
    parseProcSnapshot: parseProcSnapshot,
    parseNoCpuPsLine: parseNoCpuPsLine,
    parseProcDetailPs: parseProcDetailPs,
    calcProcCpu: calcProcCpu,
    mergeProcRows: mergeProcRows,
    cpuSortValue: cpuSortValue,
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
    buildGuardedSignalCommand: buildGuardedSignalCommand,
    wrapCollectorCommand: wrapCollectorCommand,
    OUTPUT_CAP_TINY: OUTPUT_CAP_TINY,
    OUTPUT_CAP_MEDIUM: OUTPUT_CAP_MEDIUM,
    OUTPUT_CAP_LARGE: OUTPUT_CAP_LARGE,
    OUTPUT_CAP_XLARGE: OUTPUT_CAP_XLARGE,
    overdueCollectors: overdueCollectors,
    buildGroupKillCommand: buildGroupKillCommand,
    buildExecutableValidationScript: buildExecutableValidationScript,
    parseExecutableValidation: parseExecutableValidation,
    buildGrantCapabilityScript: buildGrantCapabilityScript,
    buildRevokeCapabilityScript: buildRevokeCapabilityScript,
    buildCollisionSafeInstallScript: buildCollisionSafeInstallScript,
    SMART_HELPER_PATH: SMART_HELPER_PATH,
    SMART_SUDOERS_PATH: SMART_SUDOERS_PATH,
    smartHelperScript: smartHelperScript,
    smartSudoersRule: smartSudoersRule,
    buildGrantSmartScript: buildGrantSmartScript,
    buildRevokeSmartScript: buildRevokeSmartScript,
    isValidIfaceName: isValidIfaceName,
    isValidNvmeDevice: isValidNvmeDevice,
    isValidUsername: isValidUsername,
    truncateDisplay: truncateDisplay,
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
