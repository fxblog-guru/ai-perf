# ai-perf

**v0.14.0** ([changelog](CHANGELOG.md) · [user guide](docs/user-guide.md) · [flows](docs/flows.md) · [coverage](docs/coverage.md) · [showcase](docs/showcase/pipeline.html) · [contracts](CONTRACTS.md) · [design](docs/design.md)) · runs in **Claude Code**

AI-driven performance testing for any system, from a small web API to a realtime game backend.
One flow takes it from "what does this system need to handle?" to a verdict a pipeline can trust:
discover → plan → model real users → prepare environment and data → script → run at scale →
watch → analyze → report.

## Quick Start

Needs Node 20+. The first demo needs nothing else; the second needs Python with `pip install locust`
(set `PERF_PYTHON` to that Python when it is not the `python` on your PATH).

```bash
git clone https://gitlab.com/agentic-fx/ai-perf.git && cd ai-perf
node bin/perf.mjs doctor

# 1. A whole run on the built-in fake engine: no target, no install.
node bin/perf.mjs run examples/quickstart/fake.json --root examples/quickstart --wait
node bin/perf.mjs analyze --root examples/quickstart --slug demo
node bin/perf.mjs report --root examples/quickstart --slug demo --bootstrap

# 2. Real load: Locust, 2 workers, against the bundled mock API.
node mock/server.mjs 9990 &
node bin/perf.mjs run examples/quickstart/locust.json --root examples/quickstart --wait
node bin/perf.mjs report --root examples/quickstart --slug demo --bootstrap --promote
```

Both reports say `VERDICT: PASS`. The fake engine's numbers are simulated, so only the Locust run is
promoted to a baseline; the next Locust run is compared with it, and a run of another tool is refused. Results are in
`examples/quickstart/.perf/demo/runs/<id>/`: `result.json` (perf-result/v1), `analysis.md`, `verdict.md`. In Claude Code, start with `/perf-start`.

## What it does

- **Engines**: Locust, k6 (also as an open model: an arrival rate, so a stalling server is
  measured, not under-sampled), `ws` for WebSocket games, the `fake` engine for practice, and your
  own engine on the worker kit. Gatling and JMeter suites are imported and audited, not run.
- **Scale**: worker processes (`local`) or containers (`docker`) on one machine; when one machine
  is not enough, workers on other machines over ssh or as pods of a Kubernetes Job, through a
  token-protected network channel. Latency histograms are merged, never
  averaged. Workers on other clocks are aligned to the controller's.
- **Beyond the peak**: `perf run --breakpoint` climbs a staircase on until a step breaks, and
  says between which two steps, from which runs. A `recovery` test overloads the target and
  judges the time until every transaction is back within its SLO. `perf matrix` runs one setting's
  variants and ranks them; what noise cannot tell apart is a tie, not a winner.
- **Volume and scale**: a volume plan seeds and counts production-sized data, and a run is said
  to be at volume only on what it counted just before it started. `perf scale` deploys 1, 2, 4
  instances in turn, finds each one's capacity and the scaling efficiency, and names the shared
  bottleneck when a count adds nothing.
- **Names the cause**: the target's own metrics, read from its `/metrics` or from Prometheus
  (a connection pool, database locks, GC, the event loop, a queue). A signal over its limit when
  latency broke is named as the bottleneck, with its reading; the quiet ones are ruled out.
- **Watches the target**: containers (`docker stats`) or processes on the machine (by port, pid or
  command line): CPU, cores, memory; a target process that dies stops the run and fails it.
- **Safe by code**: a deterministic controller runs the load. It refuses production, hosts outside
  the allowlist and unstubbed third parties. It stops a runaway run on hard rules, and it survives
  the AI session closing. The AI explains and judges; it never sits in the hot loop. `perf watch`
  wakes it on events only.
- **Honest numbers**: a lost, saturated or frozen load generator makes the run degraded or not
  evaluable, never a quiet pass. A closed loop's heavy tail (p99 ten times p95) is not passed on
  p95. A regression must clear its 95 % confidence bound. Every assumed number is named in the
  verdict.
