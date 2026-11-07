# M7 evidence: measure honestly

After M6, the whole product was reviewed twice, independently:
- an audit against the five pillars (design §13);
- a principal performance engineer's review, run as practice would run it.

This milestone fixes what they found about **measurement and judgment**. Test types, learning and
operations come in M8–M9. Host-process monitoring comes in M10, multi-machine in M11.

## What the reviews found (the parts this milestone closes)

| Finding | Source | Severity | Closed by |
|---|---|---|---|
| Every engine ran a closed loop, so a stalling server was under-sampled (coordinated omission). Under a server frozen 3 s in every 10 s: p95 **56 ms, PASS** closed, against **2588 ms** open | engineer, experiment | critical | the open model (`profile.arrival_rps` → k6 `ramping-arrival-rate`, and fake); closed engines refuse it; dropped arrivals degrade the run; a closed p99 above 10× p95 is a WARN naming coordinated omission |
| The verdict judged p95 only; a measured p99 of 2969 ms was ignored | engineer | high | `p99_ms` judged when the plan sets it (plan gate checks it), plus the heavy-tail WARN |
| PS-F2 on one run against one baseline at 100 requests: about 25 % false regressions from sampling alone | engineer, simulation | high | the baseline keeps its histograms; a p95 change must clear PS-F2 at the 95 % lower bound of a bootstrap of both. Measured: 0 false regressions in 20 same-distribution pairs of 100; a real +30 % change is still found (lower bound +16 %) |
| The gates did not block anything: a load run on no plan could pass | audit | high | the verdict is NOT EVALUABLE when the plan, model, env or data gate fails |
| "Approval to load a system you do not own" was a free-text field, never checked at run time | audit | high | `perf run` requires an owner. Any host other than this machine needs `approval: { by, at, hosts }`, at most 90 days old, covering that host |
| No auto-stop by default | both | high | when no rule is given, the default is error rate above 50 % for 30 s (minimum 50 requests). The verdict says it applied |
| The fingerprint read `target.arrival_rate`; the gate requires `arrival_rps` | both | bug | fixed, with a test |
| The README promised "any scale" and Gatling runs; the design promised a rollup, `slo_breach` and cleanup | both | docs | the README says one machine and import-only Gatling. The design marks the three as not built |

## The coordinated-omission experiment, reproduced in a test

`tests/integrity.test.mjs` runs k6 against `mock/server.mjs` with `MOCK_STALL_EVERY_S=5`,
`MOCK_STALL_S=1.5`:

| Model | p95 | p99 | Verdict |
|---|---|---|---|
| closed, 10 VUs | 25 ms | 1480 ms | not PASS: "heavy tail, p99 … is 59× p95 … coordinated omission" |
| open, 40 rps, 200 VUs | 1262 ms | 1480 ms | the stalls are in the p95 |
| open, 40 rps, 10 VUs | — | — | degraded: `arrival_shortfall`, because 10 VUs cannot hold 40 rps through a 1.5 s stall |

## Left for later milestones (from the same reviews)

- **M8:** stress and capacity by steps (capacity and headroom); spike recovery; soak slopes for
  memory and latency; a plain summary line for a business owner; knee detection that does not
  fire on a single steady window.
- **M9:** lessons read at each step; lessons across projects; runs-to-correct-result; routing
  small cases to stlc; `doctor` checks from design §11; cleanup actually run; the measured mix
  checked against the workload.
- **M10:** host-process metrics; real correlation ids (k6 and the kit send none today, and the
  analysis must say so).
- **M11:** a network control channel for several machines, then ssh and k8s targets.

## Independent review of M7

An independent reviewer ran the k6 wrapper and scenarios in real k6 1.0.0 and confirmed seven
findings. All seven are fixed. Each fix has a test, and each test has at least one mutant it
kills.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | high | With `ramp_s: 0`, steady ramped from 10 % of the rate (4 → 18 rps through a planned 20), and nothing flagged it. The closed model's stages had the same flaw | A zero-length ramp is kept as a 0 ms stage, so the load jumps to the full rate (checked in k6: 0 s stages are accepted) |
| 2 | high | An open baseline was compared with runs at other arrival rates, and with closed runs | `result.run` records `model` and `arrival_rps`; a comparison is refused when either differs |
| 3 | medium-high | The bootstrap rule (lower bound above 10 %) never flagged a true +10–15 % change, at any n, and called it "noise"; the 5000-sample cap widened the interval | PS-F2 sets the size (point change above 10 % and 5 ms); the bootstrap tests significance (lower bound above 0), over the true n (cap 100,000). A true +12 % at n = 20,000 is a regression every time; at n = 50,000 the lower bound is above +8 %. False regressions on noise stay at 2 or fewer in 40 pairs of 100 |
| 4 | medium | Any environment in env.json missing a field blocked every verdict | The verdict judges the env gate for the run's own environment only |
| 5 | medium | `approval.hosts` as a string matched by substring | It must be a list (spec and gate) |
| 6 | low-medium | Heavy-tail WARN on 50 requests (where p99 is the maximum), and when the plan already judges p99 | It needs 200 or more requests and no planned p99 |
| 7 | low | Rates rounded per worker (0.3 rps on ten workers sent nothing); dropped iterations were not placed on k6's own clock; the VU-cap advice ignored `sleep()` | Per-minute rates split exactly; dropped iterations rebased like requests; the skill counts the whole iteration |

## Final run

- `npm test`: 214 tests, 214 pass, 0 fail (Windows 11, Node 24; Locust, k6, ws and Docker tests ran, none skipped).
- `npm run mutate`: 231 mutants, all killed. In the full run, 230 were killed and `allowlist` survived: since M7 a foreign
  host is also refused for lacking an approval, so the old test no longer told the two checks apart.
  It was moved to the unit test that asserts the allowlist message itself, and is killed.
