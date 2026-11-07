# M14 evidence: beyond the peak

[`docs/coverage.md`](../coverage.md) §1 had three rows marked partial. A staircase found the
breakpoint only when one of its steps broke. A `recovery` profile ran like a load test. And
`perf compare` judged two runs, with no planned matrix of settings and no ranking. M14 closes all
three. Each mechanism has a check that fails when the mechanism is broken (design §13).

## Design

```
perf run spec --breakpoint            perf run (profile recovery)          perf matrix m.json
  staircase ─▶ judge ─▶ read steps      base ─▶ overload ─▶ normal load       for each variant:
   held all? ─▶ climb from last held     controller keeps every window          apply (env) ─▶ run spec+override ─▶ judge
   broke?    ─▶ stop: held X, broke Y    per transaction (spike.windows)      control again (recheck)
   generator ─▶ stop: generator limit   verdict: back within SLO, 2 in a row   rank: bootstrap + 5 % floor ─▶ ties
   ceiling / max runs ─▶ no claim       overload never hurt ─▶ NOT EVALUABLE   STALE fingerprint ─▶ not ranked
  breakpoint.md, last verdict           never back / late ─▶ FAIL              matrix-<name>.md / .json
```

**Breakpoint** (`lib/breakpoint.mjs`, the loop in `bin/perf.mjs`).
- A staircase with `profile.breakpoint: { factor?, max }`. Without `max` the search is refused:
  the climb is never unbounded, and `max` is the load the environment's owner allows.
- Each run is read against the SLA, as the capacity is. It reads as one of four things:
  - `broke`: a complete step missed an SLA, or the target broke under load (an auto-stop on
    errors, target CPU or the target dying);
  - `held`: every step within the SLA;
  - `generator`: the generator saturated;
  - `unjudged`: anything else.
- After `held`, the next run starts at the last step that held and climbs by `factor`, as many
  steps as the first staircase, the last cut at `max`. The search stops at the first break, at
  the generator ("the generator, not the target, is the limit"), at the ceiling, after
  `--max-runs` runs, or at an unreadable run.
- The breakpoint is the first step seen breaking, next to the highest step seen holding below it,
  each with its run. Nothing that no run observed is claimed. A load that held in one run and broke
  in the next is flagged `unstable` (the edge, or noise), not reported as a clean breakpoint.
- Every run is an ordinary run with its own folder, verdict and lessons. `breakpoint.md` and
  `.json` hold the search; the last run's verdict carries it.

**Recovery** (`lib/verdict.mjs` `judgeRecovery`).
- The overload is the spike shape, so every engine already runs it (k6 stages, the Locust shim).
  A `recovery` profile without one is refused.
- The controller keeps every steady window per transaction (`spike.windows`).
- The verdict judges against the plan, not against the base. A window is back when every planned
  transaction measured in it is within its SLO and the window served at least 70 % of the normal
  load. Recovery is two such windows in a row after the overload, within `recovery.recovery_s`
  (else `spike.recovery_s`, else 30 s, noted).
