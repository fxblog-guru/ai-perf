# Changelog

All notable changes to ai-perf. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version is the one in `VERSION`.

## [Unreleased]

### Changed

- `perf-protocol` says where `<ai-perf>` is: `.claude/ai-perf` in a project installed with
  `npx agentic-fx`, else the ai-perf checkout.

## [0.14.0] — M15, volume and scalability

### Added

- **Volume.** A `volume` plan in `data/manifest.json`: per entity, the row count production has
  (with its `source`), a `seed` and a `count` command, and `min_pct` (default 95). `perf volume
  --slug s [--seed]` seeds when asked, counts every entity and writes `data/volume.md`. Every run
  but a smoke counts again just before it starts and keeps the counts in `run.volume`. A
  `volume` profile is refused without a plan, and judged NOT EVALUABLE when any entity counted
  less than `min_pct` of its target, or nothing; any other profile on short data is a WARN. The
  verdict's summary says on which data the run was measured.
- **Runs at other volumes are another experiment.** The plan's targets are in the data
  fingerprint (a manifest without a plan keeps its old digest), and two runs whose counts differ
  by more than 5 %, or where one counted and the other did not, are STALE for each other: the
  baseline, `perf compare`, `perf trend` and `perf matrix` (unless the variant declares
  `changes: ["data"]`).
- **Scalability.** `perf scale <scale.json> [--instances 1,2,4]` (or a run spec with
  `--instances` and `--command`): per count, the project's command deploys it, ai-perf waits until
  the target answers below 500, runs the staircase (its steps times n by default) and reads the
  capacity. Efficiency = capacity(n) / (n × capacity(1)); a count is linear from 0.8, flat when
  it adds at most 10 % over the count before it, sublinear otherwise. A flat or sublinear count
  names its shared bottleneck when a signal of the target was the cause at the knee. A count whose
  steps all held is "at least", a saturated generator is the limit (only the steps before it
  count), and no efficiency is given without the base capacity. `scale-<name>.md` and `.json` in
  the project folder; each run records its `instances`, and runs at other counts are not
  compared.
- **Commands without a shell** (`lib/command.mjs`): the scale, seed and count commands are split
  into words and started directly, placeholders filled inside a word; an instance count is only
  ever a whole number. `;`, `&&`, `|` or `$(...)` stay plain arguments.
- `mock/scale-lb.mjs`: a balancer in front of N backends with a capacity each, an optional shared
  part with its pool gauge on `/metrics`, and instances that take time to start. The fake engine's
  `capacity_url` asks it what the deployment serves.
- A `volume` profile; the planning skill says when to plan volume (multi-tenant, batch, reporting)
  and scalability, the data skill how to write the volume plan.
- `docs/coverage.md`: Volume and Scalability are covered.

## [0.13.0] — M14, beyond the peak

### Added

- **Breakpoint.** `perf run <spec> --breakpoint [--max-runs n]` on a staircase with
  `profile.breakpoint: { factor?, max }`. While every step holds, the next run climbs on from the
  last step that held, by `factor` (default 1.5), up to the ceiling `max`. It stops at the first
  step that breaks, at a load generator that saturates (said to be the limit, not the target), at
  the ceiling, after n runs (default 3) or at a run that cannot be read. `breakpoint.md` gives
  the last step that held and the first that broke, each with its run, and the last verdict
  carries it. No breakpoint is claimed that no run observed; a load that held in one run and broke
  in the next is flagged as the edge.
- **Recovery.** A `recovery` profile is an overload (the spike shape) and the normal load around
  it, judged against the SLO: back when every transaction is within its SLO, serving near the
  normal load, two windows in a row. Later than `slo.json` `recovery.recovery_s` (else
  `spike.recovery_s`, else 30 s), or never, is a FAIL. An overload that never took a transaction
  past its SLO, a normal load already past it, or too short a watch is NOT EVALUABLE. A
  `recovery` profile without an overload is refused.
- **Configuration matrix.** `perf matrix <matrix.json>`: variants of one setting (an `apply`
  command, `env`, a spec override), each run with the same spec, ranked by p95 or capacity. A
  difference must be significant (bootstrap) and at least `min_diff_pct` (5 %), else it is a
  tie; on capacity, the lower variant must have broken clearly past the SLA. The control runs
  again at the end: if it moved, no winner. A variant measured under another fingerprint than its
  setting declares is STALE and not ranked. `matrix-<name>.md` and `.json` in the project folder.
