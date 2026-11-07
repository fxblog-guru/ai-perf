# M10 evidence: host-process monitoring

Until M10 only containers were monitored. A target started with `npm start`, a JAR or a local
Postgres had no CPU or memory in the analysis, and a soak could not judge its memory. When such a
target crashed under load, the run went on loading a dead port, and the verdict blamed errors,
not the crash.

## What it does

`env.json` `monitor: { metrics: "host-process", processes: [{ name, pid | port | match }] }`:

| Found by | How | Linux | Windows | other posix |
|---|---|---|---|---|
| `pid` | that process | `/proc/<pid>` | PowerShell `Get-Process` | `ps` |
| `port` | the process listening on that TCP port | `/proc/net/tcp*` → socket inode → `/proc/*/fd` | `netstat -ano` | `lsof` |
| `match` | every process whose command line matches, summed | `/proc/*/cmdline` | `Win32_Process.CommandLine` | `pgrep -f` |

Each sample has `target_cpu_cores`, `target_cpu_pct` (share of this machine's CPUs),
`target_mem_bytes`, `target_mem_pct` and `target_process_up`. A process is found once and then
followed by pid. A restart under a new pid is therefore the old target gone, not the same target.

| Situation | Result |
|---|---|
| not running when the run starts | `perf run` refuses: "target process not running: api (port 8080)" |
| never sampled | `monitoring_failed`, run degraded (as for a container) |
| dies during the run | the run stops (`auto_stop:target_gone`); verdict FAIL "the target failed under load … process api (pid N) exited at t=…" |
| memory grows in a soak | the soak FAIL of M8, now for a host process too |

## Measured

`mock/busy-server.mjs` keeps a set share of a core busy, holds memory and can leak it.

| Platform | Asked | Measured (port, pid, match agree) |
|---|---|---|
| Windows 11 (PowerShell) | 0.6 core | 0.52–0.59 core, 130 MB |
| Linux (node:22-alpine, `/proc`) | 0.8 core | 0.803 core, 134 MB |

On Windows the first sample takes about 6 s, because netstat and the process list are read once.
Later samples take about 1 s: one PowerShell call measures every followed process.

## Correlation ids, said honestly

The M7 audit found that the analysis wrote "N sampled request(s) with correlation ids" even when
the engine recorded none. That is true of k6, and of the worker kit, which had no way to pass an
id. The analysis now counts the ids. It says "none with a correlation id: the engine records
none" and how to get them (an `X-Request-ID` header; the kit's new
`record(..., { correlation_id })`).

## Checks

- `tests/host.test.mjs`, 7 tests:
  - the adapter by port, pid and match on this OS;
  - the Linux path in a `node:22-alpine` container;
  - spec validation;
  - refusal when the target is not running;
  - a run sampling the process, then stopping and failing when it is killed mid-steady;
  - a soak failing on a leaking process;
  - correlation evidence.
- Mutation: 10 new mutants, all killed (each check above, disabled, fails its test).
- `npm test`: 259 tests; two ws tests failed once in the full parallel run on a loaded machine (generator saturated, run not evaluable) and passed on rerun (ws.test.mjs 14 of 14, the docker ws test 1 of 1).
- Independent review: see the section below.

## The independent review

A reviewer who had not written the code read commit 1691fd5. All eleven findings are fixed, in
the M11 commit. Their tests are in `tests/host.test.mjs` and their mutants in `tests/mutate.mjs`.

| # | Finding | Fix |
|---|---|---|
| 1 | A measuring tool that exited non-zero (Get-Process with one dead pid among live ones does) or timed out read as "target gone": a healthy server failed the run | output is kept whatever the exit code; a snapshot the tool could not take is no sample, never a death |
| 2 | The pid set was frozen at the first sample: recycled workers were missed, and a pool whose first workers were all replaced looked dead | `port` and `match` are looked up in every snapshot; workers that leave are an anomaly; gone only when none is left |
| 3 | `match` could catch the load generator (workers, the controller's children) | the controller, its descendants and any command line holding the run folder are excluded |
| 4 | macOS pgrep took POSIX regexes (and an option-like pattern) | one `ps -axo …command=` snapshot filtered with the same JS regex everywhere |
| 5 | Linux memory assumed 4 KiB pages | `RssAnon` (kB) from `/proc/<pid>/status` |
| 6 | A reused pid was measured as the target | processes are keyed by pid and start time |
| 7 | Windows netstat's state word is translated | `Get-NetTCPConnection -State Listen` |
| 8 | Windows working set can be trimmed (a leak looks healed); RSS of forked workers double-counts shared pages | private memory: Windows private bytes, Linux RssAnon; stated in CONTRACTS §1a |
| 9 | "Monitored" accepted any sample, so a target whose CPU was never measured passed | a CPU sample is required; the target is sampled once before the load, so its CPU rate starts with the run |
| 10 | A crash on a staircase was read as where capacity ran out | `target_gone` is a FAIL on every profile |
| 11 | The doctor's hint, error-rate auto-stop racing the death, PowerShell per sample | the hint names permissions; one PowerShell call per snapshot (about 2 s, so keep `interval_s` ≥ 5); the race leaves the verdict a FAIL either way |

Fixing finding 9 found one more problem. A target that died before its first in-run sample was
reported as "never monitored" instead of "gone". The priming sample before the load closes that
gap.
