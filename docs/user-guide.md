# ai-perf user guide

Written for: a developer, QA engineer or performance lead who has ai-perf on their machine and
wants to know whether a system will hold its load.

This is the practical guide. [`CONTRACTS.md`](../CONTRACTS.md) is the authority. Where this
guide and the contract disagree, the contract is right and this file has a bug.
[`flows.md`](flows.md) draws the same thing as diagrams. [`coverage.md`](coverage.md) says which
kinds of performance testing are covered and which are not. To see the whole flow before reading
about it, open [`showcase/pipeline.html`](showcase/pipeline.html) in a browser.

---

## 1. The one idea that explains all the rest

**Code runs the load; the AI explains it.** A deterministic controller starts the workers,
merges their histograms, watches the target and stops a runaway run. It never asks the AI
anything while the load runs, and it survives the AI session closing. The AI does what a
performance engineer does around the run: it reads the system, plans, models users, writes the
script, then explains what broke and why.

Two rules follow from that, and every surprise below comes from one of them:

- **Gates are the product.** Each step writes a file and checks it (`perf check <step>`). The
  next step refuses to start without a pass. A gate is never weakened to make it pass.
- **Never a silent pass.** A saturated load generator, a lost worker, a missing baseline or an
  SLO nobody agreed is written in the verdict. A run that cannot be judged is NOT EVALUABLE,
  never PASS.

---

## 2. Day 1: install and prove it

Needs Node 20 or later. Locust needs Python with `pip install locust`; k6 needs the `k6` binary.
The fake engine needs nothing.

```bash
node bin/perf.mjs doctor          # what this machine has; --fix repairs what is safe
```

`[FAIL]` is a real blocker. `[WARN]` says which run will be unhappy later, and why.

Then run the whole flow once on the built-in fake engine. It needs no target and no install:

```bash
node bin/perf.mjs run examples/quickstart/fake.json --root examples/quickstart --wait
node bin/perf.mjs report --root examples/quickstart --slug demo --bootstrap
```

```
VERDICT: PASS
  note: BOOTSTRAP: no baseline exists; judged on SLOs only. Promote this run to start regression checks.
  note: target not monitored: a bottleneck can be located only from response times
  note: SLOs not agreed with an owner (source imported/assumed/default): listItems, getItem, createOrder
  summary: At 20 users (100 requests/s), every planned transaction met its SLO.
```

The notes are the point: even a PASS says what it rests on.

In Claude Code, everything below is a slash command. `/perf-help` always answers "what now?" from
the project's files.

---

## 3. A new project, or one with no perf tests

```
/perf-start
```

`/perf-start` chains the lifecycle with safe defaults:
- the `local` target;
- a smoke run first;
- production refused;
- the fewest workers that keep the generator cool.

It stops and hands over only when a decision is yours: an owner, a production question, or where
accounts come from. You can also run each step yourself:

| # | Command | Writes (`.perf/<slug>/`) | Stops on |
|---|---|---|---|
| 1 | `/perf-discover` | `context.md`, `assumptions.json` | at most 3 questions, each with a proposed answer |
| 2 | `/perf-plan` | `slo.json`: SLAs, stricter SLOs, the profiles | a critical transaction without a measurable SLO; an SLO looser than its SLA |
| 3 | `/perf-model` | `workload.json`: personas, journeys, mix, think time, open or closed model | a mix that does not sum to 100 %; a number with no source |
| 4 | `/perf-env` | `env.json`: hosts, owner, parity, stubs, monitoring, signals | production; an unstubbed third party; no owner |
| 5 | `/perf-data` | `data/`: accounts, records, the cleanup command | fewer unique accounts than users; no cleanup |
| 6 | `/perf-script` | the engine's script | a one-user smoke that fails any journey step |
| 7 | `/perf-run` | `runs/<id>/` | the quick doctor; a host outside the allowlist |
| 8 | `/perf-watch` | `runs/<id>/watch.md` | it is woken by events only, never polls |
| 9 | `/perf-analyze` | `analysis.md`: the knee, the bottleneck, failures by cause | a cause with no evidence is written as "not established" |
| 10 | `/perf-report` | `verdict.md`, `verdict.json` | no baseline without `--bootstrap`; an unconfirmed assumption is named |

