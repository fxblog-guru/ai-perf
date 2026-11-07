---
name: discovering-the-system
description: Use to understand a system before testing its performance - reads the repo, logs assumptions, asks at most three questions (/perf-discover).
---

# Discovering the system

Follow [perf-protocol](../perf-protocol/SKILL.md) and the
[asking policy](references/asking-policy.md).

1. Run `perf discover --slug <slug>`. It scans the repo:
   - the API description and its `x-perf` budgets;
   - compose services and datastores;
   - the stack;
   - realtime libraries;
   - existing Locust, k6, JMeter and Gatling suites, and in-house load scripts (a script in a
     `perf`/`load`/`stress`/`bench` folder, or named so, that sends requests);
   - an sdlc contract.

   It writes `context.json`, `context.md` and `assumptions.json`, and returns at most 3 questions.
2. With an sdlc contract, also read
   `node <sdlc>/scripts/api-contract-check.mjs <slug> --load-plan --json`. Its budgets and load
   plan become `source: contract` values in later steps.
3. Read what the scan cannot: the README, the architecture docs, and how the system scales
   (cache, CDN, autoscaling, queues). Note each finding in `context.md` with the file it came
   from.
4. Ask the returned questions together, each with its proposed answer. Record every answer with
   `perf discover --slug <slug> --answer key=value`. "Don't know" stays an assumption.
5. Past incidents under load, if any, become the first scenarios in `/perf-plan`.

Gate: `context.json` exists, and `perf discover` reports no unanswered question you could have
answered from the repo. Next: `/perf-plan` (`perf help` names `/perf-import` instead once that
command exists, in M3; until then plan alongside the existing suite and reuse its scenarios).
