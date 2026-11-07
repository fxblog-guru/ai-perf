# M5 evidence: realtime

## Checks

| Check | Result | How to rerun |
|---|---|---|
| Tests | 183 pass, 0 fail | `npm test` |
| Mutation | 175 of 175 killed | `npm run mutate` |
| Exit check: a WebSocket run against a mock, with CCU and reconnect metrics | 20 players on 2 workers against `mock/game.mjs`: CCU 20/20 held, every operation measured, tick lag recorded; with the server dropping players, the run records drops and reconnects and fails a drop SLA | `node --test tests/ws.test.mjs` |

## What M5 added

- **The worker kit** (`adapters/engines/kit.mjs`, guide in `docs/engine-kit.md`). It holds the
  worker protocol for in-house engines: the barrier, the clock, stop rules, stalls, windows,
  realtime counters, masked error samples, CPU and event-loop lag. Its I/O is non-blocking.
- **The `ws` engine**: WebSocket games on Node's built-in client, with no dependency. One virtual
  user is one player script. Each request is timed by its reply, and drops, reconnects, players
  online and tick lag are counted.
- **Realtime in the verdict** (`slo.json` `realtime`): tick lag p95 and drops per minute as SLO
  and SLA, and the share of players that must stay online.
- **Generator event-loop lag as saturation** (D13), found while building the engine. With the
  kit's file writes synchronous, the worker's own event loop pushed tick lag p95 to 106 ms, while
  a bare client on the same machine measured 21–28 ms. Two changes followed: the kit's I/O is now
  non-blocking, and a worker whose loop runs more than 100 ms late makes the run NOT EVALUABLE.
- `docs/perf-standard-v1.1-draft.md`: section L (realtime) and the extensions from M3–M4. The MR to
  stlc has not been opened; that is Luan's call (D1).

## Independent review

An independent reviewer, given the paths and the design, ran scratch tests against
`perf run` / `perf report` and the game mock. It confirmed nine findings. All nine are fixed, each
with a test that fails on the old code (a mutant in `tests/mutate.mjs`).

| # | Severity | Finding | Fix | Test (mutant) |
|---|---|---|---|---|
| 1 | high | A refused request or a script error was handled as a drop. The player reconnected (30 reconnects, 0 drops), and CCU fell to 13 of 20: a false FAIL | Only a server cut leads to a reconnect. A failed request keeps the player online, and the script runs again on the same session | `refused requests are failures, not drops…` (`ws: a refused request is not a drop`) |
| 2 | high | A realtime block in the plan with no realtime measured gave a quiet PASS | NOT EVALUABLE: "realtime is in the plan but this run measured none" | `realtime in the plan but not measured…` (`verdict: planned realtime unmeasured`) |
| 3 | high | A tick-lag SLO (no SLA) with no ticks measured was silent | NOT EVALUABLE for any planned limit left unmeasured | same test (`verdict: SLO-only limit unmeasured`) |
| 4 | high | A worker with no events in a window wrote no file, so its idle players counted as offline: a false CCU FAIL | The kit writes every window it runs through, with its player count | `idle players are online…` (`kit: idle windows counted`) |
| 5 | medium | A worker that never filled its share never started its minimum, which hid every dip | The minimum is held from full share, or one window into steady at the latest | `a worker that never fills its share…` (`kit: held one window into steady`) |
| 6 | medium | ws on the docker target dialled `127.0.0.1` inside the container | The target reaches the worker as `AI_PERF_TARGET_URL`, rewritten to `host.docker.internal` | `docker target: ws players in containers…` (`ws: target url in containers`) |
| 7 | medium | Tick lag used the announced period, so a rounded announcement hid lag and a wrong one grew it without bound | The period is measured over the session, lag is recorded only once it is known, and a mismatch is noted in the verdict | `a server that announces the wrong tick…` (`ws: tick period measured`) |
| 8 | low | The plan gate accepted limits nobody judges (`tick_lag_ms`) and any `ccu_hold_pct` | Only the judged keys are accepted, and `ccu_hold_pct` must be in (0, 100]. The discover default was renamed `tick_lag_p95_ms` | plan gate test (`gate: only judged realtime limits`, `gate: ccu hold in range`) |
| 9 | low | No connect timeout: a server that never finished the handshake hung the player | The connect fails with `ConnectTimeout` after `timeout_ms` | `a server that accepts TCP but never finishes the handshake…` (`ws: connect timeout`) |

Things the reviewer checked and found sound:
- request/reply correlation: timeouts clean up, late replies are ignored, nothing is counted
  twice on a drop;
- drop versus intentional close;
- the kit's stop path, heartbeat-lost, hard end and stalls with async I/O;
- the merge's steady-only window selection;
- the controller gating loop-lag saturation on the measured window;
- the mock's framing (masking, 16- and 64-bit lengths, ping/pong, close echo).

## Known limits

- `ccu_max` sums each worker's peak within a window, so it can read slightly above the true
  instantaneous peak. The hold check uses `ccu_min`, which can only err low.
- The mock ignores fragmented frames: Node's client does not fragment.
- Tick lag needs about a second of ticks per session before it is recorded.

## Final run

- `npm test`: 183 tests, 183 pass, 0 fail (Windows 11, Node 24; Locust, k6 and Docker tests ran, none skipped).
- `npm run mutate`: 175 of 175 mutants killed.
