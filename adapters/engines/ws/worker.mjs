// One WebSocket worker. The kit speaks the worker protocol; this file only plays: it keeps this
// worker's share of the profile's players online, each running the product's player script
// (CONTRACTS §3a), and turns what happens on the wire into measurements:
// - each request/reply pair is an operation, timed from send to reply (a timeout or an error reply
//   is a failure);
// - connecting is the operation `connect` (it fails on an error or after timeout_ms);
// - a connection the server cuts is a drop; the player reconnects with backoff, and the next
//   successful connect after a drop is a reconnect. A failed request is not a drop: the player
//   stays online and its script runs again on the same session;
// - each server tick's lateness is tick lag, against the server's measured tick period.
import { pathToFileURL } from 'node:url';
import { readJson, sleep } from '../../../controller/files.mjs';
import { join } from 'node:path';
import { runWorker } from '../kit.mjs';

const [runDir, indexArg, scriptArg] = process.argv.slice(2);
const index = Number(indexArg);
const spec = readJson(join(runDir, 'run.json'));
const opts = spec.engine_options ?? {};
const TIMEOUT_MS = opts.timeout_ms ?? 5000;
const RECONNECT_MS = opts.reconnect_ms ?? 500;
// In a container the target is reached as host.docker.internal: the docker target says so here.
const URL_ = process.env.AI_PERF_TARGET_URL || spec.target_url;
const { default: player } = await import(pathToFileURL(scriptArg ?? spec.script_path).href);

class Dropped extends Error {}

// Tick lag against the server's schedule. The period is measured over the session (first to
// latest tick), and lag is recorded only once about a second of ticks is in (at least 5), so a
// wrong or rounded announcement (64 Hz sent as "16") neither hides lag nor grows it without bound.
// Lag of a tick is its arrival minus the earliest arrival the recent ticks allow for it: late
// server ticks and slow delivery both count, and a tick after a late one is not credited as early.
function tickClock(ctx, announced) {
  const recent = [];
  let first = null;
  const settle = Math.max(5, Math.min(20, Math.ceil(1000 / (announced || 50))));
  return (seq, now) => {
    if (!Number.isFinite(seq)) return;
    first ??= { seq, now };
    const span = seq - first.seq;
    recent.push({ seq, now });
    if (recent.length > 200) recent.shift();
    if (span < settle) return;
    const period = (now - first.now) / span;
    let due = Infinity;
    for (const r of recent) due = Math.min(due, r.now + (seq - r.seq) * period);
    ctx.tickLag(now - due);
    if (announced && span % 50 === 0) ctx.tickPeriod(period, announced);
  };
}

// A session: one open WebSocket with request/reply correlation by id.
function session(ctx, url) {
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const at = ctx.t();
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    let open = false;
    let closing = false;
    let dropped = false;
    let tick = opts.tick_ms ? tickClock(ctx, opts.tick_ms) : null;
    const failConnect = (cls, error) => {
      ctx.record('connect', performance.now() - began, { at, failed: true, cls, error });
      closing = true;
      try { ws.close(); } catch { /* gone */ }
      reject(new Dropped(error));
    };
    // A server that accepts TCP but never finishes the handshake must not hang the player.
    const connectTimer = setTimeout(() => { if (!open) failConnect('ConnectTimeout', `connect ${url}: no handshake in ${TIMEOUT_MS} ms`); }, TIMEOUT_MS);
    const s = {
      // Sends { id, type, ...payload } and resolves with the reply that carries the same id.
      request(type, payload = {}, name = type) {
        if (!open) return Promise.reject(new Dropped('not connected'));
        const id = nextId++;
        const sentAt = ctx.t();
        const t0 = performance.now();
        return new Promise((ok, fail) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            ctx.record(name, performance.now() - t0, { at: sentAt, failed: true, cls: 'Timeout', error: `${type}: no reply in ${TIMEOUT_MS} ms` });
            fail(new Error(`timeout: ${type}`));
          }, TIMEOUT_MS);
          pending.set(id, (m) => {
            clearTimeout(timer);
            const failed = m.type === 'error';
            ctx.record(name, performance.now() - t0, { at: sentAt, failed, cls: failed ? `ws error: ${m.code ?? 'unknown'}` : null, error: failed ? JSON.stringify(m) : null });
            if (m.code === 'dropped') fail(new Dropped(`${type}: connection dropped`));
            else if (failed) fail(new Error(`${type} refused: ${m.code}`));
            else ok(m);
          });
          ws.send(JSON.stringify({ id, type, ...payload }));
        });
      },
      close() { closing = true; try { ws.close(); } catch { /* gone */ } },
      get open() { return open; },
      // The server cut this session (not the player): the next connect is a reconnect.
      get dropped() { return dropped; },
    };
    ws.onopen = () => {
      clearTimeout(connectTimer);
      if (closing) return;
      open = true;
      ctx.connected(1);
      ctx.record('connect', performance.now() - began, { at });
      resolve(s);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'welcome' && m.tick_ms) tick ??= tickClock(ctx, m.tick_ms);
      if (m.type === 'tick') { tick?.(m.seq, performance.now()); return; }
      const handler = pending.get(m.id);
      if (handler) { pending.delete(m.id); handler(m); }
    };
    ws.onerror = () => { if (!open && !closing) { clearTimeout(connectTimer); failConnect('ConnectionError', `connect ${url} failed`); } };
    ws.onclose = () => {
      if (open) ctx.connected(-1);
      // The server cut a session the player did not close: a drop.
      if (open && !closing && ctx.running) { dropped = true; ctx.drop(); }
      open = false;
      for (const [, h] of pending) h({ type: 'error', code: 'dropped' });
      pending.clear();
    };
  });
}

await runWorker({
  runDir, index,
  async start(ctx) {
    const players = new Map();
    let stopping = false;
    // One player: connect, run the script, and run it again on the same session while it stays
    // open. Only a server cut leads to a reconnect (counted); a refused request or a script error
    // keeps the player online.
    const play = async (n) => {
      const me = players.get(n);
      const here = () => !stopping && !me.leave;
      let afterDrop = false;
      let s = null;
      while (here()) {
        if (!s?.open) {
          try {
            s = await session(ctx, URL_);
          } catch {
            await sleep(RECONNECT_MS);
            continue;
          }
          if (afterDrop) ctx.reconnect();
          afterDrop = false;
        }
        try {
          await player({
            id: n, worker: index, workers: spec.workers, user: `perf-w${index}-${n}`,
            session: s, request: (type, payload, name) => s.request(type, payload, name),
            get running() { return here() && s.open; },
            think: (minS, maxS = minS) => sleep((minS + Math.random() * (maxS - minS)) * 1000),
          });
        } catch { /* a failed request or a script error: recorded where it happened */ }
        if (s.dropped) {
          afterDrop = true;
          s = null;
          if (here()) await sleep(RECONNECT_MS);
        } else if (here()) await sleep(100);
      }
      s?.close();
      players.delete(n);
    };
    let next = 0;
    // Keep this worker's share of players online, following the profile.
    const shape = setInterval(() => {
      if (stopping) return;
      const want = ctx.users();
      const live = [...players.values()].filter((p) => !p.leave);
      for (let i = live.length; i < want; i++) { const n = next++; players.set(n, { leave: false }); play(n); }
      for (const p of live.slice(want)) p.leave = true;
    }, 100);
    return async () => {
      stopping = true;
      clearInterval(shape);
      for (const p of players.values()) p.leave = true;
      await sleep(200);
    };
  },
});