- The fake engine's `backlog` (with `max_rps`): requests past the limit queue and drain only with
  the capacity left over, so a target recovers from an overload in the time that takes.
- `docs/coverage.md`: Breakpoint, Recovery and Configuration are covered.

### Reviewed (M14)

An independent review found 13 issues, all fixed with a test and a mutant
([evidence](docs/evidence/m14-beyond-the-peak.md)):
- The matrix no longer ranks a variant that is fast because it fails (verdict, SLA errors, errors
  over the control's).
- A breakpoint is never read from a step that did not measure a transaction, or from a plan that
  fails its gates.
- A recovery overload runs under a safety bound instead of the error-rate and target-CPU
  auto-stops.
- Variant env may not set ai-perf's, Node's or path-like variables.
- Learned settings are frozen for the whole matrix, and workers, timing and auto-stop are fixed.
- No winner without the recheck or the control, nor with a lead the control's own move explains.
- Recovery windows are read on their time grid, and a transaction must come back.
- The breakpoint ceiling is the environment owner's (`env.json` `max_users`, `max_arrival_rps`).
- Matrix files of the wrong types are refused.
- A run not seen to finish stops the matrix.
- A stop after the last step and `--max-runs 0` are handled.
- The significance test gained a ms floor (`min_diff_ms`).
- Settings are masked in the report.

## [0.12.0] — M13, the target's own signals

### Added

- **Signals.** `env.json` `monitor.signals` reads the target's own metrics during a run, beside
  any metrics source: a `/metrics` endpoint in the Prometheus text format (`scrape` + `metric`,
  labels filtered by `match`), or a Prometheus query (`prometheus` + `query`). Kinds with
  default limits: `pool_used_pct`, `pool_waiting`, `db_locks_waiting`, `db_slow_queries`,
  `gc_time_pct`, `event_loop_lag_ms`, `thread_pool_queue`; `queue_depth` and `custom` take
  their own. Counters become rates; `scale` puts a reading in its kind's unit (seconds to ms,
  a ratio to %). A bearer token comes from the variable `auth_env` names.
- **Causes with evidence.** A signal over its limit at the knee is the bottleneck: "waiting on
  db_pool: a connection pool was full", with the reading against its limit. Signals read and
  quiet are named as ruled out; one never read is never claimed quiet. `analysis.md` gets a
  Signals table: the highest value, the limit, the first time over.
- **The doctor reads every signal before a run** and warns about one that does not answer, or
  whose token is not set. During the run a failing signal is one `anomaly`; one never read is the
  problem `signal_missing`. Neither changes what was measured.
- The fake engine's `max_rps`: a target that serves at most that rate, so a staircase has a knee.
- Docs: [`docs/coverage.md`](docs/coverage.md) (what ai-perf covers of performance testing,
  per test type, protocol and project kind, and what comes next), [`docs/user-guide.md`](docs/user-guide.md),
  [`docs/flows.md`](docs/flows.md), [`docs/showcase/pipeline.html`](docs/showcase/pipeline.html).

### Security

- A signal URL that carries a credential (user info, or a token in the query string) is refused,
  shown URLs drop the query string, and no signal error quotes a credential.

### Reviewed (M13)

An independent review found 12 defects, all fixed with a test and a mutant
([evidence](docs/evidence/m13-signals.md)): units that made recommended metrics look quiet, a
signal over its limit all along named as the cause, a token in a query string printed, quiet
signals not named beside a cause, a counter read once reported as never answering, run
warnings dropped, label escapes, infinite readings, formatting, the Postgres lock metric, and a
Prometheus behind a path.

## [0.11.0] — M12, the learning loop

### Added

- **Learning is automatic.** `perf report` and `perf ci` learn from every judged run: lessons,
  fixes, scorecard and the brief. `/perf-learn` is no longer a step anyone has to remember.
- **ai-perf fixes itself.** A lesson whose fix touches only the load generator gets one in
  `learned.json`: a saturated generator adds workers, a late engine start lengthens the
  rampdown, dropped arrivals raise the VU cap. The next run of the profile applies it (the spec
  file stays as written; `--no-learned` turns it off) and the run after checks it: verified, or
  recurred and a larger fix. Two recurrences, or no fix that fits, and it needs a person.
- **`perf run --until-evaluable [--attempts n]`** (and `perf ci --until-evaluable`): run, judge,
  learn, run again while a fix was taught, at most n runs.
