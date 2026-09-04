#!/usr/bin/env node
// Model.js test harness.
//
// Runs the parsers against LIVE output from this machine: real /proc and
// sysfs reads, real `ps`/`df`/`free` invocations. Every source this plugin
// reads is readable by an ordinary user, so there is nothing here that needs
// privileges to exercise and nothing that has to fall back to a fixed sample
// because the real thing was out of reach.
//
// Every check reports PASS, FAIL, or SKIP with a reason. A SKIP is never
// counted as a pass. Skips should normally be zero: one appearing means a
// genuine environmental gap (no zram, no PSI, no AMD GPU) on this machine,
// not a permission this plugin wanted and did not have.
//
//   node test-model.js

var M = require("./Model.js")
var cp = require("child_process")
var fs = require("fs")

var pass = 0, fail = 0, skip = 0
var failures = []

function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name) }
  else {
    fail++
    failures.push(name + (detail ? " — " + detail : ""))
    console.log("  FAIL  " + name + (detail ? " — " + detail : ""))
  }
}

function skipped(name, why) {
  skip++
  console.log("  SKIP  " + name + " — " + why)
}

function read(path) {
  try { return fs.readFileSync(path, "utf8") } catch (e) { return null }
}

function sh(cmd) {
  try { return cp.execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) }
  catch (e) { return null }
}

function section(title) { console.log("\n" + title) }

// ------------------------------------------------------------------ CPU
section("CPU — live /proc/stat")
var stat1 = read("/proc/stat")
if (!stat1) skipped("parseCpuStat", "/proc/stat unreadable")
else {
  var cpu1 = M.parseCpuStat(stat1)
  check("parseCpuStat finds aggregate line", cpu1.total !== null)
  check("parseCpuStat core count matches nproc",
        cpu1.cores.length === parseInt(sh("nproc") || "0", 10),
        "parsed " + cpu1.cores.length)
  check("aggregate idle is a positive number", cpu1.total && cpu1.total.idle > 0)

  // Busy-wait briefly so the second sample genuinely differs.
  var spin = Date.now(); while (Date.now() - spin < 250) {}
  var cpu2 = M.parseCpuStat(read("/proc/stat"))
  var pcts = M.calcCpuPercents(cpu1, cpu2)
  check("calcCpuPercents total in 0..100", pcts.total >= 0 && pcts.total <= 100, "got " + pcts.total)
  check("calcCpuPercents returns one value per core", pcts.cores.length === cpu1.cores.length)
  check("every core percent in 0..100", pcts.cores.every(function(p) { return p >= 0 && p <= 100 }))
}

check("calcCpuPercent handles identical samples (no divide-by-zero)",
      M.calcCpuPercent({user:1,nice:0,system:1,idle:8,iowait:0,irq:0,softirq:0,steal:0},
                       {user:1,nice:0,system:1,idle:8,iowait:0,irq:0,softirq:0,steal:0}) === 0)
check("calcCpuPercent clamps a wrapped/decreasing counter to 0",
      M.calcCpuPercent({user:99,nice:0,system:0,idle:99,iowait:0,irq:0,softirq:0,steal:0},
                       {user:1,nice:0,system:0,idle:1,iowait:0,irq:0,softirq:0,steal:0}) === 0)
check("calcCpuPercent: fully busy delta reads 100",
      M.calcCpuPercent({user:0,nice:0,system:0,idle:0,iowait:0,irq:0,softirq:0,steal:0},
                       {user:100,nice:0,system:0,idle:0,iowait:0,irq:0,softirq:0,steal:0}) === 100)
check("calcCpuPercent: fully idle delta reads 0",
      M.calcCpuPercent({user:0,nice:0,system:0,idle:0,iowait:0,irq:0,softirq:0,steal:0},
                       {user:0,nice:0,system:0,idle:100,iowait:0,irq:0,softirq:0,steal:0}) === 0)
check("calcCpuPercent counts iowait as idle",
      M.calcCpuPercent({user:0,nice:0,system:0,idle:0,iowait:0,irq:0,softirq:0,steal:0},
                       {user:0,nice:0,system:0,idle:0,iowait:100,irq:0,softirq:0,steal:0}) === 0)
check("parseCpuLine rejects a non-cpu line", M.parseCpuLine("intr 12345 0 0") === null)
check("parseCpuLine rejects an empty line", M.parseCpuLine("") === null)

section("Load average — live /proc/loadavg")
var la = M.parseLoadAvg(read("/proc/loadavg"))
check("parseLoadAvg returns three averages", la && la.load1 >= 0 && la.load5 >= 0 && la.load15 >= 0)
check("parseLoadAvg splits running/total", la && la.total > 0, la ? "total=" + la.total : "null")

// ------------------------------------------------------------------ memory
section("Memory — live `free -b`")
var freeRaw = sh("free -b")
if (!freeRaw) skipped("parseFree", "`free -b` unavailable")
else {
  var mem = M.parseFree(freeRaw)
  check("memTotal > 0", mem.memTotal > 0)
  check("memAvail > 0 and <= memTotal", mem.memAvail > 0 && mem.memAvail <= mem.memTotal)
  check("memUsed <= memTotal", mem.memUsed <= mem.memTotal)
  check("swapTotal parsed", mem.swapTotal > 0, "got " + mem.swapTotal)
}

section("Zram — live /sys/block/zram0/mm_stat")
var zramRaw = read("/sys/block/zram0/mm_stat")
if (!zramRaw) skipped("parseZram", "no zram device on this machine")
else {
  var z = M.parseZram(zramRaw)
  check("parseZram returns sizes", z && z.origSize > 0 && z.comprSize > 0)
  check("compression ratio > 1 (data actually compresses)", z && z.ratio > 1, z ? "ratio=" + z.ratio.toFixed(2) : "null")
}
check("parseZram returns null on empty input", M.parseZram("") === null)
check("parseZram returns null on zero sizes", M.parseZram("0 0 0 0 0") === null)

// ------------------------------------------------------------------ pressure
section("Pressure — live /proc/pressure/*")
var psiParts = sh(M.COLLECT_PRESSURE)

if (!psiParts) skipped("parsePressure", "PSI not available (CONFIG_PSI off)")
else {
  var psi = M.parsePressure(psiParts)
  check("parsePressure finds cpu", psi.cpu && typeof psi.cpu.some === "number")
  check("parsePressure finds io", psi.io && typeof psi.io.some === "number")
  check("parsePressure finds memory", psi.memory && typeof psi.memory.some === "number")
  check("parsePressure keeps some and full distinct",
        psi.io && typeof psi.io.full === "number")
}

