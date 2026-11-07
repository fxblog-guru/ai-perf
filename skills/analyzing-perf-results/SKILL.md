---
name: analyzing-perf-results
description: Use after a run - the merged timeline, failures by cause with evidence, the bottleneck, in one sentence each (/perf-analyze).
---

# Analyzing results

Follow [perf-protocol](../perf-protocol/SKILL.md) and [bottlenecks](references/bottlenecks.md).

1. `perf analyze --slug <slug>` writes `analysis.json` and `analysis.md`. They hold:
   - the per-window timeline (rps, p95, error rate per phase);
   - failures grouped by class, each with a category (app / data or script / network) and
     sampled requests with correlation ids;
   - the knee, and whether the target was CPU-bound or waiting;
   - the signals (a pool, locks, GC, an event loop) when `env.json` lists them: each one's highest
     value, its limit, and when it first went over. A signal over its limit at the knee is named
     as the cause; the ones read and quiet are named as ruled out.
   A wait with no signal to show it ("not CPU in …") is where the analysis stops. Say which signal
   would have shown it, and propose it for `env.json` (checking-perf-environment step 6).
2. Triage order (PS-H1):
   1. the generator: was it saturated?
   2. which transactions;
   3. when, from the timeline;
   4. which resource saturated first.
3. For each failure class and the bottleneck, write the one-sentence cause from the reference
   template. A sentence the evidence does not support says "cause not established". Never guess
   a component.
4. Follow a correlation id into the target's logs or traces when you can read them, and cite what
   you found.
5. Never recompute what `perf analyze` computed. If you think it is wrong, say why and show the
   window.

Next: `/perf-report`.
