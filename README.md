# System Monitor — Omarchy plugin

A native system-monitoring panel for [Omarchy](https://omarchy.org/): CPU, memory, GPU, disk, network and processes in one large floating window, keyboard-driven, in the spirit of btop but drawn by the shell itself. A bar cell with a quick-reference dropdown sits alongside it for a lighter glance — the full panel stays the deep-dive view.

![kind](https://img.shields.io/badge/kind-panel-blue) ![kind](https://img.shields.io/badge/kind-bar--widget-blue) ![shell](https://img.shields.io/badge/omarchy-shell-lightgrey)

## Install

```bash
omarchy plugin add https://github.com/PixelatedContinuum/omarchy-sysmonitor.git --enable
```

Then bind it. In `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + CTRL + SHIFT + T", "System Monitor", "omarchy-shell shell toggle jharrison.sysmonitor")
```

It is a Quickshell `FloatingWindow`, so Hyprland tiles it by default. To float and centre it like btop's window, in `~/.config/hypr/hyprland.lua`:

```lua
o.window({ class = "^org\\.quickshell$", title = "^System Monitor$" }, { tag = "+sysmonitor-window" })
o.window({ tag = "sysmonitor-window" }, { float = true })
o.window({ tag = "sysmonitor-window" }, { center = true })
o.window({ tag = "sysmonitor-window" }, { size = { 1180, 900 } })

-- Omarchy tags every window "+default-opacity" (0.985/0.96). On a dense grid
-- of small numbers even 4% of bleed-through costs legibility.
o.window({ tag = "sysmonitor-window" }, { tag = "-default-opacity" })
o.window({ tag = "sysmonitor-window" }, { opacity = "1 1" })
```

Update with `omarchy plugin update jharrison.sysmonitor`.

## Bar widget

Installing the plugin also registers a `bar-widget` kind — a compact row of icon-prefixed
readouts (CPU, GPU if a discrete AMD card is detected, memory, CPU temperature, network
throughput), using the same Nerd Font glyph family Quadrant's own bar cell uses so the two
read as one visual language rather than two clashing styles. Click it for a condensed
quick-reference dropdown: the same headline numbers plus disk in a small grid, and the top
few processes by CPU. It polls independently of the full panel, so it stays current whether
or not the big window is open.

Not shown anywhere by default; place it in `~/.config/omarchy/shell.json` under `bar.layout`
(`left`, `center`, or `right`):

```json
{ "id": "jharrison.sysmonitor" }
```

It reserves its own edge margin on both sides — the same convention `WidgetButton` gives
every ordinary bar widget by default — so it won't crowd whatever ends up next to it, no
matter which section it's placed in or which side that neighbor is on. If you'd like even
more breathing room than that as a matter of taste, Omarchy ships a first-party
`omarchy.spacer` bar-widget — drop one into the array with a pixel `size`:

```json
{ "id": "omarchy.spacer", "size": 24 }
```

`omarchy-restart-shell` afterwards. The dropdown has an "Open full monitor" link that runs the
same `omarchy-shell shell toggle jharrison.sysmonitor` command as the keybinding above — a
second door into the same panel, not a second implementation of it.

## Uninstall

```bash
omarchy plugin remove jharrison.sysmonitor
```

This unregisters the plugin and stops the shell from loading it. The keybinding in
`bindings.lua` and the window rules in `hyprland.lua` from Install are just a few lines you
added by hand — removing the plugin does not touch either file. Leaving them in place is
harmless (the panel's window class simply never appears again), but delete them too for a
clean config.

## What it shows

| Section | Detail |
|---|---|
| **CPU** | Total plus a per-thread grid, load average, pressure stall (cpu/io/mem), package temperature |
| **Memory** | RAM, swap, and zram compression ratio |
| **GPU** | AMD: core and memory-controller utilisation, VRAM, power against cap, sclk/mclk, fan, and all three die temps (edge / junction / mem) |
| **Disk** | Per-filesystem usage, deduplicated by device, plus NVMe health (temperature, wear, hours, error count) |
| **Network** | Interface throughput and per-process traffic via bandwhich |
| **Processes** | CPU, threads, runtime, memory; search by name or pid; click for executable path, working directory and full ancestry; terminate, force-kill, renice, or open in `lsof` |

## Keys

| Key | Action |
|---|---|
| `j` / `k`, arrows | Move the cursor |
| `h` / `l` | Previous / next section |
| `1`–`9` | Jump to a section |
| `/` | Search processes by name or pid |
| `Enter` | Process detail (or, while searching, apply the filter) |
| `x` | Terminate the selected process |
| `s` | Sort by CPU or memory |
| `p` | Pause the process list |
| `r` | Refresh everything |
| `PgUp` / `PgDn`, `Home` / `End` | Scroll |
| `Esc` | Back, then close (or, while searching, clear the filter) |

Search matches the process name, its full command line (so `--flag value` style
arguments count), and pid, all as substrings — and, unlike the plain process
list, is never limited to the top `processCount` rows. That distinction is the
point of the feature: a stuck or idle process (a game window that will not
exit, holding ~0% CPU and memory) sorts to the bottom on every key and drops
out of the capped view entirely, so search is what makes it findable again.

## A note on the CPU column

`ps %cpu` reports *CPU time ÷ elapsed time averaged over a process's whole lifetime*, scaled to one core. A scanner holding one core of sixteen reports "98%", which reads as nearly the whole machine while the headline says 12%. Both numbers are right and they measure different things.

This panel computes CPU the way btop does — `utime+stime` deltas between polls, read from `/proc/[0-9]*/stat` — and the column is **share of the whole machine**, so it sums toward the headline instead of contradicting it. The per-core figure is in the detail view: "6.1% of 16 threads (98% of one core)".

## Permissions

Two sections need privileges the panel does not assume. Each renders an **Enable** button that shells out to `pkexec`, so the polkit agent raises its own password prompt and the panel never handles the credential.

- **Per-process network** — `setcap cap_net_raw,cap_net_admin+eip` on the bandwhich binary.
- **Drive health** — a sudoers drop-in granting exactly `smartctl -j -a /dev/nvme*n1`. It is validated with `visudo -c` before install, since a malformed drop-in can lock `sudo` out entirely. This is narrower than joining the `disk` group, which would grant raw read/write on every disk.

bandwhich's own `<UNKNOWN>` rows are shown as *unattributed*: without root it cannot map another user's socket back to a process.

## Configuration

`manifest.json` → `panel.defaults`:

| Key | Default | Meaning |
|---|---|---|
| `pollInterval` | `2000` | Base poll in ms |
| `showCpuPerCore` | `true` | Per-thread CPU grid |
| `showSmartHealth` | `true` | NVMe health rows |
| `showBandwhich` | `true` | Per-process network |
| `processCount` | `14` | Rows in the process table |
| `showAllSensors` | `false` | Every hwmon reading rather than one per device |
| `fontScale` | `1.25` | Multiplier over the theme's font tokens |

A `panel`-kind plugin receives no `settings` injection from the shell, so the manifest is the config surface. Edit it and run `omarchy-restart-shell`.

## Layout

The window is resizable and tileable; nothing assumes the 1180px it opens at. Cores reflow 4 → 2 → 1, the dashboard stacks below 700px, and process columns drop right-to-left as width runs out, with COMMAND absorbing the slack. `minimumSize` is 360×280.

## Development

```bash
node test-model.js
```

All parsing lives in `Model.js` — pure functions plus the collector shell scripts, so the panel and the tests run byte-identical commands. The suite exercises them against this machine's real `/proc`, sysfs, `ps` and `df` output. Checks report PASS, FAIL or **SKIP**; a skip is never counted as a pass, so a capability that could not be exercised says so rather than passing silently.

A QML edit needs `omarchy-restart-shell` to take effect — the `FloatingWindow` survives hide/show, so reopening the panel keeps the old object and its stale property values.

`docs/PLAN.md` carries the design history and the traps found along the way.

## Requirements

Omarchy shell (Quickshell). AMD GPU section needs `amdgpu`; NVMe health needs `smartmontools`; per-process network needs `bandwhich`. Everything else reads `/proc` and sysfs directly. Sections whose source is missing hide themselves rather than rendering empty.

## Licence

MIT.