- **Learns on its own, and fixes itself**: every judged run teaches lessons, with no command to
  remember. A mistake in how the load was made (a saturated generator, a late engine, dropped
  arrivals) is fixed in the next run, and the run after checks that the fix worked; what only a
  person can fix is said so. `perf run --until-evaluable` loops until a run can be judged.
  A scorecard counts the runs each version needs before one can be judged.
- **Remembers cheaply, shares with the team**: `perf brief` is everything known about the project
  on one page of about 1500 tokens, whatever its history, and every step starts from it. Lessons,
  decisions, environments, baselines and capacity go to the team's Recall (`perf share`), and
  what the team knows comes back into the brief. A lesson two projects taught becomes a draft
  patch to the skill that should have known it.
- **Asks little**: it reads the repo and measures first. At most three questions per step, each
  with a proposed answer.

For a single machine, one protocol and a short run, the perf tier in stlc is enough. ai-perf is
for scale, long runs, monitoring, realtime traffic and existing suites.

## Status

| Milestone | State |
|---|---|
| M1 controller core | done, reviewed ([evidence](docs/evidence/m1-review.md)) |
| M2 lifecycle on HTTP: 9 skills, Locust, docker target, docker-stats, verdict | done, reviewed ([evidence](docs/evidence/m2-review.md), [pillars](docs/evidence/m2-pillars.md)) |
| M3 existing suites: `/perf-import`, `/perf-audit`, k6 engine; Gatling and JMeter imported and audited, not run | done, reviewed ([evidence](docs/evidence/m3-review.md)) |
| M4 operations: `perf ci` gate with JUnit, compare, trend with slow-decay detection, STALE baselines, lessons + Recall | done, reviewed ([evidence](docs/evidence/m4-review.md)) |
| M5 realtime: `ws` engine for WebSocket games (CCU, drops, reconnects, tick lag), the worker kit for in-house engines, perf-standard v1.1 draft | done, reviewed ([evidence](docs/evidence/m5-review.md)) |
| M6 dogfood on fx-blog: the whole lifecycle on a real app; seven findings fixed in ai-perf (`perf contract`, in-house suites, CPU per core, honest bottleneck hints, same-build noise) | done ([evidence](docs/evidence/m6-dogfood.md)) |
| M7 measure honestly: the open model on k6, coordinated omission, regressions above noise, gates and approval enforced, default auto-stop | done, reviewed ([evidence](docs/evidence/m7-integrity.md)) |
| M8 test types: staircase capacity and headroom, spike recovery, soak drift, a business summary | done, reviewed ([evidence](docs/evidence/m8-types.md)) |
| M9 learning and operations: lessons at each step and across projects, runs-to-evaluable scorecard, small cases to stlc, the doctor of design §11, cleanup run, the measured mix checked | done, reviewed ([evidence](docs/evidence/m9-learning.md)) |
| M10 host-process monitoring: a target outside Docker by port, pid or command line; its death fails the run; honest correlation ids | done, reviewed ([evidence](docs/evidence/m10-host.md)) |
| M11 several machines: a network control channel, `perf-agent`, `ssh` and `k8s` targets, clock skew in the doctor | done, reviewed ([evidence](docs/evidence/m11-remote.md)) |
| M12 the learning loop: automatic learning, self-correcting runs with checked fixes, the brief, the Recall outbox and import, lessons back to the bundle as patches | done, reviewed ([evidence](docs/evidence/m12-learning-loop.md)) |
| M13 signals: the target's own metrics from `/metrics` or Prometheus name a full pool, locks, GC or a late event loop at the knee; what ai-perf covers and does not ([coverage](docs/coverage.md)) | done, reviewed ([evidence](docs/evidence/m13-signals.md)) |
| M14 beyond the peak: the breakpoint found by climbing on, recovery after an overload judged against the SLO, a configuration matrix ranked with ties | done, reviewed ([evidence](docs/evidence/m14-beyond-the-peak.md)) |
| M15 volume and scalability: a volume plan counted before every run, STALE across volumes; capacity per instance count and the scaling efficiency | done ([evidence](docs/evidence/m15-volume-scale.md)) |

In a project of your own: `npx agentic-fx@latest install --bundle perf` puts the commands and skills
in `.claude/` and the runtime in `.claude/ai-perf/`.
