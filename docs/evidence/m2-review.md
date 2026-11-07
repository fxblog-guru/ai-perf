# M2 evidence: the lifecycle on HTTP

## Checks

| Check | Result | How to rerun |
|---|---|---|
| Tests | 135 pass, 0 fail | `npm test` |
| Mutation | 106 of 106 mutants killed | `npm run mutate` |
| Quick Start | both README demos run as written on a clean copy (`tests/quickstart.test.mjs`); also run by hand on a copy with no runs or baselines | `node --test tests/quickstart.test.mjs` |
| Five pillars | each check mapped to its test and mutant | `docs/evidence/m2-pillars.md` |

Two things in the environment affected the test runs. Both are deliberate behaviour of ai-perf,
not gaps in it:
- The test machine was shared with heavy video renders, which freeze processes for up to 17 s.
  ai-perf reports such freezes as `worker_stalled` and a degraded run.
- Tests that use real engines retry a run that ended degraded for that reason (at most twice).
  Any other outcome fails at once.

## Mutation check before review

The first full mutation run of M2 left three survivors:
- `discover: confirmed stays confirmed`;
- `watch: budget`;
- `rules: target cpu gap`.

The first two now have tests that kill them. The third mutant was equivalent: dropping the gap
guard changes nothing, because `Math.min` over a null sample never exceeds a limit. It now
mutates to the realistic bug, judging only the samples that are present, and a unit test kills it.

## Independent review

An independent reviewer, given only the paths and the design, reviewed M2. It reproduced its
findings with scratch scripts and confirmed eight defects. All eight are fixed, each with a test
that fails on the old code (a mutant in `tests/mutate.mjs`).

| # | Severity | Finding | Fix | Test (mutant) |
|---|---|---|---|---|
| 1 | high | A container that yields no metrics (a misspelt name, docker down) silently disabled the `target_cpu_pct` auto-stop; the verdict still implied the target was monitored | `anomaly` event at the first miss; `monitoring_failed` makes the run degraded | `a container that yields no metrics…` (`unmonitored degrades`, `unmonitored warns at once`) |
| 2 | high | Steady rps used the windows that held samples: a target hung for a window produced no file and inflated rps (reproduced: 100 rps reported, 66.7 true) | rates over every planned whole window | `a target that completes nothing for a window…` (`rate over planned windows`) |
| 3 | medium | Any profile named `smoke` passed the smoke-only environment and skipped the SLO checks (5000 users for 2 h accepted) | a smoke is at most 10 users and 300 s | `"smoke" is a shape…` (`smoke is a shape`) |
| 4 | medium | The load script outside `.perf/` and the sampled errors in `raw/` were never scanned; the shim wrote error text unmasked | both scanned; the shim masks tokens, auth headers and URL credentials | doctor and shim tests (`secret: script scanned`, `secret: raw errors scanned`, `shim: secrets masked`) |
| 5 | medium | The shim took HTTP codes from digits in the message (`127.0.0.1` → "HTTP 127", `[Errno 111]` → "HTTP 111"), sending network failures to the app team | status from the response; otherwise the exception type | `shim: errors are classed by the response…` (`shim: status from response`) |
| 6 | low | `no_measured_window` could never be recorded, so a not-evaluable run said "see problems" over an empty list | condition fixed | `a target that completes nothing at all…` (`no measured window said`) |
| 7 | low | Python and Node disagreed on `warmup_users: 0` | Python uses the same `??` rule | shim test (`shim: warmup_users 0`) |
| 8 | low | Docs and flow contradicted the code: help sent users to `/perf-import` and `/perf-compare`, which do not exist yet, and treated NOT EVALUABLE as a pass; `stalled` was missing from `result.workers[]`; `perf report` crashed without `result.json`; a baseline at another target or user count was compared; `--wait` could give up while docker was starting | help names only existing commands and sends NOT EVALUABLE back to be fixed; `stalled` and `run.users` added; NOT EVALUABLE (exit 3) without a result; target and users refused; `--wait` follows the controller's `hard_deadline` | help, report and run tests (`help: not evaluable is fixed first`, `verdict: no result is not evaluable`, `verdict: refuse other target`, `verdict: refuse other load level`) |

Things the reviewer checked and found sound:
- percentiles only from merged histograms;
- window arithmetic matches between Python and Node;
- state precedence;
- heartbeat while collecting;
- the clock-offset bound;
- production, allowlist and stub refusals;
- the promote guard;
- the error-rate `min_requests` guard;
- the exit codes in CONTRACTS and the skills.

### Found by the pillar audit, before the review

A baseline measured with the fake engine was compared with a Locust run, and the README promised
that comparison. A baseline from another load tool is now refused (`verdict: refuse other tool`).

### Not covered by a mutant

`--wait` following the controller's `hard_deadline` is checked only by asserting that the deadline
is written and covers barrier + profile + drain. A slow container start cannot be reproduced on
the local target, so no test fails if `perf run` ignores the deadline.

## Final run

- `npm test`: 135 tests, 135 pass, 0 fail (Windows 11, Node 24, Locust 2.47.0, Docker 29.9.2; the docker and Locust tests ran, none skipped).
- `npm run mutate`: 106 mutants; the full run killed 105. The last one pointed at a line the
  monitoring fix had changed (reported `STALE`, which fails the run); repointed to the new line,
  it is killed. An unknown mutant name now fails the runner instead of passing it.
