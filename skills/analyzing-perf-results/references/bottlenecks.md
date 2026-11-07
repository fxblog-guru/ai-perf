# Symptom → likely bottleneck

`perf analyze` finds the knee and reads the target's CPU, and its signals when the environment
lists them (CONTRACTS §1b). A signal above its limit at the knee is evidence: the hint starts
"waiting on" and names it. Otherwise this table turns the evidence into the first place to look.
A hint without a signal is a hypothesis: confirm it with the target's own metrics or traces
before you file it, and add the signal that would have shown it to `env.json`.

| Signal over its limit at the knee | What it means | Next |
|---|---|---|
| `pool_used_pct`, `pool_waiting` | requests waited for a pool connection | the pool size against the users at the knee; slow queries holding connections |
| `db_locks_waiting` | transactions waited on each other | the hot rows; transaction length; lock order |
| `db_slow_queries` | the database ran slow queries under load | the query plan; a missing index; data volume |
| `gc_time_pct` | the runtime spent its time collecting garbage | allocation per request; heap size; a leak if it grows over a soak |
| `event_loop_lag_ms` | synchronous work blocked a single-threaded server | the blocking call (JSON of large bodies, crypto, sync I/O) |
| `thread_pool_queue` | work queued for a thread | blocking calls on pool threads; the pool size |
| `queue_depth` | consumers fell behind producers | consumer count and speed; the slowest step per message |

| Symptom | Likely cause | Confirm with |
|---|---|---|
| p95 rises with load, target CPU > 85 % | CPU-bound: hot code path, serialization, missing cache | profiler or flame graph at the knee |
| p95 rises with load, target CPU low | waiting: DB connection pool, locks, a slow dependency, I/O | pool wait metrics, DB slow log, dependency latency |
| Latency steps up at one load level and stays | a pool or queue hit its size | pool size vs users at the knee |
| Latency grows over hours at constant load | leak: memory, connections, file handles; GC pressure | memory over time, GC logs, open connections |
| Errors `HTTP 503` or `429` at load | throttling or a circuit breaker opened | gateway or limiter config |
| Errors `HTTP 500` only at load | race, deadlock, a resource exhausted under concurrency | app logs at the error's correlation id |
| Errors `HTTP 4xx` | the script or its data is wrong, not the system | the sampled request |
| Timeouts or connection errors | network, a full accept backlog, an exhausted port range | target socket stats; the generator's ports |
| p95 high but throughput is flat for all levels | the generator is the limit | generator CPU (`generator_saturated`) |
| Tick lag rises with players online, round trips fine | the game loop is CPU-bound: simulation or broadcast cost grows with players | server tick duration, CPU per room |
| Drops at a player count, then reconnects | a connection limit, an idle timeout, or a load balancer cutting long-lived sockets | server connection count, LB idle timeout, file-descriptor limit |
| Players online fall below the plan and do not come back | reconnects are refused or rate-limited | server logs at the drop time; the reconnect backoff |
| `generator_saturated` with an event loop late | the load generator, not the server: its timestamps are late | the player script (busy loops, synchronous work); fewer players per worker |
| One endpoint regressed, others fine | localized: that code path changed | diff of the build for that path |
| Every endpoint regressed | systemic: infrastructure, a shared dependency, the environment | environment changes, shared DB, node size |

## One-sentence cause (PS-H2)

> At **<load>**, **<transaction>** p95 went from **<a>** to **<b>** because **<resource>**
> **<what happened>**, shown by **<evidence>**.

If the evidence does not support that sentence, the cause is "not established". Say so.
