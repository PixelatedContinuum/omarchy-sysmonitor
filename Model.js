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

// The active theme's full colour palette. The shell's own Color singleton
// reads this same file but keeps only four values from it (foreground,
// background, accent, and red mapped to urgent), so the named hues a theme
// also defines (green, yellow, cyan, magenta, orange) are not reachable
// through it. This panel wants them to colour section headings apart from
// each other, so it reads the file itself.
//
// The path is the theme symlink Omarchy maintains, and colors.toml ships with
// every theme (checked: all 22 installed here), so this is a plain
// world-readable file read with a graceful empty result if it is ever absent.
var COLLECT_THEME_PALETTE =
  'cat "$HOME/.local/state/omarchy/current/theme/colors.toml" 2>/dev/null || true'

// Pulls `key = "#rrggbb"` pairs out of colors.toml. Deliberately not a real
// TOML parser: the file is flat key/value with no tables or arrays, and the
// only values this cares about are hex colours, so anything that is not a
// plain hex string is skipped rather than guessed at. A theme that omits a
// key simply does not get an entry, and the panel falls back per-key.
function parseThemePalette(raw) {
  var out = {}
  var lines = _lines(raw)
  for (var i = 0; i < lines.length; i++) {
    var m = String(lines[i]).match(/^\s*([a-z_]+)\s*=\s*"(#[0-9a-fA-F]{6})"\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// The GPU's marketing name, the counterpart to the CPU's "model name" line
// from /proc/cpuinfo. The kernel does not publish one: sysfs carries only the
// numeric PCI vendor and device ids, so the name has to be looked up in
// hwdata's pci.ids, the same table `lspci` itself reads. Reading that file
// directly rather than shelling out to lspci keeps this a plain
// world-readable file read with no extra binary to depend on.
//
// pci.ids is indented by tab depth: vendors at column 0, devices one tab in,
// subsystem entries two tabs in. The awk below walks into the right vendor
// block, then the right device line, and prefers a subsystem match when the
// card has one (those name the specific board) while falling back to the
// generic device name when it does not. This machine's card has no subsystem
// entry, checked directly, so the fallback is the path actually exercised
// here. Missing file, missing ids or an unknown card all end as empty output,
// which the panel renders as no model line at all rather than an error.
function collectGpuModel(gpuPath) {
  var g = String(gpuPath || "").replace(/'/g, "")
  if (!g) return "true"
  return "v=$(cat '" + g + "/vendor' 2>/dev/null); d=$(cat '" + g + "/device' 2>/dev/null); " +
    "sv=$(cat '" + g + "/subsystem_vendor' 2>/dev/null); sd=$(cat '" + g + "/subsystem_device' 2>/dev/null); " +
    "[ -n \"$v\" ] && [ -n \"$d\" ] || exit 0; " +
    "[ -r /usr/share/hwdata/pci.ids ] || exit 0; " +
    "awk -v v=\"${v#0x}\" -v d=\"${d#0x}\" -v sv=\"${sv#0x}\" -v sd=\"${sd#0x}\" '" +
    "/^[0-9a-f]/ { invend = ($1 == v); indev = 0; next } " +
    "invend && /^\\t[0-9a-f]/ { sub(/^\\t/, \"\"); " +
    "if ($1 == d) { indev = 1; dname = substr($0, index($0, $2)) } else indev = 0; next } " +
    "indev && /^\\t\\t/ { sub(/^\\t\\t/, \"\"); " +
    "if ($1 == sv && $2 == sd) sname = substr($0, index($0, $3)); next } " +
    "END { print (sname != \"\" ? sname : dname) }' /usr/share/hwdata/pci.ids"
}

// pci.ids device names read "<silicon> [<marketing name>]", e.g.
// "Navi 21 [Radeon RX 6900 XT]" or "GA102 [GeForce RTX 3090]". The bracketed
// half is the name a person recognises and the one worth showing. Entries
// without brackets (many integrated parts) are already the plain name and
// pass through unchanged.
function parseGpuModel(raw) {
  var s = String(raw || "").trim()
  if (!s) return ""
  var m = s.match(/\[([^\]]+)\]/)
  return (m ? m[1] : s).trim()
}

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
// Two independent reads joined by a marker: the `ps` table that the process
// list renders from, then the per-pid tick counters that CPU% is derived from.
//
// ORDER MATTERS, and it is the reason `ps` goes first. The whole thing is piped
// through `head -c OUTPUT_CAP_XLARGE`, and at ~96 bytes per process that cap
// binds at roughly 10,900 processes — well before the ARG_MAX ceiling below.
// Whichever half is downstream of the cut is the half that gets lost, and
// losing ticks costs CPU%, which the row model already renders as undefined.
// Losing the `ps` half instead used to cost the ENTIRE process list, because
// the marker went with it and parseProcSnapshot found nothing to split on. A
// process monitor showing no processes is the worst available failure, so the
// expendable half is the one placed last.
//
// Neither the glob nor awk touches argv. Passing /proc/[0-9]*/stat straight to
// awk builds an argv that exceeds ARG_MAX (~131k paths here); `printf` is a bash
// builtin, so it absorbs the expanded list with no execve and streams it
// NUL-separated into xargs, which chunks it. That ceiling is far above the cap,
// so it is the lesser of the two bounds — kept because it costs nothing.
//
// Letting awk open the files itself is the bug that actually bit. A process
// exiting between the glob expanding and awk reaching its file makes gawk abort
// the entire invocation with a FATAL open error, dropping every remaining
// process in that chunk; `2>/dev/null` hid it. Measured on an idle machine,
// snapshots fell from ~516 processes to as low as 358. `cat` warns and carries
// on where awk gives up, and awk then sees one concatenated stream, which is
// safe because each stat file is exactly one newline-terminated line and $1
// (the pid) comes from the contents rather than the filename.
var COLLECT_PROC_SNAPSHOT =
  "ps -eo pid,ppid,user:20,%mem,stat,nice,rss,nlwp,etimes,comm --no-headers 2>/dev/null; " +
  "echo '@@TICKS'; " +
  "printf '%s\\0' /proc/[0-9]*/stat 2>/dev/null | xargs -0 -r cat 2>/dev/null | " +
  "awk '{ n=index($0, \") \"); if (n == 0) next; " +
       "rest = substr($0, n + 2); split(rest, f, \" \"); " +
       "print $1, f[12], f[13], f[20] }'"

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

// ---------------------------------------------------------------- processes

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
// is — not what the user selected.
//
// The token compared is field 22 of /proc/PID/stat, the process start time in
// boot-relative clock ticks. That is an IDENTITY, not a quantity: it is fixed
// for the life of a process and a reused pid gets a different one, so it is
// compared for exact equality with no tolerance window to size or defend. It
// replaced an `etimes >= expected - 3s` test, which needed slack precisely
// because elapsed seconds keep moving, and any slack is a window a reuse can
// land inside. Tick granularity is also 100x finer than the one-second fields
// `ps` can report, so a same-second reuse cannot slip through either.
//
// Reading it takes one `awk` over one file, which is also why `ps` is gone
// from this path: `ps` cannot report raw start ticks at all, so keeping it for
// the username would have meant two reads at two instants to verify one
// identity. Ownership is not checked here because it is enforced twice over
// without this: the UI only offers these actions on rows the user owns, and
// the kernel fails kill/renice against anyone else's process with EPERM.
//
// This is NOT atomic and must not be described as such. Identity is read once,
// the action is a later exec, so a gap remains between the check and the act;
// the guard narrows the window, it does not close it. The race-free primitive
// is pidfd_open(2) plus pidfd_send_signal(2), which has no shell equivalent.
// What bounds the remaining exposure is that these are unprivileged operations
// on the user's own processes: the worst outcome is signalling one of your own
// processes you did not mean to, not a privilege boundary being crossed.
//
// actionCmd must not itself depend on anything other than the pid/signal/
// nice-value literals the caller already embedded in it (e.g. "kill -TERM
// 1234") — this only wraps a guard around it, it does not sanitize it.
function buildGuardedSignalCommand(pid, actionCmd, expectedComm, expectedStarttime) {
  var p = _int(pid)
  var comm = String(expectedComm || "")
  var start = _int(expectedStarttime)
  // Single-quote for POSIX sh; a literal single quote inside a value (rare in
  // a comm, but comm can hold nearly anything) is escaped by closing the
  // quote, emitting an escaped quote, and reopening it.
  var sq = function(s) { return "'" + s.replace(/'/g, "'\\''") + "'" }
  var refuse = "echo " + sq("REFUSED: pid " + p + " no longer matches the selected process") +
               " >&2; exit 3"
  // A row with no starttime means the tick half of the snapshot was truncated
  // before this pid, so there is nothing to verify against. Refuse rather than
  // fall back to a weaker check the caller cannot see.
  if (start <= 0) return refuse
  // comm and starttime come out of the SAME line of the SAME file, so there is
  // no second read to disagree with the first. comm is taken from between the
  // parens rather than by field index because it can contain spaces or parens
  // of its own; everything after the last ") " is split positionally, where
  // original field N is f[N-2], so starttime (22) is f[20].
  return "read -r s c <<< \"$(awk '{ n = index($0, \") \"); if (n == 0) exit; " +
         "o = index($0, \"(\"); c = substr($0, o + 1, n - o - 1); " +
         "rest = substr($0, n + 2); split(rest, f, \" \"); " +
         "print f[20], c }' /proc/" + p + "/stat 2>/dev/null)\"; " +
         "if [ \"$s\" = " + sq(String(start)) + " ] && [ \"$c\" = " + sq(comm) + " ]; then " +
         actionCmd + "; else " + refuse + "; fi"
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

// Absolute interpreter paths, plus a fixed PATH for everything a script then
// calls by name. Resolving `setsid`/`bash`/`head` through the inherited PATH
// lets any writable directory earlier on it shadow them; exporting SAFE_PATH
// inside the wrapper extends the same guarantee to `awk`, `ps`, `df`, `free`
// and the rest, which the collector scripts invoke by bare name. Omarchy is
// Arch with a merged /usr, so /usr/bin is where these live; /bin trails it
// only because it costs nothing.
//
// PATH is not the only way to put attacker code in front of a bare command
// name, and pinning it alone would be a half measure. Both remaining channels
// outrank PATH lookup and both are closed by BASH_OPTS below:
//
//   BASH_ENV            non-interactive bash sources it BEFORE the script runs,
//                       so it is arbitrary code execution rather than mere
//                       shadowing. `--noprofile --norc` does NOT stop it.
//   exported functions  an exported `ps()` shadows the name whatever PATH says.
//
// `-p` (privileged mode) makes bash skip BASH_ENV/ENV and refuse inherited
// function definitions, which closes both, and unlike `env -i` it leaves HOME
// intact — COLLECT_THEME_PALETTE reads a path under it. Verified against both
// bypasses. LD_PRELOAD and LD_AUDIT remain out of scope by construction: they
// act on /usr/bin/bash itself before any of its options are parsed, and an
// attacker who can set them already has code execution as this user, which is
// the same reason none of this is a privilege boundary.
var BIN_SETSID = "/usr/bin/setsid"
var BIN_BASH = "/usr/bin/bash"
var BIN_HEAD = "/usr/bin/head"
var BASH_OPTS = "-p"
var SAFE_PATH = "/usr/bin:/bin"

// Wraps a bare shell script as an argv command carrying the same PATH
// guarantee, but with no process group and no output cap. For the one-shot,
// non-periodic commands — process detail, signal guards, group kills — where
// the collector machinery does not apply but PATH shadowing still would.
function shellCommand(script) {
  return [BIN_BASH, BASH_OPTS, "-c", "PATH=" + SAFE_PATH + "; " + String(script || "true")]
}

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
// `setsid` is deliberately used WITHOUT `-w`. Unwaited, it execs in place from a
// non-group-leader parent (which is what Quickshell spawns), so the tracked pid
// is itself the new group leader and buildGroupKillCommand can read its pgid and
// kill the whole pipeline. With `-w` setsid would linger in the ORIGINAL process
// group, and that same group kill would take the plugin down with it. Verified:
// the child's pgid equals its own pid, and exit codes still propagate.
//
// Exit status here is head's, which is 0 whether or not the script succeeded.
// That is fine for a collector, whose output is the only product, and it is
// deliberately NOT "fixed" with `pipefail`: capping output makes head close the
// pipe early, the producer takes SIGPIPE, and pipefail would then report every
// truncated-but-working collector as a failure. Commands whose exit code is
// load-bearing use wrapGuardedCommand instead.
function wrapCollectorCommand(script, maxOutputBytes) {
  var n = maxOutputBytes > 0 ? _int(maxOutputBytes) : 65536
  return [BIN_SETSID, "--", BIN_BASH, BASH_OPTS, "-c",
          "PATH=" + SAFE_PATH + "; ( " + String(script || "true") + " ) | " +
          BIN_HEAD + " -c " + n]
}

// Same isolation and cap as wrapCollectorCommand, but the wrapped script's own
// exit status survives the pipe via PIPESTATUS. For the guarded kill/renice
// path, where a non-zero status is the REFUSED signal the UI reports and must
// not be swallowed by head. PIPESTATUS rather than `pipefail` because it reads
// the producer's status directly instead of folding SIGPIPE into the verdict.
function wrapGuardedCommand(script, maxOutputBytes) {
  var n = maxOutputBytes > 0 ? _int(maxOutputBytes) : 65536
  return [BIN_SETSID, "--", BIN_BASH, BASH_OPTS, "-c",
          "PATH=" + SAFE_PATH + "; ( " + String(script || "true") + " ) | " +
          BIN_HEAD + " -c " + n + "; exit ${PIPESTATUS[0]}"]
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
// Rows come from the FIRST section and ticks from the second, matching the
// order COLLECT_PROC_SNAPSHOT emits them. A truncated read therefore still
// yields a full row list with some ticks missing, rather than no rows at all;
// see the ordering note on COLLECT_PROC_SNAPSHOT. A missing marker means the
// cut landed inside the rows, which is still parsed for whatever survived.
function parseProcSnapshot(raw) {
  var out = { ticks: {}, starts: {}, rows: [] }
  var parts = String(raw || "").split("@@TICKS")
  var rows = _lines(parts[0])
  for (var j = 0; j < rows.length; j++) {
    var r = parseNoCpuPsLine(rows[j])
    if (r) out.rows.push(r)
  }
  if (parts.length > 1) {
    var lines = _lines(parts[1])
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].trim().split(/\s+/)
      if (f.length < 3) continue
      var pid = _int(f[0])
      if (pid <= 0) continue
      out.ticks[pid] = _int(f[1]) + _int(f[2])
      // Field 22 of /proc/PID/stat, boot-relative start time in clock ticks.
      // Carried onto the row below so a signal can be guarded on it: it is an
      // identity token rather than a quantity, so it is compared exactly and
      // needs no tolerance window. Absent when the tick half was truncated,
      // which the guard treats as "cannot verify" rather than "matches".
      if (f.length > 3) out.starts[pid] = _int(f[3])
    }
    for (var k = 0; k < out.rows.length; k++) {
      var st = out.starts[out.rows[k].pid]
      if (st !== undefined) out.rows[k].starttime = st
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
    COLLECT_PROC_SNAPSHOT: COLLECT_PROC_SNAPSHOT,
    parseProcSnapshot: parseProcSnapshot,
    parseNoCpuPsLine: parseNoCpuPsLine,
    parseProcDetailPs: parseProcDetailPs,
    calcProcCpu: calcProcCpu,
    mergeProcRows: mergeProcRows,
    cpuSortValue: cpuSortValue,
    collectGpuDetail: collectGpuDetail,
    collectGpuModel: collectGpuModel,
    parseGpuModel: parseGpuModel,
    COLLECT_THEME_PALETTE: COLLECT_THEME_PALETTE,
    parseThemePalette: parseThemePalette,
    collectProcDetail: collectProcDetail,
    parseGpuDetail: parseGpuDetail,
    parseProcDetail: parseProcDetail,
    friendlySensorName: friendlySensorName,
    friendlySensorLabel: friendlySensorLabel,
    formatWatts: formatWatts,
    formatMHz: formatMHz,
    formatElapsed: formatElapsed,
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
    parsePsLine: parsePsLine,
    parsePsOutput: parsePsOutput,
    userMatches: userMatches,
    buildGuardedSignalCommand: buildGuardedSignalCommand,
    wrapCollectorCommand: wrapCollectorCommand,
    wrapGuardedCommand: wrapGuardedCommand,
    shellCommand: shellCommand,
    OUTPUT_CAP_TINY: OUTPUT_CAP_TINY,
    OUTPUT_CAP_MEDIUM: OUTPUT_CAP_MEDIUM,
    OUTPUT_CAP_LARGE: OUTPUT_CAP_LARGE,
    OUTPUT_CAP_XLARGE: OUTPUT_CAP_XLARGE,
    overdueCollectors: overdueCollectors,
    buildGroupKillCommand: buildGroupKillCommand,
    truncateDisplay: truncateDisplay,
    formatState: formatState,
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
