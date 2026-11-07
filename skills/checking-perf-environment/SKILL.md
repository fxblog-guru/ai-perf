---
name: checking-perf-environment
description: Use to decide where load may go - environments, owners, allowed hosts and profiles, third-party stubs, parity and monitoring (/perf-env).
---

# Checking the environment

Follow [perf-protocol](../perf-protocol/SKILL.md). Write `.perf/<slug>/env.json`. This file, not a
run spec, decides what may be loaded:

```json
{ "environments": { "staging": {
    "allow_hosts": ["api.staging.example.com"],
    "allowed_profiles": ["smoke", "load", "stress"],
    "owner": "platform team, approved by J. Doe 2026-10-30",
    "parity": "half of production: 2 of 4 nodes, same DB size",
    "third_party": [{ "name": "payments", "stubbed": true }, { "name": "sms", "stubbed": true }],
    "monitor": { "metrics": "docker-stats", "containers": ["shop-api", "shop-db"], "interval_s": 5 } } } }
```

1. **Owner**: who said yes to load on it, and when. No owner means no load: ask. For any host
   other than this machine, record the yes as `approval: { "by": "<name>", "at": "<ISO date>",
   "hosts": ["<host>"] }`. `perf run` refuses a host it does not cover, and refuses an approval
   older than 90 days.
2. **Hosts and profiles**: list exactly what may be hit. Heavy profiles only where load is
   authorised (PS-A2). Never mark production as a target. `perf run` refuses a host or a name
   that looks like production, whatever this file says.
3. **Third parties** (payments, email, SMS, maps): each must be stubbed or mocked. The gate and
   `perf run` refuse an unstubbed one, because loading it costs money or breaks its terms.
4. **Parity**: how close the environment is to production. The verdict quotes it, so numbers from
   a smaller environment are read as indicative.
5. **Monitoring**: watch the target, or the verdict can only guess where it broke. A target in
   Docker: `"monitor": { "metrics": "docker-stats", "containers": [...] }`. A target running on
   this machine (`npm start`, a JAR, a local Postgres): `"monitor": { "metrics": "host-process",
   "processes": [{ "name": "api", "port": 8080 }, { "name": "db", "match": "postgres" }] }`, by
   port, pid or command line. It must be running before the run; if it dies under load, the run
   stops and fails. A soak needs one of them: it judges the target's memory. With `none`, the
   analysis cannot tell CPU-bound from waiting, and it says so.
6. **Signals**: CPU says "busy" or "not busy"; it cannot say what the target waits on. Most
   bottlenecks are a full pool, locks, GC or a blocked event loop, so read them when the system
   exposes them (CONTRACTS §1b). Look in the repo first: a `/metrics` route, prom-client,
   Micrometer, prometheus-net, a `postgres_exporter` or `mysqld_exporter` in compose, a
   Prometheus in the platform. Add one signal per likely wait, not every metric:

   ```json
   "signals": [
     { "name": "db_pool", "kind": "pool_used_pct", "prometheus": "http://prometheus:9090",
       "query": "100 * sum(hikaricp_connections_active) / sum(hikaricp_connections_max)" },
     { "name": "pool_wait", "kind": "pool_waiting", "scrape": "http://127.0.0.1:8080/actuator/prometheus",
       "metric": "hikaricp_connections_pending" },
     { "name": "loop", "kind": "event_loop_lag_ms", "scrape": "http://127.0.0.1:3000/metrics",
       "metric": "nodejs_eventloop_lag_p99_seconds", "scale": 1000 },
     { "name": "gc", "kind": "gc_time_pct", "scrape": "http://127.0.0.1:8080/actuator/prometheus",
       "metric": "jvm_gc_pause_seconds_sum", "counter": true, "scale": 100 },
     { "name": "row_locks", "kind": "db_locks_waiting", "scrape": "http://127.0.0.1:9104/metrics",
       "metric": "mysql_global_status_innodb_row_lock_current_waits" }
   ]
   ```

   **Units.** A signal is compared with its kind's limit in the kind's unit: `%` for
   `pool_used_pct` and `gc_time_pct`, `ms` for `event_loop_lag_ms`, a count for the rest.
   Most exporters give seconds or ratios, so set `scale`:
   - seconds to ms: `"scale": 1000`;
   - a ratio (0 to 1) to %: `"scale": 100`;
   - a counter of seconds (`_sum`) with `"counter": true` is seconds per second, so
     `"scale": 100` gives % of the time. A `_pct` kind refuses a counter without a scale.

   A signal in the wrong unit can never cross its limit, and the analysis would then call it
   quiet. Check the doctor's reading: `gc 0.02` for a GC kind means the scale is missing.

   | Stack | Pool | Wait, lag or GC (scale) |
   |---|---|---|
   | Java (Spring, HikariCP) | `100 * hikaricp_connections_active / hikaricp_connections_max` (query) | `hikaricp_connections_pending`; `jvm_gc_pause_seconds_sum` (counter, 100) |
   | Node (prom-client) | the driver's own gauge, if any | `nodejs_eventloop_lag_p99_seconds` (1000); `nodejs_gc_duration_seconds_sum` (counter, 100) |
   | .NET (prometheus-net) | the driver's own gauge, if any | `dotnet_threadpool_queue_length`; `dotnet_gc_pause_ratio` (100) |
   | Postgres (`postgres_exporter`) | `100 * sum(pg_stat_activity_count) / max(pg_settings_max_connections)` (query) | locks waiting: none by default (`pg_locks_count` counts locks held, not waits). Add a custom query to the exporter: `SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'`, and scrape the metric it makes |
   | MySQL (`mysqld_exporter`) | `100 * mysql_global_status_threads_connected / mysql_global_variables_max_connections` (query) | `mysql_global_status_innodb_row_lock_current_waits`; `mysql_global_status_slow_queries` (counter) |

   A ratio or a sum needs a Prometheus query; a single metric can be scraped directly. A counter
   (`_total`, `_sum`, `_count`) needs `"counter": true`. A token goes in an environment variable
   named by `auth_env`, never in the URL. Run `/perf-doctor` with the spec: it reads every
   signal once, shows each value, and warns about each one that does not answer. `perf run`
   prints the same warnings and goes on.

Gate: `perf check env --slug <slug>`. Next: `/perf-data`.
