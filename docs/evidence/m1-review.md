# M1 evidence: controller core

## Checks

| Check | Result | How to rerun |
|---|---|---|
| Tests | 53 pass, 8 consecutive full runs green on Windows 11, Node 24 | `npm test` |
| Mutation | 49 of 49 mutants killed; one is probabilistic and gets 3 tries (see `tests/mutate.mjs`) | `npm run mutate` |
| Result schema | `result.json` validates against `schemas/perf-result.schema.json`, byte-identical to stlc's canonical copy | `tests/run.test.mjs` |

## Independent review

An independent reviewer, given only the paths and the contract, reviewed M1 twice.

**Round 1** confirmed nine defects that the first 34 green tests did not catch. The worst were:
- string numbers were concatenated into durations, so a 25 s profile ran for days;
- whole-run rps was undercounted;
- a run stopped early counted a partial window as whole;
- windows were not aligned to the start of steady;
- generator CPU was counted outside the measured window;
- credentials could reach run files;
- `--wait` could hang;
- timings were not checked against each other;
- a worker that could not start crashed the controller without a reason.

All nine were fixed, each with a test that fails on the old code.

**Round 2** confirmed the nine fixes and found:
- the controller looked dead while collecting, because synchronous reads blocked its heartbeat;
- `perf stop` could target a run whose controller was lost;
- the production check had been weakened;
- three smaller issues.

All were fixed, with tests.

Further defects were found by chasing flaky tests instead of loosening them:
- a worker that died too late to be noticed during load left the run `done`; it is now `degraded`;
- a CPU sample was judged in the controller's phase, not the phase it was taken in;
- the fake engine lost load on a late tick;
- the controller had no hard deadline (found through a controller orphaned by a mutant).

## Known limits

- No test for the hard deadline or for the doctor failing on a missing engine: the only engine,
  `fake`, is always installed. Both get tests with the first real engine (M2).
- `allow_hosts` lives in the run spec, so the spec author decides the allowlist. M2 moves it to
  the project's environment file.
- End-to-end timings in tests are short (100 ms ticks, 3 s timeouts). The defaults are 1 s and
  10 s; a 1 s timeout proved too tight for Windows process start under a parallel test run.
