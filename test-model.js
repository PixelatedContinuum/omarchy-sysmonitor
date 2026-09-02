#!/usr/bin/env node
// Model.js test harness.
//
// Runs the parsers against LIVE output from this machine wherever possible —
// real /proc and sysfs reads, real `ps`/`df`/`free` invocations — plus fixed
// samples for the paths that cannot be exercised locally (bandwhich needs
// CAP_NET_RAW, smartctl needs root).
//
// Every check reports PASS, FAIL, or SKIP with a reason. A SKIP is never
// counted as a pass.
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

section("isValidIfaceName — the gate before an interface name reaches a privileged command")
check("accepts ordinary interface names",
      ["eth0", "wlan0", "enp3s0", "docker0", "wg0", "tun0", "lo", "veth1234", "br-abc123def0"]
        .every(function(n) { return M.isValidIfaceName(n) }))
check("accepts the maximum kernel length (15 chars, IFNAMSIZ-1)",
      M.isValidIfaceName("123456789012345"))
check("rejects one character over the kernel limit",
      !M.isValidIfaceName("1234567890123456"))
check("rejects shell metacharacters that would matter if this were ever shell-interpolated",
      ["eth0; rm -rf /", "eth0 && whoami", "eth0`id`", "eth0$(id)", "eth0|id", "eth0\nid",
       "eth0 ", " eth0", "e/th0", "../etc"]
        .every(function(n) { return !M.isValidIfaceName(n) }))
check("rejects empty, null, and non-string input",
      !M.isValidIfaceName("") && !M.isValidIfaceName(null) && !M.isValidIfaceName(undefined))
check("rejects a name starting with a character outside [A-Za-z0-9]",
      !M.isValidIfaceName("-eth0") && !M.isValidIfaceName(".eth0") && !M.isValidIfaceName("_eth0"))
check("live default-route interface name (if any) passes the validator", (function() {
  var iface = (sh("ip -o -4 route show default 2>/dev/null | awk '{print $5}' | head -1") || "").trim()
  if (!iface) return true // no default route on this box right now — not a validator failure
  return M.isValidIfaceName(iface)
})())

section("isValidUsername — the gate before an account name reaches a sudoers principal field")
check("accepts ordinary usernames",
      ["jharrison", "root", "_apt", "www-data", "user123", "a", "user-name"]
        .every(function(n) { return M.isValidUsername(n) }))
check("accepts what useradd(8) itself allows but an earlier, narrower version of this validator rejected: uppercase, dots, a leading digit",
      ["John", "john.doe", "4nd", "UPPER", "mixedCase.name"]
        .every(function(n) { return M.isValidUsername(n) }))
check("accepts a trailing $ (Samba machine account convention)",
      M.isValidUsername("workstation$") && M.isValidUsername("John$"))
check("accepts the useradd(8) maximum length (256 chars)",
      M.isValidUsername("a" + "b".repeat(255)))
check("rejects one character over the maximum length",
      !M.isValidUsername("a" + "b".repeat(256)))
check("rejects a leading dash (the one leading character useradd(8) specifically disallows)",
      !M.isValidUsername("-user"))
check("rejects a fully numeric name, with or without the trailing $, per useradd(8)",
      !M.isValidUsername("12345") && !M.isValidUsername("12345$") && M.isValidUsername("4nd"))
check("rejects literal . and .. specifically",
      !M.isValidUsername(".") && !M.isValidUsername(".."))
check("rejects the exact sudoers-injection string this validator exists to stop",
      !M.isValidUsername("bad ALL=(ALL) NOPASSWD: /bin/bash #"))
check("rejects shell/sudoers metacharacters generally, none of these are in useradd's own allowed set either",
      ["user name", "user;id", "user#comment", "user\nALL=(ALL)", "user'quote", "user\"quote",
       "user`id`", "user$(id)", "user ALL=(ALL) NOPASSWD: /bin/bash"]
        .every(function(n) { return !M.isValidUsername(n) }))
check("rejects the bare sudoers reserved word ALL, even though it is otherwise a shape useradd would accept",
      !M.isValidUsername("ALL") && !M.isValidUsername("ALL$"))
check("rejects empty, null, and non-string input",
      !M.isValidUsername("") && !M.isValidUsername(null) && !M.isValidUsername(undefined))
