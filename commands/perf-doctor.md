---
description: Health check of the machine, the safety of a run spec, and live runs (lost controllers, orphan workers); --fix repairs what is safe.
argument-hint: [--spec <file>] [--fix]
---

Run `node <ai-perf>/bin/perf.mjs doctor --root <project root> $ARGUMENTS` and show its output as it
is. Each line is `[ok]`, `[warn]` or `[FAIL]` with a group (machine, generator, network, safety, controller,
project) and, when not ok, the fix.

- Exit 0: nothing fails. Say so in one line and give the next step from `/perf-help`.
- Exit 1: list each `[FAIL]` with its fix. Never apply a fix the output does not offer.
- `--fix` stops orphan workers and marks runs whose controller is gone as `aborted`. It acts on
  processes, so run it only when the user asked for `--fix` or confirmed after seeing the failures.
- `--spec <file>` also checks a run spec: allowlisted host, no production, valid profile, timings
  and auto-stop rules. These are the same checks `perf run` refuses on.

Do not edit scripts or specs to make a check pass. A failing check is reported, and the user
decides.
