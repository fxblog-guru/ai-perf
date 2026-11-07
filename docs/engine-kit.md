# Writing an in-house engine

Some systems cannot be loaded with Locust or k6, for example:
- a game's own TCP or UDP protocol;
- a message bus;
- a device fleet.

For those, write an **in-house engine** on the worker kit (`adapters/engines/kit.mjs`). The kit
does everything the worker protocol asks (CONTRACTS §3), so the engine only has to speak to the
target.

`adapters/engines/ws/` is the worked example: a WebSocket engine that runs a game's player script.

## What the kit does for you

- the barrier: no load before `go_at`, on the controller's clock (offset from heartbeats);
- stopping on `control.stop`, on a lost heartbeat, or at the hard end, flushing data first;
- `status.json` every tick: users, requests, failures, error classes, stalls, CPU, event-loop lag;
- perf-hist windows per operation, by the time each request started;
- realtime counters: players online, drops, reconnects, tick lag;
- error samples, masked (`lib/mask.mjs`);
- stall detection: a frozen worker is reported and never caught up;
- its own file I/O never blocks the event loop, so receive timestamps stay true.

## What the engine does

```js
// adapters/engines/<name>/worker.mjs
import { runWorker } from '../kit.mjs';
const [runDir, index] = process.argv.slice(2);

await runWorker({
  runDir, index: Number(index),
  // Called once, at go_at. Keep ctx.users() virtual users running; return an async stop().
  async start(ctx) {
    // ctx.users(): this worker's exact share of the profile's users right now
    // ctx.record(name, ms, { failed, cls, error, correlation_id }): one request, timed by its reply;
    //   correlation_id (the X-Request-ID it sent) lets a failure be found in the server's logs
    // ctx.connected(+1 | -1), ctx.drop(), ctx.reconnect(), ctx.tickLag(ms): realtime
    // ctx.t(): seconds since go_at; ctx.running; ctx.options (spec.engine_options)
    return async () => { /* close sessions */ };
  },
});
```

Then add an `adapter.mjs` with:
- `name` and `tool`;
- `detect()`;
- `workerCommand()`;
- optionally `containerCommand()`.

Register it in `adapters/index.mjs`. No skill changes: engines are a parameter (design §5), and
adding k6 changed none.

## Rules the measurements must follow

- **Time a request by its reply**, from send to the matching response. A timeout or an error reply
  is a failure with a class: `Timeout`, `ConnectionError`, `<protocol> error: <code>`.
- **Name operations after the protocol's message types** (PS-D4), not after ids.
- **A drop is a connection the server cut.** One the player closed is not a drop. The next
  successful connect after a drop is a reconnect. A refused request or a script error is a failure
  of that request, never a drop: keep the player online.
- **Tick lag is lateness against the server's own schedule**: arrival minus the earliest arrival
  the recent ticks allow, at the period measured over the session, not the announced one. A gap
  after a late tick is not counted as early.
- **Bound every wait**: a connect or a request that never answers fails after `timeout_ms`.
- **Never block the event loop in the engine.** The kit reports the loop's lag. Over
  `timing.loop_lag_ms` (100 ms) the worker is saturated and the run is NOT EVALUABLE, because its
  timestamps describe the worker.

## Testing an engine

Copy `tests/ws.test.mjs`. It needs a mock of the protocol (`mock/game.mjs`, a WebSocket server in
plain Node, is the pattern). Show, with a test each:
- every operation is measured;
- realtime counters move when the mock drops players or lags ticks;
- a lost controller stops the workers;
- a blocked event loop is caught.