- **The brief**: `perf brief --slug s [--step x]` and `brief.md`, what ai-perf knows about the
  project on one page capped at about 1500 tokens. Every step starts from it instead of reading
  the files.
- **Recall**: `perf share` lists the facts the team's Recall does not have yet (lessons,
  confirmed decisions, environments, baselines, capacity), one `knowledge_push` each, changed
  ones as successors; `--pushed` records them; `--import` takes in `knowledge_search` results,
  which join the brief.
- **Tool lessons back to the bundle as patches**: a lesson two projects taught writes a draft
  patch for its step's skill under `$PERF_HOME/proposals/`.
- `/perf-brief` and `/perf-share`; the fake engine's `cpu_pct_per_user`; `perf learn --reset <lesson>`.

### Reviewed (M12)

The M12 review found fifteen problems, all fixed and tested. Among them:

- The loop answered a person's stop or the target's auto-stop with another run.
- A VU cap learned by an open run could become the users of a closed run.
- A raised VU cap made open runs not comparable with their baseline.
- One fix that could not be made blocked the lesson for good.
- A stopped run could "verify" a fix.
- Settings crossed targets, and failed fixes stayed applied.
- The draft patch could land under the wrong heading.
- Recall would get duplicates and a successor after every run.
- `--no-learned` swallowed the spec path.

See docs/evidence/m12-learning-loop.md for all fifteen.

## [0.10.0] — M11, several machines

### Added

- **Workers on other machines.** `target: "ssh"` starts one `perf-agent` per worker over ssh
  (hosts in turn, key login, the token on stdin); `target: "k8s"` applies one Indexed Job with
  the token in a Secret, and deletes both at the end. `docker/agent.Dockerfile` builds the
  image.
- **The network control channel**: an HTTP server the controller opens for the run. The agent
  mirrors the worker protocol's files over it, so no engine changed. It needs the run token,
  accepts only the run's workers and files, and stamps answers with its time.
- **Clock skew**: agents report their machine's offset from the controller (`clock_skew_ms`,
  an anomaly above 1 s); the doctor measures each ssh host with a timed exchange.
- **Doctor**: each ssh host reachable with this ai-perf version and the engine; kubectl rights
  in the namespace. `perf run` refuses when a host cannot run the agent.
- `mock/fake-ssh.mjs`, `mock/fake-kubectl.mjs`: stand-ins that run the "remote" side here.

### Reviewed (M11)

The M11 review found eleven problems, all fixed and tested:

- A malformed status crashed the controller.
- The controller could kill a local process by a pid from another machine.
- "stopped" could arrive before the last window.
- One failed pod ended every pod.
- A lost controller left the Job behind.
- `~/` paths never expanded.
- A host could start with `-`.
- A worker that could not start waited out the barrier.
- Killing ssh was taken for stopping the worker.
- The doctor checked neither delete rights nor the way back to the controller.
- Smaller ones: the agent's temp folder, the skew sign and its bias, the advertised port, the
  Dockerfile.

### Reviewed (M10)

The M10 review found eleven problems, all fixed and tested:

- A failing measuring tool read as a dead target.
- The process set was frozen at the first sample.
- `match` could catch the load generator.
- pgrep spoke another regex language.
- The Linux page size was hard-coded.
- Reused pids were not noticed.
- Windows netstat output depends on the display language.
- Windows working set and shared pages were counted as memory.
- "Monitored" no longer needed a CPU sample.
- A crash on a staircase was read as capacity.
- The doctor's hint and the PowerShell cost were wrong or missing.

host-process now reads one process snapshot per sample (Windows: one PowerShell call with
`Get-NetTCPConnection` and `Win32_Process`), and samples the target once before the load.

## [0.9.0] — M10, host-process monitoring

### Added

- **`host-process` metrics**: a target running on the machine itself (not in Docker) is watched
  by pid, by the TCP port it listens on, or by its command line (all matches summed): CPU share
  and cores, memory. Linux reads `/proc` (tested in a container), Windows asks netstat and
  PowerShell (one call per sample for all processes), other posix systems lsof, pgrep and ps.
- **A target that dies stops the run**: `auto_stop:target_gone`, problem `target_gone`, verdict
  FAIL naming the process and when. A target not running before the run makes `perf run` refuse.