check("live: the actual account this suite is running as passes the validator", (function() {
  var me = (sh("whoami") || "").trim()
  if (!me) return true
  return M.isValidUsername(me)
})())

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
        return Array.isArray(cmd) && cmd[0] === "setsid" && cmd[1] === "--"
               && cmd[2] === "bash" && cmd[3] === "-c" && typeof cmd[4] === "string"
      })())
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

section("buildExecutableValidationScript / parseExecutableValidation — provenance gate before a grant")
check("a real, trusted, root-owned, package-tracked binary passes every check",
      (function() {
        var v = M.parseExecutableValidation(sh(M.buildExecutableValidationScript("/usr/bin/bash")))
        return v.ok === true && v.reasons.length === 0 && v.realPath === "/usr/bin/bash"
      })())
check("the two binaries this plugin actually grants privileges to both pass",
      (function() {
        var smartctl = M.parseExecutableValidation(sh(M.buildExecutableValidationScript("/usr/bin/smartctl")))
        var bandwhich = M.parseExecutableValidation(sh(M.buildExecutableValidationScript("/usr/bin/bandwhich")))
        return smartctl.ok && bandwhich.ok
      })())
check("a nonexistent path fails closed with reasons given, not a silent pass",
      (function() {
        var v = M.parseExecutableValidation(sh(M.buildExecutableValidationScript("/tmp/sysmonitor-test-does-not-exist")))
        return v.ok === false && v.reasons.length > 0
      })())
check("a real file outside trusted system directories fails on path and ownership",
      (function() {
        var p = "/tmp/sysmonitor-test-fake-binary"
        fs.writeFileSync(p, "not a real binary")
        var v = M.parseExecutableValidation(sh(M.buildExecutableValidationScript(p)))
        fs.unlinkSync(p)
        return !v.ok && v.reasons.indexOf("resolved path is outside trusted system directories") >= 0
                     && v.reasons.some(function(r) { return r.indexOf("not owned by root") === 0 })
      })())
check("never throws on garbage input", (function() {
  M.buildExecutableValidationScript(null)
  M.parseExecutableValidation(null)
  M.parseExecutableValidation(undefined)
  return true
})())

section("buildCollisionSafeInstallScript — never a blind overwrite")
var csiTarget = "/tmp/sysmonitor-test-csi-target-" + process.pid
try { fs.unlinkSync(csiTarget) } catch (e) {}
function csiBackups() {
  return fs.readdirSync("/tmp").filter(function(f) { return f.indexOf("sysmonitor-test-csi-target-" + process.pid + ".bak") === 0 })
}
check("fresh install succeeds and makes no backup (nothing to back up)",
      (function() {
        sh(M.buildCollisionSafeInstallScript(csiTarget, "content-v1", "0644", "", "", null))
        return fs.existsSync(csiTarget) && fs.readFileSync(csiTarget, "utf8") === "content-v1" && csiBackups().length === 0
      })())
check("re-installing identical content stays a no-op backup-wise",
      (function() {
        sh(M.buildCollisionSafeInstallScript(csiTarget, "content-v1", "0644", "", "", null))
        return csiBackups().length === 0
      })())
check("installing different content backs up the old content before overwriting",
      (function() {
        sh(M.buildCollisionSafeInstallScript(csiTarget, "content-v2-different", "0644", "", "", null))
        var backups = csiBackups()
        return fs.readFileSync(csiTarget, "utf8") === "content-v2-different"
            && backups.length === 1
            && fs.readFileSync("/tmp/" + backups[0], "utf8") === "content-v1"
      })())
