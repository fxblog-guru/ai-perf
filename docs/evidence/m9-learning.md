# M9 evidence: learning and operations

The M7 audit found that pillar 2 (memory and learning) and parts of operations stopped at
writing things down. Lessons existed but nothing read them at the step they were for. Nothing
measured whether ai-perf got better from one version to the next. Cleanup was declared but never
run. Nothing checked that a run sent the workload it was planned to send. The doctor covered four
of the seven groups in design §11. This milestone closes those gaps; each one has a check that
can fail.

| Gap (M7 audit) | Pillar | Mechanism now | The check that fails without it |
|---|---|---|---|
| Lessons not read at each step | P2 | each lesson names the step that can act on it; `perf lessons --step`, `perf help` and `perf run` show them | `learning.test.mjs`: the script lesson is shown at the script step and not elsewhere; `perf run` prints the run lesson |
| Lessons not shared across projects | P2 | `run` lessons go to `$PERF_HOME/lessons.json`; when two projects teach the same one, it is proposed to the bundle; a third project reads them | a lesson from two projects is `[propose]`d; a system lesson (HTTP 503) stays local; a new project reads the lesson |
| Runs-to-correct-result not tracked | P2 | `scorecard.json`: runs to an evaluable result per version and profile, with the reasons; global median per version | 2 NOT EVALUABLE runs then a PASS give "evaluable at run 3; no baseline … ×2"; the global median is 3 |
| Small cases not routed to stlc | P3 | `perf help` says "small case" (≤ 5 operations, ≤ 50 users, no realtime, suite, peak event or incident) | a small project is routed; realtime, an incident or 500 users keep it here |
| Doctor covered 4 of 7 groups | P4 | machine (Docker, Python), generator (CPU, ports, open files), network (answers, DNS, localhost on Windows), safety (unstubbed third parties), project (files, gates, stale baselines, contract drift, assumptions) | a planted fault per check (`doctor.test.mjs`); a run that needs Docker is refused when Docker does not answer |
| Cleanup declared, never run | P4 | the controller runs it after every run, with the run id, killed with its children on timeout | `cleaned.txt` holds the run id; a failing or hung cleanup is a WARN; `none:` is a no-op |
| Measured mix never checked against the plan | P3 | per operation, the share sent against the share planned (5 pp + 3 σ); unplanned operations | an even plan against a 6:3:1 script warns; an operation the plan lacks warns |

Clock skew is the one §11 group left. It needs several machines, which is M11.

## The independent review

A reviewer who had not written the code read the diff. Every finding is fixed, and each fix has a
mutant that its test kills.

| # | Finding | Fix |
|---|---|---|
| 1 | In a closed model a weight is a share of users, not of iterations: journeys with different think times warned on plans the script followed (50/50 at 1 s and 10 s think sends 91/9) | closed plans weigh users over their cycle (measured p50 + think); open plans are arrival shares; the meaning is written in the contract and the modeling skill |
| 2 | An imported Locust suite drafted one journey with equal shares, so its `@task(6/3/1)` warned on every run | one journey per operation at the task's weight; a login in `on_start` is setup, out of the mix |
| 3 | A rare operation (planned 3 %) never sent passed the 5 pp floor | also off by more than half its share, and never sent while 5 or more were due |
| 4 | Full doctor sent a GET to a host the spec refused; a TLS error read as "does not answer" | no probe when the spec has errors; only no-connection fails, other errors warn |
| 5 | Cleanup ran before `result.json` was written; its time inflated `ended_at` | the result is written first, then cleanup is added to it |
| 6 | Cleanup command and output went raw into result, events, verdict and JUnit | masked (shared `lib/mask.mjs`, which now also masks `PASSWORD=`, `API_KEY=`, `--password=`) |
| 7 | A cleanup leaving a background process was a timeout; a non-numeric timeout killed it at once | done on exit; `timeout_s` validated by the data gate |
| 8 | A stray file in `baselines/` crashed the doctor | directories only |
| 9 | Contract drift flagged every x-perf operation, though the drafter picks GETs of chosen classes | flags what the drafter would pick: GETs in a class the plan covers |
| 10 | Lessons learned before steps existed were never read | a known lesson takes today's step, kind and text on each learn |
| 11 | The global store held absolute paths; two clones counted as two projects; no lock | projects are hashes of repo + slug; writes take a lock |
| 12 | A profile already working under an old version flattered the new one | such profiles are `continued`, out of the global median |
| 13 | "50-100 users" read as 50; open assumptions warned forever | a range is its top; assumptions warn once a load run rests on them |

The reviewer also said a failed cleanup turns a CI PASS into exit 4. It does not: a WARN exits 0.
The contract now says so.

## What the new checks found in ai-perf itself

- **The Quick Start example and the M2 lifecycle test planned the wrong workload.** Their
  `workload.json` ran all three operations in one journey, a third each. Their Locust script
  weighs tasks 6:3:1. Every verdict they produced described a workload nobody had planned. The mix
  check flagged it on its first full run. Both now plan 60 / 30 / 10.
- **A hung cleanup would have hung the controller on Windows.** Killing the shell left its node
  child holding the output pipes, so the run never finished. The cleanup is now killed as a tree
  (`taskkill /T`, or a process group on posix) and the run ends at the timeout.
- **A run that needs Docker started without it** and found out only through missing samples. The
  quick doctor before a run now checks Docker when the run needs it.
- **README was two milestones behind** (v0.6.0, no M7 or M8 row).

## Checks

- `npm test`: 252 of 252 pass. New: learning.test.mjs (12 tests), 5 doctor tests, 1 import test, 2 docker tests.
- Mutation: all 321 mutants killed, 48 of them new for M9. The full run left one surviving: its pattern also matched an earlier line (the list of project folders), so it mutated the wrong code. It was retargeted to the baselines line and is killed.
- Independent review: 13 findings, all fixed, above.

## Left for later milestones

- **M10:** host-process metrics (by port, pid or name), so a target outside Docker is monitored,
  including its memory for soaks; real correlation ids.
- **M11:** a network control channel for several machines, then ssh and k8s targets; clock skew
  between machines in the doctor.