- Soaks judge a host process's memory like a container's.
- The worker kit takes `record(..., { correlation_id })`.
- `mock/busy-server.mjs`, a stand-in target that burns CPU and can leak memory.

### Fixed

- The analysis claimed "sampled requests with correlation ids" when the engine recorded none (k6,
  the kit). It now counts them and says how to get them.

## [0.8.0] — M9, learning and operations

### Added

- **Cleanup runs.** The data manifest's command runs after every run with the run id, is killed
  with its children on a timeout, and a failure is a WARN naming the command (`result.cleanup`, a
  `cleanup` event). `"none: <why>"` declares a target that keeps no data.
- **The measured mix is checked** against `workload.json`: an operation off its planned share by
  more than 5 pp beyond sampling noise, or requests to unplanned operations, is a WARN.
- **Doctor, design §11**: Docker and Python; generator CPU, ephemeral ports and open files for the
  planned users; the target answering (DNS named), `localhost` on Windows; unstubbed third
  parties; per project, broken files, failing gates, stale baselines, a plan out of step with the
  contract's x-perf budgets, open assumptions. `perf run` refuses when it needs Docker and Docker
  does not answer.
- **Lessons at each step**: each lesson names the step that can act on it; `perf lessons --step`,
  `perf help` and `perf run` show them. Lessons about running ai-perf are kept across projects
  (`PERF_HOME`); taught by two projects, one is proposed to the bundle.
- **Scorecard**: runs to an evaluable result per ai-perf version and profile, and why earlier runs
  were not (`perf scorecard`, `--global`).
- **Small cases go to stlc**: `perf help` says when stlc's perf tier covers the project.
- `/perf-lessons`, `/perf-scorecard`.

### Reviewed

An independent review found thirteen problems, fixed and tested (`docs/evidence/m9-learning.md`):
the mix check read closed plans as iteration shares and let a rare operation go unsent; imported
suites lost their task weights; doctor sent a request to a host the spec refused; cleanup ran
before the result was written, could leak credentials, and treated a background child as a
timeout; and smaller ones (stray files in baselines, contract drift beyond what the drafter picks,
old lessons without a step, other projects' paths in the global store, upgraded profiles
flattering a version, ranges of users).

### Fixed

- The Quick Start example and the M2 lifecycle test planned an even mix while their Locust script
  sends 6:3:1; the new mix check found it. Their workloads now plan what the script sends.
- README showed v0.6.0 and had no M7 or M8 row.

## [0.7.0] — M8, test types

Stress, capacity, spike and soak were names before; each is now a shape the engines run and a
verdict on what it is for (`docs/evidence/m8-types.md`).

### Added

- **Staircase** (`profile.steps`, `step_s`), closed or open. `result.steps` holds each step's
  numbers after a settling window. The verdict gives the capacity (the top step within the SLA), the
  headroom over the planned peak (FAIL below it, WARN under 20 %), a Capacity table, and a capacity
  regression against a promoted staircase. An auto-stop is where it broke, not a FAIL.
- **Spike** (`profile.spike`). `result.spike` holds the base, the peak and the recovery time.
  Transactions are judged on the base; recovery against `slo.json spike.recovery_s` (default 30 s).
- **Soak drift.** `result.drift` fits a Theil–Sen line through steady p95 and each container's
  memory; a soak fails above `slo.json soak` limits (defaults 20 % and 10 %).
- **A business summary**: one sentence first in `verdict.md` and last in `perf report`.
- k6 stages, the k6 arrival scenario and the Locust shim follow steps and spikes.
- The fake engine's `drift` fault (latency growing with run time).

### Reviewed

An independent review of the milestone found twelve problems, all fixed and tested
(`docs/evidence/m8-types.md`): a stopped staircase or spike blamed the target; Theil–Sen was
quadratic (a day-long soak would block the controller); Locust accepted an open staircase; steps and
spikes off window edges mixed two loads; recovery passed on one window; whole-run checks judged a
staircase; staircases skipped the baseline gates; a 4-window soak could fail on noise; the summary
could contradict a NOT EVALUABLE outcome.

### Fixed

- The knee needs the offered load to have grown: a soak's drift is no longer read as saturation.
- The Locust shim no longer evaluates a step outside steady (it crashed a staircase in warmup).
- A docker command that cannot start (`EFTYPE`) is no sample; it killed the controller. A `.cjs`
  stand-in runs under node.

## [0.6.0] — M7, measure honestly