**If the repo has an API contract with `x-perf` budgets**, discovery uses it: `perf contract`
drafts `slo.json` and `workload.json` from the budgets, and "what kind of system is this?" is
never asked.

**If the system is small** (a few operations, at most 50 users, no realtime, no existing suite),
`perf help` says so and offers stlc's perf tier first. ai-perf is for scale, long runs,
monitoring, realtime and existing suites.

---

## 4. A project that already has a perf suite

```
/perf-import      # JMeter, k6, Locust, Gatling, in-house → drafts, run specs, old results
/perf-audit       # score against perf-standard; ranked fixes, each applied only on your yes
```

ai-perf keeps your scripts. It wraps them in its controller and does not rewrite them. The audit
finds what such suites usually get wrong:
- no warm-up;
- one account shared by a thousand users;
- averaged p95s;
- no SLO at all.

k6 and Locust suites run as they are. Gatling and JMeter suites are imported and audited, and
their old results become reference numbers, but ai-perf does not run them.

---

## 5. Reading the outcome

Every run has a folder, `.perf/<slug>/runs/<id>/`:

| File | What it is | Who reads it |
|---|---|---|
| `verdict.md` | the outcome, one sentence for a business owner, the transactions, and "Read with care" | everyone |
| `analysis.md` | the timeline per window, failures by cause, the knee and its bottleneck, the signals | engineers |
| `result.json` | `perf-result/v1`: every number, comparable with any engine | tools, trend, CI |
| `junit.xml` | from `perf ci`: one test case per transaction | the pipeline |
| `events.ndjson`, `state.json` | what happened during the run | `/perf-status`, `/perf-watch` |

The outcomes:

| Outcome | Means | `perf report` / `perf ci` exit |
|---|---|---|
| PASS | every planned transaction within its SLO, no regression | 0 |
| WARN | an SLO missed with the SLA met, a heavy tail, little headroom, a mix that is not the plan's | 0 |
| FAIL | an SLA breached, a regression above noise, capacity below the planned peak, the target died | 1 |
| NOT EVALUABLE | the run cannot be judged: a gate failed, no baseline, a lost or saturated generator | 3 |

**The sentence to read first** is `summary`. For a staircase it reads like "It holds 8 users
(80 requests/s) within the SLA; the planned peak is 10, so the headroom is 0.8×". For a spike or a recovery
test, it gives the recovery time. For a soak, it gives the drift. A breakpoint search adds
`breakpoint.md`: "It breaks between 16 and 32 users: 16 held (run …), 32 broke (run …)". A project with a
volume plan adds the data the run was measured on: "Measured at the planned data volume: orders
5,000,000 of 5,000,000 (100 %)", or "on less data than planned".

**The section to read second** is "Read with care": every assumption, default and gap the
verdict rests on. A PASS with five notes is weaker than a PASS with none.

---

## 6. Choosing the tests: each project has its own approach

`/perf-plan` starts from smoke and load at the expected peak. It adds a profile only when a
question needs it:

| Question | Profile | Plan it in `slo.json` |
|---|---|---|
| Does it meet the SLO at the peak? | `load` | the transactions' SLO and SLA |
| Where does it break, and what headroom is left? | `stress` or `capacity`: a staircase of `steps` | `workload.json` `target` is the planned peak |
| How far past the peak can it go, when nobody knows? | `stress` with `breakpoint: { factor, max }`, run with `perf run --breakpoint` | `max`, at most the ceiling the environment's owner set in `env.json` (`max_users`, `max_arrival_rps`) |
| Does it survive a campaign or a release-day spike, and come back? | `spike` | `spike.recovery_s` |
| After minutes of overload, does it come back within its SLO by itself? | `recovery`: the overload as a `spike` shape, the normal load around it | `recovery.recovery_s` |
| Is it still fast with production-sized data? | `volume`, with a volume plan in `data/manifest.json` (`perf volume --seed`) | each entity's `target` rows; `min_pct` (95 %) of it counted before the run |
| Does a second instance double the throughput? | a `stress` staircase run per instance count with `perf scale` | the command that deploys `{n}` instances, the counts (`1,2,4`) |
| Does it degrade over hours? | `soak`, with the target monitored | `soak.max_p95_drift_pct`, `soak.max_memory_growth_pct` |
| Is this build slower than the last good one? | any, against a promoted baseline | nothing: same workload, script, data and environment, or the baseline is STALE |

