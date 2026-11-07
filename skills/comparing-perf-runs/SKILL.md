---
name: comparing-perf-runs
description: Use to compare two runs before and after a change, to rank the values of one setting (pool size, cache, instance type) with ties for noise (perf matrix), or to read results across releases for step regressions and slow decay (/perf-compare, /perf-trend).
---

# Comparing runs and reading trends

Follow [perf-protocol](../perf-protocol/SKILL.md).

## Two runs (`/perf-compare`)

`perf compare --slug <slug> --run <before> --run <after>` shows, side by side:
- p95 and error rate for each operation;
- the change in throughput;
- the regressions past the PS-F2 thresholds, marked localized or systemic.

It writes `compare-<before>.md` in the later run's folder.

- Like with like only. Another environment, profile, load tool, target or user count is refused
  (exit 3), and so is a run measured under another workload, architecture, environment, script
  or data set (its fingerprint, CONTRACTS §8). Do not edit results to get around that: run the missing side again.
- Only runs that ended `done` are compared.
- Before explaining the difference, name the change between the two runs (commit, config, data).
- Runs that counted their data (a `volume` plan) more than 5 % apart, or one counted and one
  not, measured another data set: STALE (`data`). Runs of `perf scale` at other instance counts
  are other deployments and are not compared; read them in `scale-<name>.md`.

## Which setting is faster (`perf matrix`)

For A/B tuning (a pool size, a cache, an instance type), write a matrix file and let ai-perf run
and rank it:

```json
{ "name": "pool-size", "spec": ".perf/shop/load.json", "measure": "p95",
  "variants": [
    { "name": "pool-10", "apply": "kubectl set env deploy/api POOL_SIZE=10 && kubectl rollout status deploy/api" },
    { "name": "pool-20", "apply": "kubectl set env deploy/api POOL_SIZE=20 && kubectl rollout status deploy/api" }
  ] }
```

`perf matrix <file> [--bootstrap]` runs the variants in order. For each, its `apply` command runs
first from the project root, with its `env` and `PERF_VARIANT` set; a variant whose apply fails
is not run. `env` may not set ai-perf's own variables (`AI_PERF_*`, `PERF_*`), Node's, or
`PATH`-like ones. A `spec` override is merged into the run spec (never the slug, environment,
profile, engine, target, URL, workers, timing or auto-stop: every variant runs the same test on the
same generator). What earlier runs taught is applied once and frozen for the whole matrix. A run
that is not seen to finish stops the matrix. Then the first variant, the control,
runs again (`recheck`, default true).

- **Ranked by** `measure`: `p95` (of all requests, or of one `transaction`; lower is better) or
  `capacity` (a staircase spec; higher is better).
- **Fast because it fails is not faster.** A variant whose verdict is FAIL or NOT EVALUABLE, or
  whose errors are above the SLA or 0.5 pp above the control's, is not ranked. A control that
  cannot be ranked means no ranking at all.
- **Ties.** A variant beats another only when the difference is significant (the 95 % lower bound
  of a bootstrap of both histograms above zero, and at least `min_diff_ms`, default 1 ms) and at
  least `min_diff_pct` (default 5 %). On
  capacity, only when the lower variant's first broken step broke past the SLA by more than the
  PS-F2 noise floor. Otherwise they tie and share a rank. There is no winner when the top rank is
  shared.
- **Drift.** When the control's second run differs from its first by a difference that counts,
  the environment moved during the matrix: no winner. Nor when the recheck could not be made, or
  when the winner's lead, less the control's own move, is under `min_diff_pct`. Run it again at a
  quieter time.
- **STALE.** A variant measured under another fingerprint than the control is STALE and not
  ranked, unless its setting declares the part it changes (`"changes": ["script"]`). So is a run
  that did not end done, or one under another tool, target or load.

It writes `matrix-<name>.md` and `.json` in the project folder and exits 0 when at least two
variants were ranked, 3 otherwise. Report ties as ties: "pool-15 and pool-20 are within noise of
each other" is a finding.

## Across releases (`/perf-trend`)

`perf trend --slug <slug> [--env e] [--profile p]` reads every done run comparable with the latest
one. It writes `trend.md` and `trend.json`, and flags two patterns:
- **step**: one run is worse than the run before by more than PS-F2 allows (p95 +10 %,
  throughput −10 %). A step that a later run brought back within the limit was fixed and is not
  flagged.
- **slow decay**: over the recent runs (the last 8 since the last step, at least 5), a robust
  line through the values (Theil–Sen, so one noisy run neither makes nor hides it) moves more
  than 12 % the wrong way. No single comparison would show this decline.

It exits 1 when anything is flagged. For a slow decay, list the changes across the flagged runs:
the cause is usually several small ones, such as a growing table, a dependency or a slower
default.

Runs of another kind are left out and listed with the reason. Do not mix them in by hand.

Next: `/perf-learn`.