This milestone comes from two reviews of the whole product (`docs/evidence/m7-integrity.md`): an
audit against the five pillars, and a principal performance engineer's review. Under a server
that froze for 3 s in every 10 s, the engineer measured p95 56 ms (PASS) closed against 2588 ms
open.

### Added

- **The open model is executed.** `profile.arrival_rps` runs k6 `ramping-arrival-rate` (and the fake
  engine). Engines that run closed loops refuse it. Arrivals k6 drops in steady make the run
  degraded (`arrival_shortfall`).
- **A closed loop's heavy tail cannot pass.** p99 more than 10× p95 is a WARN that names
  coordinated omission. `p99_ms` is judged when the plan sets it.
- **Regressions above noise.** A baseline keeps its histograms. A p95 change counts only when the
  95 % lower bound of a bootstrap still clears PS-F2: no false regressions in 20 same-distribution
  pairs of 100 requests, where the point rule gave about 25 %.
- **Gates are enforced.** A load verdict passes only when the plan, model, env and data gates pass.
- **Approval.** A host other than this machine needs `approval: { by, at, hosts }`, at most 90 days
  old, covering that host. Every environment needs an owner at run time.
- **Default auto-stop.** A run with no rule stops when the error rate is above 50 % for 30 s. The
  verdict says so.
- `mock/server.mjs` can stall (`MOCK_STALL_EVERY_S`, `MOCK_STALL_S`).

### Fixed

- The fingerprint read `target.arrival_rate`, while the gate uses `arrival_rps`: an open-model
  rate change never made a baseline stale.
- From an independent review of M7:
  - With `ramp_s: 0`, k6's steady phase was really a ramp, in both models. A zero-length ramp is
    now a 0 ms jump.
  - An open baseline was compared across different arrival rates, and with closed runs. The
    run now records its model and rate, and both must match.
  - The bootstrap rule weakened PS-F2: a true +12 % change was never flagged, and was called
    "noise". Now PS-F2 sets the size and the bootstrap tests significance (lower bound above 0)
    over the true n.
  - A draft environment blocked every verdict. The env gate now judges the run's own
    environment.
  - `approval.hosts` given as a string matched by substring; it must now be a list.
  - Heavy-tail false positives: it needs 200 or more requests, and it is not raised when the
    plan judges p99.
  - k6 rates are per minute, split exactly over workers: 0.3 rps on ten workers was 0.
- The README promised "any scale" and Gatling runs. It now says one machine, and import-only for
  Gatling and JMeter. The design marks the rollup, `slo_breach` and cleanup as not built.

## [0.5.0] — M6, dogfood on fx-blog

ai-perf ran its whole lifecycle on fx-blog, a production Next.js build on Postgres with its G8
volume seed, in a scratch copy with its own database:
- discover, import, contract, plan, model, env, data;
- script (Locust), smoke, load, analyze and report;
- promote, compare, learn, CI and trend.

It ran a parity check against fx-blog's own load script on the same app: `listPosts` p95 77.0 ms
against 76.4 ms. The findings are in `docs/evidence/m6-dogfood.md`.

### Added

