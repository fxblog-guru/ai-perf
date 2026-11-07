# M13 evidence: the target's own signals

Luan asked what ai-perf covers of performance testing, and for what it lacks to be built.
[`docs/coverage.md`](../coverage.md) maps the whole field and ranks the gaps. The largest gap
came first. Until M13 the analysis saw only the target's CPU and memory. So at a knee it could
say "not CPU", but not what the target waited on: a full connection pool, locks, GC, or a late
event loop. Most bottlenecks are one of those.

## Design

```
env.json monitor.signals ──▶ doctor reads each once (warn) ──▶ perf run prints the warnings
        │
        ▼  every interval_s, never waited for
 /metrics (Prometheus text)  or  Prometheus /api/v1/query
        │  sum of matching series · counter → rate · × scale
        ▼
 monitor/target.ndjson  { name: "signal", value, unit, labels: { signal, kind } }
        │
        ▼  perf analyze
 knee? ─▶ a signal over its limit at the knee, that got there with the load ─▶ "waiting on …"
        ─▶ over all along ─▶ said, not the cause      ─▶ under its limit ─▶ ruled out by name
        ─▶ never read ─▶ never claimed quiet; problem signal_missing; lesson for the env step
```

- **Two sources, one shape.** `scrape` reads an app's or an exporter's `/metrics`. It filters
  the series by `match` and sums them; an absent metric is no reading, never 0. `prometheus`
  runs an instant query, for ratios and sums.
- **Kinds carry meaning and a default limit**: `pool_used_pct` 95, `pool_waiting` 0,
  `db_locks_waiting` 0, `db_slow_queries` 0, `gc_time_pct` 10, `event_loop_lag_ms` 100,
  `thread_pool_queue` 0. `queue_depth` and `custom` need `above`.
- **Units are explicit.** `scale` turns seconds into ms or a ratio into %. A counter of a `_pct`
  kind without a scale is refused, because it could never cross its limit.
- **A cause must have come with the load.** A signal over its limit at the knee is the cause only
  if it was within its limit earlier in the loaded run, or is higher now than ever before. A lock
  held since the start did not make latency break at this load.
- **The load is never at stake.** A failing signal is one `anomaly`. A signal with no sample is
  the problem `signal_missing`. Neither changes the run's state.
- **No credential leaves.** A URL with a user, a password or a token in its query string is
  refused, as `target_url` is. URLs are shown without user, password or query. Errors are
  scrubbed.

## What was tested

`tests/signals.test.mjs`, 16 tests:

| Case | Result |
|---|---|
| Exposition | labels with escaped quotes, commas, braces; `C:\\new` kept; timestamps; NaN dropped; a prefix is not the metric; absent is null |
| Prometheus | vector summed; scalar read; error, empty and matrix give no value; a server behind a path keeps it |
| `env.json` checks | each mistake named: both sources, unknown kind, a custom kind without a limit, bad URL, credentials in user info and in the query, a query string on a Prometheus URL, scale ≤ 0, a `_pct` counter without a scale, unknown key, and more; a bad signal refuses the run |
| Reading | scrape and query from a live mock; a 404, a dead port and a missing metric are errors, never throws; a bearer token only from the variable `auth_env` names; a credential in a URL never in the error |
| Counters and scale | first reading and a reset give no sample; (100 − 40) / 2 s = 30/s; 0.25 s × 1000 = 250 ms; GC seconds per second × 100 = 30 %; +Inf is an error, not a null in the file |
| Exam | a pool full at the knee is the cause, with "100 % > 95" and the quiet signal named; exactly at the limit is not over; a custom limit wins; quiet signals rule themselves out while an unread one is not claimed; over long before the knee is not the cause; a lock held all along is said ("over their limits before latency broke") and the CPU decides; the same lock rising is the cause; the generator still comes first |
| End to end | a staircase against a target capped at 70 rps (fake engine `max_rps`) with a pool that fills during step 2: the knee names `db_pool`, with the Signals table. A quiet pool and a dead GC endpoint: the pool is ruled out, the GC said once as an `anomaly`, `signal_missing` raised, the run `done`, `perf run` printed the warning, the lesson went to `env`. A counter read once: "one reading only; a counter needs two" |
| Doctor | a dead signal and an unset token warn, with the URL shown clean; a live one shows its value |

## The independent review

A reviewer who had not written the code read the change, reproduced several findings with
scripts, and found 12. All are fixed, each with a test and a mutant.

| # | Finding | Fix |
|---|---|---|
| 1 | Exporters give seconds and ratios, but kinds compare in ms and %. The recommended metrics could never cross their limits, so the analysis ruled them out by name | `scale`; a `_pct` counter needs one; the skill's examples and table give the scale for each metric |
| 2 | A signal over its limit the whole run was named the cause, even ahead of a 99 % CPU | the cause must have come with the load; one over all along is said apart, and the CPU decides |
| 3 | A token in a URL's query string was accepted and printed by the doctor | the `target_url` rule applies; shown URLs drop the query string |
| 4 | With a cause found, the quiet signals were not named as ruled out, as the contract said | named in both cases |
| 5 | README and design said v0.12.0 and linked this file before either existed | version bumped; this file |
| 6 | A counter read once was reported as never answering | answered and sampled are tracked apart; the problem says "one reading only" |
| 7 | `perf run` read the signals in its quick doctor and dropped the warnings | printed, and the run goes on |
| 8 | Label escapes undone in two passes turned `C:\\new` into a newline | one pass |
| 9 | +Inf became `null` in the file and vanished | an error, said once |
| 10 | A dead regex left a double space for unitless signals, and a test locked it in | formatting fixed, test corrected |
| 11 | `pg_locks_count` counts locks held, not waits, and was recommended for `db_locks_waiting` | the skill says so and gives a query on `pg_stat_activity` waits, and MySQL's row-lock waits as the example |
| 12 | A Prometheus behind a path, or with a query string, broke the API URL | the path is kept; a query string is refused |

The reviewer also confirmed that signals cannot come from a run spec (the environment replaces
`spec.monitor`), and that no signal can crash or hang the controller or change the run's state.

## Checks

- `npm test`: 309 tests, 308 pass. The one failure, "host-process: a soak watches the process
  memory", is the known load flake from M12: Windows takes about 2 s per process snapshot, and on
  a loaded machine the soak window got no memory sample. It does not use signals; run alone it
  passed twice.
- Mutation: 444 mutants in all, none stale. The 34 for M13 (22 for the mechanisms, 12 for the review
  fixes) are all killed, and so are the 23 older ones on the files M13 rewrote (`analyze`, the fake
  engine, `learn`). One older anchor moved by the fake engine's `max_rps` was retargeted. The first
  M13 run found 5 anchors moved by the review fixes; they were retargeted and killed.
- **Not tested:** a real Prometheus, real exporters (`postgres_exporter`, HikariCP, prom-client).
  The text format and the query API are checked against a mock that speaks them. The metric names
  in the skill come from those exporters' documentation; a project confirms them in `perf doctor`,
  which shows each value it read.
