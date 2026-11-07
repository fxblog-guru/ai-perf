# M8 evidence: test types

The M7 reviews found that stress, spike, soak and capacity were names only. Each ran the same
ramp-and-hold shape and got the same whole-run verdict. This milestone gives each one a shape that
the engines run, and a verdict on the question it exists to answer.

| Type | Question | Shape (CONTRACTS §1) | Judged on (CONTRACTS §9) |
|---|---|---|---|
| stress, capacity | how much does it hold within the SLA? | `steps`, `step_s`: ramp to the first step, hold each, jump to the next | the capacity (top step of the unbroken run within the SLA), its headroom over the planned peak, a regression against a promoted staircase |
| spike | does it come back after a sudden jump, and how fast? | `spike: { users \| arrival_rps, at_s, for_s }` inside steady | the time back to the base, against `slo.json spike.recovery_s`; transactions on the base, not on the spike |
| soak | does anything grow at constant load? | the usual shape, held long, target monitored | p95 and memory drift over steady (Theil–Sen), against `slo.json soak` limits |

## What the fake runs show (tests/types.test.mjs)

The numbers below come from the fake engine with scripted faults. The faults are known, so each
answer can be checked.

| Case | Scripted | Measured | Verdict |
|---|---|---|---|
| Staircase 4 → 8 → 16 users, peak 10 | target 20× slower from step 3 | p95 by step < 200, < 200, > 400 ms; capacity 8 | FAIL: "capacity 8 users is below the planned peak of 10"; summary "It holds 8 users (… requests/s) within the SLA; … headroom is 0.8×" |
| Same, peak 7 | same | capacity 8 | WARN: 14 % headroom |
| Same, slow only in step 2's first window | settling time | every step held | note: "add a higher step" (the settle window is not judged) |
| Same, errors from step 3, auto-stop | target breaks | step 3 has numbers, `complete: false` | note: "the staircase broke … during step 3"; not "the target failed under load" |
| Staircase against a promoted one that held 16 | 20× slower from step 3 | capacity 8 | FAIL: "capacity regression … 16 -> 8 users" |
| Spike 4 → 12 users for 3 s | target slow until 3 s after the spike | `recovery_s: 3` | PASS under the default 30 s budget; FAIL under a 2 s budget |
| Spike, target never recovers | slow to the end | `recovered: false` | FAIL; the base transactions still pass, so the spike is not judged against the SLA |
| Soak, latency +8 %/s | `drift` fault | p95 drift > 40 % | FAIL above the 25 % limit; `perf analyze` finds no knee (the load did not grow) |
| Soak, memory +20 MiB per sample | stand-in `docker stats` | memory drift > 50 % | FAIL: "memory of shop-api grew … a leak until shown otherwise" |
| Soak, flat | none | p95 drift near 0 | PASS, with a note that memory was not measured |

## The independent review

A reviewer who had not written the code read the diff as a principal performance engineer. They
were given the code, not the author's conclusions. Every finding is fixed, and each fix has a test
that fails without it (a mutant).

| # | Finding | Fix |
|---|---|---|
| 1 | A manual stop during a spike or a staircase was a FAIL that blamed the target | a step left incomplete by anything but the target's auto-stop is NOT EVALUABLE; a spike not back within less than its budget is NOT EVALUABLE |
| 2 | Theil–Sen over every memory sample: 8 000 points took 33 s; a 24 h soak (17 000 samples) would block the controller | fitted on time over at most 120 median bins: 17 280 points in well under 1 s |
| 3 | Locust accepted an open staircase and ran the rates as users | the engine check runs after `steps` sets the rate |
| 4 | Realtime CCU, business checks and `min_rps` judged a staircase over all its steps; heavy tail skipped | judged at the capacity step (or the spike's base); whole-staircase realtime and checks are noted |
| 5 | Spikes and steps off window edges, or with too little steady around them, made checks unable to fail | `step_s`, `at_s`, `for_s` must be whole windows; two windows before and after a spike |
| 6 | Recovery on one window of any size; recovery time rounded down | two windows in a row, each serving ≥ 70 % of the base's requests; counted to the window end; the base must pass its own test |
| 7 | Step rps wrong when steps were off window edges | closed by #5 |
| 8 | `arrival_shortfall` planned the top rate over all of steady | planned arrivals follow the shape. Drops on an open staircase still degrade the run: a starved step cannot be told from a held one, so the conservative reading stays |
| 9 | Staircases skipped the baseline gates; other steps were compared | the gates apply; capacity is compared only with the same steps |
| 10 | 4 windows were enough to fail a soak on noise; unmeasured memory passed | 30 windows; unmeasured memory is a WARN; a soak with steps or a spike is NOT EVALUABLE |
| 11 | The summary said "It holds 8 users" on a NOT EVALUABLE run | the summary says only why it cannot be judged |
| 12 | `capacityOf` crashed without an SLA; steps and spike together | tolerated (the plan gate reports it); refused |

## Defects the new tests found

- **Locust shim crashed on a staircase in warmup.** `users_at` evaluated `steps[step_at(t)]` in
  every phase; outside steady `step_at` is `None`. It is now computed in steady only. The
  Python-against-Node parity test for both shapes found this.
- **A docker command that could not start killed the controller.** `execFile` throws
  synchronously on `EFTYPE`, outside its callback. It is now no sample, which is how a missing
  docker is handled, and it ends in `monitoring_failed`. Tested with a non-executable
  `PERF_DOCKER`.
- **The staircase auto-stop note named the wrong step.** It named the last step with numbers; it
  now names the first incomplete step.
- **The knee fired at constant load.** A soak whose p95 doubled late was read as saturation. A
  knee now requires that the offered load grew into that window or the one before it. There is a
  new exam case for this.

## Checks

- `npm test`: 232 of 232 pass (types.test.mjs adds 16 tests; exam, Locust and docker tests gained cases).
- Mutation: all 273 mutants killed, 42 of them new for M8. Each guard above, disabled in turn, fails its test. A full run first left four mutants stale (code that moved) and two surviving: the auto-stop mutant hit the new `targetBroke` line instead of the branch; the realtime-kit one is timing-bound under load and now retries up to three times. All were retargeted or fixed and rerun, and every mutant is killed.
- Independent review: 12 findings, all fixed, above.

## Left for later milestones

- **M9:** lessons read at each step; lessons across projects; a runs-to-correct-result
  scorecard; routing small cases to stlc; `doctor` checks from design §11; actually running the
  cleanup command; checking the measured mix against the workload.
- **M10:** host-process metrics (by port, pid or name), so a target outside docker can be monitored,
  including memory for soak.
- **M11:** a network control channel, then ssh and k8s targets, when the load must exceed one
  machine.
