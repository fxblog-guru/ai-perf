# ai-perf — what it covers, and what it does not

Written for: a performance lead deciding whether ai-perf fits a project, and what to add when it
does not.

Performance testing is not one test. Each project needs its own mix, chosen from the risks it
carries. This page maps that whole field against ai-perf v0.14.0:
- **covered**: built, judged by the verdict, and tested;
- **partial**: part of it works, and the gap is named;
- **missing**: not built. Its row says what a project does instead today.

[`CONTRACTS.md`](../CONTRACTS.md) is the authority for what each covered row does. Where this page
and the contract disagree, the contract is right.

---

## 1. Test types: the question each one answers

| Type | Question | State | How, or what is missing |
|---|---|---|---|
| Smoke | Does the wiring work? | covered | `profile.name: smoke`, at most 10 users and a short run; errors only; the CI gate (`perf ci`) |
| Baseline | How fast is it with nobody else on it? | covered | `baseline` profile; `--promote` makes a run the baseline later runs are compared with |
| Load | Does it meet the SLO at the expected peak? | covered | `load` profile, closed loop (users) or open model (`arrival_rps`, k6) |
| Stress | Where does it break, the knee? | covered | a staircase (`steps`, `step_s`); the verdict reads the capacity from the steps that held |
| Breakpoint | How far past the peak can it go? | covered | `perf run --breakpoint` (M14): while every step holds, the next run climbs on from the last held step by `breakpoint.factor` up to `breakpoint.max`, never above the ceiling the environment's owner set in `env.json`. It reports the last step that held and the first that broke, each with its run; a saturated generator is said to be the limit, and no breakpoint is claimed that no run observed |
| Capacity and headroom | How many users at the SLA, and what is left over the plan? | covered | the capacity over `workload.json` `target`; under 20 % headroom is a WARN |
| Spike | Does it survive a sudden jump, and come back? | covered | `spike: { users \| arrival_rps, at_s, for_s }`; judged on recovery time (`slo.json` `spike.recovery_s`) |
| Recovery | After an overload, does it come back by itself? | covered | a `recovery` profile (M14): an overload, then the normal load again; judged on the time until every transaction is back within its SLO (`recovery.recovery_s`). Not back in time is a FAIL; an overload that never took the target past its SLO is NOT EVALUABLE, never a pass |
| Soak (endurance) | Does it degrade over hours: leaks, pools, disks? | covered | p95 drift and target memory growth (`slo.json` `soak`) |
| Regression | Is this build slower than the last good one? | covered | baseline comparison above a 95 % confidence bound; STALE when the workload, script, data or environment differ |
| Trend | Is it slowly getting worse across releases? | covered | Theil–Sen line over recent runs (`perf trend`), so a slow decay is flagged |
| Realtime (WebSocket, games) | Does it hold its players, with ticks on time? | covered | `ws` engine: players online (CCU), drops, reconnects, tick lag, round trip per message type |
| Scalability | Does a second instance double the throughput? | covered | `perf scale` (M15): per instance count, the project's command deploys it (`docker compose up -d --scale api={n}`, run without a shell, `{n}` only ever a whole number), ai-perf waits until the target answers, climbs the staircase (scaled by the count) and reads the capacity. Efficiency = capacity(n) / (n × capacity(1)): linear from 0.8, flat when a count adds at most 10 %, sublinear between; a flat or sublinear count names its shared bottleneck when a signal shows it (the database pool). A count whose steps all held is "at least", a saturated generator is the limit, and no efficiency is claimed without the base capacity. Tested on a mock balancer in front of N backends, not yet on a real cluster |
| Volume | Is it still fast with production-sized data? | covered | a `volume` plan in `data/manifest.json` (M15): a target row count per entity with its source, a seed and a count command. `perf volume --seed` loads and counts; every run but a smoke counts again just before it starts and keeps the counts. A `volume` run is at volume only when every entity counted at least 95 % of its plan; short or uncounted is NOT EVALUABLE (a WARN on other profiles), and runs at volumes more than 5 % apart are STALE for each other. Seeding production-sized data fast is the project's seed command; ai-perf does not generate rows |
| Configuration (A/B tuning) | Which setting is faster: pool size, cache, instance type? | covered | `perf matrix` (M14): one spec per variant (an `apply` command, `env`, a spec override), ranked by p95 or capacity. A difference within noise (bootstrap bound, a 5 % floor) is a tie, a control that moved between its two runs voids the winner, and a variant measured under another fingerprint than its setting declares is STALE and not ranked |
| Contention | What happens when everyone hits the same record? | missing | data partitions keep users apart on purpose. A hot-key or lock test needs a planned shared-data persona |
| Resilience under load | What do users see when a node, a dependency or the database fails over mid-run? | missing | deferred in design §2 as chaos under load. The run fails when the target process dies; nothing kills a part on purpose |

## 2. What is being loaded