[`coverage.md` §4](coverage.md) lists which profiles each kind of project needs, for example
transactional, multi-tenant SaaS, realtime or event-driven, and what ai-perf does not cover yet
for each.

**Open or closed model.** A closed loop of users waits for each answer, so a stalling server
gets fewer requests and looks faster than it is (coordinated omission). When users arrive
whatever the server does, as on a public site, plan an open model: `profile.arrival_rps`, run by
k6. A closed run's p99 ten times its p95 is a WARN for this reason.

---

## 7. Seeing inside the target: monitoring and signals

Without monitoring, the analysis can only say "latency more than doubled while throughput
stopped growing; the resource is unknown". Two levels of monitoring fix that, both set in
`env.json` by `/perf-env`.

**CPU and memory** (`monitor.metrics`):
- `docker-stats` for containers;
- `host-process` for a process on this machine, found by port, pid or command line. If it dies
  under load, the run stops and fails.

This is enough to tell CPU-bound from waiting. A soak needs it: it judges memory growth.

**Signals** (`monitor.signals`) say what the target waits on: a full connection pool, database
locks, GC, a late event loop, a backed-up queue. Each signal is one number from the app's
`/metrics` endpoint or from a Prometheus query:

```json
"signals": [
  { "name": "db_pool", "kind": "pool_used_pct", "prometheus": "http://prometheus:9090",
    "query": "100 * sum(hikaricp_connections_active) / sum(hikaricp_connections_max)" },
  { "name": "loop", "kind": "event_loop_lag_ms", "scrape": "http://127.0.0.1:3000/metrics",
    "metric": "nodejs_eventloop_lag_p99_seconds", "scale": 1000 }
]
```

The analysis then names the cause with evidence instead of guessing:

```
waiting on db_pool: a connection pool was full: requests waited for a connection.
Evidence: p95 52 -> 410 ms at t=60s, rps flat at 70, CPU max 31 % (api), db_pool 100 % > 95; under their limits then: loop.
```

Each signal is compared with its limit in its kind's unit, so `scale` turns seconds into ms
(1000) or a ratio into % (100). A signal that was read and stayed under its limit is listed as
ruled out. One that was over its limit all along, before the load grew, is said but not named
as the cause. One that never answered is said, and the run is still judged. The
`checking-perf-environment` skill has the metric names and scales for Java, Node, .NET,
Postgres and MySQL.

---

## 8. More load than one machine

| Need | Target | Notes |
|---|---|---|
| A few thousand users | `local`: worker processes | the default |
| Isolated generators, or the engine in a container | `docker` | |
| More than one machine can generate | `ssh` | a `perf-agent` on each host; an `approval` in `env.json` naming the host, at most 90 days old |
| A cluster | `k8s`: the workers are pods of a Job | the same approval rule |

Workers on other machines report over a token-protected channel. Their clocks are aligned to
the controller's. Histograms are merged, never averaged. A worker whose CPU passes 80 % saturates
the run, which becomes NOT EVALUABLE; the next run adds workers by itself (section 9).

---

## 9. After the run: the loop that keeps it honest

**It learns by itself.** Every judged run updates the project's lessons. A mistake in how the
load was made is fixed in the next run of the same profile, and the run after checks the fix:
- a saturated generator gets more workers;
- a late engine start gets a longer rampdown;
- dropped arrivals get a higher VU cap.

What only a person can fix is marked "needs a person". The spec file is never edited.

```bash
perf run spec.json --until-evaluable     # run, judge, fix, run again until a run can be judged (at most 3)
```

