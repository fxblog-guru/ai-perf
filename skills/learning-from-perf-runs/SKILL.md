---
name: learning-from-perf-runs
description: "Use to see or share what runs taught - lessons, the fixes ai-perf made itself and whether they worked, what needs a person, Recall, and lessons proposed back to the bundle (/perf-learn). Learning itself is automatic after every judged run."
---

# Learning from runs

Follow [perf-protocol](../perf-protocol/SKILL.md). Learning happens on its own: every judged run
(`perf report`, `perf ci`, `perf run --until-evaluable`) runs `perf learn`. This skill reads what
it learned, shares it and closes what needs a person.

1. `perf learn --slug <slug>` (again, if you want it fresh). It collects the lessons each judged
   run taught, each with a stable id:
   - problems: a saturated or frozen generator, a late engine start, monitoring that failed;
   - the bottleneck;
   - failure classes;
   - regressions.

   It writes `lessons.json`, `lessons.md`, `learned.json`, `scorecard.json` and `brief.md`. Each
   lesson names the step that can act on it. When a lesson comes up again, its count goes up.
   Lessons about running ai-perf also go to `$PERF_HOME/lessons.json`, across projects.
2. **The fixes** (`learned.json`). A lesson whose fix touches only the load generator gets one,
   from the run that taught it: `problem:generator_saturated` adds workers (up to this machine's
   CPUs for local and docker workers, 8 per ssh host, 64 on k8s, never more than a closed loop's
   users), `problem:engine_start_lag` lengthens the rampdown, `problem:arrival_shortfall` raises
   the VU cap of an open model (a smoke stays at 10). The next run of the same profile, model and
   target applies it (`perf run` prints `learned: …`; the spec file is never edited;
   `--no-learned` runs without). The first later run that used it and ran to its end checks it:
   `verified` when the lesson did not come back, `recurred` when it did, then a larger fix. A
   stopped run teaches and checks nothing. When no fix fits now (the machine is full) it is
   `needs_person`; after two recurrences the fix is rolled back and it stays `needs_person` until
   a person resets it: `perf learn --slug <slug> --reset <lesson>`. Report each `needs_person` to
   the user with its reason; never raise a load, an SLO or an environment to make a lesson go away.
3. **Share** (Recall tools available): `perf share --slug <slug>` lists every fact Recall lacks:
   lessons (tool lessons instance-wide, system ones as `defect_pattern` with the project label),
   confirmed decisions, environments, baselines and capacity. Search Recall first for each
   title; when the same fact is there, record its id instead of pushing a duplicate. Push the rest
   with `knowledge_push`, using the listed arguments as they are, then
   `perf share --slug <slug> --pushed <key>=<id>,…`.
   A changed fact comes back with `supersedes_id`: push it as the successor. Without Recall, say
   so; the facts stay pending.
4. If `perf learn` says a lesson was "seen in two projects or more", a draft patch to the skill of
   its step is in `$PERF_HOME/proposals/` (`perf learn` and `perf lessons --global` print its path). Show it and say
   which projects it came from. Apply it to the bundle only when asked (`git apply` in ai-perf).
5. A production incident under load becomes a scenario. Add it to `slo.json` or `workload.json`
   through `/perf-plan`, with source `confirmed` and the incident as the reason.

Show `perf scorecard --slug <slug>`: how many runs each profile needed before one could be judged,
and why. A count that grows from one ai-perf version to the next is a regression of the bundle;
say so.

Gate: `lessons.json` is up to date with the last judged run, every `needs_person` was told to the
user, and every fact is in Recall or marked as local only. Next: the next profile in the plan, or
`/perf-trend`.
