---
description: "Read-only state of the latest (or a named) run: phase, controller alive or lost, workers, problems, last events."
argument-hint: [--slug <slug>] [--run <run_id>]
---

Run `node <ai-perf>/bin/perf.mjs status --root <project root> $ARGUMENTS` and show the result. It
reads files only (CONTRACTS §2, §4). It never starts, stops or changes a run.

Then add one line for what to do next:

| Status | Next |
|---|---|
| running phase, controller alive | wait; events will say when something needs attention |
| controller lost | `/perf-doctor`; it reports orphan workers, and `--fix` stops them |
| `done` | analyze the result (`/perf-analyze`, from M2) |
| `degraded`, `not_evaluable` | name the problem from the list, and do not quote the numbers as a verdict |
| `aborted` | give the stop reason; an `auto_stop` reason means the target was failing under load |
| no runs | `/perf-start` (from M2) |
