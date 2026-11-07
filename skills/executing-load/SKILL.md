---
name: executing-load
description: Use to start a load run - the run spec, workers and target, auto-stop rules, cost estimate, detached start (/perf-run).
---

# Executing load

Follow [perf-protocol](../perf-protocol/SKILL.md). Write the run spec (CONTRACTS §1), then start
it:

```json
{ "slug": "shop", "engine": "locust", "script": ".perf/shop/scripts/locust/locustfile.py",
  "target": "local", "workers": 4, "environment": "staging",
  "target_url": "https://api.staging.example.com",
  "profile": { "name": "load", "users": 200, "warmup_s": 60, "ramp_s": 120, "steady_s": 600, "rampdown_s": 30 },
  "auto_stop": [{ "metric": "error_rate", "above": 0.05, "for_s": 30, "min_requests": 200 }],
  "watch": { "max_wakes_per_hour": 12 } }
```

1. **Workers**: enough that none exceeds 80 % CPU (PS-A5). A saturated generator makes the run
   NOT EVALUABLE. Use `target: docker` for container workers. When one machine is not enough
   (its workers saturate, or the doctor says ports or file descriptors will run out), put
   workers on other machines: `target: ssh` with `ssh.hosts` (Node, ai-perf and the engine on
   each; key login), or `target: k8s` with `k8s.namespace` and an image from
   `docker/agent.Dockerfile`. Both need `channel.advertise`, this machine's address on their
   network (CONTRACTS §3b). `perf doctor --spec` checks each host and its clock first.
2. **Open or closed**, as the model says. For an open model, set `profile.arrival_rps` and a VU
   cap (`users`) large enough to wait out a slow server: arrival rate × the longest iteration
   expected (its requests at their worst latency plus any `sleep()` inside it). k6 runs it; dropped arrivals make the run degraded.
3. **Auto-stop** from the SLA, always. It runs in the controller within seconds, whatever you are
   doing.
4. **Cost** before starting: the duration (warmup + ramp + steady + rampdown), the workers, and
   about one wake per notable event. `perf run` prints its estimate and the verdict notes a run
   that took far longer. Get a yes for anything over 30 minutes.
5. `perf run <spec>` returns at once; the controller runs detached. Do not wait in a loop: go to
   `/perf-watch`.
6. `perf run` refuses an unknown host, a disallowed profile, an unstubbed third party, a missing
   engine, a secret in the load script or the run evidence, a smoke larger than 10 users or 300 s,
   or production. Fix the cause; never bypass it.
7. With `monitor.containers` set, a container that yields no metrics is reported at once
   (`anomaly`) and makes the run degraded: check the names in `env.json` before a long run.

CI: `perf run <smoke spec> --wait` exits 0 done, 3 not evaluable, 4 degraded, 5 aborted. Then
`perf report` exits 0 PASS or WARN, 1 FAIL, 3 NOT EVALUABLE.

**Fixing itself.** `perf run` applies what earlier runs of the profile taught (`learned: …` on
stderr; `--no-learned` to run the spec as written). `perf run <spec> --until-evaluable
[--attempts n] [--bootstrap]` runs, judges and learns, and runs again while a run taught a fix
ai-perf may make itself (more workers, a longer rampdown, a higher VU cap), at most n runs
(default 3, at most 5). State the cost of every attempt before starting. It stops at the first run
that taught nothing to fix, at a lesson that needs a person, and at any run that was stopped (by
a person or an auto-stop): a stop is never answered with another run. Its exit is the last
verdict's (0 PASS or WARN, 1 FAIL, 3 NOT EVALUABLE).

**Finding the breakpoint.** A stress staircase with `profile.breakpoint: { factor?, max }`, `max` at
most the ceiling the environment's owner set in `env.json` (`max_users`, `max_arrival_rps`; none
set, no search), and `perf run <spec> --breakpoint [--max-runs n]
[--bootstrap]`: when every step held, the next run climbs on from the last step that held, each
step `factor` (default 1.5) above the one before, the last one cut at `max`. It stops at the first
step that breaks, at a generator that saturates (the generator, not the target, is the limit: add
workers or machines and search again), at the ceiling, after n runs (default 3, at most 6), or at
a run that cannot be read. Each run is an ordinary run with its own folder and verdict. The
search is in `.perf/<slug>/breakpoint.md`: the last step that held and the first that broke, each
with its run. State the cost first: n runs of the staircase.

**Scaling across instance counts.** `perf scale <scale.json>` (or `perf scale <spec> --instances
1,2,4 --command "docker compose up -d --scale api={n}"`) runs, for each count, the command that
deploys it, waits until the target answers below 500 (`ready.url`, default the target URL, at most
`ready.timeout_s`, default 120 s), then the staircase, its steps times n (`"steps": "same"` keeps
them). The command runs without a shell: `{n}` is only ever a whole number, and a pipe or `&&`
belongs in a script it calls. State the cost first: one staircase per count, plus each deploy.
The report is `.perf/<slug>/scale-<name>.md`: capacity per count, the scaling efficiency
capacity(n) / (n × capacity(1)), and per count linear (0.8 or more), sublinear, flat (a shared
bottleneck, named when a signal shows it), generator (the generator, not the target, was the
limit: add workers) or unknown (only "at least" was observed). Say it in those words; never turn
an "at least" into a capacity.

**Volume.** With a `volume` plan in `data/manifest.json`, `perf run` counts the data before every
run but a smoke and prints `volume: at volume` or `NOT at volume` with the counts. Before a
`volume` run that says NOT at volume, seed (`perf volume --slug <slug> --seed`) instead of running:
the verdict would be NOT EVALUABLE.
