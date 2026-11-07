# M4 evidence: operations

## Checks

| Check | Result | How to rerun |
|---|---|---|
| Tests | 168 pass, 0 fail | `npm test` |
| Mutation | 154 of 154 killed | `npm run mutate` |
| Exit check: the trend flags a planted slow decay | five real runs with latency planted at +6 % per run (+25 % in total, no step over 10 %) are flagged as `slow_decay`; four flat runs are not | `node --test --test-name-pattern "planted slow decay" tests/ops.test.mjs` |

## What M4 added

- **`perf ci`**: one command that runs, analyses and reports, with the verdict as the exit code
  and JUnit for the pipeline. `ci/gitlab-ci.perf.yml` is a sample smoke job.
- **`perf compare`** and **`perf trend`**: like with like only, with steps and slow decay.
- **Run fingerprints**: what a run was measured under, taken when it starts. A baseline measured
  under another fingerprint is STALE; compare refuses such runs and trend leaves them out.
- **`perf learn`**: lessons with stable ids. The next verdict says "seen before", and the skill
  pushes lessons to Recall.

## Independent review

An independent reviewer, given the paths and the design, reproduced its findings with scratch
scripts against the library. It confirmed eight. All eight are fixed. Each fix has a test, and
each test has at least one mutant that it kills.

| # | Severity | Finding | Fix | Test (mutant) |
|---|---|---|---|---|
| 1 | high | A STALE baseline still added its regressions as FAIL. The way out it named (`--bootstrap --promote`) could not promote: a FAIL is never promoted | Nothing is compared against a refused baseline. With `--bootstrap`, the run is judged on SLOs only and can be promoted | `baseline STALE…` (`stale: refuses and compares nothing`, `stale: bootstrap way out`) |
| 2 | medium-high | The fingerprint went stale on harmless edits (a source confirmed, a threshold, an allowed host). It missed real changes (a third party un-stubbed, the script, the data). It was taken at promote time, not at run time | `lib/fingerprint.mjs` covers only what moves the numbers. It is taken by `perf run` and kept in `run.json` and `result.run`. A baseline older than M4 is reported as unchecked | `fingerprint: thresholds, sources and allowed hosts…` (`fingerprint: sources are not measurements`, `fingerprint: stubs count`, `fingerprint: script counts`) |
| 3 | medium | Trend missed noisy drift, a late decay after a long flat history, and a decay after an old step. It flagged a fixed step forever | A recent window (the last 8 runs since the last step, at least 5) and a Theil–Sen line (> 12 %). A step that a later run brought back is not flagged | `trend math…`, using the reviewer's own sequences (`trend: fixed step resolved`, `trend: decay after a step`, `trend: recent window`, `trend: robust line`) |
| 4 | medium | `perf ci` judged the latest run of the slug, not its own | `perf run` hands its run folder to `ci`. Run ids carry milliseconds | `ci judges its own run…` (`ci: judges its own run`) |
| 5 | medium-low | Compare and trend ignored workload and plan changes | The fingerprint is part of the shared like-with-like rule | `baseline STALE…` (compare refuses, trend leaves out) |
| 6 | low-medium | The CI skill's promote command could not work, the smoke advice was wrong, and the sample job did not wait for the mock | The skill was rewritten: a smoke never reads a baseline, and a load profile is promoted with `--bootstrap --promote`. The job now waits for `/health` | docs; read against the code |
| 7 | low | "Seen before" missed repeated regressions and could cite later runs | The verdict passes its own regressions, and only earlier runs are cited | `a repeated regression is "seen before"…` (`learn: regressions seen before`, `learn: only earlier runs`) |
| 8 | low | A repeated flag broke single-value commands | `--run` twice is accepted by `compare` only. Elsewhere it is a usage error, and any other flag takes one value | `a flag given twice…` (`cli: one --run`) |

Things the reviewer checked and found sound:
- the `perf ci` exit codes for refused, lost, degraded, aborted and auto-stopped runs;
- the JUnit mapping and its escaping;
- compare's refusals, argument order and exit codes;
- the trend's sort order and the direction of rps versus p95;
- stable lesson ids, with no double count for a saturated generator;
- `--pushed`.

## Mutation check during the fixes

The first run of the new mutants left two survivors, `trend: robust line` and
`learn: only earlier runs`. Two cases were added: noise at both ends around a flat middle, and
re-judging an older run after a later one was learned. Both mutants are now killed.

## Final run

- `npm test`: 168 tests, 168 pass, 0 fail (Windows 11, Node 24; k6, Locust and Docker tests ran, none skipped).
- `npm run mutate`: 154 of 154 mutants killed.
