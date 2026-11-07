# perf-standard v1.1: draft proposal from ai-perf

**Status: draft.**
- The canonical standard lives in stlc. Per design decision D1, this proposal goes there as a
  merge request, and opening that MR is Luan's call.
- Until it is merged, ai-perf documents these extensions here and keeps `perf-result/v1`
  byte-identical to stlc's copy: every field below is optional and additive.

## L. Realtime (new section)

| ID | Level | Rule | Evidence |
|---|---|---|---|
| PS-L1 | MUST | WebSocket and game tests record the players online (CCU) over the measured window: the highest count and the lowest count held | `realtime.ccu_max`, `realtime.ccu_min` |
| PS-L2 | MUST | Message round trip is timed per message type, from send to the matching reply, as an operation with percentiles (PS-D2, PS-D4) | `endpoints.<type>` |
| PS-L3 | MUST | Connections the server cuts are counted as drops, and successful reconnects after a drop are counted | `realtime.drops`, `realtime.reconnects`, `realtime.drops_per_min` |
| PS-L4 | MUST | Tick lag is the lateness of each server tick against the server's own schedule (seq × interval), merged as a histogram, never averaged | `realtime.tick_lag_ms` p50/p95/p99/max |
| PS-L5 | MUST | The plan states realtime limits (tick lag p95, drops per minute, the share of players that must stay online), and the gate judges them like SLOs and SLAs | `slo.json` `realtime` |
| PS-L6 | MUST | A load generator whose event loop is late (it timestamps late) is saturated: the run is NOT EVALUABLE (extends PS-A5) | `generator_saturated` with the loop lag |

## Additions to existing sections

| ID | Change |
|---|---|
| PS-D3 | Business checks an engine evaluates beside the request (a k6 `check()`) count as failures (`checks.failed`) |
| PS-F3 | A baseline is compared only when the run was measured under the same workload, architecture, environment stubs, script and data (`run.fingerprint`); otherwise it is STALE |
| PS-F5 (new) | Trends are judged over the recent runs with a robust line (Theil–Sen), so a slow decay under the per-step limit is flagged and one noisy run neither makes nor hides it |
| PS-G1 | `perf-result/v1` gains optional `realtime`, `checks`, `run.users`, `run.fingerprint`, `problems`, `workers[]` and `hist` |

## Why

Without L, a WebSocket or game test reports message latency and nothing else. Yet a game can
look fast while it fails in three ways:
- it drops players;
- its ticks run late;
- it cannot hold the planned number of players online.

The additions to D, F and G come from defects ai-perf's own reviews found in M3 and M4:
- a 200 response with a failed check passed;
- a baseline taken under another workload was compared;
- a slow decay was invisible to step-by-step comparison.