**It remembers cheaply.** `/perf-brief` puts everything known about the project on one page of
about 1500 tokens: the system, decisions, measurements, fixes in effect, lessons, and what the
team knows. Every step starts from it.

**It shares with the team.** `/perf-share` lists the facts the team's Recall does not have yet,
and takes in what Recall already knows. A lesson two projects taught becomes a draft patch to the
skill that should have known it.

**Over releases:**

| Command | Answers |
|---|---|
| `/perf-compare` | is run B slower than run A, above noise? |
| `/perf-trend` | is it slowly getting worse? A Theil–Sen line flags a decay too small for any one step |
| `perf scale` | does a second instance double the throughput? Capacity per count and the scaling efficiency: linear, sublinear, flat (with the shared bottleneck a signal names), or only "at least" |
| `perf volume` | is the data at production size? Seeds (`--seed`) and counts each entity of the volume plan |
| `perf matrix` | which setting is faster (pool size, cache, instance type)? One run per variant, ranked; within noise is a tie, and a control that moved voids the winner |
| `/perf-ci` | the merge-request gate: a smoke on every MR, exit code = verdict, JUnit for the pipeline ([`ci/gitlab-ci.perf.yml`](../ci/gitlab-ci.perf.yml)) |
| `/perf-scorecard` | how many runs each version of ai-perf needs before one can be judged |

---

## 10. What each command stops on

| Step | Gate | It refuses when |
|---|---|---|
| plan | `perf check plan` | a transaction has no numeric SLO and SLA, or its SLO is looser than its SLA |
| model | `perf check model` | the mix does not sum to 100 %, or a number has no source |
| env | `perf check env` | there is no owner or parity, the environment is production, or a third party is not stubbed |
| data | `perf check data` | there are fewer accounts than users and no reason why, or no cleanup |
| script | `perf check script` | the smoke fails a journey step |
| run | quick doctor | the engine is missing, a secret is in a file, a host is outside the allowlist, or a remote host has no approval |
| report | the gates above, for the run | a gate fails: NOT EVALUABLE |

---

## 11. Mistakes that cost the most

1. **Load without monitoring.** A FAIL with "the resource is unknown" costs a second run. Set
   `monitor` and at least the pool signal before the first load run.
2. **A closed loop for an open system.** Coordinated omission hides the stalls users feel. A
   public site gets an open model.
3. **One account for every user.** The cache answers, the locks never contend, and the numbers
   are fiction. `/perf-data` refuses it unless you give a reason.
4. **Comparing runs that differ.** Another script, other data or another environment is not a
   regression. ai-perf marks such a baseline STALE instead of comparing.
5. **Promoting a bad run.** `--promote` makes a run the yardstick for every later run. Promote
   only a run you would sign.
6. **Hiding a FAIL.** A FAIL is the finding. Loosening the SLO to make it pass is the one thing
   the gates are built to stop.

---

## 12. Where everything lives

```
<project>/.perf/<slug>/
  context.md, assumptions.json      what the system is; what nobody confirmed
  slo.json, workload.json           the plan and the model
  env.json, data/                   where load may go; the accounts and the cleanup
  runs/<id>/                        one folder per run (section 5)
  lessons.json, learned.json        what was learned; the fixes in effect
  brief.md                          the one-page memory
  breakpoint.md, matrix-<name>.md   a breakpoint search; a matrix of settings, ranked
  scale-<name>.md                   capacity per instance count, scaling efficiency
  data/volume.md                    the volume plan as last seeded and counted
  shared.json, recalled.json        what went to Recall; what came back
~/.ai-perf/                         lessons across projects, scorecards, proposals/
```

---

## 13. How it fits the rest of agentic-fx

| Neighbour | Owns | With ai-perf |
|---|---|---|
| sdlc | `x-perf` budgets in the API contract | ai-perf reads them to draft the plan |
| stlc | the light perf tier: one machine, one protocol, a short run | `perf help` offers it for a small case; ai-perf takes over when a project needs scale, long runs or monitoring |
| Recall | the team's memory | lessons, decisions, environments and baselines go there and come back |
| ai-eval | the quality of AI answers | out of scope: ai-perf tests the speed of systems, not AI output |
