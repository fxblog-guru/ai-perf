# M2 evidence: the five pillars

Design §13 says each pillar needs a mechanism and a check that can fail. This file maps each
check to the test that enforces it and to the mutant that proves the test can fail. A mutant
disables the guard in the source; `npm run mutate` fails if the test still passes.

Status:
- **met**: a test enforces the check and its mutant is killed.
- **partial**: the mechanism exists but its check is narrower than §13 asks.
- **later**: the mechanism is in a later milestone and nothing here claims it.

## P1 Intelligence

| Check | Status | Enforced by | Mutants |
|---|---|---|---|
| An exam of known-answer cases: the analysis names the cause | met | `tests/exam.test.mjs`: 7 bottleneck cases (CPU-bound, waiting, unmonitored, saturated generator twice, no knee, throughput still growing) and 9 failure-class cases | `exam: knee needs flat throughput`, `exam: saturated generator first`, `exam: unmonitored is unknown`, `analyze: knee`, `analyze: waiting vs hot`, `analyze: 5xx is app` |
| When the evidence is missing, the analysis says "unknown" rather than guessing | met | exam case "target not monitored → resource unknown" | `exam: unmonitored is unknown` |
| Percentiles merged from histograms, never averaged | met | `tests/unit.test.mjs`, `tests/locust.test.mjs` (Python and Node agree on every bucket) | `merge adds counts`, `percentile rank`, `merge histograms` |
| Leak or GC drift at constant load ("latency grows over hours") | later (M4, soak and trend) | the symptom table in `skills/analyzing-perf-results/references/bottlenecks.md` lists it; no detector yet | none |

## P2 Memory & Learning

| Check | Status | Enforced by | Mutants |
|---|---|---|---|
| The second run cites the first run's baseline | met | `report: the second run cites the first run as its baseline` | `verdict: cites its baseline`, `verdict: p95 regression`, `verdict: systemic scope` |
| An answer is never asked again; a confirmed value is never downgraded | met | `discover: an answer is never asked again…`, `discover: a value confirmed later…is never downgraded` | `discover: confirmed stays confirmed` |
| A baseline is kept only from a run that passed, and only compared like with like | met | `promote refuses a run that did not pass`, refusals for another profile and another load tool | `verdict: promote guard`, `verdict: refuse other baseline`, `verdict: refuse other tool` |
| Lessons written to Recall and read at the start of each step (`/perf-learn`); runs-to-correct-result per version | later (M4) | none | none |

## P3 Judgment & Integrity

| Check | Status | Enforced by | Mutants |
|---|---|---|---|
| Asking policy: at most 3 questions, each with a proposed answer; an API description answers the operations question | met | `tests/lifecycle.test.mjs` discover tests | `discover: at most 3 questions`, `discover: api answers operations` |
| Drop the SLO → not PASS | met | `no slo.json` gives NOT EVALUABLE | `verdict: unmeasured`, `verdict: plan SLOs replace defaults` |
| Kill a worker → not PASS | met | `tests/faults.test.mjs` (crash, late death, all lost) | `lost worker degrades`, `worker loss detected`, `no stop ack is lost` |
| Saturate the generator → not PASS | met | faults: saturated generator gives NOT EVALUABLE, including without steady | `saturation detected`, `saturation outranks degraded`, `saturation without steady` |
| Mismatch the environment, profile or load tool → not compared | met | baseline refusals (PS-F3, other tool) | `verdict: refuse other baseline`, `verdict: refuse other tool` |
| A frozen worker is reported, not quietly caught up | met | `a worker that freezes sends no catch-up load…` | `stall not caught up`, `stall degrades` |
| Unconfirmed assumptions and unagreed SLOs are printed with the verdict | met | verdict notes, lifecycle tests | `verdict: plan SLOs replace defaults` |
| A hung target cannot inflate throughput: rates count windows in which nothing completed | met | `a target that completes nothing for a window…` | `rate over planned windows`, `no measured window said` |
| A NOT EVALUABLE run is sent back to be fixed, never on to the next profile | met | `help: a NOT EVALUABLE verdict sends you to fix the run…` | `help: not evaluable is fixed first` |
| Wake budget: the AI is not woken for every event | met | `watch: with the wake budget spent…` | `watch: info never wakes`, `watch: budget` |

