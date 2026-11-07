# ai-perf — design

Status: **draft for review** (M0). Nothing below is built yet. Once Luan approves this document,
it becomes the contract that M1 onward is built and tested against.

## 1. What it is

ai-perf is an agentic performance-testing bundle for Claude Code. It takes any system, from a small
web API to a realtime game backend, through the whole performance-testing lifecycle: understand
the system, model real users, run load at the scale needed, watch the run, explain what broke,
and give a verdict a pipeline can trust.

It is AI-driven performance testing, not performance testing of AI (that is ai-eval's job).

Design rules, in order of precedence:

1. **Safety and speed belong to code; explanation and judgment belong to the AI.** A run is driven
   by a deterministic controller. The AI is never in the hot loop (§7).
2. **Engine-agnostic.** Locust, Gatling, k6, or an in-house tool plug in through one contract
   (§8.1). Adding an engine adds an adapter, not a skill.
3. **Ask last.** Read, then measure, then default, and only then ask (§10).
4. **Never a silent pass.** Missing data, a saturated generator, a lost worker or an unconfirmed
   assumption is visible in the verdict, and is never reported as PASS.
5. **Improve what exists.** A project with perf tests keeps them. ai-perf imports, wraps and
   audits them; it does not rewrite them unasked (§4).

## 2. Boundaries

| Neighbour | Owns | ai-perf's relation |
|---|---|---|
| sdlc | `x-perf` budgets and the load plan in the dev contract | reads them (`api-contract-check.mjs <slug> --load-plan --json`) |
| stlc | the **light tier**: single-machine perf design, script, `qa:perf` verdict | keeps it; stlc gains one line saying when to move to ai-perf. stlc never depends on ai-perf |
| perf templates (`locust-performance-testing`, `gatling-performance-testing`) | best-practice frameworks at perf-standard 10/10 | engines that ai-perf wraps |
| perf-standard (canonical in stlc) | the bar every perf framework meets | ai-perf meets it and proposes v1.1 (§9) |
| Recall | lessons across projects | ai-perf pushes and reads lessons (`/perf-learn`) |
| ai-eval | quality of AI output | out of scope |

Out of scope: client-side performance (Web Vitals, Lighthouse; stlc and the product's own checks
cover it). Deferred: chaos under load (killing services mid-run), noted in §15.

When to use which: a single machine is enough, the run fits in one session, and there is one
protocol → stlc. Otherwise (more than one worker, a long run that must survive the session, server
monitoring, WebSocket or realtime traffic, an existing perf suite to improve) → ai-perf.

## 3. Users

| User | Needs | Served by |
|---|---|---|
| Newcomer (dev or QA who has never load-tested) | one command, safe defaults, a result they can read | `/perf-start`, `/perf-help` |
| Practitioner | control of every step, override every default | the nine lifecycle commands |
| Performance lead | scale, monitoring, triage, trends, CI gates | controller, `/perf-analyze`, `/perf-trend` |
| Business owner | "can we handle the sale?" in plain words | `verdict.md` headline, capacity and headroom |

Depth scales with the system (pillar 3): a small API gets one table; a large system gets capacity,
headroom and trend.

## 4. Entry modes

| Situation | Entry | What happens |
|---|---|---|
| New project | `/perf-start` | discover → full lifecycle, smoke first |
| Running project, no perf tests | `/perf-start` | same, but the most critical transactions and past incidents go first; a first result inside one session |
| Existing perf suite (JMeter, k6, Locust, Gatling, in-house) | `/perf-import` | reads scripts, configs and old results → `workload.json`, `plan.md`, baseline; old scripts are wrapped by an adapter, kept as they are |
| Existing suite, wants it better | `/perf-audit` | scores the suite against perf-standard; ranked fixes (e.g. no warm-up, one account for 1,000 users, averaged p95s, no SLO); applies each fix only on approval |

## 5. Lifecycle and commands

```
Entry:       /perf-start (new / no perf)        /perf-import + /perf-audit (existing suite)
                 │
Understand:  /perf-discover → context.md + assumptions.md
                 │
Lifecycle:   plan → model → env → data → script → run ⇄ watch → analyze → report
                 │                              (perf-controller runs in the background)
Operate:     /perf-trend · CI smoke gate · /perf-compare · /perf-learn
Support:     /perf-status · /perf-help · /perf-doctor
```

### 5.1 Lifecycle

| # | Command | Skill | Reads | Writes | Gate (stops the flow) |
|---|---|---|---|---|---|
| 1 | `/perf-plan` | planning-perf-tests | `context.md`, `x-perf`, SLA | `plan.md`: goals, SLA, SLO, error budget, profiles, engine, auto-stop rules | every critical transaction has a measurable SLO; no SLO is looser than its SLA |
| 2 | `/perf-model` | modeling-workload | `plan.md`, analytics or logs if any | `workload.json`: personas, journeys, mix, think time, open/closed, target load (Little's law shown) | mix sums to 100 %; every number names its source (measured or assumed) |
| 3 | `/perf-env` | checking-perf-environment | `workload.json`, target | `env.md`: prod parity, what to monitor, third-party dependencies and their stubs, safety limits | production refused; an unstubbed third-party call blocks; low parity is stated in the verdict |
| 4 | `/perf-data` | preparing-perf-data | `workload.json` | `data/`: accounts, characters, records, a cleanup script tied to the run id | enough unique data for the target load; cleanup runs at the end of every run |
| 5 | `/perf-script` | generating-load-script | workload, data, engine | engine scripts | a one-user smoke passes every journey step with business checks |
| 6 | `/perf-run` | executing-load | scripts, profile, target | `runs/<id>/` | quick doctor passes; warm-up; controller started detached (§7) |
| 7 | `/perf-watch` | monitoring-load-run | `runs/<id>/events.ndjson` | notes in `runs/<id>/watch.md` | woken by events only (§7.4) |
| 8 | `/perf-analyze` | analyzing-perf-results | `runs/<id>/` | `analysis.md`: merged result, bottleneck, failures by class | every failure class has evidence (trace id, metric window) or says "cause not established" |
| 9 | `/perf-report` | reporting-perf-verdict | analysis, baseline, `assumptions.md` | `verdict.md`: verdict, capacity and headroom, assumptions it rests on; baseline promotion on sign-off | no comparison possible → NOT EVALUABLE; a verdict resting on an unconfirmed assumption says so |

Every command ends with one line: the next step and the command for it.

### 5.2 Entry, operations and support

| Command | Purpose |
|---|---|
| `/perf-start` | the newcomer's single command: doctor → discover → plan … report, with safe defaults (local target, smoke first, production refused) |
| `/perf-discover` | builds `context.md` and `assumptions.md` under the asking policy (§10) |
| `/perf-import` | brings an existing suite in (§4) |
| `/perf-audit` | scores a suite against perf-standard and ranks fixes |
| `/perf-compare` | two runs side by side (before/after a change) |
| `/perf-trend` | results across releases; slow decay is flagged |
| `/perf-learn` | lessons across runs; a lesson seen in two projects is proposed back to the bundle |
| `/perf-status` | reads `state.json`: where the project is, which run is live |
| `/perf-help` | what to do now, from the project state; `/perf-help <command>` explains one command |
| `/perf-doctor` | health check (§11); `--fix` repairs what is safe; setup on a new machine is `doctor --fix` |

Engine and test type are parameters (`--engine k6`, `--type websocket`), never separate skills.

## 6. The four adapter axes

| Axis | Values | First wave | Later |
|---|---|---|---|
| Engine | Locust, Gatling, k6, in-house, JMeter | Locust (wraps the template), a `fake` engine for tests | Gatling, k6, in-house, JMeter |
| Test type | HTTP API, WebSocket, game/realtime | HTTP | WebSocket, game |
| Deploy target | local, docker, ssh, k8s, cloud | local (processes), docker (compose, N containers) | ssh, k8s, cloud |
| Metrics source | none, docker stats, host process; signals from Prometheus (M13) | none, docker stats | OTel, cloud |

Each axis has one contract (§8). An adapter is done when it passes that contract's conformance
tests; nothing outside the adapter changes.

### 6.1 Distributed runs (controller and workers)

Engines differ: Locust has master/worker, k6 OSS and Gatling OSS have none. ai-perf does the
orchestration itself, the same way for every engine:

1. **Split** the load across workers; each worker gets its own data partition (no shared
   accounts or characters).
2. **Barrier start**: all workers report ready before load begins.
3. **Lost worker** → the run is `degraded`; its share of load is missing and the verdict says so.
4. **Saturated worker** (generator CPU above 80 %, the PS-A5 line, or event-loop lag) → its
   samples in that window are invalid; the report asks for more workers.
5. **Merge histograms, never percentiles.** Workers emit bucketed latency histograms
   (`perf-hist/v1`, §8.6); the controller adds them and computes percentiles from the sum.
   Averaging per-worker p95s is the commonest scaling error and is tested against.
6. **One time axis**: all samples are timestamped relative to the barrier start, so clock skew
   between machines does not distort the merged timeline.
7. **Other machines** (`ssh`, `k8s` targets, M11): a `perf-agent` on each machine runs the same
   worker on its own disk and mirrors the protocol's files over an HTTP channel the controller
   opens for the run (CONTRACTS §3b). The engines do not know the difference.

### 6.2 Game and realtime

The virtual-user model holds: one virtual user is one player with a character. Character
personas are data in `workload.json`, read by every engine. Install and patch download is a
separate CDN/HTTP test; gameplay starts at login. Realtime metrics differ from HTTP:
concurrent users (CCU), message round-trip, tick lag, reconnects, matchmaking wait. These need the
v1.1 schema fields (§9). UDP has no support in Locust or k6, so a UDP game needs an in-house engine
behind the engine contract.

## 7. Execute and monitor

### 7.1 Why the AI is not in the loop

A soak runs for hours. An LLM polling metrics every few seconds would cost tokens in proportion to
run length, react too slowly to stop a runaway test, and lose the run when the session ends. So
two layers:

```
┌─ Machine layer: perf-controller (Node, deterministic, detached) ─────┐
│  drives workers · samples metrics every second · hard auto-stop      │
│  writes state.json, events.ndjson, monitor series, results           │
└───────────────┬──────────────────────────────────────────────────────┘
                │ events only
┌─ AI layer ────▼──────────────────────────────────────────────────────┐
│  explains events, proposes next steps, asks a human before acting    │
│  outside the hard rules                                              │
└──────────────────────────────────────────────────────────────────────┘
```

Token cost then follows the number of events, not the length of the run.

### 7.2 Run state machine

```
preparing → warmup → ramp → steady → rampdown → collecting → done
     │         │       │       │         │            │
     └─────────┴───────┴───────┴─────────┴────────────┴──→ aborted | degraded
done with no comparable data → not_evaluable
```

`state.json` holds the current state, the plan hash, workers and their heartbeats, and the
auto-stop rule that fired, if any. `/perf-status` and `/perf-watch` only read it.

### 7.3 Failure handling

| Problem | Mechanism | Failing check |
|---|---|---|
| Session closes | controller is detached; `/perf-status` reattaches | kill the AI session mid-run; the run completes and status is correct |
| Controller dies | workers need a heartbeat; no heartbeat for N seconds → workers stop | kill the controller; workers stop within N + 2 s, no orphan load |
| Runaway load | hard auto-stop rules from `plan.md` (e.g. error rate > 20 % for 30 s, target CPU > 95 %) | inject errors; the run stops within the stated bound |
| Generator bottleneck | generator CPU and event-loop lag per worker | saturate one worker; it is flagged, not reported as an application error |
| Timeline mismatch | relative time axis (§6.1) | merged timeline aligns a latency rise with the resource that saturated |
| Data volume | planned, not built: a 1 s → 10 s → 1 min rollup. Today the controller keeps one histogram file per window (10 s by default) and reads them at the end, beating while it reads | — |
| Evidence | sampled failed requests with trace id, secrets masked | no credential in run files (a data-guard check) |

### 7.4 When the AI is woken

Events: `phase_changed`, `slo_breach` (reserved, not emitted yet: the controller does not read the SLOs), `new_error_class`, `anomaly`, `generator_saturated`,
`worker_lost`, `auto_stopped`, `run_finished`. A per-hour wake budget is set in `plan.md`; past
it, events are batched. Check: an 8-hour soak's token cost stays within the estimate given before
the run.

## 8. Contracts

Each contract is versioned and has conformance tests. A change that breaks one is a MAJOR bump.

### 8.1 Engine adapter (`adapters/engines/<name>/adapter.mjs`)

| Member | Does |
|---|---|
| `detect()` | installed? version? |
| `validate(scriptDir)` | can these scripts run? |
| `start(spec)` | starts one worker with its profile slice, data partition, target, and the relative start time |
| `status()` | live counters for the controller (requests, errors, users) |
| `export(rawDir)` | native output → `perf-result/v1` + `perf-hist/v1` |
| `stop()` | stops cleanly, then forcefully after a timeout |

The `fake` engine produces scripted, deterministic results and failures. Every controller test
runs on it, so the controller is tested without network or real load.

### 8.2 Runner (deploy target, `adapters/targets/<name>.mjs`)

`provision(n)`, `startWorkers(spec)`, `heartbeat()`, `stopWorkers()`, `collect()`, `teardown()`.
`local` runs worker processes; `docker` runs a compose project with N worker containers.

### 8.3 Metrics source (`adapters/metrics/<name>.mjs`)

`sample(window) → [{name, unit, t, value, labels}]` on the shared relative time axis. `none` is
allowed and makes the verdict say "target not monitored". `docker-stats` watches containers;
`host-process` watches processes on this machine (by pid, port or command line), and a target
process that dies stops the run.

### 8.4 Events (`runs/<id>/events.ndjson`)

One JSON object per line: `{t, type, severity, summary, data}`. Types are fixed (§7.4); adding one
is MINOR.

### 8.5 Project files (`.perf/<slug>/`)

```
context.md        assumptions.md    plan.md         workload.json   env.md
data/             scripts/<engine>/ baselines/<env>/<profile>.json
runs/<id>/        state.json  events.ndjson  monitor/  raw/<worker>/  result.json  hist/  watch.md
analysis.md       verdict.md        lessons.md
```

Every file a later step reads has a schema or required headings, checked by `/perf-doctor`.

### 8.6 Histogram (`perf-hist/v1`)

Log-linear buckets (about 1 % relative precision, 0.1 ms to 10 min), counts per bucket per
endpoint per 10 s window. Adding two histograms is adding counts, so merge across workers and
windows is exact within the bucket precision. Kept in-house, no dependency, so every engine
adapter can produce it from raw samples or the tool's own buckets.

## 9. perf-standard v1.1 (proposal)

The canonical standard lives in stlc. These additions go to stlc as one MR; the templates update
their copies after. Version stays v1.x because nothing existing changes.

| New | Criterion |
|---|---|
| K. Distributed runs | barrier start; per-worker data partitions; a lost worker makes the run `degraded`; percentiles only from merged histograms; generator CPU per worker |
| L. Realtime | CCU, message round-trip percentiles, tick lag, reconnects and drops are recorded for WebSocket and game tests |
| E5 | SLA and SLO are separate; SLO is stricter by a stated margin; the verdict distinguishes "SLO missed, SLA met" (warn) from "SLA breached" (FAIL) |
| G5 | the result can point to its `perf-hist/v1` files |

`perf-result/v1` gains optional `realtime`, `workers[]`, `hist` and `assumptions` blocks. Optional
fields keep every existing result valid.

## 10. Asking policy

Most users cannot answer "what is your p95 target?". Asking too much makes them quit or guess.

Every fact goes through four tiers, and only the last one is a question:

| Tier | Source | Examples |
|---|---|---|
| 1. Read | repo, configs, `x-perf`, OpenAPI, compose, IaC | endpoints, cache, DB, autoscaling |
| 2. Measure | one-user smoke; logs and analytics where readable | current latency, real traffic mix |
| 3. Safe default | industry defaults per system kind | read-heavy web p95 < 500 ms, error < 1 %; game tick lag < 50 ms |
| 4. Ask | what no machine can know | expected peak, upcoming events, past incidents |

Rules: at most three questions per step, chosen by impact on the result; every question has a
proposed answer to accept; multiple choice before free text; ask at the step that needs it, not
all up front; business questions in business words; "don't know" is a valid answer that becomes a
logged assumption; never ask what `context.md`, the repo or Recall already holds.

`assumptions.md` lists each value with its source, confidence and impact if wrong. The verdict
names the assumptions it rests on. A confirmation promotes an assumption to a fact and re-checks
the conclusions that used it.

Checks: more than three questions in a step fails; a repo with OpenAPI must not cause a question
about endpoints; a PASS resting on an unnamed assumption fails; the second run on a project must
not repeat a first-run question.

## 11. Doctor and help

`/perf-help` answers "what now?" from the project state and never asks anything. `/perf-doctor`
answers "what is broken?":

| Group | Checks |
|---|---|
| Machine | engines installed and pinned, Docker, Node, Python |
| Generator | file-descriptor and socket limits, ephemeral port range, CPU headroom |
| Network | target reachable, latency, DNS; on Windows, `localhost` instead of `127.0.0.1` costs about 2 s per request |
| Safety | production target, secrets in scripts, unstubbed third parties |
| Controller | daemon alive, orphan workers, heartbeats |
| Project | `.perf/` files valid, stale baselines, scripts out of step with current `x-perf`, open assumptions |
| Clock | skew between workers on more than one machine |

`/perf-run` runs a quick doctor first; any ❌ blocks the run. Every doctor check has a fault-injection
test: stop Docker, set a production URL, plant a fake token, leave an orphan worker. The matching
check must fail, or the doctor itself fails.

## 12. Operations

| Need | Mechanism |
|---|---|
| Regression gate | smoke profile in CI on every merge request against the mock or a dev target (`/perf-run --profile smoke --ci`, exit code = verdict); a sample job for the ci-cd repo |
| Scheduled load | nightly or pre-release load on an authorised environment |
| Trend | `/perf-trend` across releases; slow decay is flagged even when each step is under 10 % |
| Baseline upkeep | a baseline is marked `STALE` when the plan, workload or architecture it was taken under changes |
| Script drift | `/perf-doctor` compares scripts with the current `x-perf` operations |
| Learning | a production incident under load becomes a scenario; lessons go to Recall, are read at the step that can act on them, and a lesson about running the tool that two projects taught is proposed to the bundle; a scorecard counts runs to an evaluable result per version |
| Cleanup | the cleanup command in `data/manifest.json` runs at the end of each run (CONTRACTS §8); a failure is a WARN naming the command |

## 13. Five pillars

Each pillar has a mechanism and a check that can fail, on two layers: the AI doing the testing,
and the system under test (`/perf-plan` asks one question per pillar about it, and the answers
become scenarios, e.g. "how does it protect itself under overload?" → a spike or breakpoint test).

| Pillar | Mechanism | Failing check |
|---|---|---|
| P1 Intelligence | references: open vs closed models, Little's law, histogram merging, realtime metrics, a symptom → bottleneck catalogue (DB pool, GC, N+1, connection limits, lock contention) | an exam of cases with known answers (e.g. "p95 rises with load, CPU low → ?"); the analysis must name the cause |
| P2 Memory & Learning | baselines per run; learning after every judged run, without being asked; a lesson about the load generator is fixed by ai-perf in the next run and the fix checked (verified, recurred, needs a person); the brief, one capped page read at the start of each step; the Recall outbox and import; a lesson seen in two projects becomes a draft patch to the bundle | the second run cites the first run's baseline and lessons; a saturated run is followed by an evaluable one with the fix verified; a fix that keeps failing stops the loop; the brief stays under its cap with any history; runs-to-correct-result tracked per version |
| P3 Judgment & Integrity | asking policy (§10); NOT EVALUABLE over a guess; stlc for small cases; low parity stated | mutations: drop the SLO, kill a worker, saturate the generator, mismatch the environment — each must block or mark, never PASS |
| P4 Verification & Safety | gates at all nine steps; production refused; hard auto-stop; approval before loading a system the user does not own; no secrets in scripts or evidence | a mutation test per gate; a production URL is refused; an over-limit run stops in time |
| P5 Value & Experience | one-command start; a verdict a business owner can read; new engines without flow changes; cost estimated before running (tokens, machine hours, cloud) | Quick Start tested on a clean machine; estimated vs actual cost recorded, a large gap warns; adding k6 changes no skill (measured by diff) |

## 14. Repository layout

```
ai-perf/
  README.md  CHANGELOG.md  VERSION  CONTRACTS.md
  commands/            perf-*.md
  skills/              one folder per skill (§5), references/ inside
  controller/          perf-controller: state machine, scheduler, merge, auto-stop, events
  adapters/engines/    fake/  locust/  (gatling/  k6/  …)
  adapters/targets/    local.mjs  docker.mjs
  adapters/metrics/    none.mjs  docker-stats.mjs  host-process.mjs
  adapters/targets/    local.mjs  docker.mjs  ssh.mjs  k8s.mjs
  bin/perf-agent.mjs   a worker on another machine (CONTRACTS §3b)
  schemas/             perf-hist.v1.json, project file schemas
  tests/               unit, conformance per contract, mutation runner
  docs/                design.md, user-guide.md, evidence/
```

Node 20+, ES modules, no runtime dependencies in the controller (same as sdlc and stlc scripts).
Engines bring their own runtime (Python for Locust, JVM for Gatling, the k6 binary).

## 15. Roadmap

Each milestone ends with its checks green and a local commit. Push and MR only on Luan's go.

| Milestone | Delivers | Exit check |
|---|---|---|
| **M0 Design** | this document | Luan approves; open decisions (§16) settled |
| **M1 Controller core** | state machine, `perf-hist/v1` merge, events, auto-stop, heartbeat, `local` target, `fake` engine, `/perf-doctor`, `/perf-status` | conformance + mutation tests; kill-the-controller and kill-the-session tests pass |
| **M2 Lifecycle on HTTP** | the nine lifecycle skills, `/perf-start`, `/perf-discover` with the asking policy, `/perf-help`, Locust adapter, `docker` target, docker-stats metrics | end-to-end on the bundled mock with 4 workers; asking-policy checks |
| **M3 Existing suites** | `/perf-import`, `/perf-audit`, Gatling and k6 adapters | import a k6 and a Locust suite; audit finds planted defects; k6 added with no skill diff |
| **M4 Operations** | CI smoke job, `/perf-compare`, `/perf-trend`, `/perf-learn` + Recall, STALE baselines | trend flags a planted slow decay |
| **M5 Realtime** | WebSocket type, perf-standard v1.1 MR to stlc, game/realtime type, in-house engine template | WebSocket run against a mock with CCU and reconnect metrics |
| **M6 Dogfood** | apply to fx-blog; record what the AI got right and wrong; stlc pointer MR | findings in `docs/evidence/`; material for the blog series |
| M7–M11 | measure honestly; test types; learning and operations; host-process monitoring; ssh and k8s workers over a network channel | evidence in `docs/evidence/m7-…m11-…` |
| M12 | the learning loop | `docs/evidence/m12-learning-loop.md` |
| M13 Signals | the target's own metrics (`/metrics`, Prometheus) at the knee; the coverage map | `docs/evidence/m13-signals.md` |
| M14 Beyond the peak | breakpoint search, recovery after an overload, the configuration matrix | `docs/evidence/m14-beyond-the-peak.md` |
| M15 Volume and scalability | a volume plan counted before every run; capacity per instance count and the scaling efficiency | `docs/evidence/m15-volume-scale.md` |
| Next, by [coverage.md §5](coverage.md) | the approach per project kind; resilience under load; streaming, gRPC, queues; profiles at the knee; a real cluster | — |
| Later | OTel and cloud metrics adapters, JMeter, network shaping | — |

Rough size: M1 and M2 are the bulk (controller plus nine skills); M3–M5 are adapters and
references; M6 is long because it is a real run.

## 16. Decisions

Luan asked on 2026-10-30 for the whole roadmap to be built without stopping for questions. D1–D4
were proposed in M0 and stand. D5 got a default so M5 can proceed. D6 stays open because it is an
outward step.

| # | Decision | State |
|---|---|---|
| D1 | perf-standard v1.1 lands in stlc (canonical) via MR, then template copies | decided: at M5, as a draft MR; until merged, ai-perf documents its extensions here |
| D2 | Controller in Node with no runtime dependencies | decided, built |
| D3 | Own `perf-hist/v1` instead of an HDR library | decided, built; Python and Node arithmetic checked equal |
| D4 | k6 before WebSocket | decided |
| D5 | Game protocol for the first realtime target | default: WebSocket (browser and most mobile games). TCP or UDP needs an in-house engine behind the same worker protocol; revisit when a real game is named |
| D6 | License and visibility | open: Luan's call before any push |
| D7 | Machine-checked project files are JSON, not YAML (M0 planned a YAML workload file) | decided in M2: no YAML parser dependency, and every gate reads the file exactly |
| D8 | The allowlist lives in `env.json`, never in a run spec | decided in M2 after review: the spec author must not decide what may be loaded |
| D9 | A frozen load generator degrades the run | decided in M2: catching up hides that the planned load was never sent |
| D10 | Engines that cannot write files run behind a sidecar worker | decided in M3 for k6: a Node sidecar speaks the worker protocol and runs the engine as its child; the same pattern serves an in-house engine (M5) |
| D12 | In-house engines are workers on a shared kit | decided in M5: the kit owns the worker protocol, realtime counters and its own non-blocking I/O; `ws` (Node's built-in WebSocket, no dependency) is the first and the template for TCP/UDP game protocols |
| D13 | A late generator event loop is saturation | decided in M5: a worker whose loop runs late timestamps late, so its latencies describe the worker (extends PS-A5) |
| D14 | A project's contract comes before questions | decided in M6 after dogfooding fx-blog: `x-perf` budgets and traffic classes in an OpenAPI contract draft the plan and the model (`perf contract`, source `contract`), and answer "what kind of system" without asking |
| D15 | The open model is executed, and a closed loop's heavy tail cannot pass | decided in M7 after a principal engineer's review measured coordinated omission (p95 56 ms closed vs 2588 ms open under a stalling server): `profile.arrival_rps` runs k6 `ramping-arrival-rate`; closed engines refuse it; dropped arrivals degrade the run; a closed p99 ten times p95 is a WARN |
| D16 | Gates and approval are enforced, not advised | decided in M7: a verdict passes only on a plan whose gates pass; a host other than this machine needs a dated approval for that host; a run with no auto-stop gets a default |
| D11 | Gatling suites are imported and audited, not yet run by ai-perf | decided in M3: Gatling 3.11+ writes a binary `simulation.log` and the OSS edition has no pluggable data writer, so per-window histograms would need Gatling internals. Its `perf-result/v1` results import as reference. Revisit with a Gatling-side writer if a project needs it |
