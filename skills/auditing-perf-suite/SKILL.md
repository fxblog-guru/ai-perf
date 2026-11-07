---
name: auditing-perf-suite
description: Use to judge an existing perf suite against perf-standard - scores it, ranks the fixes with evidence lines, and applies a fix only on the owner's approval (/perf-audit).
---

# Auditing a perf suite

Follow [perf-protocol](../perf-protocol/SKILL.md).

1. Run `perf audit --slug <slug>`. It writes `audit.json` and `audit.md`: a score out of 100 for
   each suite, then every finding, most severe first, with its perf-standard rule, the lines that
   show it, and the fix.
   - **High:** a credential in the script (PS-A3); a production host (PS-A1); one account for
     every user (PS-B7); averaged percentiles (PS-D2).
   - **Medium:** nothing that can fail the run (PS-E1); no response checks (PS-B8); no warm-up
     (PS-D1); no think time (PS-B4); unnamed requests (PS-D4).
   - **Low:** a host written in the script; a fixed think time.
2. Read each finding in the file before you report it. The audit reads patterns, so a finding
   can be wrong: drop it and say why, rather than repeat it.
3. Present the ranked fixes to the suite's owner. Apply one only when the owner says yes, as its
   own small change, then run `perf audit` again to show the score move.
4. A high finding blocks running the suite against a shared environment until it is fixed:
   production and credentials first.

Gate: `audit.json` exists and every high finding is fixed or accepted by the owner in writing.
Next: `/perf-plan`, to agree the SLOs the suite will be judged against.
