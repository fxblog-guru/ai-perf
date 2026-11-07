---
name: planning-perf-tests
description: Use to set what "fast enough" means - SLAs, stricter SLOs, critical transactions and profiles, every number sourced (/perf-plan).
---

# Planning performance tests

Follow [perf-protocol](../perf-protocol/SKILL.md). Write `.perf/<slug>/slo.json`:

```json
{ "profiles": ["smoke", "load"],
  "min_rps": 150,
  "transactions": [
    { "name": "createOrder", "source": "contract",
      "slo": { "p95_ms": 400, "error_rate": 0.005 },
      "sla": { "p95_ms": 800, "error_rate": 0.01 } } ] }
```

0. **A contract with budgets first.** When `context.md` lists an API description with `x-perf`
   budgets, run `perf contract --slug <slug> --ops <the few that matter>`. It drafts `slo.json` with
   SLA = the budget and SLO 20 % stricter (`source: contract`). Error rates are defaults, and the
   verdict names them. Then review the draft instead of writing one.
1. **Transactions** are the operations users feel: the operationIds from `context.json`. Take the
   few that matter (checkout, login, search), not every endpoint.
   Add `p99_ms` next to `p95_ms` for transactions where the tail matters (checkout, login): it is
   judged when set.
2. **SLA** is what was promised (a contract, an `x-perf` budget). **SLO** is the internal target,
   stricter by a margin you state (default 20–50 %). An SLO is never looser than its SLA.
3. No SLA anywhere? Use the system-kind defaults from `context.json` as `source: default`. The
   verdict will say they were not agreed with anyone.
4. **Profiles**: smoke always; load at the expected peak. Add stress, spike, soak or capacity only
   when a question needs it (workload-modeling reference, profile table). A past incident gets the
   profile that reproduces it. Shapes (CONTRACTS §1):
   - stress or capacity: `"steps": [50, 100, 200, 400], "step_s": 300`. The verdict gives the
     capacity and its headroom over `workload.json` `target`.
   - spike: `"spike": { "users": 400, "at_s": 300, "for_s": 60 }` with steady after it. Plan the
     recovery budget: `"spike": { "recovery_s": 60 }` in `slo.json`.
   - soak: hours at the peak, with the target monitored (memory). Plan the limits:
     `"soak": { "max_p95_drift_pct": 20, "max_memory_growth_pct": 10 }` in `slo.json`.
   - breakpoint: a stress staircase with a ceiling, `"breakpoint": { "factor": 1.5, "max": 2000 }`,
     run with `perf run <spec> --breakpoint`. The owner sets the ceiling in `env.json`
     (`max_users`, or `max_arrival_rps` for an open model; `/perf-env` asks for it). `max` may not
     exceed it, and an environment without one gets no breakpoint search. Never guess it.
   - recovery: `"name": "recovery"` with the overload as a spike shape,
     `"spike": { "users": 600, "at_s": 300, "for_s": 300 }`, and the normal load (`users`)
     before and after it. Plan the budget: `"recovery": { "recovery_s": 120 }` in `slo.json`.
   - configuration (A/B tuning): not a profile but a matrix of one setting's values, each run
     with the same spec (`perf matrix`, `/perf-compare` skill).
   - volume: `"name": "volume"`, a load at the planned peak on production-sized data. It needs
     the volume plan in `data/manifest.json` (`/perf-data`): the rows per entity production has,
     with their source. Judged as a load run, and only at volume when the counts taken just
     before it reach the plan.
   - scalability: not a profile but the stress staircase run once per instance count
     (`perf scale`, a scale plan with the command that deploys `{n}` instances).

   Which one, and when:
   - **Stress or capacity** when the question is "do we have headroom over the planned peak?".
     The staircase stops at its top step.
   - **Breakpoint** when nobody knows how far past the peak it goes (a launch, a campaign whose
     size is unknown, a capacity plan for next year), or a staircase came back with every step
     held. It costs several runs: say the number (`--max-runs`, default 3) and the ceiling first.
   - **Spike** when the risk is a sudden jump that lasts seconds or a minute (a push
     notification, a ticket sale opening). Judged against the steady before it.
   - **Recovery** when the risk is what happens after: a queue or a pool that stays full, retries
     that keep it down, a cache that must warm again. The overload must last long enough to
     hurt (minutes, not seconds), and the normal load after it must be within the SLO on its
     own. During the overload and its budget, the error-rate and target-CPU auto-stops give way to
     a safety bound (errors above 95 %), so a target that sheds load is watched coming back. Judged against the SLO, not against the base. It is not evaluable when the overload
     never took a transaction past its SLO: raise it, do not accept it.
   - **Configuration** when the owner asks which setting is faster (pool size, cache on or off,
     instance type, a runtime flag), before a tuning decision is made.
   - **Volume** when the data grows and the queries read it: a multi-tenant system (one large
     tenant's tables), batch, ETL and reporting (the job and the reports scan what is there), search
     and history pages, anything whose plan changes with table size (indexes, sorts, pagination
     deep in a list). A test database of a few thousand rows hides all of it. Ask the owner for
     production's sizes today and in a year; plan the larger.
   - **Scalability** when the plan for more traffic is "add instances" (autoscaling, a launch, a
     sizing decision), or a staircase found the capacity and the next question is what a second
     instance buys. Plan it when a shared part could cap it: one database, a cache, a lock, a
     licence. Monitor that part (`monitor.signals`) so a flat count names it. Ask the owner for the
     command that deploys n instances in the test environment and the most it allows.
5. **Realtime** (WebSocket, games). Add a `realtime` block with its own `source`:
   `{ "slo": { "tick_lag_p95_ms": 30, "drops_per_min": 0.5 }, "sla": { "tick_lag_p95_ms": 50,
   "drops_per_min": 1 }, "ccu_hold_pct": 95, "source": "default" }`.
   - Tick lag and drops are judged like SLOs and SLAs.
   - Fewer than `ccu_hold_pct` of the planned players online in steady is a FAIL.
   - The default for a realtime system is a tick lag p95 under 50 ms.
6. **Auto-stop rules** for the run spec, from the SLA, e.g. error rate above 3× the SLA for 30 s.
7. Ask the system's owner one question per pillar (design §13), only for an initiative-sized
   system. For example: "how does it protect itself under overload?" A spike, recovery or
   breakpoint test follows from the answer.

Gate: `perf check plan --slug <slug>`. Next: `/perf-model`.