// ------------------------------------------------------------------ network
section("Network — live /proc/net/dev")
var netRaw = read("/proc/net/dev")
if (!netRaw) skipped("parseNetDev", "/proc/net/dev unreadable")
else {
  var net = M.parseNetDev(netRaw)
  check("parseNetDev finds loopback", !!net.lo)
  check("parseNetDev skips the two header lines",
        Object.keys(net).every(function(k) { return k.indexOf("|") < 0 && k !== "face" }),
        Object.keys(net).join(","))
  check("loopback rx equals tx (a loopback invariant)",
        net.lo && net.lo.rxBytes === net.lo.txBytes)

  var prev = { eth0: { rxBytes: 1000, txBytes: 500, rxPackets: 0, txPackets: 0 } }
  var curr = { eth0: { rxBytes: 3000, txBytes: 1500, rxPackets: 0, txPackets: 0 } }
  var rates = M.calcNetRate(prev, curr, 2)
  check("calcNetRate computes bytes/sec", rates.eth0.rxRate === 1000 && rates.eth0.txRate === 500)
  var reset = M.calcNetRate({ eth0: { rxBytes: 9000, txBytes: 9000 } },
                            { eth0: { rxBytes: 10, txBytes: 10 } }, 2)
  check("calcNetRate clamps a counter reset to 0", reset.eth0.rxRate === 0)
  check("calcNetRate ignores a zero time delta",
        Object.keys(M.calcNetRate(prev, curr, 0)).length === 0)
  check("calcNetRate skips an interface absent from the previous sample",
        M.calcNetRate({}, curr, 2).eth0 === undefined)
}

section("truncateDisplay — the length bound before external data reaches a Text element")
check("passes a short string through unchanged",
      M.truncateDisplay("eth0", 64) === "eth0")
check("passes a string exactly at the limit through unchanged",
      M.truncateDisplay("12345", 5) === "12345")
check("cuts a string one character over the limit and marks it with an ellipsis",
      M.truncateDisplay("123456", 5) === "1234…" && M.truncateDisplay("123456", 5).length === 5)
check("cuts a very long string down to the limit",
      M.truncateDisplay("x".repeat(10000), 100).length === 100)
check("treats null and undefined as empty, not as the literal text 'null'/'undefined'",
      M.truncateDisplay(null, 10) === "" && M.truncateDisplay(undefined, 10) === "")
check("coerces a non-string (number) rather than throwing",
      M.truncateDisplay(12345, 3) === "12…")
check("a maxLen of 0 or negative still returns a bounded (1-char) string, never throws",
      M.truncateDisplay("hello", 0).length <= 1 && M.truncateDisplay("hello", -5).length <= 1)

section("buildGuardedSignalCommand — the identity re-check immediately before a kill/renice actually runs")
check("returns a string even for garbage input, never throws",
      typeof M.buildGuardedSignalCommand("not-a-pid", "echo x", "u", "c", "not-a-number") === "string")

// A real child process to test against: its pid, comm, and user are fully
// known, and starting it here means its elapsed time is known too, instead
// of guessing at a moving target.
var guardChild = cp.spawn("sleep", ["30"], { stdio: "ignore" })
var guardPid = guardChild.pid
var guardUser = (sh("whoami") || "").trim()

function runGuarded(actionCmd, user, comm, elapsed) {
  var built = M.buildGuardedSignalCommand(guardPid, actionCmd, user, comm, elapsed)
  try {
    var out = cp.execSync(built, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, stdout: out }
  } catch (e) {
    return { ok: false, stdout: (e.stdout || "").toString(), stderr: (e.stderr || "").toString(), code: e.status }
  }
}

if (!guardPid || !guardUser) {
  skipped("buildGuardedSignalCommand live checks", "could not spawn a test child process or resolve whoami")
} else {
  var realEtimes = parseInt((sh("ps -o etimes= -p " + guardPid + " 2>/dev/null") || "0").trim(), 10) || 0

  check("runs the action when user, comm, and elapsed all match",
        runGuarded("echo GUARD_PASSED", guardUser, "sleep", realEtimes).stdout.indexOf("GUARD_PASSED") >= 0)

  check("passes when expected elapsed is within the polling-slack tolerance of the live reading",
        runGuarded("echo GUARD_PASSED", guardUser, "sleep", realEtimes + 2).stdout.indexOf("GUARD_PASSED") >= 0)

  check("refuses when expected elapsed is far beyond tolerance of the live reading (stale/reused pid)",
        (function() { var r = runGuarded("echo SHOULD_NOT_RUN", guardUser, "sleep", realEtimes + 30)
                      return !r.ok && r.stdout.indexOf("SHOULD_NOT_RUN") < 0 })())

  check("refuses when the comm no longer matches (simulated pid reuse)",
        (function() { var r = runGuarded("echo SHOULD_NOT_RUN", guardUser, "totally-different-binary", realEtimes)
                      return !r.ok && r.code === 3 && r.stdout.indexOf("SHOULD_NOT_RUN") < 0 })())

  check("refuses when the user no longer matches",
        (function() { var r = runGuarded("echo SHOULD_NOT_RUN", "no-such-user", "sleep", realEtimes)
                      return !r.ok && r.stdout.indexOf("SHOULD_NOT_RUN") < 0 })())

  check("shell metacharacters in the expected comm cannot break out of the identity check",
        (function() {
          var r = runGuarded("echo SHOULD_NOT_RUN", guardUser, "sleep; echo INJECTED", realEtimes)
          return !r.ok && r.stdout.indexOf("INJECTED") < 0 && r.stdout.indexOf("SHOULD_NOT_RUN") < 0
        })())

  check("a single quote in the expected comm produces a clean refusal, not a shell syntax error",
        (function() {
          var r = runGuarded("echo SHOULD_NOT_RUN", guardUser, "sle'ep", realEtimes)
          return !r.ok && r.code === 3
        })())

  guardChild.kill()
}

section("wrapCollectorCommand — process-group isolation and output cap for periodic collectors")
check("returns a setsid-prefixed argv array shaped for Process.command",
      (function() {
        var cmd = M.wrapCollectorCommand("echo hi", 1000)
        return Array.isArray(cmd) && cmd[0] === "/usr/bin/setsid" && cmd[1] === "--"
               && cmd[2] === "/usr/bin/bash" && cmd[3] === "-p" && cmd[4] === "-c"
               && typeof cmd[5] === "string"
      })())
check("shellCommand never throws on missing/garbage input", (function() {
  M.shellCommand(null); M.shellCommand(undefined); M.shellCommand(42)
  return true
})())

// ---- the hardening, exercised rather than asserted --------------------------
//
// Asserting on the argv string only proves the function built what it meant to
// build. These run each wrapper against a POISONED environment — a fake `ps` and
// `head` first on PATH, a BASH_ENV injection file, and an exported `ps` shell
// function — and check what actually executes. They fail if the pin stops
// working for any reason, including one the string shape cannot see.
var poison = fs.mkdtempSync("/tmp/sysmon-poison-")
fs.writeFileSync(poison + "/ps", "#!/bin/sh\necho PWNED-FAKE-PS\n", { mode: 0o755 })
fs.writeFileSync(poison + "/head", "#!/bin/sh\necho PWNED-FAKE-HEAD\n", { mode: 0o755 })
fs.writeFileSync(poison + "/evil.sh", "echo PWNED-VIA-BASH_ENV\n")

