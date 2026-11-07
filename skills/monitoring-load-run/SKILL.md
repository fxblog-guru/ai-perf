---
name: monitoring-load-run
description: Use while a run is live - wait for events, explain them, and act only on what the hard rules do not cover (/perf-watch).
---

# Monitoring a load run

Follow [perf-protocol](../perf-protocol/SKILL.md). You are woken by events, never by polling.

Loop:

1. `perf watch --slug <slug> --since <n>` blocks until something notable happens: a new error
   class, a lost or saturated worker, an auto-stop, the controller lost, or the end of the run.
   Phase changes ride along; they never wake you on their own. Past the wake budget, only critical
   events wake you.
2. For each wake, write one or two lines in `runs/<id>/watch.md`: what happened, at what t, and
   what it probably means ([bottlenecks](../analyzing-perf-results/references/bottlenecks.md)).
3. Act only outside the hard rules:
   - a new error class: look at a sampled request (`raw/<w>/errors.ndjson`);
   - the controller lost: `/perf-doctor`;
   - a saturated generator: the run will be NOT EVALUABLE, so plan more workers for the rerun.

   Stopping early (`perf stop --slug <slug>`) is for a person's request, or an obvious waste such
   as a broken script. Auto-stop already covers target failure.
4. Continue with `--since <next>` from the output, until `run_finished`.

Then: `/perf-analyze`.
