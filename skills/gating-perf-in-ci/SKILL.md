---
name: gating-perf-in-ci
description: Use to put a performance regression gate in CI - perf ci runs a spec, analyses and judges it, writes JUnit, and exits with the verdict (/perf-ci).
---

# Gating performance in CI

Follow [perf-protocol](../perf-protocol/SKILL.md).

1. The gate is a **smoke** on every merge request: a few users and a short run, against the
   bundled mock or a dev environment its owner allows in `env.json`. A smoke proves the wiring and
   catches a broken build. It never stands in for a load test: CONTRACTS §1 caps it at 10 users
   and 300 s.
2. `perf ci <spec> --junit perf-junit.xml` runs, analyses and reports in one command. Exit codes:
   - 0: PASS or WARN.
   - 1: FAIL, or an internal error.
   - 2: the spec was refused (production, a foreign host, a secret, a missing engine).
   - 3: NOT EVALUABLE. Treat it as a failed job: an unjudged build is not a green build.
3. A smoke is judged on failures and failed checks only: it never reads a baseline.
4. A load profile belongs in a scheduled job (nightly or pre-release) on an authorised
   environment, not on every merge request. Estimate its cost first (protocol rule 6). Its first
   run has no baseline:
   - Run it once with `--bootstrap`.
   - Review the result, then run `perf report --bootstrap --promote`. Without `--bootstrap`, the
     missing baseline makes it NOT EVALUABLE, and that cannot be promoted.
   - Never let CI promote on its own.
   - After a change to the workload, architecture, environment, script or data, the baseline is
     STALE. Promote a new one the same way.
5. `perf ci` judges the run it started, even when another run of the same slug starts while it
   is running.
6. `ci/gitlab-ci.perf.yml` is a sample job: copy it into the project's pipeline. Do not push it to
   a shared pipeline repository unless its owner agrees.

Gate: the job exits with the verdict, and `perf-junit.xml` is kept as a report artifact.
Next: `/perf-trend` once a few runs have been judged.
