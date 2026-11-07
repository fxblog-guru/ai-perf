---
name: perf-protocol
description: Rules every ai-perf skill follows - files, gates, asking, safety, cost, the next-step line. Read before any /perf-* step.
---

# ai-perf protocol

`perf` below is `node <ai-perf>/bin/perf.mjs --root <project root>`. `<ai-perf>` is `.claude/ai-perf`
in a project installed with `npx agentic-fx`, else the ai-perf checkout. Project files live in
`.perf/<slug>/` (CONTRACTS §8). A step reads the files of the steps before it. It never guesses
what they say.

## Rules that never bend

1. **Code does safety and speed; you do explanation and judgment.** Never poll a run yourself.
   `perf watch` wakes you. Never compute a percentile, a rate or a verdict by hand. `perf analyze`
   and `perf report` compute them; you explain them.
2. **Gates are the product.** Each step ends with `perf check <step> --slug <slug>`. A failing gate
   means you fix the file, or you ask. Never weaken a check, a threshold or an allowlist to make it
   pass. A FAIL verdict is a finding, not a problem to hide.
3. **Never production.** `env.json` names who owns each environment and which profiles it allows.
   Loading a system the user does not own needs the owner's written yes, recorded in `env.json`
   `owner`.
4. **Ask last** ([asking policy](../discovering-the-system/references/asking-policy.md)): read,
   then measure, then default, then ask. At most 3 questions per step. Each question has a
   proposed answer. Every value nobody confirmed goes into `assumptions.json`, and the verdict
   names it.
5. **No number without its source.** Every number in `slo.json` and `workload.json` carries a
   `source`: `contract`, `measured`, `confirmed`, `imported`, `assumed` or `default`.
6. **Estimate cost first.** Before a run, state its length, its worker count and its expected
   wakes (tokens). Before a long soak, get a yes.
7. **Scale to the system (P3).** A small API gets one profile and one table. Do not build a
   capacity study nobody asked for. A single machine with one protocol and a short run is stlc's
   light tier: say so.

## Every step ends with

- the gate output, and
- one line: `next: <command>, <why>`. `perf help --slug <slug>` gives it from the files.

## Memory: load, learn, share

**Load first, cheaply.** Start every step with `perf brief --slug <slug> --step <step>` (`plan`,
`model`, `env`, `data`, `script`, `run` or `analyze`). It is one capped page (about 1500
tokens, whatever the history): the system, what was decided, what was measured, the fixes in
effect, the lessons for this step and what the team already knows. Open a project file only when
the brief points you to it or the step writes it. Act on each lesson in it; say which ones.

**Learning is automatic.** Every judged run (`perf report`, `perf ci`, `perf run
--until-evaluable`) updates the lessons, the fixes, the scorecard and the brief. Nobody has to
call `/perf-learn`. A lesson about running the tool whose fix touches only the load generator
(more workers, a longer rampdown, a higher VU cap) is fixed by ai-perf in the next run of that
profile, and the run after checks the fix: `verified`, or `recurred`. A lesson about running the
tool with no such fix, or whose fix recurred twice, says "needs a person": tell the user, never
work around it. A lesson about the system under test is the test's finding: report it, never
"fix" it by changing the load, the SLOs or the environment. When a verdict says "seen before", start the explanation there.

**Share with the team (Recall).** When the Recall tools (`knowledge_search`, `knowledge_push`)
are available:
- at the start of work on a project, search Recall for the project label and for "ai-perf", save
  the results as JSON and run `perf share --slug <slug> --import <file>`: they join the brief;
- after each judged run, `perf share --slug <slug>` lists the facts Recall does not have yet,
  each the arguments of one `knowledge_push` (with `supersedes_id` when it replaces an entry).
  Push each, then record them: `perf share --slug <slug> --pushed <key>=<recall id>,…`.
Without Recall, say so once; everything stays in `.perf/<slug>/` and `~/.ai-perf/`.
