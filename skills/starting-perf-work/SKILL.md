---
name: starting-perf-work
description: Use when someone wants performance testing and has not started - one command from nothing to a first verdict with safe defaults (/perf-start).
---

# Starting performance work

Follow [perf-protocol](../perf-protocol/SKILL.md). This skill chains the lifecycle for a newcomer.
Each step's own skill does the work; this one decides the order and keeps the defaults safe.

## Defaults a newcomer gets

- Target `local`, smoke first, production refused, the bundled mock if no system is running yet.
- Workers: 1 for smoke. For load: the fewest that keep the generator under 80 % CPU (start with
  2).
- Engine: an existing suite's tool (`/perf-import`, from M3). Otherwise Locust when Python is there,
  else the `fake` engine to show the flow.

## Order

1. `perf doctor`: fix any `[FAIL]` first (setup is `perf doctor --fix`).
2. `/perf-discover`. If `perf help` then says "small case" (a few operations, at most 50 users, no
   realtime, no suite, no peak event or incident), offer stlc's perf tier first: a smoke and one
   load check in the same flow as the rest of testing. Go on with ai-perf only if the team wants
   it. If discover finds an existing suite, reuse its scenarios; from M3, `/perf-import`
   brings it in instead of writing new scripts.
3. `/perf-plan` → `/perf-model` → `/perf-env` → `/perf-data` → `/perf-script`. Each must pass its
   gate before the next.
4. `/perf-run` with smoke, then load. `/perf-watch` while it runs.
5. `/perf-analyze`, then `/perf-report --bootstrap --promote` for the first load run.

Before step 4, state the estimated cost (protocol rule 6). Stop and hand over when a gate needs a
decision only a person can make: an owner, a production question, or a missing account source.
End with the verdict headline and `perf help`'s next step.