## P4 Verification & Safety

| Check | Status | Enforced by | Mutants |
|---|---|---|---|
| A gate at every step | partial: plan, model, env, data and script (smoke) gates exist; import and audit gates come with M3 | `every gate passes…`, gate tests | `gate: *` (8 mutants) |
| Production refused, by name, by prefix and by host | met | faults and unit tests | `production refused`, `production prefix`, `production host`, `production host label`, `gate: env production` |
| Only allow-listed hosts and allowed profiles; third parties stubbed | met | spec tests | `allowlist`, `allowlist not in spec`, `profile allowed by env`, `third party stubbed` |
| A smoke is a shape (at most 10 users, 300 s), so a load run cannot pass as one | met | `"smoke" is a shape…` | `smoke is a shape` |
| Monitoring that fails is reported at once and the run cannot end done | met | `a container that yields no metrics…` | `unmonitored degrades`, `unmonitored warns at once` |
| An owner who authorises the load is named | met | `gate: env owner` | `gate: env owner` |
| Hard auto-stop stops an over-limit run in time | met | error storm stopped within 0.5 s + 3 s slack; generator CPU; target CPU from docker-stats | `auto-stop wired`, `error-rate limit`, `min requests`, `cpu sustained`, `rules: target cpu gap` |
| No secrets in scripts, run files or evidence | met | `tests/doctor.test.mjs` (the load script wherever it lives, sampled errors in `raw/`); credentials in the URL refused; the Locust shim masks error text | `secret: script scanned`, `secret: raw errors scanned`, `shim: secrets masked`, `secret: bearer`, `secret: env refs pass`, `secret: url credential`, `credential in url`, `run folders scanned` |
| No orphan processes: lost heartbeat stops workers and containers | met | `tests/kill.test.mjs`, docker heartbeat test | `worker heartbeat stop`, `orphans reported`, `lost controller reported` |

## P5 Value & Experience

| Check | Status | Enforced by | Mutants |
|---|---|---|---|
| Quick Start tested on a clean copy | met, with one gap: it runs on a clean copy of the repo on the development machine, not on a fresh machine | `tests/quickstart.test.mjs` runs the README's commands as written (demo 2 runs when Locust is installed) | `quickstart: README demo 1 bootstraps` |
| One command to start; the next step is always named | met | `help: walks the lifecycle from nothing to a verdict` | none: the walk itself is the test |
| A verdict a business owner can read | partial | `verdict.md` gives one outcome, a table per transaction, the baseline compared, and a "Read with care" list; nobody outside the team has read one yet | none |
| Cost estimated before the run; estimated vs actual recorded; a large gap warns | met for run time | `report: estimated vs actual run time is recorded; a large gap warns` | `verdict: cost gap warns` |
| Cost in tokens and cloud spend | later (M4; cloud targets come after local) | none | none |
| A new engine needs no change to the flow ("adding k6 changes no skill", measured by diff) | later (M3, k6 adapter) | M2 added Locust with no change to the flow skills; M3 records the diff for k6 | none |

## Found while doing this audit

- **Integrity bug, fixed.** A baseline measured with the fake engine was silently compared with a
  Locust run, and the README promised that comparison. Numbers from two load tools are not
  comparable, so the verdict now refuses it as NOT EVALUABLE. The fake engine's simulated numbers
  are no longer promoted in the Quick Start.
- **Three checks were not tested** (surviving mutants):
  - `discover: confirmed stays confirmed`;
  - `watch: budget`;
  - `rules: target cpu gap`. Its old mutant was equivalent, because `Math.min` over a null sample
    never trips a limit, so it now mutates to the realistic bug: judging only the samples that
    are present.

  Each one now has a test that kills its mutant.
- The README did not say how to point ai-perf at a Python that has Locust (`PERF_PYTHON`).
- The independent review then found eight more defects, five of them against P3 or P4. All are
  fixed and listed in the tables above; details are in `docs/evidence/m2-review.md`.
