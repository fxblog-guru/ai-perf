# ai-perf — flows

Written for: anyone who wants to see how ai-perf works before reading its contract.

Six diagrams, from the whole lifecycle down to a single run and the loop that learns from it.
Read them in order: each zooms into something the previous one drew as a box.
[`CONTRACTS.md`](../CONTRACTS.md) is the authority for every rule shown here. If a diagram and the
contract disagree, the contract is right.

---

## 1. The lifecycle: ten steps, each with a gate

```
 ENTRY        /perf-start  (new project, or no perf tests)      /perf-import + /perf-audit  (existing suite)
                   │                                                      │
                   └──────────────────────────┬───────────────────────────┘
                                              ▼
 UNDERSTAND   /perf-discover ─▶ context.md, assumptions.json      (≤ 3 questions, each with an answer)
                                              │
 PREPARE      /perf-plan ──▶ slo.json        gate: every critical transaction has SLO ≤ SLA
                   │
              /perf-model ─▶ workload.json   gate: mix = 100 %, every number has a source
                   │
              /perf-env ───▶ env.json        gate: owner, parity, no production, third parties stubbed
                   │
              /perf-data ──▶ data/           gate: enough unique accounts, a cleanup command
                   │
              /perf-script ▶ engine script   gate: a one-user smoke passes every journey step
                                              │
 RUN          /perf-run ───▶ runs/<id>/      quick doctor ─▶ controller started detached
                   │   ⇅
              /perf-watch                    woken by events only
                                              │
 JUDGE        /perf-analyze ▶ analysis.md    knee · bottleneck · signals · failures by cause
                   │
              /perf-report ─▶ verdict.md     PASS · WARN · FAIL · NOT EVALUABLE
                                              │
 OPERATE      /perf-ci · /perf-compare · /perf-trend · /perf-brief · /perf-share
 SUPPORT      /perf-help · /perf-status · /perf-doctor
```

A failing gate stops the flow. The step's skill fixes the file or asks a person. It never
loosens the check.

---

## 2. Two layers: why the AI is not in the loop

```
┌─ Machine layer: perf-controller (Node, deterministic, detached) ───────────────────┐
│  starts workers · barrier start · merges histograms · samples target and signals   │
│  hard auto-stop · heartbeat · writes state.json, events.ndjson, result.json        │
└──────────────────────────────┬─────────────────────────────────────────────────────┘
                               │ events only: phase_changed, new_error_class, anomaly,
                               │ generator_saturated, worker_lost, auto_stopped, run_finished
┌─ AI layer ───────────────────▼─────────────────────────────────────────────────────┐
│  explains events · proposes next steps · asks a person before acting outside rules │
└────────────────────────────────────────────────────────────────────────────────────┘
```

A soak runs for hours. An AI polling every few seconds would cost tokens in proportion to the
run's length, react too late to stop a runaway test, and lose the run when the session closed. So
the token cost follows the number of events, not the length of the run.

---

## 3. One run: the state machine

```
preparing ─▶ warmup ─▶ ramp ─▶ steady ─▶ rampdown ─▶ collecting ─▶ done
    │           │        │        │          │            │
    └───────────┴────────┴────────┴──────────┴────────────┴──▶ aborted   (a stop, an auto-stop,
                                                                          the target gone, the deadline)
                                                          └──▶ degraded  (a lost or saturated worker,
                                                                          dropped arrivals, unmonitored)
done with no comparable data ─────────────────────────────────▶ not_evaluable
```

Only `steady` is measured; a run without a steady phase is judged over the whole run, and the
verdict says so. A staircase is a steady phase made of steps; a spike sits inside it.

---

## 4. Workers: one load, many generators

```
                         perf-controller
                 ┌──────────┬─────┴─────┬──────────┐
              split      barrier      merge      watch
                 │          │           │          │
   ┌─────────────┼──────────┼───────────┼──────┐   │  target: docker stats | host process
   ▼             ▼          ▼           ▼      │   │  signals: /metrics | Prometheus
 worker 1     worker 2   worker 3 …  worker N  │   ▼
 (local process, container, ssh host, k8s pod) │  monitor/target.ndjson
   │  own data partition, own histograms       │
   └──────── perf-hist/v1 per window ──────────┘
                    │
                    ▼
     merged histogram ─▶ percentiles from the sum, never an average of p95s
```

- A lost worker makes the run `degraded`: its share of the load is missing, and the verdict says
  so.
- A worker above 80 % CPU, or with its event loop late, saturates the run: its numbers describe
  the tool, not the target.
- Workers on other machines mirror the same files over a token-protected HTTP channel. Their
  clocks are aligned to the controller's.

---

## 5. From a knee to a cause

```
timeline per window ──▶ knee? (p95 > 2× the early steady p95, rps flat, offered load just grew)
                          │ no ──▶ "no knee: latency did not break while load grew"
                          │ yes
                          ▼
       generator saturated? ── yes ──▶ "load generator: the numbers describe the tool"
                          │ no
                          ▼
       a signal over its limit at the knee? ── yes ──▶ "waiting on <signal>: <what it means>"
                          │ no                          + its reading against its limit
                          ▼
       target CPU > 85 %? ── yes ──▶ "CPU-bound: <container> above 85 %"
                          │ no
                          ▼
       one core pegged? ── yes ──▶ "maybe CPU-bound on one thread"
                          │ no
                          ▼
       "not CPU in <what was watched>: the wait is in a pool, locks, a dependency or I/O"
         + the signals that were read and quiet, named as ruled out
       target not monitored at all ──▶ "the resource is unknown"
```

Every answer carries its evidence: the load, the latency before and after, the throughput, and
the resource. A cause the evidence does not support is "not established", never a guess.

---

## 6. The learning loop

```
perf run ──▶ run ──▶ perf report / perf ci ──▶ verdict
   ▲                                   │
   │                                   ▼  (automatic, every judged run)
   │          learn: lessons.json, learned.json, scorecard.json, brief.md
   │                                   │
   └── learned settings ◀── fix (only the load generator) ──┘
                                       │
                         needs a person (the system, the plan, the environment,
                         no fix that fits, a fix that recurred twice)
                                       │
                                       ▼
                 perf share ──▶ Recall (the team)  ──▶ back into every brief
                 a lesson from two projects ──▶ a draft patch to the skill
```

- **A fix is checked.** The next run that used the fix and ran its course decides: `verified`, or
  `recurred` and a larger fix. After two recurrences the fix is rolled back and a person is asked.
- **What ai-perf never fixes:** the system under test, the planned load, the SLOs or the
  environment. A lesson about the system is the test's finding.
