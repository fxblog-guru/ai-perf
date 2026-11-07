# ai-perf contracts

Versioned with the bundle. Renaming or removing a key, state, event type or exit code is MAJOR; a new
optional key, event type or adapter is MINOR; wording is PATCH. The design behind these is in
[docs/design.md](docs/design.md).

## §1 Run spec (`perf run <spec.json>`)

| Key | Default | Rule |
|---|---|---|
| `slug` | — | `^[a-z0-9][a-z0-9-]*$` |
| `engine` | `fake` | a key of `ENGINES` in `adapters/index.mjs` |
| `target` | `local` | a key of `TARGETS` |
| `workers` | `1` | integer ≥ 1 |
| `target_url` | — | a URL whose host is in the environment's `allow_hosts` (§1a, PS-A1); no user:password, no token in the query; a host with a label starting `prod` or `prd` (but not `product`) is refused |
| `script` | — | required for every engine but `fake`: the engine script, a path from the project root that must exist |
| `environment` | `local` | a key of `env.json` `environments` (§1a); its hosts, profiles, stubs and monitor apply. A name starting with `prod` or `prd` (`prod1`, `Prod EU`, `production2`), except `product…`, or `production: true`, is refused |
| `profile` | — | `name`, `users` > 0, `warmup_s`, `ramp_s`, `steady_s`, `rampdown_s` ≥ 0, total > 0; optional `warmup_users` (default 10 % of `users`, at least 1; an explicit 0 stays 0). **Open model**: `arrival_rps` (> 0) starts that many requests or iterations per second whatever the server does, with `warmup_rps` (default 10 %) and the same phases; `users` is then the cap on concurrent virtual users. Only engines in `OPEN_MODEL` (`k6`, `fake`) run it; another engine is refused. Arrivals k6 drops in steady (every VU busy) from 1 % of the planned ones are `arrival_shortfall`, and the run is degraded. A steady phase must hold at least one `window_s`. **Staircase** (stress, capacity): `steps` (at least two ascending numbers: users, or arrivals per second in the open model) and `step_s` (> 0, a whole number of `window_s` and at least two: one to settle, one to measure). The ramp goes to the first step, each step is held `step_s`, `steady_s` becomes `steps × step_s`, and `users` (or `arrival_rps`) becomes the top step. **Spike**: `spike: { users | arrival_rps, at_s, for_s }`, `at_s` and `for_s` whole numbers of `window_s`, at least two windows of steady before it and two after it; load jumps to the spike at `steady + at_s` and back after `for_s`. A profile has steps or a spike, not both. `profile.model: "open"` with `steps` makes the steps arrival rates; an engine that runs only closed loops is refused. `steps` sets `steady_s` and `users` (or `arrival_rps`); values given for them are replaced. On an open spike, `users` is the VU cap and must cover the spike. k6 stages and the Locust shim follow both shapes exactly. A profile named `smoke` is at most 10 users and 300 s in total. **Recovery**: a profile named `recovery` needs its overload, given as a spike shape (`spike`); `users` (or `arrival_rps`) is the normal load before and after it. `perf run` sets `overload_grace: { from_s, to_s }` from the start of the overload to its end plus the recovery budget (`slo.json` `recovery.recovery_s`, else `spike.recovery_s`, else 30 s) or the longest auto-stop rule's `for_s`, whichever is longer; a grace written in the spec is dropped. In the grace the `error_rate` and `target_cpu_pct` rules give way to one safety bound, errors above 95 % for max(30 s, the longest error-rate rule) (`controller/rules.mjs` `rulesAt`); it stops the run as `auto_stop:overload_safety`. `generator_cpu_pct` rules and the target dying still apply. **Breakpoint**: `breakpoint: { factor?, max }`, on a staircase only: `factor` > 1 (default 1.5), `max` at or above the top step and at most the environment's ceiling (`max_users`, or `max_arrival_rps` for an open model, §1a); an environment with no ceiling refuses a breakpoint. `max` is the ceiling `perf run --breakpoint` may climb to (§8b) |
| `timing` | see below | every value > 0; `heartbeat_timeout_s` and `worker_timeout_s` cover at least 3 ticks; `window_s` at least one tick |
| `auto_stop` | `error_rate` above 0.5 for 30 s (min 50 requests) when none is given; the verdict says the default applied | rules `{ metric, above, for_s, min_requests? }`; metrics `error_rate`, `generator_cpu_pct`, `target_cpu_pct` (needs a metrics source) |
| `engine_options` | `{}` | passed to the engine untouched |
| `watch` | `{}` | `max_wakes_per_hour` (default 12): past it, only critical events wake the AI (§5) |

Every number must be a JSON number: `"5"` is refused, never coerced.

`timing` defaults: `tick_ms` 1000, `window_s` 10, `heartbeat_timeout_s` 10, `worker_timeout_s` 10,
`barrier_timeout_s` 60, `saturation_pct` 80.

A spec that carries its own `allow_hosts` is refused: the allowlist is the project's, not the run's.

A profile named `volume` is a load on production-sized data: refused unless `data/manifest.json`
has a valid `volume` plan (§8). It is judged as a load run, and on the volume it counted (§9).

`perf run` adds `run_id` (`YYYYMMDD-HHMMSSmmm-xxxx`), `root`, `git_sha`, `git_dirty` (uncommitted changes to tracked files; two runs are "the same build" only when both are clean at one sha), `tool_version` (engine detection runs here, never in the controller, whose event loop must not block), `script_path` and `monitor`, and writes the result as
`run.json` in the run folder. The controller reads only that file. When `data/manifest.json` has a
valid `volume` plan, every run but a smoke counts it first and keeps the count as `volume` (§8);
a `perf scale` run adds `instances`.

## §1a Environment file (`.perf/<slug>/env.json`)

