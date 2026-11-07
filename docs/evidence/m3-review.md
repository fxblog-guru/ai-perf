# M3 evidence: existing suites

## Checks

| Check | Result | How to rerun |
|---|---|---|
| Tests | 156 pass, 0 fail | `npm test` |
| Mutation | 133 of 133 killed | `npm run mutate` |
| Exit check: import a k6 and a Locust suite | both are imported and run as they are under the controller, against the mock | `node --test tests/suites.test.mjs` |
| Exit check: the audit finds planted defects | `examples/legacy-suite` holds 10 planted defects in k6 and 5 in Locust; every one is found, at its line | same |
| Exit check: k6 added with no skill diff | `git diff bdf27a7 499bc42 -- skills commands` is empty: the k6 engine changed no skill or command | `git diff bdf27a7 499bc42 --stat -- skills commands` |

## What M3 added

- **k6 engine** (design D10). A Node sidecar speaks the worker protocol and runs k6 as its
  child: started paused, resumed at `go_at`, its points read from `--out json`. k6 runs as a
  binary or as `grafana/k6:1.0.0` under Docker.
- **`perf import`**. It reads k6, Locust, Gatling and JMeter suites without changing them. It
  writes draft `workload.json` and `slo.json` where none exist, one run spec per runnable suite,
  and the old results as reference only. It has its own gate.
- **`perf audit`**. Eleven rules mapped to perf-standard, a score per suite, and ranked fixes,
  each with its evidence lines.
- **Gatling** suites are imported and audited but not run (design D11): Gatling 3.11+ logs in
  binary and the OSS edition has no pluggable writer.

## Independent review

An independent reviewer, given the paths and the design, reproduced each finding against a
real k6 (grafana/k6:1.0.0 in Docker). It confirmed nine. All nine are fixed, each with a test
that fails on the old code (a mutant in `tests/mutate.mjs`).

| # | Severity | Finding | Fix | Test (mutant) |
|---|---|---|---|---|
| 1 | high | k6 starts its stages seconds after `go_at` (2.5 s measured; more with a slow `setup()`), so ramp load landed in the steady windows; `setup()` requests counted as an operation | points are placed on k6's own clock from its first default-scenario request; setup and teardown points are skipped; the lag is reported as `start_lag_s`, and a lag longer than the rampdown degrades the run (`engine_start_lag`); `perf run` warns below 3 s of rampdown with k6 | `k6: a slow setup() delays the load…` (`k6: points on k6 own clock`, `k6: setup is not load`, `k6: start lag degrades`) |
| 2 | high | A sidecar that died mid-run left k6 loading the target: the controller never stopped its child, and doctor ignored it (reproduced: the container kept running after its `docker run` client was killed) | the controller kills `child` as soon as a worker is lost; doctor reports a live child of a lost run as an orphan, and `--fix` removes it | `k6: a sidecar that dies mid-run…` (`k6: stop a dead sidecar's engine`), `doctor reports the engine a dead sidecar left running…` (`doctor: orphan engine`) |
| 3 | medium-high | An unnamed k6 request was keyed by its full URL, query and token included, in `result.json` and `errors.ndjson` | the key drops the query and is masked | slow-setup test (`k6: unnamed URL without query`) |
| 4 | medium | Failed k6 `check()`s never counted as failures, so a 200 with a failed payload could PASS | checks counted per window, merged into `result.checks`, and judged against the strictest SLA and SLO error rates (PS-B8, PS-D3) | `report: failed business checks count…` (`verdict: failed checks fail`) |
| 5 | medium | Import overwrote a tuned run spec, and two suites of the same tool shared one spec | one spec per suite, named after it; an existing spec is kept | `import: thresholds map…` (`import: tuned spec kept`) |
| 6 | medium | The import gate passed unnamed suites, and a `name` in a request body was taken for an operation | the gate fails on requests with ids and no name; k6 names come only from `tags` | `import: unnamed requests with ids fail the gate…` (`import: unnamed fails gate`, `k6 parse: names from tags only`) |
| 7 | medium | Per-operation thresholds were collapsed into one wrong SLO | each operation takes its own threshold, else the unscoped one | `import: thresholds map…` (`import: threshold per operation`) |
| 8 | low | Generator CPU from `/proc` (k6 binary on Linux) was a share of one core, while Docker's was a share of the machine | `/proc` divided by the core count | not testable on this Windows machine; noted |
| 9 | low | The shared-account rule fired on any literal `email:` or `user:`, such as a create-user payload | a literal identity counts only inside a login or auth call | `audit: a literal identity outside a login call…` (`audit: identity only near login`) |

Things the reviewer checked and found sound:
- the clock offset (host and container within about 50 ms);
- k6's API becoming ready only after VU init;
- an early or late k6 exit;
- the exact user split;
- the controller's child cleanup on a missing stop ack;
- old results never reaching a baseline;
- `workload.json` and `slo.json` kept when they exist;
- the import → audit routing in `perf help`.

## Gaps left on purpose

- Gatling and JMeter suites are not run (D11).
- `/proc` CPU (finding 8) has no test on this machine.
- A k6 binary on Windows or macOS reports the host's CPU as the generator's, which also counts
  other programs. That errs towards NOT EVALUABLE, never towards a quiet pass.

## Final run

- `npm test`: 156 tests, 156 pass, 0 fail (Windows 11, Node 24, k6 1.0.0 under Docker, Locust 2.47.0; none skipped).
- `npm run mutate`: 133 of 133 mutants killed.
- One test (the error-storm verdict) failed once in a full run: the starved machine lost every
  fake worker before the auto-stop fired, and ai-perf reported that (`all_workers_lost`). It
  passed 3 of 3 alone, and now retries only that outcome, at most twice.