| Kind of system or traffic | State | Notes |
|---|---|---|
| HTTP and REST APIs | covered | Locust, k6, the fake engine for practice |
| GraphQL | covered | it is HTTP; transactions are named per operation in the script |
| WebSocket | covered | `ws` engine on the worker kit |
| TCP or UDP game protocols | partial | the worker kit is the template for an in-house engine (decision D12); none is bundled |
| Existing JMeter and Gatling suites | partial | imported and audited, not run (decision D11) |
| gRPC | missing | k6 has a gRPC module; the k6 adapter does not map it yet |
| Message queues (Kafka, RabbitMQ, SQS) | missing | the questions are throughput and consumer lag, not response time; needs an engine and lag metrics |
| Streaming answers (SSE, LLM endpoints) | missing | the measures are time to first token and tokens per second; p95 of the whole response says little |
| Batch jobs, ETL, reports | missing | a job's measure is its duration over a data size and the rows per second; it is not a load model |
| Serverless | missing | cold starts and concurrency limits need their own counters |
| Browser front end (Web Vitals, page load) | missing, by design | out of scope (design §2): stlc and the product's own checks cover it |
| Mobile app (start-up, frames, battery) | missing, by design | belongs to the mobile test bundle; its backend is an HTTP or WebSocket target here |

## 3. Where the load runs, and what is watched

| Area | State | Notes |
|---|---|---|
| One machine: processes or containers | covered | `local`, `docker` targets |
| Several machines: ssh hosts, Kubernetes pods | partial | built and tested with fake ssh and kubectl; no run on a real cluster yet |
| Cloud load services, other regions | missing | a load from several regions, or one that sends real network delay, has no target adapter |
| Network conditions (latency, loss, bandwidth) | missing | nothing shapes the traffic between the generator and the target |
| Target CPU, cores and memory | covered | `docker stats`, or processes on the machine found by port, pid or command line |
| The target's own metrics (Prometheus) | covered | `monitor.signals` (M13): a `/metrics` endpoint or a Prometheus query per signal. A pool, locks, GC, an event loop or a queue over its limit at the knee is named as the cause, with its reading |
| OpenTelemetry metrics, cloud monitoring (CloudWatch, Azure Monitor) | partial | read through a Prometheus that collects them; no direct adapter |
| Database: slow queries, pool, locks | covered | as signals, from the database's exporter (`postgres_exporter`, `mysqld_exporter`) or the app's pool metrics |
| Traces per request (APM) | partial | failed requests keep their trace ids. Nothing fetches the trace |
| Profiles (flame graphs) during the steady window | missing | a CPU-bound bottleneck is named but not located in code |
| Cost per throughput | missing | there is no price per instance and no cost per 1,000 requests |

## 4. The approach per project

ai-perf asks one question today, the system kind, and knows three: read-heavy, transactional and
realtime. Each kind sets the default SLOs. The table below is what a performance lead would plan
for wider kinds of project. "Covered by ai-perf" lists the rows of §1–§3 each kind needs.

| Project | Main risks | Profiles a lead would plan | Covered by ai-perf |
|---|---|---|---|
| Public site or read-heavy API | peaks from campaigns, cache misses | smoke, load, spike, capacity | all |
| Transactional (orders, payments, bookings) | locks, double charges under load, third parties | load, stress, soak, contention | all but contention; third parties are stubbed |
| Multi-tenant B2B SaaS | one large tenant slows the others; reports during peaks | load per tenant size, volume, soak | load, volume (tenants and their rows as entities) and soak; per-tenant isolation is missing |
| Realtime: chat, live updates, games | players dropped, late ticks, reconnect storms | load in CCU, spike, soak, recovery | all; a TCP or UDP protocol needs an in-house engine; recovery is judged on requests, not yet on tick lag or players back online |
| Event-driven (queues, workers) | consumer lag growing, poison messages | throughput, soak, scalability | scalability of an HTTP front; missing: queue engine and lag metrics |
| Batch, ETL, reporting | the job no longer fits its window as data grows | volume, duration trend | volume and trend for the endpoints that start or read a job; a job's own duration over its data size is missing |
| AI or LLM service | time to first token, rate limits, cost | load, spike, soak on streaming | missing: streaming measures and cost |
| Internal tool, few users | none worth a load test | smoke in CI | all (smoke) |

## 5. What to build next, ranked

Ranked by how many projects each one blocks and how much it changes a verdict.

1. **The target's own metrics: done in M13.** Signals from `/metrics` or Prometheus name a full
   pool, locks, GC or a late event loop at the knee, with evidence. Left: a direct OpenTelemetry
   or cloud-monitoring adapter.
2. **Choosing the approach per project.** Discovery classifies the project into the kinds of §4,
   not three, and the plan proposes the profiles for that kind, each with the risk it answers.
   This is where the reasoning of a performance lead lives.
3. **Volume and scalability: done in M15.** A volume plan by row count, counted after seeding and
   before every run; `perf scale` across instance counts with the scaling efficiency. Left: a run
   on a real cluster, and a batch job judged on its duration over its data size.
4. **Resilience under load.** Kill or slow one part mid-run (an instance, a dependency, the
   database primary). Judge what users saw and how long recovery took, reusing the spike's
   recovery judgment.
5. **More kinds of traffic.** Streaming (time to first token, tokens per second), gRPC through k6,
   and queue throughput with consumer lag.
6. **Locating the cause in code.** Capture a profile during the steady window when the analysis
   finds the target CPU-bound.
7. **Running at real scale.** A run on a real Kubernetes cluster, network shaping, and loads from
   other regions.

Client-side performance and mobile apps stay out of scope. Their bundles own them, and ai-perf
loads their backends.