`{ environments: { <name>: { allow_hosts[], allowed_profiles[], owner, parity, production?, third_party?: [{ name, stubbed }], monitor?: { metrics, containers[] | processes[], interval_s, signals[] (§1b) } } } }`.
`perf run` refuses a host outside `allow_hosts`, a profile outside `allowed_profiles` (PS-A2), an
environment marked `production`, and a third party not `stubbed: true`. `perf check env` also
requires `owner` (who authorised load) and `parity` (quoted by the verdict). An environment may set `max_users` and `max_arrival_rps` (numbers > 0): the highest load its owner allows a breakpoint search (§1 `profile.breakpoint`). `perf run` refuses an environment with no `owner`, and, for any host other than this machine (`127.0.0.1`, `localhost`, `::1`), one without `approval: { by, at, hosts }` that is at most 90 days old and names the host. `monitor.metrics` is
a key of `METRICS`: `none`, `docker-stats` (which needs `containers`) or `host-process` (which needs
`processes`: `[{ name, pid | port | match }]`, each found by exactly one: a pid, the process
listening on a TCP port, or every process whose command line matches a regular expression, summed). `target_cpu_pct` is the
share of the CPUs a container may use (its CPU limit, else the Docker host's CPUs), not `docker
stats`' percentage of one core; the sample's `labels.cpus` says which (`--cpus`, a CPU quota, a cpuset,
else the host). `target_cpu_cores` keeps docker's per-core figure, so a single-threaded target
pegged at one core still shows: the analysis says "maybe CPU-bound on one thread" instead of "not CPU". `host-process`
samples the same `target_cpu_pct` (share of this machine's CPUs), `target_cpu_cores`,
`target_mem_bytes` and `target_mem_pct` (private memory: Windows private bytes, Linux `RssAnon`,
so pages shared by forked workers count once; elsewhere RSS), plus `target_process_up` (1, or 0
once) and `target_process_exited` (some of its processes went: an `anomaly`). Each sample reads
one snapshot of the machine's processes; `port` and `match` targets are looked up in every
snapshot, so recycled workers are followed, and the target is gone only when none is left. A
`pid` target is followed by pid and start time (a reused pid is not it). The load generator (the
controller, its children, any process whose command line holds the run folder) is never part of
a target. The target is sampled once before the workers start, so it is followed from the start.
A snapshot the tool could not take is no sample, never a death. On Windows a snapshot takes
about 2 s (one PowerShell call); keep `interval_s` at 5 or more. One that is not running before the run makes
`perf run` refuse (doctor `machine/processes`); one that never yields a sample is
`monitoring_failed`; one that disappears during the run (crashed, killed, restarted under a new
pid) stops it: `auto_stop:target_gone`, problem `target_gone`, verdict FAIL "the target failed under
load". Linux reads `/proc`, Windows `netstat` and PowerShell, other posix systems `lsof`, `pgrep`
and `ps`. The labels are `{ container: <name>, pids, cpus }`.

## §1b Signals: the target's own metrics (`monitor.signals`)

Beside any `monitor.metrics` (even `none`), an environment may list the numbers that tell a wait
from a busy CPU: `monitor.signals: [{ name, kind, scrape | prometheus, metric | query, match?,
counter?, scale?, above?, auth_env? }]`.

| Key | Meaning |
|---|---|
| `name` | a short name (letters, digits, `.` `_` `-`), unique |
| `kind` | `pool_used_pct` (limit 95), `pool_waiting` (0), `db_locks_waiting` (0), `db_slow_queries` (0), `gc_time_pct` (10), `event_loop_lag_ms` (100), `thread_pool_queue` (0), `queue_depth` and `custom` (no default: `above` is required) |
| `scrape` + `metric` | an http(s) endpoint in the Prometheus text format (the app's or an exporter's `/metrics`); the value is the sum of the metric's series whose labels equal `match`; a metric with no such series is no reading, never 0 |
| `prometheus` + `query` | a Prometheus server; the value is the instant query's scalar, or the sum of its vector. The server's URL keeps its path (the API is `<path>/api/v1/query`); a query string is refused |
| `counter` | `true`: the value is a rate per second between two readings (the first reading, and one after a reset, give no sample) |
| `scale` | a number > 0 the value (or the rate) is multiplied by, to put it in the kind's unit: 1000 for seconds to ms, 100 for a ratio or seconds per second to %. A counter of a `_pct` kind needs one |
| `above` | the limit; a reading above it (not equal) is over |
| `auth_env` | the environment variable holding a bearer token. A URL that carries a credential (a user and password, or `token`, `access_token`, `key`, `api_key`, `password`, `sig` in its query) is refused, as `target_url` is |

Signals are read every `interval_s` while the run goes, never waited for, and written to
`monitor/target.ndjson` as `{ t, name: "signal", unit, value, labels: { signal, kind } }`. A signal
that cannot be read, or reads an infinite number, gets one `anomaly` event (`data.signal`,
`data.error`); one with no sample at the end gets the problem `signal_missing` (`data.signals`;
a counter read only once is said as such). Its lesson goes to the `env` step. Neither changes the run's state: the load was
measured; only the analysis sees less. The doctor reads each signal before a run: a failure, or
an `auth_env` that is not set, is a warning (`network/signals`); `perf run` prints it and goes on.
URLs are shown without user, password or query string, and errors never quote a credential.

## §2 Run folder (`.perf/<slug>/runs/<run_id>/`)

| File | Writer | Content |
|---|---|---|
| `run.json` | `perf run` | the normalised spec (§1) |
| `state.json` | controller | §4 |
| `control.json` | controller | `{ heartbeat_at, go_at, stop, stop_reason }`, epoch ms |
| `stop.request` | `perf stop` | any content; its existence asks for a stop |
| `events.ndjson` | controller, doctor | §5 |
| `controller.log` | controller | its stdout and stderr: a crash leaves its reason here |
| `monitor/target.ndjson` | controller | target samples from the metrics source: `{ t, name, unit, value, labels }` |
| `raw/<worker>/errors.ndjson` | worker | up to 20 sampled failed requests per class: `{ t, name, class, error, correlation_id }` (PS-G4) |
| `analysis.json`, `analysis.md` | `perf analyze` | §9 |
| `verdict.json`, `verdict.md` | `perf report` | §9 |
| `monitor/timeline.ndjson` | controller | one line per tick: `t`, `phase`, `target_users`, `requests`, `failures` (deltas), `cpu` per worker |
| `raw/<worker>/status.json` | worker | §3 |
| `raw/<worker>/hist-<k>.json` | worker | §3 |
| `hist/merged.json` | controller | merged `perf-hist/v1` for the measured window, total and per endpoint |
| `result.json` | controller | §6 |

## §3 Worker protocol

Every engine adapter's worker, whatever the tool, speaks this protocol. That is what makes the
controller engine-agnostic.

- Write `status.json` every tick: `{ worker, pid, state, reason, ts, t, users, requests, failures,
  cpu_pct, error_classes, stalls }`. `state` is `starting` → `ready` → `running` → `stopped`. `requests`,
  `failures` and `error_classes` are cumulative counts.
- Send no load before `control.go_at`. `t` is seconds since `go_at`, the run's only time axis.
- **The controller's clock is the run's clock.** A worker in a container or on another machine can
  be seconds off. On every control read it computes `heartbeat_at − local now`. Because the
  controller wrote `heartbeat_at` before the read, this is a lower bound of the true offset, so
  the maximum over reads converges on it. The worker adds that offset to its clock for `t`, `ts`
  and the heartbeat check.
- **Stalls are reported, not hidden.** A gap between ticks longer than max(1 s, 5 ticks) is a
  stall: the process, its container or its disk froze, and no load went out. The worker appends
  `{ from, to }` to `stalls` and does not catch up the lost load. When a worker's stalls cover
  more than 5 % of the measured span, the controller marks it `stalled`, emits `anomaly`, and the
  run is `degraded`.
- Each worker gets `AI_PERF_WORKER` (its index) and `AI_PERF_WORKERS` (the count) in its
  environment, so a script can take its own data partition.
- Write one window file per `window_s` slice: `{ schema: "perf-hist-window/v1", worker, window: k,
  window_s, origin_s, endpoints: { <name>: { requests, failures, hist } } }`. Windows are laid so
  one starts exactly where steady starts: `origin_s = steady_from − window_s·ceil(steady_from /
  window_s)` (≤ 0) and `k = floor((t − origin_s) / window_s)` for each request's own time `t`
  (`windowOrigin`, `windowIndex` in `controller/profile.mjs`). `hist` is `perf-hist/v1` (§7).
- A file write that fails is retried on the next tick; it never stops the worker.
- Stop, write `state: stopped` with a `reason`, and exit when `control.stop` is true (`reason` =
  `stop_reason`) or `control.heartbeat_at` is older than `heartbeat_timeout_s` (`heartbeat_lost`).
- Never run longer than barrier timeout + profile + 30 s (`hard_end`).

An engine adapter exports `name`, `tool` (the `perf-result/v1` tool enum), `detect() → { ok,
version, install? }`, `workerCommand({ runDir, index, count, options, spec }) → { cmd, args, env? }`
and, to run on the `docker` target, `containerCommand({ index, spec }) → { image, args, env?,
entrypoint? }` with a pinned image. A target adapter exports `name`, `startWorkers({ runDir, spec,
engine }) → [{ id, index, pid, container?, spawn_error? }]` (it may be async, and must not block the
event loop for long) and `stopWorker(worker) → boolean`. `local` runs processes. `docker` runs one
container per worker, with the run folder and ai-perf bind-mounted, and reaches a host target as
`host.docker.internal`. A metrics adapter exports `name` and an async `sample({ containers, t }) →
[{ t, name, unit, value, labels }]`; the controller samples every `interval_s` without waiting for
it. Workers it starts must outlive the controller so the heartbeat rule,
not the process tree, stops them. A worker that cannot start gets a `status.json` with `state:
stopped` and `reason: spawn_failed: <code>`, so the barrier ends the run at once (`worker_failed`).

A **sidecar worker** speaks this protocol for an engine that cannot (k6: a script cannot write
files). It runs the engine as its child, names that child in `status.json` `child` (`{ pid }` or
`{ container }`), and stops it whenever it stops itself. Whoever kills a sidecar (the controller on
a missing stop ack, `perf doctor --fix` on an orphan) kills its `child` too. The k6 sidecar starts
k6 `--paused` before the barrier, resumes it at `go_at` through k6's REST API, maps the run profile
to k6 stages (users split exactly over workers), and places each `http_req_duration` point in its
window by the request's own time, measured from k6's first default-scenario request (setup and
teardown requests are not load). The lag from `go_at` to that request is `status.start_lag_s`; a
lag longer than the rampdown cut the steady state short, so the controller marks the worker
`stalled` with the problem `engine_start_lag` and the run is degraded. Keep 3 s or more of rampdown
with k6 (`perf run` warns). Failed `check()`s are counted per window (`checks: { passed, failed }`),
merged into `result.checks`, and judged by the verdict as failures. Its generator CPU is k6's own (`docker stats` of its container,
or `/proc` on Linux); only a k6 binary on another OS falls back to the host's CPU.

## §3a In-house engines and the `ws` engine

An in-house engine is a worker on the kit (`adapters/engines/kit.mjs`, guide in
`docs/engine-kit.md`). The kit speaks §3 and adds to `status.json`:
- `ccu`: players online now;
- `loop_lag_ms`: the p99 lag of the worker's event loop over the last tick. Above
  `timing.loop_lag_ms` (default 100) the worker is saturated (`generator_saturated`), because
  what it receives is timestamped late.

While it runs, the kit writes every window, with or without events, so idle players still count
as online. Its windows carry `realtime: { ccu_max, ccu_min, drops, reconnects, tick_lag,
tick_period? }`:
- `ccu_min` is held from the moment the worker first has all its players in steady, or one
  window into steady at the latest;
- `tick_lag` is a perf-hist;
- `tick_period` is the measured period against the announced one.

The merged result has `realtime: { ccu_max, ccu_min, drops, reconnects, drops_per_min,
tick_period_ms: { measured, announced }, tick_lag_ms: { count, p50, p95, p99, max } }`, with players
online summed over workers per window. A per-window sum of worker peaks can read slightly above the
true instantaneous peak; the minimum is what the hold check uses.

The `ws` engine runs the product's player script: a module whose default export is
`async function player(vu)`. `vu` has:
- `id`, `worker`, `workers`;
- `user`: unique per player;
- `request(type, payload, name)`: sends `{ id, type, ...payload }` and resolves with the reply
  that carries the same `id`. A reply `{ type: "error", code }` fails with the class
  `ws error: <code>`, and no reply within `engine_options.timeout_ms` (5000) fails with
  `Timeout`. A failed request is not a drop: the player stays online, and its script runs again
  on the same session;
- `think(min, max)`, in seconds;
- `running`.

The engine also reads the server's messages:
- `{ type: "welcome", tick_ms }` announces the tick;
- `{ type: "tick", seq }` gives the tick lag: arrival minus the earliest arrival the recent ticks
  allow, at the period measured over the session. Lag is recorded once about a second of ticks
  is in, so a wrong or rounded `tick_ms` neither hides lag nor grows it.

It counts connections: a connection the server cuts is a drop, and the next successful connect is
a reconnect, after `engine_options.reconnect_ms` (500). `connect` is an operation too, and it fails
with `ConnectTimeout` when the handshake takes longer than `timeout_ms`. On the docker target, the
worker reaches the target through `AI_PERF_TARGET_URL` (rewritten to `host.docker.internal`).
A plan with a `realtime` block whose run measured no realtime, or no tick lag for a planned tick
limit, is NOT EVALUABLE. The plan gate accepts only the judged limits (`tick_lag_p95_ms`,
`drops_per_min`) and a `ccu_hold_pct` in (0, 100].
`mock/game.mjs` is a WebSocket game server for tests: login, matchmaking, moves, a fixed-timestep
tick, and optional lag, drops and errors.

## §3b Workers on other machines (`ssh`, `k8s`) and the network control channel

When one machine cannot generate the load (its CPU saturates, ports or file descriptors run out:
the doctor's generator checks and the `generator_saturated` problem say when), workers run on
other machines. The worker protocol (§3) does not change: each worker reads `control.json` and
writes `status.json`, its histogram windows and its sampled errors, on its own disk. `perf-agent`
(`bin/perf-agent.mjs`), started on that machine by the target, mirrors those files over HTTP:

| Request (each with `Authorization: Bearer <token>`) | Does |
|---|---|
| `GET /v1/run`, `GET /v1/script` | the run spec and the script file, once at start |
| `GET /v1/control` | `control.json`, every tick (the heartbeat travels in it) |
| `PUT /v1/workers/<id>/<file>` | `status.json` (with `host` and `clock_skew_ms`), `hist-<n>.json`, `errors.ndjson`, when changed; status last |

The controller opens the channel before the workers start and closes it after the drain. It
answers only the run's token (32 random bytes, new per run, compared in constant time), only
`w0`…`w<n-1>`, only those files (32 MB at most each), only JSON objects, and a status only with a
numeric `ts` and a `state`; a status's `child` is dropped (a process on another machine is
nothing the controller may kill). No body can stop the controller: a bad one is a 400, a failed
write a 500. It stamps every answer with `x-perf-time`. The agent reads its status first, then
sends every changed window and error file, and sends that status only when all of them went: the
controller never sees "stopped" before the windows it covers. A remote worker is never killed
from here: it stops on `control.stop` or a stale heartbeat. A worker whose agent cannot reach the controller sees `control.json` go stale and
stops itself (§3); its status goes stale here, and it is lost (§4). The channel is plain HTTP
with a bearer token: use it on a network you trust, or put it behind a VPN or tunnel.

Run spec:

| Key | For | Value |
|---|---|---|
| `channel` | `ssh`, `k8s` | `{ advertise: "http://<this machine on their network>[:port]", port?, bind? }`: a port in `advertise` is the one listened on; without one, `port` (default 0, a free one) and `advertise` gets it; give a fixed port when a firewall is in the way |
| `ssh` | `target: "ssh"` | `{ hosts: ["host" \| "user@host", …], ai_perf: "/path/to/ai-perf", node? }`: workers go to the hosts in turn; key login (`BatchMode`); `--` before the host, which must start with a letter or digit; `ai_perf` and `node` may start with `~/`; the token goes to the agent on stdin, never on a command line. What ssh and the remote side print goes to `raw/w<i>/agent.log`; if ssh ends before the agent reported, the worker stops at once with that reason. `PERF_SSH` replaces the ssh command |
| `k8s` | `target: "k8s"` | `{ namespace, image, ai_perf?: "/ai-perf", node?, resources? }`: one Indexed Job of `workers` pods (`JOB_COMPLETION_INDEX` is the worker), the token in a Secret of the run; both labelled `ai-perf.run` and deleted when the run ends, or by `perf doctor --fix` after a lost controller. `backoffLimitPerIndex: 0` (Kubernetes 1.29 or later): a failed pod is one lost worker, never retried, never the others' end. `activeDeadlineSeconds` is the run's hard deadline plus 2 minutes, `ttlSecondsAfterFinished` an hour; pods get no service-account token. The doctor needs create and delete rights on jobs and secrets; a barrier under 180 s warns (pulling an image takes time). The image needs Node, ai-perf and the engine (`docker/agent.Dockerfile`). `PERF_KUBECTL` replaces kubectl |

Every worker loads `target_url` from its own machine: the allowlist and approval are checked here,
before anything starts, and they must hold for the workers' network too. The script travels with
the run; a script that imports other files needs them beside it on the worker machine. Each
machine needs the engine; `perf-agent --probe` (run by the doctor through ssh) says which it has.

Clock: workers align to the controller's clock from `control.json` (§3), so their samples share
its time axis whatever their own clocks say. The agent also measures its machine's skew on every
GET (the midpoint of the round trip), reported in `result.workers[].clock_skew_ms` as that
machine's clock minus the controller's; more than 1 s is an `anomaly` (fix NTP there: its logs
will not line up). The doctor measures each ssh host before the run (same sign), all hosts at
once, and checks that each reaches the controller back: it listens on the run's port for the
probe, and a host whose agent gets no HTTP answer from `channel.advertise` fails (its workers
could not report).

## §4 Run state (`state.json`, `perf-state/v1`)

States: `preparing`, `warmup`, `ramp`, `steady`, `rampdown`, `collecting`, then one terminal state:

| Terminal | When | Exit code |
|---|---|---|
| `done` | measured window has samples, no worker lost, generator not saturated | 0 |
| `not_evaluable` | generator above `saturation_pct` in the measured window (steady, or the whole run for a profile without steady), or no measured window | 3 |
| `degraded` | a worker was lost during load, or did not confirm the stop; its share of load is missing | 4 |
| `aborted` | auto-stop, `perf stop`, barrier timeout, a worker that failed to start, all workers lost, the hard deadline (barrier + profile + drain + 60 s), or a lost controller marked by `perf doctor --fix` | 5 |

A CPU sample, like a request, belongs to the time the worker took it (`status.t`), not to the time
the controller read it. `generator.cpu_max_pct` covers the measured window only, and is `null` when
no sample fell inside it.

Precedence: aborted > not_evaluable > degraded > done. Legal moves: each running phase to the next
or to `collecting`; `preparing` to `warmup` or `collecting`; `collecting` to a terminal state. Every
move is appended to `history`. `heartbeat_at` is refreshed every tick; a controller is **lost** when
the run is not terminal and its pid is gone or `heartbeat_at` is older than `heartbeat_timeout_s`
(three times that while `collecting`, which reads every window file), or when `state.json` was never
written and the pid in `controller.pid` has been gone for 5 s (before the pid file exists, the run
folder's age counts). `perf doctor --fix` never kills a lost controller's pid (it may have been
reused); it writes `stop.request` and marks the run `aborted`. The controller kills a worker that
did not confirm the stop only while that worker is alive and still reporting. `perf stop` acts only
on a run whose controller is alive or starting; for a lost one it points to `perf doctor --fix`.

## §5 Events (`events.ndjson`)

One JSON object per line: `{ ts, t, type, severity, summary, data }`, `severity` in `info`, `warn`,
`error`. Types: `phase_changed`, `slo_breach`, `new_error_class`, `anomaly`, `generator_saturated`,
`worker_lost`, `auto_stopped`, `cleanup` (the data cleanup after load stopped; warn when it failed), `run_finished`. The AI is woken by these only.
`anomaly` is emitted for a stalled worker. `slo_breach` is reserved.

`perf watch` blocks until the AI should look. It wakes on any non-info event while the hourly
budget allows, and on a critical one (`auto_stopped`, `run_finished`, `worker_lost`) or a lost
controller at any time. It returns the events since `--since` and the next index.

## §6 Result (`result.json`)

Valid `perf-result/v1` (`schemas/perf-result.schema.json`, byte-identical to the canonical copy in
stlc). Numbers cover `run.window` only: the whole windows inside the steady phase and before load
stopped, with `window.from`/`to` the span those windows cover; or the whole run (`kind: whole-run`)
for a profile without steady or a run stopped before it, with rps over the time load actually ran.
Rates in the steady case are over every planned whole window, including one in which no request
completed (a hung target): a window that holds no samples still took its seconds.
Fields ai-perf adds: `run.users` (the profile's users, so a baseline is compared at the same load),
`run_state` (§4), `problems[]` (`{ kind, detail, t, data? }`: `data` holds the numbers a fix reads, e.g. `engine_start_lag` `{ lag_s, rampdown_s }`), `workers[]` (`{ id, pid, state, lost,
saturated, stalled, cpu_max_pct, requests, failures }`) and `hist` (path to `hist/merged.json`).
`run.volume` (a volume plan, §8): `{ counted_at, min_pct, entities: { <name>: { target, count,
pct, ok, error? } }, at_volume, short[], failed[] }`, counted just before the run started.
`run.instances`: the instance count a `perf scale` step deployed (§8b).
A staircase adds `steps[]`: `{ index, users | arrival_rps, from_s, to_s, complete, total,
endpoints{ requests, p95_ms, p99_ms, error_rate } }` over each step's whole windows after its first
(the settling window); a step the run did not finish is `complete: false`. A spike adds `spike`:
`{ from_s, to_s, users | arrival_rps, base{ total, endpoints }, peak_p95_ms, peak_error_rate,
recovered, recovery_s, observed_after_s, base_steady_pct }`: the base is the steady before the
spike. A window is back near the base when its p95 is within 20 % + 5 ms of the base's, its error
rate within 0.5 pp, and it served at least 70 % of the base's requests per window; `recovery_s` runs
from the end of the spike to the end of the first of two such windows in a row. `base_steady_pct` is
the share of the base's own windows that pass the same test. A spike records `window_s`; on a
`recovery` profile it adds `windows[]`, every steady window from the start of steady to where load
stopped (the normal load, the overload and after it): `{ start, requests, p95_ms, error_rate,
endpoints{ <name>: { requests, p95_ms, error_rate } } }`, with `ran_to_s` (where the overload really
ended: the planned end, or where load stopped) and `end_s` (where load stopped in steady).
Any other profile with at least 4 steady windows adds `drift`: `{ windows, p95_pct, memory_pct{
container: pct } }`, the change over steady of a Theil–Sen line through each window's p95 and
through each container's `target_mem_bytes`, on time (not sample order), in % of the line's start;
past 120 points it is fitted on 120 time bins (their medians), so a day of samples stays cheap.
The planned arrivals behind `arrival_shortfall` follow the shape (steps, a spike).

`perf` exit codes: 0 ok/done, 1 error or doctor failure (also `--wait` seeing a lost controller, or
giving up 30 s past the controller's `hard_deadline` in `state.json`, which it sets once its workers
have started), 2 refused, 3 not_evaluable, 4 degraded,
5 aborted.

## §7 Histogram (`perf-hist/v1`)

`{ schema: "perf-hist/v1", count, max_ms, buckets: { <b>: <count> } }`. Bucket 0 holds values ≤ 0.1
ms; bucket b > 0 holds (0.1·1.01^(b−1), 0.1·1.01^b] ms. Merging adds counts per bucket. A percentile
is the upper edge of the bucket that holds its rank, capped at `max_ms`. Percentiles are only read
from merged histograms, never averaged.

## §8 Project files (`.perf/<slug>/`)

Machine-checked files are JSON; prose is Markdown. Every number carries `source`: `contract`,
`measured`, `confirmed`, `imported` (read from an existing suite, not yet agreed), `assumed` or
`default`.

| File | Written by | Gate (`perf check <step>`) |
|---|---|---|
| `slo.json`, `workload.json` drafts | `perf contract` | from the API contract's `x-perf` budgets and `info.x-traffic-classes`, only where none exist: SLA p95 = the budget, SLO 20 % stricter, `source: contract`, `error_rate_source: default` (the verdict names those). One closed persona per class: `concurrency` clients with no think time, or, for a rate-only class, the clients Little's law needs at its budget and the think time that holds them to its peak. `littles_law.rps` is the rate the loop drives at the budget, `peak_rps` the contract's peak; a class driven past 3× its peak is warned. `--ops` picks operations, `--traffic` classes (default: the GETs of every class). The YAML reader takes operations under `paths` only, each one's own keys at its child indent (flow or block `x-perf`, flow or block classes, comments dropped, quoted paths); it refuses, drafting nothing, a second `operationId`, an `x-perf` it cannot place (callbacks excepted) and a budget that is not a number |
| `import.json`, `run-<engine>.json` | `perf import` (drafts one journey per operation at the suite's weights, e.g. Locust `@task(n)`; a request outside any task, a login in `on_start`, is setup and left out of the mix) | `import`: every suite found names its operations (an in-house script is exempt: it is listed, not parsed), has no unnamed requests with ids, and is runnable (its engine installed) or says why not. `workload.json` and `slo.json` drafts are written only where none exist. Old results are listed as reference and never become a baseline |
| `audit.json`, `audit.md` | `perf audit` | none: a score out of 100 per suite (high −15, medium −8, low −3) and the findings ranked, each with its perf-standard rule, lines and fix |
| `context.json`, `context.md`, `assumptions.json` | `perf discover` | at most 3 questions, each with a proposed answer; never one the repo or an answer already settles |
| `slo.json` | /perf-plan | `plan`: each transaction has numeric `slo` and `sla` p95 and error rate, the SLO never looser than the SLA; named profiles; optional `spike: { recovery_s }`, `recovery: { recovery_s }` and `soak: { max_p95_drift_pct, max_memory_growth_pct }`, numbers > 0, no other key |
| `workload.json` | /perf-model | `model`: open or closed with a reason; shares and weights each add up to 100; journeys use defined personas; Little's law within 15 % |
| `env.json` | /perf-env | `env`: §1a, plus `owner` and `parity` |
| `data/manifest.json` | /perf-data | `data`: accounts ≥ target users (or `shared_reason`), a cleanup command, `run_id_prefix: true`. The controller runs `cleanup.command` after every run that started, once `result.json` is written (its time is not in `ended_at`), from the project root, with `$RUN_ID` (also `${RUN_ID}`, `%RUN_ID%`) replaced and set in the environment. It is done when the command exits (a background process it leaves is not waited for), and killed with its children after `cleanup.timeout_s` (a number > 0, default 120). `result.cleanup` is `{ command, exit_code, output, duration_s }`, credentials masked, and a `cleanup` event is emitted; a command starting `none` ("none: the mock keeps no state") declares there is nothing to clean: `{ skipped }`. Optional **`volume`** (production-sized data): `{ entities: { <name>: { target, count, seed?, source } }, min_pct?, timeout_s? }`; at least one entity, its name letters, digits, `.` `_` `-`; `target` a whole number > 0 (the rows production has), with its `source`; `count` a command that prints the row count, `seed` one that loads the data; `min_pct` in (0, 100] (default 95); `timeout_s` > 0 (default 600) kills a seed or count command. Both commands run from the project root **without a shell** (`lib/command.mjs`): the template is split into words (quotes keep spaces), `{entity}` and `{target}` are filled inside a word, and `PERF_ENTITY`, `PERF_TARGET` are set; `;`, `&&`, `|` and `$(...)` are plain arguments, so a pipe belongs in a script. A count is the last non-empty line printed, a whole number (`5000000`, `5,000,000`, `5_000_000`); a command that exits non-zero, or prints anything else, counted nothing |
| `data/volume.json`, `data/volume.md` | `perf volume --slug s [--seed]` | none: with `--seed`, each entity's seed command runs first; then every count. `{ counted_at, min_pct, entities: { <name>: { target, count, pct, ok, seed?: { exit_code, duration_s, output? }, error? } }, at_volume, short[], failed[] }`; `at_volume` when every entity counted at least `min_pct` % of its target. Exit 0 at volume, 3 not, 2 without a valid plan. Counting never seeds |
| (a smoke run) | /perf-script | `script`: the last smoke is done, has no failure, and ran every workload operation |
| `baselines/<env>/<profile>.json` | `perf report --promote` | only a done run with a PASS or WARN verdict (PS-F1) |
| `run.json` `fingerprint`, `result.run.fingerprint` | `perf run` | what the run was measured under, taken when it starts (`lib/fingerprint.mjs`): digests of the workload (model, users, personas and their shares, journeys with steps, weights and think time), the architecture (services, datastores, stack, realtime from `context.json`), the environment (parity, which third parties are stubbed), the script file and the data set (account count, and the volume plan's target per entity when there is one; a manifest without a plan keeps the digest it had before 0.14.0). Sources, SLO thresholds, prose and allowed hosts are left out: they change no measurement. The volume each run counted is compared apart (`lib/volume.mjs` `volumeDiff`): two runs whose counts of an entity differ by more than 5 % of the larger, or where one counted an entity the other did not (or counted nothing), measured another data set, STALE with the `data` part. Two runs at different `instances` are refused as another deployment. Two runs whose fingerprints differ are another experiment: a baseline is **STALE** (NOT EVALUABLE, nothing compared; with `--bootstrap`, judged on SLOs only so a new baseline can be promoted), `perf compare` refuses them and `perf trend` leaves them out. A baseline measured before 0.3.0 has no fingerprint; the verdict says it was not checked |
| `trend.json`, `trend.md` | `perf trend` | none: the comparable runs (the baseline rule, fingerprint included), per-operation p95 and total rps series, and flags: `step` (one run past PS-F2, unless a later run came back within the limit) and `slow_decay` (on the last 8 runs since the last step, at least 5: a Theil-Sen line that moves more than 12 %). Exit 1 when anything is flagged |
| `lessons.json`, `lessons.md` | `perf learn` | none: lessons with stable ids (`problem:*`, `bottleneck:*`, `failure:*`, `regression:*`, `mix:off`, `cleanup:failed`), a `kind` (`run`: about running ai-perf, true in any project; `system`: about the system under test), the `step` that can act on it (`plan`, `model`, `env`, `data`, `script`, `run`, `analyze`), the runs that taught them, `seen` (every judged run read) and `pushed` (in Recall). A later verdict notes "seen before" when its run repeats a lesson. `perf lessons --step` lists a step's lessons, this project's then other projects'; `perf help` adds the next step's; `perf run` prints the `env` and `run` ones before loading |
| `lessons.json` `remedy` | `perf learn` | none: per lesson, the last fix for it (below), or `{ status: "needs_person", why }` for a lesson about running the tool that ai-perf has no fix for. Lessons about the system under test have none: they are the test's findings |
| `learned.json` | `perf learn` (after every judged run) | none: recomputed from the judged runs each time. `profiles.<profile>/<open\|closed>/<target>`: the settings applied to every later run of that profile, model and target (`workers`, `profile.rampdown_s`, `profile.users` for an open model only), only ever raised, never lowering what a spec asks. `fixes[]`: `{ lesson, profile, key, field, from, to, run, status, checked_by?, why?, terminal? }`. Fixes: `problem:generator_saturated` → workers (CPU to 60 %, at least one more, double when pegged; at most this machine's CPUs for `local`/`docker`, 8 per ssh host, 64 on k8s, and never more than a closed loop's users), `problem:engine_start_lag` → rampdown above the recorded lag (a run that recorded none teaches nothing), `problem:arrival_shortfall` → twice the VU cap (open model; at most 10 for a smoke, 10000 otherwise). A run that was stopped (`aborted`: a person, an auto-stop, the target gone, the deadline) teaches no fix and checks none; one without a measured window checks none. `status`: `applied`; `verified` or `recurred` from the first later run of the key that ran with the value to its end (a run without it checks nothing); `needs_person` when no fix fits now (a later run may still get one), or, `terminal`, after two recurrences: the setting is rolled back and nothing more is tried until `perf learn --slug s --reset <lesson>` (`learn-reset.json`: the runs up to then no longer count for it). `perf run` applies the key's settings to the raw spec before checking it (the doctor checks the spec as it will run), records them as `run.json` `learned`, and never edits the spec file; `--no-learned` runs the spec as written. `perf run --until-evaluable [--attempts n]` (and `perf ci --until-evaluable`) judges each run and runs again while the run just judged ran its course and taught an `applied` fix, at most n runs (default 3, at most 5); it exits with the last verdict's code (0 PASS/WARN, 1 FAIL, 3 NOT EVALUABLE; 2 refused, 1 error before any verdict), with `--json` the progress goes to stderr, and it refuses `--no-learned` |
| `brief.md` | `perf report`, `perf ci`, `perf share`; `perf brief` prints it live | none: what is known about the project on one page: System, Decided, Measured, Learned, Lessons (`--step` keeps one step's), From the team (Recall), To share. At most 6 lines per section, 160 characters per line, 60 lines and 6000 characters in all; what a section does not show is counted; secrets are masked. Skills read it at the start of every step instead of the files behind it |
| `shared.json` | `perf share --pushed` | none: per fact key, the hash of what was pushed, Recall's id and when; instance-wide facts (tool lessons) also in `$PERF_HOME/shared.json`, so one machine pushes each once for all projects; a lesson marked `pushed` by `perf learn --pushed` counts as shared. `perf share` lists the facts whose hash differs: new ones, and changed ones with `supersedes_id`. Bodies hold only what stays true (no run counts, no project's fix numbers), so a repeated lesson is not pushed again. A fact is `{ key, kind, title, body, tags, project? }` in Recall's kinds: `lesson` (about running ai-perf, no project: instance-wide), `defect_pattern` (a lesson about the system), `decision` (a workload or SLOs the team confirmed; assumed numbers are never shared), `env_note` (an environment, a baseline, a capacity). Titles at most 120 characters, bodies 2000, masked. The project label is the repository's name |
| `recalled.json` | `perf share --import <file>` | none: what the team already knows, from `knowledge_search` results (an array, or `{ results }`): `{ id, kind, title, body, project }`, deduplicated by id, masked, the newest 50 kept, a search's first result newest; the brief shows the newest four |
| `$PERF_HOME/proposals/<id>.patch` | `perf learn` | none: for a lesson two projects taught, a patch for `git apply` in the bundle that adds it at the end of the "## Lessons from other projects" section of its step's skill (the section is added at the end the first time), keeping the file's line ends and handling a missing final newline; none when the skill already says it. `perf learn` and `perf lessons --global` print its path. Never applied by ai-perf |
| `scorecard.json` | `perf learn`, `perf scorecard` | none: per ai-perf version (`run.json` `ai_perf_version`) and profile, judged runs, outcomes, `runs_to_evaluable` (the first run that was not NOT EVALUABLE) and why the earlier ones were not; a profile first judged under an earlier version is `continued` and left out of the global median |
| `$PERF_HOME/lessons.json`, `$PERF_HOME/scorecards/` | `perf learn` | none: across projects (`PERF_HOME`, default `~/.ai-perf`). `run` lessons only, each with the projects that taught it, each a hash of its repository (origin remote, else folder) and slug, so two clones are one project and no path is stored; taught by two projects, it is `proposed` back to the bundle. Writes take a lock. `perf lessons --global`, `perf scorecard --global` (median runs to an evaluable result per version) |
| `runs/<id>/junit.xml`, `runs/<id>/compare-<other>.md` | `perf ci`, `perf compare` | `perf ci` exits with the verdict (0 PASS/WARN, 1 FAIL, 3 NOT EVALUABLE) or the run's own refusal (2) or error (1); `perf compare` exits 0, 1 on a regression, 3 when the runs are not comparable |

## §8a Doctor (`perf doctor`)

Each check is `{ id, group, status: ok|warn|fail, detail, fix? }`, and has a test that plants its fault.

| Group | Checks |
|---|---|
| machine | Node ≥ 20; each engine (fail when the spec needs it); Docker (fail when the spec monitors with docker stats or targets docker, which `perf run`'s quick doctor then refuses); Python; the target processes of `host-process` running; each ssh host reachable with this ai-perf version and the engine (fail when it cannot run perf-agent); kubectl allowed to create Jobs and Secrets in the namespace |
| generator | CPU already over 80 % busy; ephemeral ports under 4 per user (or 60 s of open-model arrivals); open-file limit under 4 per user + 256 (posix) |
| network | the target answers, probed only when the spec has no error (a refused host is never sent anything): fail when no connection (refused, DNS named, unreachable, timeout), warn on any other error (TLS, a proxy) or over 1 s; `localhost` on Windows (IPv6 first, about 2 s per connection) |
| safety | the spec (allowlist, production, approval); secrets in the project, run evidence and the script; third parties not stubbed |
| controller | lost controllers, orphan workers (`--fix`) |
| clock | per ssh host: its clock against this one, from a timed exchange with `perf-agent --probe` (warn above 1 s beyond the exchange's uncertainty) |
| network (remote) | per ssh host: it reaches the controller at `channel.advertise` (fail when not) |
| project | per `.perf/<slug>`: a file that is not JSON (fail); a gate failing (warn); a baseline whose fingerprint no longer matches (stale); slo.json out of step with the contract's x-perf budgets, or an x-perf GET no journey runs in a traffic class the plan covers (what `perf contract` would draft); open assumptions once a load run rests on them |


## §8b Beyond one run: the breakpoint, the configuration matrix and scaling

**`perf run <spec> --breakpoint [--max-runs n] [--bootstrap]`** needs a staircase with
`profile.breakpoint.max` (refused, exit 2, without it: the climb is never unbounded). It runs the
staircase, judges it (as `perf report` does) and reads it against `slo.json`'s SLAs, as the
capacity is read (`lib/breakpoint.mjs`):

| Reading | When | Then |
|---|---|---|
| `broke` | a complete step missed an SLA, or the run auto-stopped on `error_rate`, `target_cpu_pct` or `target_gone` during a step | stop: the breakpoint is that step |
| `held` | every step within the SLA | run again with the steps `[last held, × factor, …]`, as many as the first staircase had (at least 2), each at least one above the one before, the last cut at `max`; stop when the last held step is `max` (`ceiling`) or after n runs (`runs`; default 3, at most 6) |
| `generator` | the generator saturated (`generator_saturated`, or a saturated worker) | stop: the generator, not the target, is the limit |
| `unjudged` | the run ended another way (a stop, a lost worker, not done); it auto-stopped on errors or CPU after every step held; the first step out of the SLA did not measure a planned transaction while none it measured broke; or the verdict found a plan, model, environment or data gate failing | stop: nothing is read from it |

`--max-runs` is a whole number from 1 to 6; anything else is refused (exit 2). Each run is an ordinary run: its own folder, verdict, lessons and learned settings.
`breakpoint.json` and `breakpoint.md` in `.perf/<slug>/`: `{ found, unit, held: { value, run },
broke: { value, run, why }, unstable?, limit: target | generator | ceiling | runs | unjudged,
stopped, max, factor, factor_default?, runs[]: { run_id, steps, reading, outcome }, summary }`.
`broke` is the first step seen breaking and `held` the highest step seen holding below it, in
that run or an earlier one; with no step seen breaking, `found` is false and `broke` null.
`unstable` marks a load that held in one run and broke in the next. The last run's `verdict.json`
gets `breakpoint` and a note with the summary. The exit is the last verdict's.

**`perf matrix <matrix.json> [--bootstrap]`** (`lib/matrix.mjs`) runs one spec per variant of a
setting and ranks them. The file:

| Key | Default | Rule |
|---|---|---|
| `name` | the file's name | `^[a-z0-9][a-z0-9-]*$` |
| `spec` | — | the run spec every variant runs, a path from the project root that exists |
| `variants` | — | at least two `{ name, apply?, env?, spec?, changes? }`, names unique (letters, digits, `.` `_` `-`). The first is the control |
| `variants[].apply` | — | a shell command run from the project root before the variant's run, with `env` and `PERF_VARIANT` set; a non-zero exit is `apply_failed` and the variant is not run |
| `variants[].env` | `{}` | an object of string values, set for `apply` and for the run, and restored after it. Refused (any case): `AI_PERF_*`, `PERF_*`, `NODE_*`, `NPM_*`, `LD_*`, `DYLD_*`, `PATH`, `PATHEXT`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `COMSPEC`, `SHELL`, `PYTHONPATH`, `PYTHONHOME`, `SYSTEMROOT`, `TEMP`, `TMP`, `TMPDIR`, and any name that is not a plain identifier |
| `variants[].spec` | `{}` | merged into the run spec (objects key by key, arrays replaced); never `slug`, `environment`, `profile`, `target_url`, `engine`, `target`, `workers`, `timing` or `auto_stop`. Written to the report masked: a value under a key that names a secret is `***`, strings are masked as run evidence is |
| `variants[].changes` | `[]` | the fingerprint parts (`workload`, `architecture`, `environment`, `script`, `data`) the setting itself changes |
| `measure` | `p95` | `p95` (of all requests, or of `transaction`; lower is better) or `capacity` (a staircase; higher is better) |
| `min_diff_pct` | 5 | a p95 difference smaller than this is a tie |
| `min_diff_ms` | 1 | a p95 difference whose 95 % lower bound is under this many ms is a tie |
| `recheck` | `true` | run the control again after the variants |

The settings earlier runs taught (`learned.json`) are applied once to the spec before the first
variant and frozen: every run of the matrix runs with `--no-learned`, so no run changes the
generator of the next (`learned` in the report). Each variant's run is checked, run and judged as
`perf run` and `perf report --bootstrap` would (without a baseline, on its SLOs). A run that started
and was not seen to finish (`--wait` gave up, its controller was lost) stops the matrix: the later
variants are not run (`not run: the matrix stopped at …`) and the exit is 1. Not ranked, with the
reason (`flag`): a variant whose apply failed or whose run was refused; a run that did not end
done; a verdict FAIL or NOT EVALUABLE; on p95, an error rate (of all requests, or of
`transaction`) above the strictest SLA error rate, or more than 0.5 pp above the control's; one `compareBaseline` refuses against the control (environment, profile, tool,
target, model, users); one whose fingerprint differs from the control's in a part its `changes`
does not declare (**STALE**); for capacity, another grid of steps. Ranking: the best remaining
variant leads a rank, and every other variant it does not clearly beat shares that rank, until
none is left. On p95 a variant clearly beats another when the p95 change is at least
`min_diff_pct` and its one-sided 95 % bootstrap lower bound (both histograms, §9) is above zero in
% and at least `min_diff_ms` in ms. The control (the first variant) is held to the same rules;
when it cannot be ranked, no variant is (`no ranking`), and none takes its place. On capacity, when the other's first broken step broke past an SLA by more than the
PS-F2 noise floor (p95 above SLA × 1.10 and SLA + 5 ms, or the error rate 0.5 pp above). `winner`
is the variant alone in the first rank, else null. It is also null when a recheck was asked for
and could not be made (`drift.checked: false`); when the control's second run moved from its
first by a difference that counts, either way (`drift.moved`: the environment moved); and, on p95,
when the winner's lead over the best of the rest (`lead_pct`) minus the control's own move
(`drift.moved_pct`) is under `min_diff_pct`. Written to `.perf/<slug>/matrix-<name>.json` and `.md`: `{ name, spec, measure,
transaction, min_diff_pct, rows[]: { name, run_id, status, value, rank, flag?, stale?, tie?,
behind?, requests?, error_rate?, outcome, note? }, groups, winner, lead_pct, drift: { checked,
first, again, moved, moved_pct, run_id } | { checked: false, why } | null, verdict, ranked,
learned, variants }`. Exit 0 when at least two variants were ranked, 3 otherwise, 1 when the matrix
stopped on a run not seen to finish, 2 for a file that fails its check.

**`perf scale <scale.json> [--instances 1,2,4] [--bootstrap]`**, or **`perf scale <spec.json>
--instances 1,2,4 --command "<cmd>" [--ready-url u] [--name n]`** (`lib/scale.mjs`): the capacity
per instance count, and the scaling efficiency. The plan:

| Key | Default | Rule |
|---|---|---|
| `name` | the file's name | `^[a-z0-9][a-z0-9-]*$` |
| `spec` | — | the run spec, a path from the project root that exists; its profile must be a staircase (`steps`) |
| `instances` | — | 2 to 8 whole numbers from 1, ascending (`"1,2,4"` or `[1, 2, 4]`); `--instances` replaces it. Anything else (`2.5`, `0x10`, `1;id`) is refused: only a number ever reaches the command |
| `command` | — | deploys `{n}` instances (`docker compose up -d --scale api={n}`); run from the project root without a shell, as the volume commands are (§8), `{n}` filled inside its word and `PERF_INSTANCES` set; killed after `timeout_s` (default 600) |
| `steps` | `scaled` | `scaled`: count n climbs the spec's steps × n / base (rounded, each at least one above the one before), base the smallest count, so every count is read on the same relative grid; `same`: every count climbs the spec's steps |
| `ready` | `{}` | `{ url?, timeout_s? }`: after the command, `url` (default the spec's `target_url`; on the same host, or refused) is polled every 250 ms until it answers below 500 (a 503 while instances start is not ready), at most `timeout_s` (default 120) |

For each count in order: the command (a non-zero exit, or a timeout: the count is not run), the
wait for ready (not ready in time: not run), then an ordinary run of the spec with the count's
steps and without `profile.breakpoint` (`run.json` and `result.run` record `instances`), judged as
`perf report` would. The count is read with the breakpoint's reading (§8b above): its capacity
is the highest step that held (`held`). When the generator saturated, only the steps that ended
before the first `generator_saturated` problem count. With `k = n / base`:

| Verdict of a count | When |
|---|---|
| `linear` | efficiency = held(n) / (k × held(base)) ≥ 0.8. A count whose steps all held is linear "at least" |
| `flat` | below 0.8, and its capacity at most 1.1 × the last count before it that broke with a capacity (less than it: negative) |
| `sublinear` | below 0.8 otherwise |
| `generator` | the generator saturated: it is the limit, the target held at least `held`; no efficiency verdict |
| `unknown` | every step held with an efficiency under 0.8 (only a floor is known), or the base's capacity is unknown: the base held every step, saturated the generator, broke at its first step, or was not measured |
| `not_measured` | not run, or the run cannot be read |

A `flat` or `sublinear` count names its shared bottleneck from its run's analysis when a signal
was the cause (`bottleneck.cause`, §9: the hint and the evidence), and otherwise says no signal
named it. Written to `.perf/<slug>/scale-<name>.json` and `.md`: `{ name, spec, command (masked),
steps, base, base_known, measured, points[]: { instances, scale: { argv, exit_code, duration_s },
ready_s?, steps?, run_id?, outcome?, reading?, unit?, held?, rps?, bottleneck?, capacity?: {
value, at_least }, efficiency?, efficiency_at_least?, verdict?, why_verdict?, why? }, summary }`.
Exit 0 when the base capacity is known and at least two counts were measured, 3 otherwise, 2 for
a plan that fails its check.

## §9 Analysis and verdict

`perf analyze` writes the per-window timeline (rps, p95, error rate, phase). It groups failures
by class, each with a category, its count, the first time it appeared, and sampled requests with
correlation ids ("cause not established" when nothing was sampled; "none with a correlation id" when the engine records none: k6 does not, the worker kit only when the engine passes `record(..., { correlation_id })`). It gives the knee (p95 more
than doubled while rps stopped growing, where the offered load grew into that window or the one
before: latency rising at constant load is drift, not a knee) and reads the target's CPU around it: above 85 % means
CPU-bound, otherwise waiting.

With `monitor.signals` (§1b), a signal above its limit in the knee's window, padded by one
`interval_s` on each side, is the cause when it got there with the load: some earlier reading in
the loaded run was within its limit, or the reading at the knee is higher than any before. One
over its limit all along is named in the evidence as "over their limits before latency broke, so
not its cause", and the CPU decides. A cause reads "waiting on <signal>: <what its kind
means>", `bottleneck.cause` lists the kinds, and the evidence adds each reading against its limit
(the hint adds the CPU when it was above 85 % too). Signals read in that window and under their limits
are named in the evidence as ruled out; a signal not read there is never claimed quiet. A
generator saturated still comes first. `analysis.json` `signals[]` gives each planned signal over
the loaded windows: `{ name, kind, above, read, unit?, max?, first_over_t? }`, and `analysis.md`
shows them as a table ("no sample" for one with none).

`perf report` gives one of four outcomes:

| Outcome | When | Exit |
|---|---|---|
| PASS | every planned transaction within its SLO; no regression | 0 |
| WARN | an SLO missed with its SLA met; a closed-loop transaction with 200 or more requests, no planned p99, and a p99 more than 10× its p95 (coordinated omission: p95 understates the stalls); a run other than a volume run whose volume plan was short or not counted (below) | 0 |
| FAIL | an SLA breached; `min_rps` not met; the target process gone during the run (`auto_stop:target_gone`); a regression against the baseline (PS-F2: p95 up > 10 % and > 5 ms, and, when both histograms are kept, significant: the 95 % lower bound of a bootstrap of both (resampling the true n) above zero; a change past PS-F2 that is not significant at that n is a note, not a regression; an open run is compared only with an open run at the same `arrival_rps`, error rate up > 0.5 pp, throughput down > 10 %, endpoints with ≥ 100 requests on both sides); the target failing under load (an auto-stop on `error_rate` or `target_cpu_pct`); a smoke with any failure | 1 |
| NOT_EVALUABLE | a plan, model or data gate failing, or the env gate for the environment the run used (a load run is judged only against a finished plan); the run not `done` (except that auto-stop); a planned transaction never measured; no baseline without `--bootstrap`; a baseline from another environment, profile, load tool, target, user count or instance count, or STALE (its fingerprint, or the volume it counted); a volume run short of its plan or with nothing counted; a run with no `result.json` yet (still going, or its controller died) | 3 |

The mix (PS-B2): a journey's `weight_pct` is its share of arrivals in an open model and its share
of virtual users in a closed one. A closed user repeats its journey once per cycle (each step's
measured p50 plus the think time), so an operation's planned share is the sum over journeys of
weight / cycle × its count in the steps; in an open model, weight × count. On the judged requests
(the window; a staircase's capacity step; a spike's base), from 200 requests, an operation off by
more than 5 pp, or by more than half its planned share, beyond 3 σ of sampling (or never sent
while 5 or more were due) is a WARN ("the numbers describe another workload"); so is more than 5 %
of requests to operations the plan does not have. A failed or timed-out cleanup is a WARN naming
the command (exit 0 like any WARN).

Test types are judged on what they are for:

- **Staircase**: the capacity is the highest step of the unbroken run, from the bottom, of complete
  steps where every planned transaction met its SLA. Below the planned peak (`workload.json`
  `target`) is a FAIL, under 20 % headroom a WARN; no step held is a FAIL; every step held is a
  note (add a higher one). An auto-stop on errors or target CPU is where it broke, a note, not a
  FAIL; any other end before a step completed (a stop, a lost worker, the deadline) is NOT EVALUABLE,
  never a capacity. Every step held is a note that names `perf run --breakpoint` (§8b). The baseline gates apply as to any run (PS-F3, PS-F4, fingerprint, tool, users);
  then only the capacity is compared, and only with a staircase of the same steps: lower is a
  regression. The transactions, the heavy-tail check and `min_rps` are the capacity step's (the
  first step's when none held). Business checks and realtime are measured over the whole staircase:
  noted, not judged.
- **Spike**: transactions, the heavy-tail check and `min_rps` are judged on the base (the steady
  before the spike). Back later than `spike.recovery_s` (default 30 s, noted), or not back with at
  least the budget observed after the spike, is a FAIL; not back with less observed, a base that
  passes its own recovery test in fewer than half its windows, or no whole base window, is NOT
  EVALUABLE. Errors or failed business checks above the strictest SLA error rate during the run are
  a WARN (users saw them).
- **Recovery** (profile `recovery`, a spike shape): transactions, the heavy-tail check and
  `min_rps` are judged on the base, as for a spike, but recovery is judged against the plan, not
  the base, on `spike.windows`. A window is within the SLO when every planned transaction measured
  in it (at least one) has its p95 and error rate within its SLO, and it served at least 70 % of
  the base's requests per window, and every transaction the base sent in each of its windows is
  measured in it again. Windows are read on their time grid from the end of the overload to where
  load stopped (`end_s`): a window with no requests is not back, and two in a row means adjacent in
  time. Recovery is the time from the end of the overload to the end of the first of two such
  windows in a row; the watch (`observed_after_s`) is the whole grid. `overload_s` is what ran
  (`ran_to_s`); load that stopped before the planned end of the overload is NOT EVALUABLE, and so is a
  run stopped by the overload safety bound (§1). The budget is `recovery.recovery_s`, else
  `spike.recovery_s`, else 30 s (noted). NOT EVALUABLE: no whole window before the overload; the
  base within the SLO in fewer than half its windows; no overload window that took a transaction
  past its SLO ("nothing to recover from"); not back with less than the budget observed after the
  overload. FAIL: not back with at least the budget observed, or back later than the budget.
  `verdict.recovery`: `{ overloaded, hurt[], recovered, recovery_s, budget_s, observed_after_s,
  base_within_slo_pct, overload_s, peak_p95_ms, peak_error_rate }`. Errors during the overload
  are expected and not judged.
- **Volume** (a `volume` plan in `data/manifest.json`): judged on `run.volume`, the counts taken just before the run, never on a seed or an earlier count. Every entity at least `min_pct` % of its target: a note "at volume", `verdict.volume` (`{ at_volume, min_pct, counted_at, entities }`) and the summary says the run was measured at the planned volume. An entity short or not counted: on profile `volume`, NOT EVALUABLE (the run says nothing about production-sized data); on any other profile, a WARN (the numbers on a smaller data set flatter the target), and the summary says it was measured on less data. A `volume` profile with nothing counted is NOT EVALUABLE. A smoke is never counted or judged on volume.
- **Soak** (profile `soak`): p95 drift above `soak.max_p95_drift_pct` (default 20 %) or a
  container's memory growth above `soak.max_memory_growth_pct` (default 10 %) is a FAIL; defaults
  are noted; memory not measured (fewer than 4 samples) is a WARN; fewer than 30 steady windows, or
  steps or a spike, is NOT EVALUABLE.

`verdict.summary` is one sentence for a business owner (capacity and headroom, recovery time after a spike or an overload,
drift, or the load and what missed; a NOT EVALUABLE run says only why it cannot be judged), printed first in `verdict.md` and last by `perf report`.
`verdict.md` has a Capacity table for a staircase.

A regression on at least half of the compared endpoints (and at least 2) is `systemic`;
otherwise it is `localized`. The verdict's notes name every unconfirmed assumption, every SLO
whose source is `assumed` or `default`, the environment's parity, and whether the target was
monitored. `perf run` prints a cost estimate (seconds of load, worker-seconds) and writes it to
`run.json` `estimate`; the verdict records `cost` (estimated and actual seconds) and notes a run that
took more than 1.5 × the estimate + 30 s.

Target monitoring: a container in `monitor.containers` that never yields a sample gets an `anomaly`
event at its first miss, and the problem `monitoring_failed` at the end, which makes the run
`degraded`: its `target_cpu_pct` auto-stop could not fire.
