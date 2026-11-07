---
name: generating-load-script
description: Use to write the load scripts for the chosen engine from the workload model - journeys, business checks, auth, data (/perf-script).
---

# Generating the load script

Follow [perf-protocol](../perf-protocol/SKILL.md). Write the script for the engine in
`.perf/<slug>/scripts/<engine>/`, or reuse an imported suite.

## Locust

`mock/locustfile.py` is the pattern:

- **One User class per persona.** `weight` is the persona's share. `wait_time` is the think time.
- **One task per journey step, in order.** `name=` is the operationId (PS-D4).
- **Correlation**: ids and tokens from one response feed the next request (PS-B2).
- **Business checks**: `catch_response=True` and `r.failure("...")` when a 2xx means failure
  (PS-B8).
- **Auth**: per user, in `on_start`. Re-login on 401 (PS-B7).
- **No load shape** in the script. ai-perf's shim owns the profile, the workers' shares and the
  barrier.

## k6

`mock/k6-load.js` is the pattern:
- **Name every request** with `tags: { name: '<operationId>' }`.
- **Check the business outcome** with `check()`. Failed checks count as failures.
- **Read the target** from `__ENV.BASE_URL`.
- **Keep `setup()` short.** k6 starts its load after it, and a lag longer than the rampdown
  degrades the run.

## WebSocket and games (engine `ws`)

`mock/game-player.mjs` is the pattern. One virtual user is one player (design §6.2).
- **The script** exports `async function player(vu)` that plays one session.
- **What the engine owns:** it opens the session, times each `vu.request(type, payload, name)`
  by its reply, counts drops and reconnects, and measures tick lag from the server's ticks.
- **Name requests** after the game's message types (PS-D4).
- **Log in per player** with `vu.user`, which is unique per worker (PS-B7).
- **Loop while `vu.running`**, with `vu.think(min, max)` between moves.
- **Never block** with busy loops or synchronous work: a late event loop makes the run NOT
  EVALUABLE.
- **Another protocol** (TCP, UDP, a message bus) needs an in-house engine on the worker kit:
  `docs/engine-kit.md`.

The fake engine needs no script. Its `engine_options` script latency and faults for practice
runs.

## Prove it

Run a smoke: `perf run <spec>` with `"profile": {"name": "smoke", "users": 4, "warmup_users": 4,
"warmup_s": 30}` and `--wait`. Make it long enough that every operation runs: the gate checks it.

Gate: `perf check script --slug <slug>`: a clean smoke that ran every workload operation.
Next: `/perf-run`.