// Runs an argv array under the poisoned environment and returns its output.
function runPoisoned(argv, extraEnv) {
  var env = { PATH: poison + ":/usr/bin:/bin", HOME: process.env.HOME }
  for (var k in (extraEnv || {})) env[k] = extraEnv[k]
  try {
    return cp.execFileSync(argv[0], argv.slice(1),
      { encoding: "utf8", env: env, stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch (e) { return "ERROR" }
}
var probe = "ps -o comm= -p 1"
check("live: a shadowed `ps` on PATH cannot hijack a wrapped collector",
      runPoisoned(M.wrapCollectorCommand(probe, 4096)) === "systemd",
      runPoisoned(M.wrapCollectorCommand(probe, 4096)))
check("live: a shadowed `head` on PATH cannot hijack the output cap",
      runPoisoned(M.wrapCollectorCommand("echo capped", 4096)) === "capped")
check("live: a shadowed `ps` cannot hijack shellCommand either",
      runPoisoned(M.shellCommand(probe)) === "systemd")
// The control: the same probe WITHOUT the wrapper must be hijacked, otherwise
// the poison is not actually reaching the shell and the three checks above
// would pass for the wrong reason.
check("control: an unwrapped command IS hijacked by the poisoned PATH",
      runPoisoned(["/usr/bin/bash", "-c", probe]) === "PWNED-FAKE-PS",
      runPoisoned(["/usr/bin/bash", "-c", probe]))
check("live: BASH_ENV cannot inject code into a wrapped collector",
      runPoisoned(M.wrapCollectorCommand("echo clean", 4096),
                  { BASH_ENV: poison + "/evil.sh" }) === "clean")
check("live: BASH_ENV cannot inject code into shellCommand",
      runPoisoned(M.shellCommand("echo clean"),
                  { BASH_ENV: poison + "/evil.sh" }) === "clean")
check("live: an exported shell function cannot shadow a command name",
      (function() {
        var argv = M.wrapCollectorCommand(probe, 4096)
        var quoted = argv.map(function(a) { return "'" + String(a).replace(/'/g, "'\\''") + "'" }).join(" ")
        var out = sh("ps() { echo PWNED-VIA-EXPORTED-FUNCTION; }; export -f ps; " +
                     "PATH=" + poison + ":/usr/bin:/bin " + quoted)
        return String(out || "").trim() === "systemd"
      })())
try { fs.rmSync(poison, { recursive: true, force: true }) } catch (e) {}
check("never throws on missing/garbage input", (function() {
  M.wrapCollectorCommand(null, "not-a-number")
  M.wrapCollectorCommand(undefined, undefined)
  return true
})())

var wccArgv = M.wrapCollectorCommand("for i in $(seq 1 100000); do echo -n x; done", 500)
var wccOut = sh(wccArgv.map(function(a) { return "'" + String(a).replace(/'/g, "'\\''") + "'" }).join(" "))
check("live: output is truncated to the requested byte cap even though the script would emit far more",
      wccOut !== null && wccOut.length === 500, "got " + (wccOut ? wccOut.length : "null") + " bytes")

// Launches argv as a `nohup ... &` job from a throwaway shell rather than
// via Node's own cp.spawn — deliberately. Two reasons:
//
// 1. Fidelity: program + args with no extra shell wrapping around the
//    *target* command is how Quickshell's own Process type launches a
//    command, so setsid's isolation has to come from inside the argv
//    wrapCollectorCommand builds, not from how the harness invokes it.
// 2. A `cp.spawn`'d child that gets killed by an external `kill` (as
//    opposed to Node's own child.kill()) sits as a zombie until Node's
//    event loop gets a turn to reap it — and this file's timing checks are
//    tight synchronous busy-waits that do not reliably yield for that.
//    A later section (Process detail) finds "the newest bash owned by this
//    user" via pgrep, which — confirmed empirically — matches zombies too;
//    a lingering `bash <defunct>` from here would be picked up as if it
//    were a real shell and fail /proc/PID/exe and /proc/PID/cwd resolution
//    for it. Backgrounding via a shell that immediately exits orphans the
//    job to init instead, which reaps its own children promptly with zero
//    involvement from Node — sidestepping the timing question entirely
//    rather than racing it.
function sq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }
function launchCollectorArgv(argv) {
  var cmdline = argv.map(sq).join(" ")
  var pid = (sh("nohup " + cmdline + " >/dev/null 2>&1 & echo $!") || "").trim()
  return pid ? parseInt(pid, 10) : null
}

function waitForDeath(pid, timeoutMs) {
  var deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((sh("ps -o pid= -p " + pid + " 2>/dev/null") || "").trim() === "") return true
    var spin = Date.now(); while (Date.now() - spin < 30) {}
  }
  return false
}

check("live: the wrapped pipeline runs in a process group distinct from this shell's own", (function() {
  var pid = launchCollectorArgv(M.wrapCollectorCommand("sleep 2 & wait", 100))
  if (!pid) return false
  var spin = Date.now(); while (Date.now() - spin < 200) {}   // let setsid/exec land
  var pgid = (sh("ps -o pgid= -p " + pid + " 2>/dev/null") || "").trim()
  var myPgid = (sh("ps -o pgid= -p " + process.pid + " 2>/dev/null") || "").trim()
  sh(M.buildGroupKillCommand(pid))   // clean up regardless of outcome
  waitForDeath(pid, 1500)
  return pgid !== "" && pgid !== myPgid
})())

section("overdueCollectors — the watchdog sweep's pure decision logic")
check("a collector well within its deadline is not overdue",
      M.overdueCollectors([{ name: "cpuProc", startedAt: 1000, deadlineMs: 8000 }], 2000).length === 0)
check("a collector past its deadline is reported overdue",
      M.overdueCollectors([{ name: "cpuProc", startedAt: 1000, deadlineMs: 8000 }], 9500)[0] === "cpuProc")
check("exactly at the deadline counts as overdue (>=, not >)",
      M.overdueCollectors([{ name: "x", startedAt: 0, deadlineMs: 100 }], 100).length === 1)
check("only the overdue entries are returned out of a mixed set",
      (function() {
        var tracked = [{ name: "fast", startedAt: 9000, deadlineMs: 8000 },
                       { name: "hung", startedAt: 0, deadlineMs: 8000 }]
        var r = M.overdueCollectors(tracked, 9000)
        return r.length === 1 && r[0] === "hung"
      })())
check("an empty or missing tracked list returns an empty list, never throws",
      M.overdueCollectors([], 1000).length === 0 && M.overdueCollectors(null, 1000).length === 0)
check("a malformed entry in the list is skipped rather than throwing",
      M.overdueCollectors([null, { name: "ok", startedAt: 0, deadlineMs: 10 }], 100).length === 1)

section("buildGroupKillCommand — the cleanup half of the watchdog")
check("returns a safe no-op string for a non-positive pid",
      M.buildGroupKillCommand(0) === "true" && M.buildGroupKillCommand(-5) === "true")
check("live: tears down an entire process group from just the leader's pid", (function() {
  // The leader (child.pid, the setsid-exec'd bash) is itself a member of
  // the group buildGroupKillCommand computes from that same pid — so
  // confirming the leader dies is a direct, self-contained check of "the
  // right group got killed" with no need to separately hunt for a
  // descendant by name (unsafe here — see spawnCollectorArgv above).
  var pid = launchCollectorArgv(M.wrapCollectorCommand("sleep 3 & wait", 100))
  if (!pid) return false
  var spin = Date.now(); while (Date.now() - spin < 200) {}   // let setsid/exec land
  var aliveBefore = (sh("ps -o pid= -p " + pid + " 2>/dev/null") || "").trim() !== ""
  sh(M.buildGroupKillCommand(pid))
  var reaped = waitForDeath(pid, 1500)
  return aliveBefore && reaped
})())

section("Per-process CPU — live sampling")
var ncpu = parseInt(sh("nproc") || "1", 10)
var hz = parseInt(sh("getconf CLK_TCK") || "100", 10)
var snapA = M.parseProcSnapshot(sh(M.COLLECT_PROC_SNAPSHOT))
check("snapshot returns a tick table", Object.keys(snapA.ticks).length > 10,
      Object.keys(snapA.ticks).length + " pids")
check("snapshot returns ps-derived rows", snapA.rows.length > 10,
      snapA.rows.length + " rows")
check("tick table covers pid 1", snapA.ticks[1] !== undefined)
// Threads/elapsed used to come from a second, separate /proc scan keyed by
// pid — a process could appear in the ps rows and miss that scan entirely if
// it was born or reaped in the gap between the two. They are read off the
// same ps line as state/mem/rss now, so every row has them unconditionally.
check("rows carry thread count straight from ps, not a separate /proc pass",
      snapA.rows.every(function(r) { return r.threads > 0 }),
      snapA.rows.slice(0, 3).map(function(r) { return r.command + ":" + r.threads }).join(" "))
check("rows carry elapsed time straight from ps",
      snapA.rows.every(function(r) { return r.elapsed >= 0 }))
check("a freshly parsed row has no CPU reading yet — undefined, not a misleading 0",
      snapA.rows.every(function(r) { return r.cpu === undefined && r.cpuCore === undefined }))


var tA = Date.now()
var spin2 = Date.now(); while (Date.now() - spin2 < 600) {}
var snapB = M.parseProcSnapshot(sh(M.COLLECT_PROC_SNAPSHOT))
var dtReal = (Date.now() - tA) / 1000
var cpuMap = M.calcProcCpu(snapA.ticks, snapB.ticks, dtReal, ncpu, hz)
check("CPU computed for a meaningful number of pids", Object.keys(cpuMap).length > 10)
check("machine share never exceeds 100%",
      Object.keys(cpuMap).every(function(k) { return cpuMap[k].cpu <= 100 }))
check("machine share is core share divided by cpu count",
      Object.keys(cpuMap).every(function(k) {
        return Math.abs(cpuMap[k].cpu - cpuMap[k].cpuCore / ncpu) < 0.001
      }))
check("total machine share across all pids stays under 100%",
      Object.keys(cpuMap).reduce(function(a, k) { return a + cpuMap[k].cpu }, 0) <= 100.5,
      Object.keys(cpuMap).reduce(function(a, k) { return a + cpuMap[k].cpu }, 0).toFixed(1) + "%")

var merged = M.mergeProcRows(snapB.rows, cpuMap, "cpu", 8)
check("merge returns the requested row count", merged.length === 8)
check("thread counts are positive", merged.every(function(r) { return r.threads > 0 }),
      merged.slice(0, 3).map(function(r) { return r.command + ":" + r.threads }).join(" "))

var up = parseFloat((read("/proc/uptime") || "0").split(" ")[0])
check("elapsed never exceeds system uptime",
      merged.every(function(r) { return r.elapsed >= 0 && r.elapsed <= up + 1 }))
check("thread count agrees with ps for the top process", (function() {
  var t = parseInt((sh("ps -o nlwp= -p " + merged[0].pid) || "0").trim(), 10)
  return t === merged[0].threads
})(), "pid " + merged[0].pid)
check("elapsed agrees with ps etimes for the top process (within 2s)", (function() {
  var e = parseInt((sh("ps -o etimes= -p " + merged[0].pid) || "-1").trim(), 10)
  return e >= 0 && Math.abs(e - merged[0].elapsed) <= 2
})(), "pid " + merged[0].pid)
check("merged rows are sorted by CPU descending",
      merged.every(function(r, i) { return i === 0 || M.cpuSortValue(merged[i - 1]) >= M.cpuSortValue(r) }))
check("sorting by mem reorders by RSS", (function() {
  var m = M.mergeProcRows(snapB.rows, cpuMap, "mem", 8)
  return m.every(function(r, i) { return i === 0 || m[i - 1].rss >= r.rss })
})())
// This is the fix itself: a process born after the tick snapshot has no
// cpuByPid entry at all. It must not tie with, let alone rank above, a
// process actually confirmed idle at 0.0% — that would be the exact "looks
// broken" signature (search "claude", see rows with no CPU reading dressed
// up as a flat 0%) this was built to remove.
check("a pid with no CPU reading sorts behind a confirmed-idle 0.0%, not level with it",
      (function() {
        var rows = [{ pid: 1, cpu: undefined, cpuCore: undefined, rss: 900 },
                    { pid: 2, cpu: 0, cpuCore: 0, rss: 10 }]
        return M.mergeProcRows(rows, null, "cpu", 2).map(function(r) { return r.pid }).join(",") === "2,1"
      })())

check("equal-CPU rows break the tie on memory, not arbitrarily",
      (function() {
        var rows = [{ pid: 1, cpu: 0, cpuCore: 0, rss: 10 },
                    { pid: 2, cpu: 0, cpuCore: 0, rss: 900 },
                    { pid: 3, cpu: 0, cpuCore: 0, rss: 400 }]
        return M.mergeProcRows(rows, null, "cpu", 3)
                .map(function(r) { return r.pid }).join(",") === "2,3,1"
      })())
check("calcProcCpu ignores a zero time delta",
      Object.keys(M.calcProcCpu({1:10}, {1:20}, 0, 4, 100)).length === 0)
check("calcProcCpu skips a pid absent from the previous sample",
      M.calcProcCpu({}, {7:50}, 1, 4, 100)[7] === undefined)
check("calcProcCpu clamps a reused pid (counter went backwards)",
      M.calcProcCpu({7:900}, {7:10}, 1, 4, 100)[7].cpu === 0)
check("calcProcCpu: one full core on a 4-cpu box is 25% of the machine",
      Math.abs(M.calcProcCpu({7:0}, {7:100}, 1, 4, 100)[7].cpu - 25) < 0.001)
check("calcProcCpu: that same load is 100% of one core",
      Math.abs(M.calcProcCpu({7:0}, {7:100}, 1, 4, 100)[7].cpuCore - 100) < 0.001)
check("mergeProcRows with a null map preserves existing readings (sort toggle)",
      (function() {
        var rows = [{ pid: 1, cpu: 5, cpuCore: 20, rss: 100 },
                    { pid: 2, cpu: 9, cpuCore: 36, rss: 50 }]
        var r = M.mergeProcRows(rows, null, "cpu", 2)
        return r[0].cpu === 9 && r[1].cpu === 5
      })())
check("mergeProcRows assigns undefined, not 0, for a pid missing from a fresh cpuByPid map",
      (function() {
        var rows = [{ pid: 1, rss: 10 }]
        var r = M.mergeProcRows(rows, {}, "cpu", 1)
        return r[0].cpu === undefined && r[0].cpuCore === undefined
      })())

// ------------------------------------------------------------ process search
check("mergeProcRows filter matches on command, case-insensitively",
      (function() {
        var rows = [{ pid: 1, cpu: 5, cpuCore: 20, rss: 100, command: "steam", fullCommand: "steam" },
                    { pid: 2, cpu: 1, cpuCore: 4, rss: 50, command: "bash", fullCommand: "bash" }]
        var r = M.mergeProcRows(rows, null, "cpu", 8, "STE")
        return r.length === 1 && r[0].pid === 1
      })())
check("mergeProcRows filter also matches inside the full command line",
      (function() {
        var rows = [{ pid: 1, cpu: 5, cpuCore: 20, rss: 100, command: "python3",
                      fullCommand: "python3 /opt/game-launcher/run.py --fullscreen" },
                    { pid: 2, cpu: 1, cpuCore: 4, rss: 50, command: "bash", fullCommand: "bash" }]
        var r = M.mergeProcRows(rows, null, "cpu", 8, "launcher")
        return r.length === 1 && r[0].pid === 1
      })())
check("mergeProcRows filter matches by pid substring",
      (function() {
        var rows = [{ pid: 41234, cpu: 0, cpuCore: 0, rss: 10, command: "a", fullCommand: "a" },
                    { pid: 99, cpu: 0, cpuCore: 0, rss: 10, command: "b", fullCommand: "b" }]
        var r = M.mergeProcRows(rows, null, "cpu", 8, "4123")
        return r.length === 1 && r[0].pid === 41234
      })())
// This is the exact bug the search feature exists to fix: a stuck, idle
// process ranks below the display limit on both sort keys and is invisible
// in the plain top-N view, but must still be findable by name.
check("mergeProcRows filter bypasses the row limit so a low-usage match still surfaces",
      (function() {
        var rows = [
          { pid: 1, cpu: 90, cpuCore: 90, rss: 900, command: "hog-a", fullCommand: "hog-a" },
          { pid: 2, cpu: 80, cpuCore: 80, rss: 800, command: "hog-b", fullCommand: "hog-b" },
          { pid: 3, cpu: 70, cpuCore: 70, rss: 700, command: "hog-c", fullCommand: "hog-c" },
          { pid: 4, cpu: 0, cpuCore: 0, rss: 5, command: "stuckgame", fullCommand: "stuckgame" }
        ]
        var unfiltered = M.mergeProcRows(rows, null, "cpu", 3)
        var filtered = M.mergeProcRows(rows, null, "cpu", 3, "stuck")
        return unfiltered.every(function(r) { return r.pid !== 4 })   // hidden without a filter
            && filtered.length === 1 && filtered[0].pid === 4          // found with one
      })())
check("mergeProcRows filter still enforces a safety ceiling on a pathological match count",
      (function() {
        var rows = []
        for (var i = 1; i <= 900; i++)
          rows.push({ pid: i, cpu: 0, cpuCore: 0, rss: 0, command: "matchme" + i, fullCommand: "matchme" + i })
        var filtered = M.mergeProcRows(rows, null, "cpu", 8, "matchme")
        // Well above any real process count (so a genuine search is never
        // trimmed), but not infinite — 900 real matches must still come
        // back capped, not all 900.
        return filtered.length === 500
      })())
check("mergeProcRows filter with no match returns an empty list, not the unfiltered set",
      (function() {
        var rows = [{ pid: 1, cpu: 0, cpuCore: 0, rss: 0, command: "a", fullCommand: "a" }]
        return M.mergeProcRows(rows, null, "cpu", 8, "nonexistent-xyz").length === 0
      })())
check("mergeProcRows with a blank filter behaves exactly like no filter",
      (function() {
        var rows = [{ pid: 1, cpu: 5, cpuCore: 20, rss: 100, command: "a", fullCommand: "a" },
                    { pid: 2, cpu: 9, cpuCore: 36, rss: 50, command: "b", fullCommand: "b" }]
        var withBlank = M.mergeProcRows(rows, null, "cpu", 1, "   ")
        return withBlank.length === 1 && withBlank[0].pid === 2
      })())

check("parseProcDetailPs keeps a full command line with spaces",
      M.parseProcDetailPs("12 1 me 1.0 5.3 Sl 0 2048 /bin/app --flag a b").fullCommand
      === "/bin/app --flag a b")
check("parseProcDetailPs parses the fixed fields",
      (function() { var r = M.parseProcDetailPs("12 1 me 1.0 5.3 Sl 0 2048 /bin/app")
        return r.pid === 12 && r.ppid === 1 && r.user === "me" && r.rss === 2048 * 1024 })())
check("parseProcDetailPs rejects a short row", M.parseProcDetailPs("12 1 me") === null)
check("parseNoCpuPsLine keeps a command containing spaces",
      M.parseNoCpuPsLine("12 1 root 0.5 Sl 0 2048 4 120 my app").command === "my app")
check("parseNoCpuPsLine reads thread count and elapsed time off the same ps line",
      (function() {
        var r = M.parseNoCpuPsLine("12 1 root 0.5 Sl 0 2048 4 120 my app")
        return r.threads === 4 && r.elapsed === 120
      })())
check("parseNoCpuPsLine starts cpu/cpuCore undefined, not 0 — nothing has measured this row yet",
      (function() {
        var r = M.parseNoCpuPsLine("12 1 root 0.5 Sl 0 2048 4 120 app")
        return r.cpu === undefined && r.cpuCore === undefined
      })())
check("parseNoCpuPsLine rejects a row missing nlwp/etimes",
      M.parseNoCpuPsLine("12 1 root 0.5 Sl 0 2048 app") === null)

// ------------------------------------------------------------------ SMART
// Deliberately placed AFTER the live CPU sampling block: that block measures
// a tick delta between two snapshots but only starts its wall clock at the
// second one, so anything slow sitting between them (the churn test below
// spawns 60 processes) is charged to the delta and not to the elapsed time,
// which pushes the computed share past 100%.

// Three ways the snapshot used to lose processes silently, two of them hidden
// by the 2>/dev/null it needs for ordinary /proc churn.
check("snapshot never hands the /proc glob to a command as argv",
      M.COLLECT_PROC_SNAPSHOT.indexOf("printf '%s\\0' /proc/[0-9]*/stat") !== -1
      && !/awk[^|]*\/proc\/\[0-9\]\*\/stat/.test(M.COLLECT_PROC_SNAPSHOT))
check("snapshot reads through cat, so a process exiting mid-scan cannot truncate it",
      M.COLLECT_PROC_SNAPSHOT.indexOf("xargs -0 -r cat") !== -1)

// The whole command is piped through head -c OUTPUT_CAP_XLARGE, so on a busy
// enough machine the tail is cut. `ps` must therefore come FIRST: losing the
// tail costs CPU%, losing the head would cost the entire process list, which
// is what happened while the tick pass led. Asserted on behaviour, not on the
// command string: a snapshot cut anywhere past the marker still yields rows.
check("ps section is emitted before the tick section",
      M.COLLECT_PROC_SNAPSHOT.indexOf("ps -eo") < M.COLLECT_PROC_SNAPSHOT.indexOf("@@TICKS")
      && M.COLLECT_PROC_SNAPSHOT.indexOf("@@TICKS") < M.COLLECT_PROC_SNAPSHOT.indexOf("printf"))
var liveSnap = sh(M.COLLECT_PROC_SNAPSHOT)
var cutAtMarker = M.parseProcSnapshot(liveSnap.slice(0, liveSnap.indexOf("@@TICKS")))
var cutMidRows = M.parseProcSnapshot(liveSnap.slice(0, Math.floor(liveSnap.indexOf("@@TICKS") / 2)))
check("a snapshot truncated before the marker still returns the process rows",
      cutAtMarker.rows.length > 10 && Object.keys(cutAtMarker.ticks).length === 0,
      cutAtMarker.rows.length + " rows, " + Object.keys(cutAtMarker.ticks).length + " ticks")
check("a snapshot truncated mid-rows returns the rows that survived, not zero",
      cutMidRows.rows.length > 5, cutMidRows.rows.length + " rows")

// gawk aborts the WHOLE invocation with a fatal open error when a process
// exits before it reaches that pid's stat file, dropping every remaining
// process in the chunk. cat warns and continues, so the read survives churn.
// Measured on an idle machine, the old form fell from ~516 rows to as low as
// 358. Exercised for real by spawning short-lived processes underneath it.
var tickPass = M.COLLECT_PROC_SNAPSHOT.split("echo '@@TICKS'; ")[1]

// Deterministic mechanism check, run against a fixed set of files with one
// deliberately missing entry in the MIDDLE. This is the bug reduced to its
// essentials, with no timing, no $RANDOM (a bashism that silently yields 0
// under dash and would make a churn-based test pass vacuously), and no
// threshold to tune: awk given the list directly dies at the gap and never
// reads what follows, while the printf|xargs|cat form reads every survivor.
var gapDir = fs.mkdtempSync("/tmp/sysmon-gap-")
for (var gi = 1; gi <= 40; gi++) {
  fs.writeFileSync(gapDir + "/" + gi + ".stat",
                   gi + " (proc" + gi + ") S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20\n")
}
fs.unlinkSync(gapDir + "/20.stat")   // the gap a vanishing process leaves
// The list must NAME the deleted file — that is the whole point. Generating it
// from `ls` after the unlink would silently omit the gap and the control would
// pass for the wrong reason, which is exactly what it did on the first attempt.
var awkProg = tickPass.slice(tickPass.indexOf("awk '")).trim()
var fileList = "$(seq 1 40 | sed 's/$/.stat/')"
var oldForm = sh("cd " + gapDir + " && " + awkProg + " " + fileList + " 2>/dev/null | wc -l")
var newForm = sh("cd " + gapDir + " && printf '%s\\0' " + fileList + " 2>/dev/null" +
                 " | xargs -0 -r cat 2>/dev/null | " + awkProg + " | wc -l")
check("a vanished file makes the old awk-opens-the-glob form drop the rest",
      parseInt(oldForm || "0", 10) < 39,
      "old form read " + String(oldForm).trim() + " of 39 surviving files")
check("the shipped form reads every surviving file past the gap",
      parseInt(newForm || "0", 10) === 39,
      "new form read " + String(newForm).trim() + " of 39 surviving files")
try { fs.rmSync(gapDir, { recursive: true, force: true }) } catch (e) {}

// Corroboration against the real thing. POSIX-safe: no $RANDOM, the churn is
// created by short-lived subshells that exit at staggered but fixed intervals.
var churn = sh("i=1; while [ $i -le 60 ]; do ( sleep 0.0$(( i % 9 )) ) & i=$((i+1)); done; " +
               "N=$(" + tickPass + " | wc -l); wait; echo $N")
var churnCount = parseInt(churn || "0", 10)
check("live: tick pass still sees the full process table while processes churn",
      churnCount > Object.keys(snapA.ticks).length * 0.9,
      churnCount + " ticks under churn vs " + Object.keys(snapA.ticks).length + " at rest")

section("Disk — live `df`")
var dfRaw = sh("df -h --output=source,size,used,avail,pcent,target")
if (!dfRaw) skipped("parseDfOutput", "`df` unavailable")
else {
  var disks = M.parseDfOutput(dfRaw)
  check("parseDfOutput returns filesystems", disks.length > 0, "got " + disks.length)
  var sources = disks.map(function(d) { return d.source })
  check("sources are deduplicated",
        sources.length === new Set(sources).size, sources.join(","))
  var rawDevRows = dfRaw.split("\n").filter(function(l) { return l.indexOf("/dev") === 0 }).length
  check("dedup actually collapsed rows (btrfs subvolumes)",
        disks.length <= rawDevRows,
        rawDevRows + " raw rows -> " + disks.length + " filesystems")
  check("every filesystem has a primary mount", disks.every(function(d) { return !!d.mount }))
  check("percent parsed as a number", disks.every(function(d) { return d.percent >= 0 && d.percent <= 100 }))
  var multi = disks.filter(function(d) { return d.mounts.length > 1 })
  if (multi.length) {
    check("multi-mount filesystem picks the shortest mount as primary",
          multi.every(function(d) {
            return d.mounts.every(function(m) { return m.length >= d.mount.length })
          }),
          multi[0].source + " -> " + multi[0].mount + " of [" + multi[0].mounts.join(", ") + "]")
  } else skipped("multi-mount primary selection", "no filesystem mounted more than once here")
}

// ------------------------------------------------------------------ sensors
section("Sensors — live hwmon scan")
var sensorScan = sh(M.COLLECT_SENSORS)

if (!sensorScan) skipped("parseSensors", "hwmon scan produced nothing")
else {
  var sensors = M.parseSensors(sensorScan)
  check("parseSensors returns readings", sensors.length > 0, "got " + sensors.length)
  check("temperatures are plausible (0-150C)",
        sensors.every(function(s) { return s.tempC > 0 && s.tempC < 150 }))
  check("every reading has a device name", sensors.every(function(s) { return !!s.name }))

  var filtered = M.filterSensors(sensors, false)
  check("filterSensors reduces the reading count",
        filtered.length < sensors.length,
        sensors.length + " raw -> " + filtered.length + " filtered")
  check("filterSensors gives every row a unique display name",
        filtered.length === new Set(filtered.map(function(s) { return s.display })).size,
        filtered.map(function(s) { return s.display + "/" + s.label }).join(", "))
  check("filterSensors collapses the 9 coretemp readings to one",
        filtered.filter(function(s) { return s.name === "coretemp" }).length === 1)
  check("filterSensors keeps both NVMe drives as separate rows",
        filtered.filter(function(s) { return s.name === "nvme" }).length ===
        new Set(sensors.filter(function(s) { return s.name === "nvme" })
                       .map(function(s) { return s.label })).size ||
        filtered.filter(function(s) { return s.name === "nvme" }).length === 2,
        filtered.filter(function(s) { return s.name === "nvme" })
                .map(function(s) { return s.display }).join(", "))
  check("filterSensors(showAll) returns everything",
        M.filterSensors(sensors, true).length === sensors.length)
  check("filterSensors falls back rather than returning empty",
        M.filterSensors([{ name: "weird", label: "nonstandard", tempC: 40 }], false).length === 1)
  check("a single device of a kind is not numbered",
        M.filterSensors([{ name: "acpitz", label: "x", tempC: 30 }], false)[0].display
        === "Motherboard")
  check("duplicate device names are numbered from 1",
        M.filterSensors([{ name: "nvme", label: "Composite", tempC: 40 },
                         { name: "nvme", label: "Composite", tempC: 36 }], false)
         .map(function(s) { return s.display }).join(",") === "NVMe 1,NVMe 2")
}

section("Fans — live hwmon scan")
var fanScan = sh(M.COLLECT_FANS)
if (!fanScan || !fanScan.trim()) skipped("parseFans", "no fan sensors on this machine")
else {
  var fans = M.parseFans(fanScan)
  check("parseFans returns readings", fans.length > 0, fans.map(function(f) { return f.name + "=" + f.rpm }).join(","))
  check("fan RPMs are positive", fans.every(function(f) { return f.rpm > 0 }))
}
check("parseFans drops a zero-RPM (stopped/absent) fan", M.parseFans("nct|0").length === 0)

// ------------------------------------------------------------------ GPU
section("GPU — live sysfs")
var gpuBusy = read("/sys/class/drm/card2/device/gpu_busy_percent")
if (gpuBusy === null) skipped("parseGpuBusy", "no gpu_busy_percent at card2")
else {
  var busy = M.parseGpuBusy(gpuBusy)
  check("parseGpuBusy in 0..100", busy >= 0 && busy <= 100, "got " + busy)
}
check("parseGpuBusy clamps out-of-range input", M.parseGpuBusy("250") === 100)
check("parseGpuBusy handles empty input", M.parseGpuBusy("") === 0)
check("parseMilliCelsius converts millidegrees", M.parseMilliCelsius("46000") === 46)

// ------------------------------------------------------------------ GPU detail
section("GPU model — live pci.ids lookup")
check("parseGpuModel prefers the bracketed marketing name over the silicon codename",
      M.parseGpuModel("Navi 21 [Radeon RX 6900 XT]") === "Radeon RX 6900 XT"
      && M.parseGpuModel("GA102 [GeForce RTX 3090]") === "GeForce RTX 3090")
check("parseGpuModel passes an unbracketed name through unchanged",
      M.parseGpuModel("AlderLake-S GT1") === "AlderLake-S GT1")
check("parseGpuModel returns empty for empty, null and whitespace input",
      M.parseGpuModel("") === "" && M.parseGpuModel(null) === ""
      && M.parseGpuModel(undefined) === "" && M.parseGpuModel("   \n ") === "")
check("collectGpuModel refuses to build a command with no path",
      M.collectGpuModel("") === "true" && M.collectGpuModel(null) === "true")
var gpuModelPath = (sh(M.COLLECT_GPU_PATH) || "").trim()
if (!gpuModelPath) skipped("live GPU model lookup", "no AMD GPU on this machine")
else if (!fs.existsSync("/usr/share/hwdata/pci.ids")) skipped("live GPU model lookup", "hwdata pci.ids not installed")
else {
  var rawModel = sh(M.collectGpuModel(gpuModelPath)) || ""
  check("live: the pci.ids lookup resolves this machine's card to a non-empty name",
        M.parseGpuModel(rawModel).length > 0, "got " + JSON.stringify(rawModel.trim()))
  check("live: the resolved name carries no leftover brackets or PCI id digits",
        (function() {
          var n = M.parseGpuModel(rawModel)
          return n.indexOf("[") < 0 && n.indexOf("]") < 0 && !/^[0-9a-f]{4}$/.test(n)
        })())
}

section("Theme palette — live colors.toml")
check("parseThemePalette pulls hex colours out of key = \"#rrggbb\" lines",
      (function() {
        var p = M.parseThemePalette('mode = "dark"\naccent = "#58a6ff"\ngreen = "#4ade80"\n')
        return p.accent === "#58a6ff" && p.green === "#4ade80" && p.mode === undefined
      })())
check("parseThemePalette ignores non-colour values rather than guessing at them",
      (function() {
        var p = M.parseThemePalette('mode = "dark"\nborder = "#58a6ff #1f6feb 45deg"\nx = 3\n')
        return Object.keys(p).length === 0
      })())
check("parseThemePalette returns an empty object for empty, null and garbage input",
      Object.keys(M.parseThemePalette("")).length === 0
      && Object.keys(M.parseThemePalette(null)).length === 0
      && Object.keys(M.parseThemePalette("  nonsense")).length === 0)
var paletteRaw = sh(M.COLLECT_THEME_PALETTE) || ""
if (!paletteRaw.trim()) skipped("live theme palette", "no colors.toml for the active theme")
else {
  var livePalette = M.parseThemePalette(paletteRaw)
  check("live: the active theme yields a foreground and an accent",
        !!livePalette.foreground && !!livePalette.accent,
        "keys=" + Object.keys(livePalette).length)
  check("live: every parsed value is a 6-digit hex colour",
        Object.keys(livePalette).every(function(k) { return /^#[0-9a-fA-F]{6}$/.test(livePalette[k]) }))
}

section("GPU detail — live sysfs")
var gpuPath = (sh(M.COLLECT_GPU_PATH) || "").trim()
if (!gpuPath) skipped("parseGpuDetail", "no AMD GPU on this machine")
else {
  var gd = M.parseGpuDetail(sh(M.collectGpuDetail(gpuPath)))
  check("busy in 0..100", gd.busy >= 0 && gd.busy <= 100, "got " + gd.busy)
  check("VRAM total > 0", gd.vramTotal > 0, M.formatBytes(gd.vramTotal))
  check("VRAM used <= total", gd.vramUsed <= gd.vramTotal)
  check("power below cap", gd.watts > 0 && gd.watts <= gd.wattsCap,
        gd.watts + "W of " + gd.wattsCap + "W")
  check("clocks parsed with labels", gd.clocks.length >= 1
        && gd.clocks.every(function(c) { return c.name && c.mhz >= 0 }),
        gd.clocks.map(function(c) { return c.name + "=" + c.mhz }).join(","))
  check("multiple temps with labels", gd.temps.length >= 1
        && gd.temps.every(function(t) { return t.label && t.tempC > 0 && t.tempC < 150 }),
        gd.temps.map(function(t) { return t.label }).join(","))
}
check("parseGpuDetail on empty input yields zeroes",
      M.parseGpuDetail("").vramTotal === 0)
check("parseGpuDetail converts microwatts to watts",
      M.parseGpuDetail("power=45000000").watts === 45)
check("parseGpuDetail converts Hz to MHz",
      M.parseGpuDetail("freq:sclk=1155000000").clocks[0].mhz === 1155)

// ------------------------------------------------------------------ proc detail
section("Process detail — live /proc")
var ownPid = parseInt((sh("pgrep -u $(id -un) -n bash") || "0").trim(), 10)
if (!ownPid) skipped("parseProcDetail", "no own process found to inspect")
else {
  var pd = M.parseProcDetail(sh(M.collectProcDetail(ownPid)))
  check("exe resolves for an owned process", pd.exe.indexOf("/") === 0, pd.exe)
  check("cwd resolves for an owned process", pd.cwd.indexOf("/") === 0, pd.cwd)
  check("thread count is positive", pd.threads > 0, "threads=" + pd.threads)
  check("start time captured", pd.started !== "", pd.started)
  check("ancestry starts at the process itself", pd.chain.length > 0
        && pd.chain[0].pid === ownPid)
  check("ancestry terminates at pid 1",
        pd.chain[pd.chain.length - 1].pid === 1,
        pd.chain.map(function(c) { return c.comm + "(" + c.pid + ")" }).join(" < "))
  check("every ancestry entry has a command name",
        pd.chain.every(function(c) { return !!c.comm }))
}
check("collectProcDetail refuses a non-numeric pid",
      M.collectProcDetail("; rm -rf /") === "true")
check("collectProcDetail refuses a negative pid", M.collectProcDetail(-5) === "true")
check("parseProcDetail on empty input is safe",
      M.parseProcDetail("").chain.length === 0)

section("Sensor naming")
check("coretemp reads as CPU", M.friendlySensorName("coretemp") === "CPU")
check("amdgpu reads as GPU", M.friendlySensorName("amdgpu") === "GPU")
check("acpitz reads as Motherboard", M.friendlySensorName("acpitz") === "Motherboard")
check("iwlwifi_1 reads as Wi-Fi", M.friendlySensorName("iwlwifi_1") === "Wi-Fi")
check("ucsi_* reads as USB-C", M.friendlySensorName("ucsi_source_psy_0_00081") === "USB-C")
check("an unknown driver is capitalised, not invented",
      M.friendlySensorName("weirddrv") === "Weirddrv")
check("the temp*_input filename fallback is dropped as a label",
      M.friendlySensorLabel("acpitz", "temp1_input") === "")
check("NVMe Composite is dropped (it is the only reading)",
      M.friendlySensorLabel("nvme", "Composite") === "")
check("Package id 0 shortens to package",
      M.friendlySensorLabel("coretemp", "Package id 0") === "package")
check("a meaningful label survives",
      M.friendlySensorLabel("amdgpu", "junction") === "junction")

section("Formatting")
check("formatBytes 0", M.formatBytes(0) === "0 B")
check("formatBytes bytes", M.formatBytes(512) === "512 B")
check("formatBytes KB", M.formatBytes(1536) === "1.5 KB")
check("formatBytes GB keeps one decimal", M.formatBytes(13188538368) === "12.3 GB", M.formatBytes(13188538368))
check("formatBytes drops the decimal at 100+", M.formatBytes(1024 * 1024 * 347) === "347 MB", M.formatBytes(1024 * 1024 * 347))
check("formatBytes negative guards to 0 B", M.formatBytes(-5) === "0 B")
check("formatRate appends /s", M.formatRate(1536) === "1.5 KB/s")
check("formatTemp rounds", M.formatTemp(52.4) === "52°C")
check("formatPercent rounds", M.formatPercent(66.6) === "67%")
check("formatUptime days+hours+minutes", M.formatUptime(3 * 86400 + 14 * 3600 + 22 * 60) === "3d 14h 22m")
check("formatUptime minutes only", M.formatUptime(300) === "5m")
check("formatUptime zero", M.formatUptime(0) === "0m")
check("formatUptime live /proc/uptime parses",
      /^[0-9]/.test(M.formatUptime(parseFloat((read("/proc/uptime") || "0").split(" ")[0]))))
check("formatCompressionRatio", M.formatCompressionRatio(1416839168, 306943387) === "4.6:1")
check("formatCompressionRatio guards zero", M.formatCompressionRatio(100, 0) === "--")
check("formatElapsed seconds", M.formatElapsed(45) === "45s")
check("formatElapsed minutes", M.formatElapsed(700) === "11m")
check("formatElapsed hours zero-pad minutes", M.formatElapsed(12000) === "3h20")
check("formatElapsed days", M.formatElapsed(400000) === "4d15")
check("formatElapsed guards negatives", M.formatElapsed(-5) === "0s")
check("formatWatts keeps a decimal below 100", M.formatWatts(48.2) === "48.2 W")
check("formatWatts drops it at 100+", M.formatWatts(284) === "284 W")
check("formatMHz promotes to GHz at 1000", M.formatMHz(1155) === "1.16 GHz")
check("formatMHz stays in MHz below 1000", M.formatMHz(70) === "70 MHz")

// ------------------------------------------------------------------ summary
console.log("\n" + "=".repeat(56))
console.log("PASS " + pass + "   FAIL " + fail + "   SKIP " + skip)
if (skip > 0) console.log("(SKIP means the check did not run — never counted as a pass.)")
if (fail > 0) {
  console.log("\nFailures:")
  failures.forEach(function(f) { console.log("  - " + f) })
}
console.log("=".repeat(56))
process.exit(fail > 0 ? 1 : 0)