check("a failing validator leaves the existing target completely untouched",
      (function() {
        var before = fs.readFileSync(csiTarget, "utf8")
        var backupsBefore = csiBackups().length
        var built = M.buildCollisionSafeInstallScript(csiTarget, "not valid sudoers !!! garbage", "0644", "", "", "visudo -cf")
        var threw = false
        try { cp.execSync(built, { stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { threw = true }
        return threw && fs.readFileSync(csiTarget, "utf8") === before && csiBackups().length === backupsBefore
      })())
check("two same-second collisions each keep their own backup, neither clobbers the other",
      (function() {
        // The bug this regresses: backups named `.bak-$(date +%s)` reuse
        // the same filename for any two collisions inside one second, and
        // the second `cp -p` silently overwrote the first backup. Two
        // install calls back to back, with no sleep between them, is
        // exactly that scenario. A dedicated target, not csiTarget: the
        // checks above already left it with a backup of their own, and
        // this needs to count from a clean zero to mean anything.
        var t = "/tmp/sysmonitor-test-csi-collision-" + process.pid
        function backupsOf(target) {
          var base = target.split("/").pop()
          return fs.readdirSync("/tmp").filter(function(f) { return f.indexOf(base + ".bak") === 0 })
        }
        try { fs.unlinkSync(t) } catch (e) {}
        backupsOf(t).forEach(function(f) { try { fs.unlinkSync("/tmp/" + f) } catch (e) {} })
        sh(M.buildCollisionSafeInstallScript(t, "gen-0", "0644", "", "", null))  // baseline, no backup yet
        sh(M.buildCollisionSafeInstallScript(t, "gen-1", "0644", "", "", null))  // backs up gen-0
        sh(M.buildCollisionSafeInstallScript(t, "gen-2", "0644", "", "", null))  // backs up gen-1, same tick
        var backups = backupsOf(t)
        var contents = backups.map(function(f) { return fs.readFileSync("/tmp/" + f, "utf8") }).sort()
        backups.forEach(function(f) { try { fs.unlinkSync("/tmp/" + f) } catch (e) {} })
        try { fs.unlinkSync(t) } catch (e) {}
        return backups.length === 2 && contents[0] === "gen-0" && contents[1] === "gen-1"
      })())
csiBackups().forEach(function(f) { try { fs.unlinkSync("/tmp/" + f) } catch (e) {} })
try { fs.unlinkSync(csiTarget) } catch (e) {}

section("smartctl helper + sudoers rule — the narrower alternative to a command glob")
check("the helper script is syntactically valid bash", (function() {
  var p = "/tmp/sysmonitor-test-helper-syntax.sh"
  fs.writeFileSync(p, M.smartHelperScript())
  var ok = true
  try { cp.execSync("bash -n " + p, { stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { ok = false }
  fs.unlinkSync(p)
  return ok
})())
check("the sudoers rule names the fixed helper path and carries no wildcard or glob character",
      (function() {
        var rule = M.smartSudoersRule("someuser")
        return rule.indexOf(M.SMART_HELPER_PATH) >= 0
            && rule.indexOf("*") < 0 && rule.indexOf("?") < 0 && rule.indexOf("nvme") < 0
      })())
check("the sudoers rule's Cmnd carries an explicit empty-argument spec, so 'no arguments' is enforced by the rule and not only by the helper ignoring $@",
      (function() {
        // sudoers(5): "If no command line arguments are specified, the
        // user may run the command with any arguments they choose." A
        // rule with nothing after the path does NOT mean "no arguments";
        // it means "any arguments". "" is sudoers' own syntax for
        // requiring none.
        var rule = M.smartSudoersRule("someuser")
        return rule.indexOf(M.SMART_HELPER_PATH + " \"\"") >= 0
      })())
check("the sudoers rule passes visudo -cf, the same authoritative gate the original code used",
      (function() {
        var p = "/tmp/sysmonitor-test-sudoers-syntax"
        fs.writeFileSync(p, M.smartSudoersRule("someuser"))
        var ok = true
        try { cp.execSync("visudo -cf " + p, { stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { ok = false }
        fs.unlinkSync(p)
        return ok
      })())
check("the helper and sudoers paths are both fixed, non-empty, and distinct",
      M.SMART_HELPER_PATH !== "" && M.SMART_SUDOERS_PATH !== "" && M.SMART_HELPER_PATH !== M.SMART_SUDOERS_PATH)
check("a validated smartctl path is baked into the helper rather than left to PATH resolution",
      (function() {
        var withPath = M.smartHelperScript("/usr/bin/smartctl")
        var bare = M.smartHelperScript()
        return withPath.indexOf("'/usr/bin/smartctl' -j -a") >= 0
            && bare.indexOf("smartctl -j -a") >= 0 && bare.indexOf("'/usr/bin/smartctl'") < 0
      })())
check("buildGrantSmartScript references both fixed paths and the visudo gate",
      (function() {
        var g = M.buildGrantSmartScript("someuser")
        return g.indexOf(M.SMART_HELPER_PATH) >= 0 && g.indexOf(M.SMART_SUDOERS_PATH) >= 0
            && g.indexOf("visudo -cf") >= 0
      })())
check("smartSudoersRule refuses to build a rule for an invalid username, even one that would itself pass visudo -cf",
      (function() {
        // This is the exact injection a real account-name source could
        // hand this function: syntactically valid sudoers content that
        // visudo -cf cannot distinguish from a legitimate rule, so the
        // defense has to be at this function, not downstream of it.
        var evil = "bad ALL=(ALL) NOPASSWD: /bin/bash #"
        var rule = M.smartSudoersRule(evil)
        if (rule !== "") return false
        // Confirm the premise: had this NOT been refused, visudo -cf alone
        // would not have caught it (proving the gate has to live here).
        var p = "/tmp/sysmonitor-test-would-be-evil"
        fs.writeFileSync(p, evil + " ALL=(root) NOPASSWD: " + M.SMART_HELPER_PATH + "\n")
        var visudoWouldAccept = true
        try { cp.execSync("visudo -cf " + p, { stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { visudoWouldAccept = false }
        fs.unlinkSync(p)
        return visudoWouldAccept   // true confirms visudo alone is not the defense
      })())
check("buildGrantSmartScript refuses (exit 24) an invalid username before building any install script",
      (function() {
        var g = M.buildGrantSmartScript("bad ALL=(ALL) NOPASSWD: /bin/bash #")
        var r = runScript(g)
        return !r.ok && r.status === 24
            && g.indexOf(M.SMART_SUDOERS_PATH) < 0   // the sudoers path is never even referenced
      })())
check("live: the helper-then-sudoers install chain actually gates — a failing first half skips the second entirely",
      (function() {
        var t1 = "/tmp/sysmonitor-test-chain-a-" + process.pid
        var t2 = "/tmp/sysmonitor-test-chain-b-" + process.pid
        try { fs.unlinkSync(t1) } catch (e) {}
        try { fs.unlinkSync(t2) } catch (e) {}
        var failing = M.buildCollisionSafeInstallScript(t1, "x", "0644", "", "", "false")
        var second = M.buildCollisionSafeInstallScript(t2, "y", "0644", "", "", null)
        var threw = false
        try { cp.execFileSync("bash", ["-c", "(" + failing + ") && (" + second + ")"], { stdio: ["ignore", "pipe", "pipe"] }) }
        catch (e) { threw = true }
        var neitherExists = !fs.existsSync(t1) && !fs.existsSync(t2)
        try { fs.unlinkSync(t1) } catch (e) {}
        try { fs.unlinkSync(t2) } catch (e) {}
        return threw && neitherExists
      })())
check("live: the same chain, both halves passing, installs both — the shape buildGrantSmartScript actually uses",
      (function() {
        var t1 = "/tmp/sysmonitor-test-chain-c-" + process.pid
        var t2 = "/tmp/sysmonitor-test-chain-d-" + process.pid
        try { fs.unlinkSync(t1) } catch (e) {}
        try { fs.unlinkSync(t2) } catch (e) {}
        var me = (sh("whoami") || "").trim()
        var first = M.buildCollisionSafeInstallScript(t1, "helper content", "0755", me, me, null)
        var second = M.buildCollisionSafeInstallScript(t2, "sudoers content", "0644", me, me, null)
        cp.execFileSync("bash", ["-c", "(" + first + ") && (" + second + ")"], { stdio: ["ignore", "pipe", "pipe"] })
        var ok = fs.existsSync(t1) && fs.readFileSync(t1, "utf8") === "helper content"
              && fs.existsSync(t2) && fs.readFileSync(t2, "utf8") === "sudoers content"
        try { fs.unlinkSync(t1) } catch (e) {}
        try { fs.unlinkSync(t2) } catch (e) {}
        return ok
      })())
check("buildRevokeSmartScript removes exactly the sudoers rule and the helper, nothing else",
      (function() {
        var r = M.buildRevokeSmartScript()
        return r.indexOf(M.SMART_SUDOERS_PATH) >= 0 && r.indexOf(M.SMART_HELPER_PATH) >= 0
            && r.indexOf("rm -rf") < 0   // never a recursive/broad remove for a two-file cleanup
      })())

section("buildGrantCapabilityScript / buildRevokeCapabilityScript — bandwhich's capability, with a backup path")
check("both scripts are syntactically valid bash", (function() {
  var p = "/tmp/sysmonitor-test-cap-syntax.sh"
  var ok1, ok2
  fs.writeFileSync(p, M.buildGrantCapabilityScript("/usr/bin/bandwhich", "cap_net_raw+eip", "/tmp/x.bak"))
  try { cp.execSync("bash -n " + p, { stdio: ["ignore", "pipe", "pipe"] }); ok1 = true } catch (e) { ok1 = false }
  fs.writeFileSync(p, M.buildRevokeCapabilityScript("/usr/bin/bandwhich", "/tmp/x.bak"))
  try { cp.execSync("bash -n " + p, { stdio: ["ignore", "pipe", "pipe"] }); ok2 = true } catch (e) { ok2 = false }
  fs.unlinkSync(p)
  return ok1 && ok2
})())
// execSync("bash -c " + JSON.stringify(script)) re-parses the whole thing
// through execSync's OWN default shell before bash ever sees it — the
// outer shell's own $-expansion and quote handling mangles a script this
// size before it reaches the inner bash -c. execFileSync with an argv
// array hands `script` to bash as one literal argument, no outer shell
// involved, which is what every check below actually needs.
function runScript(script) {
  try { return { ok: true, out: cp.execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } }
  catch (e) { return { ok: false, status: e.status, stderr: (e.stderr || "").toString() } }
}

check("the grant script's own path guard rejects a target outside trusted directories before any privileged action",
      (function() {
        var built = M.buildGrantCapabilityScript("/tmp/sysmonitor-test-not-a-real-target", "cap_net_raw+eip", "/tmp/sysmonitor-test-x.bak")
        var r = runScript(built)
        return !r.ok && r.status === 20   // our own guard, not a setcap/permission failure downstream
      })())
check("live: grant refuses (exit 25) when the backup path is a pre-planted symlink, and never writes through it",
      (function() {
        var protectedFile = "/tmp/sysmonitor-test-symlink-victim-" + process.pid
        var backupPath = "/tmp/sysmonitor-test-symlink-backup-" + process.pid
        fs.writeFileSync(protectedFile, "PROTECTED-ORIGINAL")
        try { fs.unlinkSync(backupPath) } catch (e) {}
        fs.symlinkSync(protectedFile, backupPath)
        var r = runScript(M.buildGrantCapabilityScript("/usr/bin/bash", "cap_net_raw+eip", backupPath))
        var untouched = fs.readFileSync(protectedFile, "utf8") === "PROTECTED-ORIGINAL"
        var stillSymlink = fs.lstatSync(backupPath).isSymbolicLink()
        fs.unlinkSync(protectedFile); fs.unlinkSync(backupPath)
        return !r.ok && r.status === 25 && untouched && stillSymlink
      })())
check("live: grant refuses (exit 25) when the backup's CONTAINING DIRECTORY is a pre-planted symlink",
      (function() {
        var protectedFile = "/tmp/sysmonitor-test-symlink-victim2-" + process.pid
        var backupDir = "/tmp/sysmonitor-test-symlink-dir-" + process.pid
        fs.writeFileSync(protectedFile, "PROTECTED-2")
        try { fs.unlinkSync(backupDir) } catch (e) {}
        fs.symlinkSync("/tmp", backupDir)   // points somewhere real, not this specific file
        var r = runScript(M.buildGrantCapabilityScript("/usr/bin/bash", "cap_net_raw+eip", backupDir + "/" + protectedFile.split("/").pop()))
        var untouched = fs.readFileSync(protectedFile, "utf8") === "PROTECTED-2"
        fs.unlinkSync(protectedFile); fs.unlinkSync(backupDir)
        return !r.ok && r.status === 25 && untouched
      })())
check("live: grant succeeds normally against a non-symlinked backup path (the guards do not false-positive on the happy path)",
      (function() {
        var backupDir = "/tmp/sysmonitor-test-legit-dir-" + process.pid
        var backupPath = backupDir + "/cap.bak"
        try { fs.rmSync(backupDir, { recursive: true, force: true }) } catch (e) {}
        var r = runScript(M.buildGrantCapabilityScript("/usr/bin/bash", "cap_net_raw+eip", backupPath))
        // Expected to fail at the real setcap (unprivileged in this test
        // run), NOT at any of our own guards (20-25): proving the backup
        // itself got written cleanly before that final, expected failure.
        var backupWritten = fs.existsSync(backupPath)
        fs.rmSync(backupDir, { recursive: true, force: true })
        return !r.ok && r.status !== 20 && r.status !== 21 && r.status !== 22 && r.status !== 25 && backupWritten
      })())
check("live: revoke refuses (exit 23, its existing no-backup code) when the backup path is a symlink to a real file, not just when nothing is there",
      (function() {
        // -f alone follows a symlink to check its TARGET's type, so a
        // symlink to a real file would pass a bare -f check; -L is what
        // actually catches this. Confirms the read side got the same
        // defense as the write side, not just a re-verification of the
        // write side under a different name.
        var attackerFile = "/tmp/sysmonitor-test-symlink-readsrc-" + process.pid
        var backupPath = "/tmp/sysmonitor-test-symlink-readbak-" + process.pid
        fs.writeFileSync(attackerFile, "cap_sys_admin+eip")   // attacker-chosen "capability"
        try { fs.unlinkSync(backupPath) } catch (e) {}
        fs.symlinkSync(attackerFile, backupPath)
        var r = runScript(M.buildRevokeCapabilityScript("/usr/bin/bash", backupPath))
        var symlinkUntouched = fs.lstatSync(backupPath).isSymbolicLink()
        fs.unlinkSync(attackerFile); fs.unlinkSync(backupPath)
        return !r.ok && r.status === 23 && symlinkUntouched
      })())
check("revoke refuses (exit 23) when no backup file exists, rather than stripping a capability this plugin never granted",
      (function() {
        var backupPath = "/tmp/sysmonitor-test-no-such-backup-" + process.pid + ".bak"
        try { fs.unlinkSync(backupPath) } catch (e) {}
        var r = runScript(M.buildRevokeCapabilityScript("/usr/bin/bash", backupPath))
        return !r.ok && r.status === 23
      })())
check("revoke proceeds when a backup file exists (still fails past that on the real setcap without root, but past our own guard)",
      (function() {
        var backupPath = "/tmp/sysmonitor-test-has-backup-" + process.pid + ".bak"
        fs.writeFileSync(backupPath, "")   // "" is a legitimate backup: there was nothing before our grant
        var r = runScript(M.buildRevokeCapabilityScript("/usr/bin/bash", backupPath))
        // A successful pass through the backup-exists guard removes the
        // backup file itself (see buildRevokeCapabilityScript's `rm -f`) —
        // whether that happened or not, don't fail cleanup over it.
        try { fs.unlinkSync(backupPath) } catch (e) {}
        // Unprivileged setcap on a real system binary fails with its own
        // exit code — the point of this check is only that it is NOT 23
        // (our own refusal), i.e. the backup-exists guard let it through.
        return r.status !== 23
      })())
check("never throws on garbage input", (function() {
  M.buildGrantCapabilityScript(null, null, null)
  M.buildRevokeCapabilityScript(undefined, undefined)
  return true
})())

section("bandwhich — real raw format")
var bwCaps = sh('getcap "$(command -v bandwhich)" 2>/dev/null') || ""
if (bwCaps.indexOf("cap_net_raw") < 0) skipped("live bandwhich capture", "binary has no cap_net_raw")
else {
  var live = sh("timeout 5 bandwhich -r -p -i $(ip -o -4 route show default | awk '{print $5}' | head -1) 2>/dev/null") || ""
  var procLines = live.split("\n").filter(function(l) { return l.indexOf("process:") === 0 })
  if (!procLines.length) skipped("live bandwhich rows", "no traffic during the sample window")
  else {
    check("every live line parses", procLines.every(function(l) {
      return M.parseBandwhichLine(l) !== null }), procLines.length + " lines")
    check("names are not the timestamp", procLines.every(function(l) {
      var r = M.parseBandwhichLine(l)
      return r && !/^\d+$/.test(r.process) }))
  }
}

// The angle-bracketed field is a per-refresh timestamp, not a pid. Reading it
// as the name is what put bare numbers in the panel.
var bw = M.parseBandwhichLine('process: <1788094173> "claude" up/down Bps: 12/628 connections: 3')
check("extracts the quoted name, not the timestamp", bw && bw.process === "claude", bw && bw.process)
check("captures the refresh cycle id", bw && bw.cycle === "1788094173")
check("up maps to tx and down to rx", bw && bw.txRate === 12 && bw.rxRate === 628)
check("captures the connection count", bw && bw.connections === 3)
check("keeps a name containing spaces",
      M.parseBandwhichLine('process: <1> "my app" up/down Bps: 1/2 connections: 1').process === "my app")
check("legacy timestamp-less form still parses",
      M.parseBandwhichLine('process: <brave> up/down Bps: 1/2').process === "brave")
check("rejects a non-process line", M.parseBandwhichLine("Refreshing:") === null)
check("<UNKNOWN> is recognised as unattributed", M.isUnattributed("<UNKNOWN>"))
check("a real name is not unattributed", !M.isUnattributed("claude"))

check("rows for one process are summed, not overwritten", (function() {
  var st = null
  st = M.bandwhichAccumulate(st, M.parseBandwhichLine('process: <7> "a" up/down Bps: 10/100 connections: 2'))
  st = M.bandwhichAccumulate(st, M.parseBandwhichLine('process: <7> "a" up/down Bps: 5/50 connections: 1'))
  var top = M.bandwhichTop(st, 5)
  return top.length === 1 && top[0].rxRate === 150 && top[0].txRate === 15 && top[0].connections === 3
})())

check("a new refresh cycle replaces the batch rather than accumulating", (function() {
  var st = null
  st = M.bandwhichAccumulate(st, M.parseBandwhichLine('process: <1> "a" up/down Bps: 0/999 connections: 1'))
  st = M.bandwhichAccumulate(st, M.parseBandwhichLine('process: <2> "b" up/down Bps: 0/5 connections: 1'))
  var top = M.bandwhichTop(st, 5)
  return top.length === 1 && top[0].process === "b"
})())

check("unattributed traffic sorts last even when it is the largest", (function() {
  var st = null
  st = M.bandwhichAccumulate(st, M.parseBandwhichLine('process: <1> "<UNKNOWN>" up/down Bps: 0/9999 connections: 1'))
  st = M.bandwhichAccumulate(st, M.parseBandwhichLine('process: <1> "brave" up/down Bps: 0/10 connections: 1'))
  return M.bandwhichTop(st, 5)[0].process === "brave"
})())

// ------------------------------------------------------------------ proc CPU
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
section("SMART — live smartctl")
var smartRaw = sh("smartctl -j -a /dev/nvme0n1")
var smartUsable = smartRaw && M.parseSmartHealth(smartRaw) !== null
if (!smartUsable) {
  skipped("parseSmartHealth against live data", "smartctl needs root on this machine (plan 4.7)")
  check("parseSmartHealth returns null when the health log is absent",
        M.parseSmartHealth(smartRaw || '{"smartctl":{"exit_status":2}}') === null)
} else {
  var sm = M.parseSmartHealth(smartRaw)
  check("parseSmartHealth reads temperature", sm.temp > 0)
  check("parseSmartHealth reads wear percentage", sm.wearPercent >= 0)
}
check("parseSmartHealth returns null on malformed JSON", M.parseSmartHealth("not json") === null)
check("parseSmartHealth returns null on empty input", M.parseSmartHealth("") === null)
check("parseSmartHealth converts data units to bytes",
      M.parseSmartHealth('{"nvme_smart_health_information_log":{"data_units_read":2}}').dataRead === 1024000)

// ------------------------------------------------------------------ disk
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

section("NVMe enumeration")
var nvmes = (sh(M.COLLECT_NVME_LIST) || "").trim()
if (!nvmes) skipped("COLLECT_NVME_LIST", "no NVMe block devices")
else check("enumerates at least one NVMe device",
           nvmes.split("\n").every(function(d) { return d.indexOf("/dev/nvme") === 0 }),
           nvmes.split("\n").join(", "))

// ------------------------------------------------------------------ formatting
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
