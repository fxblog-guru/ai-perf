---
name: importing-perf-suite
description: Use when a project already has a perf suite (k6, Locust, Gatling, JMeter) - reads it into draft project files and run specs, keeps it as it is (/perf-import).
---

# Importing a perf suite

Follow [perf-protocol](../perf-protocol/SKILL.md). The suite belongs to its team: read it, run it,
improve it only on approval (`/perf-audit`). Never rewrite it to fit ai-perf.

1. Run `perf import --slug <slug>`. It reads every suite `/perf-discover` found:
   - operations (request names), weights, think time and peak users;
   - thresholds or assertions, which become SLO drafts;
   - old results (k6 `--summary-export`, Locust `--csv` stats, `perf-result/v1`).

   It writes `import.json`. It writes `workload.json` and `slo.json` only where the project has
   none, with `source: imported`. For each suite whose engine ai-perf runs (k6, Locust), it writes
   `run-<engine>.json`.
2. Old results are reference, never a baseline: another tool and an unknown environment are not
   comparable (PS-F3). Quote them in the plan as "what the team saw before".
3. A suite whose requests have no names (ids in URLs) fails the gate: results would split per id.
   Name the requests in the suite (with the owner's approval) or list the operations in
   `workload.json` yourself.
4. An in-house load script is listed, not run or parsed. Keep it as the team's own check, take
   its operations and budgets from the contract (`perf contract`), and compare its numbers with an
   ai-perf run of the same operations at the same concurrency (a parity run).
5. A Gatling or JMeter suite is read and its results imported; ai-perf does not run it yet. Say
   so, and run the scenarios through k6 or Locust only if the owner wants that.
6. Imported SLOs are the suite's thresholds, not agreed SLAs. The verdict marks them until an
   owner confirms them in `/perf-plan`.
7. Set `target_url` in each run spec to an allow-listed host (`/perf-env`) before the first run.

Gate: `perf check import --slug <slug>`: every suite names its operations, and is runnable or
says why not. Next: `/perf-audit`.
