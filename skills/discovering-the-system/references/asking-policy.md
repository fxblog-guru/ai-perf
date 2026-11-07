# Asking policy

Most people cannot answer "what is your p95 target?". Asking too much makes them quit or guess.
So every fact goes through four tiers. Only the last tier is a question.

| Tier | Source | Examples |
|---|---|---|
| 1. Read | repo, configs, `x-perf`, OpenAPI, compose, IaC, existing perf suites | endpoints, datastores, autoscaling, stack |
| 2. Measure | a one-user smoke; logs and analytics you can read | current latency, the real traffic mix |
| 3. Safe default | defaults per system kind (`perf discover` applies them) | read-heavy web p95 < 500 ms, error < 1 %; realtime tick lag < 50 ms |
| 4. Ask | what no machine can know | expected peak, upcoming events, past incidents |

## Rules

- At most **3 questions** per step, the ones that change the result most.
- Every question has a **proposed answer**: "Enter to accept" is the common path.
- Multiple choice before free text.
- Ask at the step that needs the answer, not everything up front.
- Business questions in business words: "how many people at the sale's peak", not "what arrival
  rate".
- **"Don't know" is a valid answer.** The default is used and logged in `assumptions.json` with
  its source, confidence and impact if wrong.
- Never ask what the repo, `context.json`, an earlier answer or Recall already holds.
  `perf discover --answer key=value` records an answer, and it is never asked again.

## Assumptions

`assumptions.json` holds `{ key, value, source, confidence, impact, status }`. The verdict names
every assumption whose status is not `confirmed`. A confirmation (`--answer`) promotes it, and the
conclusions that used it are re-run.