- A FAIL: never back with the budget observed, or back too late.
- NOT EVALUABLE: an overload that never took a transaction past its SLO ("nothing to recover
  from"), a normal load already past it, or a watch shorter than the budget.
- The fake engine's `backlog` makes this testable without a real target. Requests past `max_rps`
  queue, and the queue drains only with the capacity left over: a target with spare capacity
  recovers in proportion to the overload, and one with none never does.

**Configuration matrix** (`lib/matrix.mjs`, `perf matrix`).
- A file lists variants. Each has an `apply` command (run with its `env` and `PERF_VARIANT`;
  one that fails is not run), and/or a spec override that may not touch the slug, environment,
  profile, engine, target or URL. Every variant runs the same spec.
- Ranking: the best remaining variant leads a rank, and every variant it does not clearly beat
  shares it. On p95, clearly means significant (the bootstrap of both histograms, the same test
  as a regression) and at least `min_diff_pct` (5 %). On capacity, it means the lower variant's
  first broken step broke past the SLA by more than the PS-F2 noise floor.
- The control runs again at the end. If it moved by a difference that counts, the environment
  drifted, and there is no winner.
- A variant whose fingerprint differs from the control's in a part its setting does not declare
  (`changes`) is STALE and not ranked. So is one `compareBaseline` refuses, or a run not done.

## What each check proves

`tests/beyond.test.mjs`, 14 tests:

| Case | Proves |
|---|---|
| next staircase | climbs from the last held step by the factor, at least one more per step, cut at the ceiling, none past it; the spec gate on `breakpoint` |
| run readings | broke (SLA, with the transaction and its numbers), held, generator, unjudged (a person's stop, a degraded run); held from an earlier run kept; held-then-broke flagged unstable; nothing broken is never a breakpoint |
| climbs on (end to end) | a target capped at 150 rps: runs `4,8` and `8,16` hold, `16,32` breaks; "between 16 and 32 users", each with its run; three run folders, each with a verdict; the last verdict carries it; exit is its exit |
| never breaks | stops at the ceiling (no breakpoint, `limit: ceiling`), and at `--max-runs 1` (default factor noted); no `max`, refused (exit 2) |
| generator | a generator that saturates at the second run ends the search: "the generator, not the target"; no third run |
| recovery profile | needs its overload; `recovery.recovery_s` is checked by the plan gate |
| within SLO | at the SLO is within; one ms over, errors over, under 70 % of the normal load, or no planned transaction measured is not |
| back in time | a queue that drains: PASS with the time in the summary; a 2 s budget FAILs; the spike's budget is the fallback; transactions judged on the normal load |
| never back | no capacity left over: FAIL; a 20 s budget with 10 s observed: NOT EVALUABLE; one good window between bad ones is not back |
| no overload | an overload under capacity: NOT EVALUABLE, never PASS; a normal load past its SLO: NOT EVALUABLE |
| clear winner | three variants via spec override: 0.5× wins; 0.98× ties with the control (same rank); the control ran again and held still; four runs, each with its own setting |
| STALE and apply | an apply that changes the data set: STALE unless `changes: ["data"]`; a failed apply is not run; the remaining two tie: no winner; fewer than two ranked: exit 3 |
| file check | two variants, unique names, no override of the test, fingerprint parts, measure, env values; deep merge |
| ranking | 4 % apart is a tie under a 5 % floor and a win under 2 %; 20 requests are not significant; a control that moved voids the winner; a run not done is not ranked; capacity: a clear break wins, a marginal one ties, another grid is incomparable |

## Results

- `tests/beyond.test.mjs` alone: 14 tests, 14 pass.
- `npm test`: 323 tests. First full run: 316 pass, 7 fail (five host-process tests, a perf
  stop and a k6 docker cleanup). Second full run: 317 pass, 6 fail (a ws docker test, two doctor
  timing tests, the host-process soak, a watch test, and a staircase auto-stop that fired after
  its step had already completed). None of them touches M14 code; each passed when run alone
  afterwards. They are the load flakes the brief names: the machine was busy, and the second run
  went straight on into the mutation run.
- Mutation: 490 mutants in all (444 before M14), none stale. The 46 for M14 are all killed, and so
  is the one older anchor M14 moved (`cli: switches take no value`, retargeted to the new
  switch list). The full `npm run mutate`: all 490 killed. An earlier full run was interrupted
  mid-mutant and left the `summary: not evaluable first` mutant in `lib/verdict.mjs`; it was
  found by diff and restored before the final runs above.

## Reviewed (M14)

A reviewer who had not written the code read the change and found 13 issues. All are fixed. Each
has a test in `tests/beyond.test.mjs` that fails without the fix, and a mutant where one fits
(`review N:` in `tests/mutate.mjs`).

| # | Finding | Fix |
|---|---|---|
| 1 | HIGH. The p95 ranking ignored errors and verdicts: a variant at 20 ms with 90 % errors beat a 200 ms control | not ranked: a verdict FAIL or NOT EVALUABLE, errors above the strictest SLA error rate, or 0.5 pp above the control's. Matrix runs are judged as with `--bootstrap`, so a missing baseline alone drops nothing |
| 2 | HIGH. A planned transaction missing from a step read as "broke"; a run whose plan failed its gates was read at all | a step that measured no request of a planned transaction, with nothing it did measure past the SLA, reads unjudged; a verdict with a failing plan, model, env or data gate reads unjudged |
| 3 | MED-HIGH. A recovery overload that sheds load with errors was stopped by the default auto-stop and failed as "the target failed under load"; `overload_s` was the plan, not what ran | `perf run` sets `overload_grace`, from the overload to its end plus the budget (or the longest rule). In it the error-rate and target-CPU rules give way to a safety bound, errors above 95 % for at least 30 s. A stop on that bound is NOT EVALUABLE with a hint. `overload_s` is what ran (`spike.ran_to_s`); load that stopped during the overload is NOT EVALUABLE |
| 4 | MED. A variant's env was unrestricted: `AI_PERF_TARGET_URL` would point workers past the allowlist; `PERF_*`, `NODE_OPTIONS`, `PATH` swap what runs | refused, in any case: `AI_PERF_*`, `PERF_*`, `NODE_*`, `NPM_*`, `LD_*`, `DYLD_*`, `PATH`, `HOME` and the other path-like names, and any non-identifier |
| 5 | MED. Learned settings changed between variants (each run taught the next), and an override could change workers, timing or auto-stop | learned settings are applied once before the matrix and frozen (`--no-learned` for every run, `learned` in the report); `workers`, `timing`, `auto_stop` added to the keys a variant may not set |
| 6 | MED. A winner was declared when the recheck could not run, or when the control failed (the next variant silently became the control), or with a lead no larger than the control's own move; the text claimed a comparison it never computed | no winner when a recheck was asked and not made, or when the control cannot be ranked (`no ranking`); on p95 the lead less the control's move must still reach `min_diff_pct`; the report states the move in % and the leader's margin |
| 7 | MED. Recovery's "two in a row" used windows that had data, not windows adjacent in time; trailing empty windows shortened the watch, so never-back read NOT EVALUABLE | windows are read on their time grid to where load stopped (`spike.end_s`); a missing window is not back; the watch is the whole grid |
| 8 | MED-LOW. A transaction that vanished after the overload did not stop a window counting as back | every transaction the normal load sent in each of its windows must be measured again |
| 9 | MED-LOW. `breakpoint.max` was written by the agent, not allowed by the owner | the ceiling is `env.json` `max_users` (or `max_arrival_rps`); a `max` above it is refused, and an environment without one gets no breakpoint search. The env gate checks the ceilings |
| 10 | LOW. `checkMatrix` crashed on `env: null`, `changes: 5` or `changes: {}`, and took `env` as an array | types checked; a variant that is not an object is refused |
| 11 | LOW. `perf matrix` started the next variant when `--wait` gave up on a run still going | a run that started and was not seen to finish stops the matrix; the rest are not run; exit 1 |
| 12 | LOW. A run auto-stopped on errors after every step held read as held; `--max-runs 0` became 3 | unjudged ("where it broke was not measured"); `--max-runs` must be a whole number from 1 to 6, else refused |
| 13 | LOW. Missing tests: variant env set and restored, errors in the ranking, recheck missing or failed, an unmeasured transaction in a step, window gaps, `<=` against `<` in the edge check, the ms half of the significance test | all added. The ms half was a duplicate of the % half (both bounds come from the same resampled pairs), so it now tests something: the lower bound must be at least `min_diff_ms` (1 ms) |
| — | The spec overrides were written unmasked into `matrix-*.json` and `.md` | masked: a value under a key that names a secret is `***`, strings are masked as run evidence is |

## What is NOT tested

- **No real target.** Every end-to-end test runs on the fake engine. A real queueing system
  recovers less neatly than the fake backlog. The judgment reads only windows of requests, so it
  does not depend on the engine.
- **Run-to-run noise in the matrix** is checked only through the control's second run. The
  bootstrap covers sampling noise within a run; drift between variants that the control's two runs
  happen to miss is not ruled out. Repeating each variant is not built.
- **Capacity ties** use the PS-F2 noise floor on the broken step's point values, not a bootstrap:
  steps keep no histograms.
- **Breakpoint on an open model** climbs arrival rates the same way. The VU cap is not raised with
  them: a climb past it ends as an unreadable run (arrival shortfall), said as such. It is tested
  only on closed staircases.
- **Recovery for realtime** (players back online, tick lag) is not judged; only requests are.
- **The matrix `apply` command** runs with the shell on this machine. Restarting a remote
  target and waiting for it to be ready is the command's job; ai-perf does not check that the
  setting took effect.
