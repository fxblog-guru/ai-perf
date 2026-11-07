---
name: reporting-perf-verdict
description: Use to give the verdict - PASS, WARN, FAIL or NOT EVALUABLE against SLOs, SLAs and the baseline, with the assumptions it rests on (/perf-report).
---

# Reporting the verdict

Follow [perf-protocol](../perf-protocol/SKILL.md).

1. Run `perf report --slug <slug>`. It writes `verdict.json` and `verdict.md`. Outcomes:
   - **PASS**: every SLO met.
   - **WARN**: an SLO missed, its SLA met.
   - **FAIL**: an SLA breached, a regression against the baseline (p95 up > 10 % and > 5 ms,
     errors up > 0.5 pp, throughput down > 10 %), or the target failing under load.
   - **NOT EVALUABLE**: a degraded or saturated run, a planned transaction never measured, no
     baseline, or a baseline from another environment or profile.
2. First load run of a project: `--bootstrap` judges on SLOs only and says so. `--promote` makes a
   done PASS or WARN run the baseline; nothing else is promoted.
3. Write the human summary on top of `verdict.md`, for the owner, in plain words:
   - the headline, e.g. "Handles 200 shoppers within target; checkout is 30 % slower than last
     release";
   - the cause from `/perf-analyze`;
   - for stress or capacity runs, capacity and headroom: users at the knee against expected peak;
   - what to do next.
4. Keep every "Read with care" line: unconfirmed assumptions, SLOs not agreed with an owner,
   environment parity, target not monitored. Never present an assumed number as a fact.

Next: a fix and a rerun (`/perf-run`, then compare), the next profile, or done.