- **`perf contract`**: an OpenAPI contract's `x-perf` budgets and traffic classes become the draft
  `slo.json` (SLA = the budget, SLO 20 % stricter) and `workload.json` (closed at each class's
  concurrency, with Little's law at the peak). Read without a YAML parser.
- Discover reads the system kind from the contract's traffic, instead of asking.
- Discover lists in-house load scripts (`tests/perf/load.mjs`), and import says what to do with
  them.
- The verdict and `perf compare` say when two runs are the same build under the same fingerprint:
  the difference is then the environment's noise.
- The verdict names error-rate limits that are defaults beside contract budgets.

### Fixed

- `docker stats` CPU was read as a percentage of the machine. A database using 1.2 cores of 16 read
  as 118 % and auto-stopped a healthy run with a FAIL. It is now the share of the CPUs the
  container may use.
- The bottleneck hint said "the target is waiting" when only the database was monitored. It now
  names the containers it watched, and leaves room for the parts it did not watch.
- From an independent review of M6 (`docs/evidence/m6-dogfood.md`):
  - The YAML reader could file a response link's or a webhook's `operationId` and `x-perf`
    under the last operation. It now reads operations under `paths` only, each one's own keys
    only, and refuses what it cannot place.
  - Writes without an `operationId` were left out of the system-kind estimate.
  - Flow-form classes, block `x-perf`, inline comments and quoted paths were misread silently.
  - A DataLoader, a `loadConfig.js` or a micro-benchmark counted as an in-house load suite.
  - Little's law in the draft held by construction. It now gives the rate the loop drives,
    and warns at 3× the peak.
  - CPU limits set by quota or cpuset were ignored, and a failed `inspect` was cached. The
    per-core figure is now kept, so a pegged single-threaded target is not cleared.
  - Uncommitted changes at the same sha counted as "the same build".

## [0.4.0] — M5, realtime

### Added

- **`ws` engine**: WebSocket games and realtime systems, with no dependency (it uses Node's
  built-in WebSocket).
  - One virtual user is one player, running the product's player script.
  - Each request is timed by its reply; `connect` is an operation.
  - Drops, reconnects, players online and tick lag go into a new `realtime` result block.
- **Worker kit** (`adapters/engines/kit.mjs`, `docs/engine-kit.md`): the worker protocol for
  in-house engines (TCP, UDP, message buses). Its I/O does not block the event loop.
- **Realtime verdict**: `slo.json` `realtime` judges tick lag p95 and drops per minute as an SLO
  and SLA, plus the share of players that must stay online. Realtime that is measured but not
  planned is reported but not judged.
- **Generator event-loop lag**: a worker whose loop runs more than `timing.loop_lag_ms` late is
  saturated, so the run is NOT EVALUABLE (D13).
- `mock/game.mjs` (a WebSocket game server with a fixed-timestep tick and optional lag, drops and
  errors) and `mock/game-player.mjs`.
- `docs/perf-standard-v1.1-draft.md`: section L (realtime) and the additions found in M3–M4.
  The MR to stlc has not been opened; that is Luan's call (D1).
- Realtime rows in the symptom → bottleneck reference.

### Fixed

- From an independent review of M5 (`docs/evidence/m5-review.md`):
  - A refused request was handled as a drop: the player reconnected, and the CCU check failed for
    the wrong reason.
  - Realtime in the plan with none measured, or a tick-lag SLO with no ticks, gave a quiet PASS.
  - Idle players counted as offline, and a worker that never filled its share hid every dip.
  - The ws engine on the docker target could not reach a target on the host.
  - A wrong or rounded announced tick hid lag or grew it without bound.
  - The plan gate accepted limits nobody judges.
  - A connect that never finished the handshake hung.

## [0.3.0] — M4, operations

### Added

- **`perf ci`** (`/perf-ci`): the regression gate. It runs, analyses and reports in one command and
  exits with the verdict. A refused spec keeps exit 2. It writes JUnit (`--junit`) for the
  pipeline. `ci/gitlab-ci.perf.yml` is a sample smoke job.
- **`perf compare`** (`/perf-compare`): two done runs side by side, like with like only.
- **`perf trend`** (`/perf-trend`): flags steps past PS-F2 (unless a later run fixed them), and
  **slow decay** that no single step shows: a Theil-Sen line over the recent runs (at least 5, the
  last 8 since the last step) moving more than 12 %.
- **Run fingerprints and STALE baselines**: each run records, when it starts, what it is
  measured under: workload, architecture, environment stubs, script and data. A baseline
  measured under another fingerprint is STALE, so nothing is compared and `--bootstrap --promote`
  moves on. Compare and trend apply the same rule.
- **`perf learn`** (`/perf-learn`): lessons from every judged run, with stable ids.
  - A later verdict says "seen before".
  - The skill pushes new lessons to Recall and proposes a lesson seen in two projects back to the
    bundle.
  - `perf help` routes through it before the next run.
- Skills `gating-perf-in-ci`, `comparing-perf-runs` and `learning-from-perf-runs`.

### Changed

- Run ids carry milliseconds, so runs started in the same second sort in start order.
- `--run` given twice is accepted only by `perf compare`.

### Fixed

- From an independent review of M4 (`docs/evidence/m4-review.md`):
  - A STALE baseline still added its regressions, and the way out it named could not promote.
  - The fingerprint went stale on sources, thresholds and hosts, and missed stubs, scripts and
    data; it is now taken at run time.
  - Trend missed noisy, late or post-step decay, and flagged a fixed step forever.
  - `perf ci` could judge another run of the same slug.
  - "Seen before" missed repeated regressions, and could cite later runs.
  - The CI skill gave a promote command that could not work, and the sample job did not wait
    for the mock.

## [0.2.0] — M3, existing suites

### Added

- **k6 engine** through a sidecar worker (design D10). k6 starts paused before the barrier and is
  resumed at `go_at` through its REST API. The run profile becomes k6 stages, split exactly over
  workers. Each request point is placed in its window by its own time. Generator CPU is k6's own.
  k6 runs from `PERF_K6`, from `k6` on PATH, or from `grafana/k6:1.0.0` under Docker.
  - It was added with no change to any skill or command (P5, measured by diff, commit 499bc42).
- **`/perf-import`** (`perf import`):
  - reads k6, Locust, Gatling and JMeter suites without changing them: operations, weights, think
    time, peak users, and thresholds;
  - writes draft `workload.json` and `slo.json` (`source: imported`), but only where none
    exist, and a run spec for each suite ai-perf can run;
  - keeps old results (k6 summary, Locust CSV, perf-result/v1) as reference, never as a baseline;
  - has a gate, `perf check import`.
- **`/perf-audit`** (`perf audit`): scores a suite against perf-standard and ranks its fixes,
  each with its rule, lines and fix. Eleven rules: secret, production host, shared account,
  averaged percentiles, nothing that can fail, no checks, no warm-up, no think time, unnamed
  requests, hardcoded host, and fixed think time.
- `examples/legacy-suite`: a k6 and a Locust suite with planted defects, which the audit must find.
- `perf help` routes an existing suite through import → audit → plan.

### Changed

- Gatling suites are imported and audited but not run (design D11).
- The verdict also marks SLOs whose source is `imported` as not agreed.
- Failed business checks that an engine evaluates beside the request (k6 `check()`) are counted
  in `result.checks` and judged as failures (PS-B8, PS-D3).

### Fixed

- From an independent review of M3 (`docs/evidence/m3-review.md`):
  - k6's start-up lag no longer puts ramp load into the steady windows. A lag too long to absorb
    degrades the run, and `setup()` requests are no longer counted as load.
  - A sidecar that dies no longer leaves k6 loading the target. The controller stops the child
    at once, and doctor finds and removes it.
  - Unnamed k6 requests are keyed without their query string, and masked.
  - Import keeps tuned run specs, writes one per suite, maps thresholds per operation, and
    fails its gate on unnamed requests.
  - The audit's shared-account rule no longer fires on payload data.
  - `/proc` CPU is a share of the machine.

## [0.1.0] — M2, the lifecycle on HTTP

### Added

- **Lifecycle.** `perf discover | check | watch | analyze | report | help` and twelve skills with
  their commands: `/perf-start`, `/perf-discover`, `/perf-plan`, `/perf-model`, `/perf-env`,
  `/perf-data`, `/perf-script`, `/perf-run`, `/perf-watch`, `/perf-analyze`, `/perf-report`,
  `/perf-help`, and the shared `perf-protocol`.
  - Each step has a gate over the JSON file it writes (CONTRACTS §8).
  - `discover` follows the asking policy: it reads the repo first, asks at most three questions,
    each with a proposed answer, and logs every unconfirmed value as an assumption.
  - `report` gives PASS, WARN, FAIL or NOT EVALUABLE against SLOs, SLAs and the baseline, with
    systemic or localized regressions, `--bootstrap` and a guarded `--promote` (§9).
  - `analyze` gives the per-window timeline, failures by category with sampled correlation ids,
    and the knee, CPU-bound or waiting.
  - `watch` wakes the AI on events only, within a budget per hour.
- **Locust engine.** A shim makes each standalone Locust process an ai-perf worker. Its bucket and
  window arithmetic is checked against the Node implementation.
- **`docker` target.** One container per worker, run folder bind-mounted. **`docker-stats`
  metrics** for the target, and an auto-stop rule `target_cpu_pct`.
- **Environment file** `.perf/<slug>/env.json` owns the allowlist, allowed profiles (PS-A2),
  owners, parity, third-party stubs and monitoring. A run spec can no longer carry its own
  allowlist.
- Worker protocol:
  - clocks are aligned to the controller (offset from heartbeats);
  - stalls are reported and never caught up; a stalled worker makes the run degraded;
  - failed requests are sampled with correlation ids;
  - `AI_PERF_WORKER(S)` give each script its data partition.
- `mock/server.mjs` (the bundled target) and `examples/quickstart`.
- References: asking policy, workload modeling, and symptom → bottleneck.
- **Five-pillar checks** (`docs/evidence/m2-pillars.md`):
  - `tests/exam.test.mjs` is an exam of known-answer bottleneck and failure cases (P1);
  - the second run's verdict cites the first run's baseline (P2);
  - `tests/quickstart.test.mjs` runs the README's Quick Start commands as written on a clean copy
    (P5);
  - `perf run` prints a cost estimate, and the verdict records estimated vs actual and warns on a
    large gap (P5).

### Changed

- A baseline is compared only like with like: the same environment, profile, load tool, target
  and user count. Otherwise the verdict is NOT EVALUABLE. The Quick Start promotes the Locust run,
  never the fake engine's simulated numbers.
- A profile named `smoke` is at most 10 users and 300 s; a larger one can no longer pass the smoke
  gate or an environment that allows only smoke.
- `perf help` names only commands the bundle has. It sends a NOT EVALUABLE run back to be fixed,
  not on to the next profile.

### Fixed

- From an independent review of M2:
  - A container that yielded no metrics (a misspelt name, docker down) silently disabled the
    `target_cpu_pct` auto-stop. It is now reported at once and makes the run degraded.
  - Steady-state rps was computed over the windows that held samples. A hung target produced no
    window files, so its rps came out inflated. Rates now use every planned whole window.
  - The Locust shim took HTTP codes from digits in the error text (`127.0.0.1` read as "HTTP 127").
    It now takes them from the response.
  - The shim wrote error text unmasked, and the doctor never scanned it or a load script kept
    outside `.perf/`. Both are now masked and scanned.
  - The shim read `warmup_users: 0` as the default.
  - `no_measured_window` was never recorded.
  - `perf report` crashed (exit 1) on a run without `result.json`; it now returns NOT EVALUABLE
    (exit 3).
  - `--wait` could give up on a healthy run while docker was still starting containers.
  - `result.workers[]` lacked `stalled`.
- Three guards had no test that could fail them (surviving mutants); each one has a test now. The
  mutation runner rejects an unknown mutant name instead of reporting "all killed" after running
  none.

- Engine detection ran inside the controller and blocked its heartbeat; it now runs in `perf run`.
  The controller's output goes to `controller.log`.
- The `docker` target started containers synchronously and froze the heartbeat; it is async now.
- `commands/perf-status.md` had invalid frontmatter (an unquoted `: `). `tests/bundle.test.mjs`
  now checks every skill and command.
- The test suite runs at most two files at once: it is itself a load generator, and starving its
  own workers produced false stalls.

## [0.0.1] — M1, the controller core

### Added

- **M1 controller core.** `perf run|status|stop|doctor` (`bin/perf.mjs`); a detached controller that
  drives workers through a barrier start and the warmup → ramp → steady → rampdown phases, keeps a
  heartbeat workers stop on, flags lost and saturated workers, applies hard auto-stop rules, emits
  events, and merges `perf-hist/v1` histograms over the steady window into `perf-result/v1`.
  Adapters: the `fake` engine (scripted latency, errors and faults) and the `local` target.
  `/perf-doctor` and `/perf-status`. Contracts in `CONTRACTS.md`. 53 tests; `npm run mutate`
  kills 49 of 49 mutants.
- Hardening from an independent review: numbers must be JSON numbers; timings are checked against
  each other; credentials in `target_url` and production-looking hosts are refused; windows start
  where steady starts; a run stopped early is measured up to the stop and whole-run rps uses the
  time load ran; generator CPU counts only in the measured window, at the sample's own time; a
  worker that cannot start ends the run at the barrier; a worker that does not confirm the stop
  makes the run degraded; the controller has a hard deadline; `perf stop` acts on live runs only;
  `--wait` has a deadline and sees a controller that never started; the doctor scans run folders
  and four more credential shapes, and `--fix` no longer kills a pid that may have been reused.
- Second review pass: the controller keeps beating while it reads window files, and gets a longer
  grace while collecting; `perf stop` never targets a run whose controller is lost; every name or
  host label starting `prod`/`prd` is refused again; `cpu_max_pct` is `null` when nothing was
  measured; a stale worker pid is never killed; a run folder without a pid file yet is `starting`.
- `docs/design.md`: scope, lifecycle and commands, the four adapter axes, controller and event
  model, contracts, the perf-standard v1.1 proposal, asking policy, doctor and help, operations,
  five pillars, roadmap and open decisions.
