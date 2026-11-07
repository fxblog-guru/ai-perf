// The worker kit: everything an ai-perf worker must do (CONTRACTS §3) except speak to the target.
// An in-house engine (a game's TCP or UDP protocol, a message bus, anything Locust and k6 cannot
// load) is a worker.mjs that calls runWorker() with its own start(), and records what it measures
// through ctx. The kit owns the protocol: the barrier, control and heartbeat, the controller's
// clock, stalls, the hard end, perf-hist windows, realtime counters, error samples (masked) and
// the generator's CPU. adapters/engines/ws is the worked example; docs/engine-kit.md the guide.
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { appendLine, readJson, sleep } from '../../controller/files.mjs';
import { create, record } from '../../controller/hist.mjs';
import { bounds, usersAt, windowIndex, windowOrigin } from '../../controller/profile.mjs';
import { mask } from '../../lib/mask.mjs';

const SAMPLES_PER_CLASS = 20;

// The kit's own file I/O never blocks the event loop: an engine's receive timestamps are taken on
// that loop, so a blocking write would show up as latency of the target. Write-then-rename, with a
// retry for Windows, as controller/files.mjs does.
async function writeJsonAsync(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  for (let i = 0; ; i++) {
    try { await rename(tmp, path); return; } catch (e) {
      if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(5);
    }
  }
}
const readJsonAsync = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

// Whole users split exactly over workers (as the Locust shim and the k6 sidecar do).
export const shareOf = (total, index, workers) => Math.floor(total / workers) + (index < total % workers ? 1 : 0);

export async function runWorker({ runDir, index, start }) {
  const spec = readJson(join(runDir, 'run.json'));
  const T = spec.timing;
  const dir = join(runDir, 'raw', `w${index}`);
  mkdirSync(dir, { recursive: true });
  const status = {
    worker: index, pid: process.pid, state: 'starting', reason: null, ts: Date.now(), t: null,
    users: 0, requests: 0, failures: 0, cpu_pct: 0, error_classes: {}, stalls: [], ccu: 0,
  };
  const origin = windowOrigin(spec.profile, T.window_s);
  // Players online are held to the plan from the moment this worker first had all of them in
  // steady, or one window into steady at the latest: the last players of a ramp still connecting
  // are start-up, but a worker that never fills its share is not excused.
  const steadyFrom = bounds(spec.profile).steady.from;
  const settle = Math.max(1, T.window_s);
  let held = false;
  const windows = new Map();
  const dirty = new Set();
  const sampled = {};
  let control = null;
  let offset = -Infinity;
  const hostNow = () => Date.now() + (Number.isFinite(offset) ? offset : 0);
  const tNow = () => (control?.go_at ? (hostNow() - control.go_at) / 1000 : null);

  const windowAt = (t) => {
    const k = windowIndex(t, spec.profile, T.window_s);
    if (!windows.has(k)) {
      windows.set(k, { schema: 'perf-hist-window/v1', worker: index, window: k, window_s: T.window_s, origin_s: origin, endpoints: {},
        realtime: { ccu_max: status.ccu, ccu_min: held ? status.ccu : null, drops: 0, reconnects: 0, tick_lag: create() } });
    }
    dirty.add(k);
    return windows.get(k);
  };

  // What an engine reports. Times are the controller's (ctx.t()); a request is placed in the window
  // where it started, like every other engine.
  const ctx = {
    spec, index, workers: spec.workers, options: spec.engine_options ?? {},
    t: tNow,
    get running() { return status.state === 'running'; },
    // The users this worker should have now: its exact share of the profile at time t.
    users: (t = tNow()) => shareOf(Math.round(usersAt(t, spec.profile)), index, spec.workers),
    // correlation_id: the id the request carried (an X-Request-ID it sent, or the one the server
    // answered with), so a failure can be found in the server's logs (PS-G4).
    record(name, ms, { at = tNow() - ms / 1000, failed = false, cls = null, error = null, correlation_id = null } = {}) {
      if (at === null || at < 0) return;
      const w = windowAt(at);
      const ep = (w.endpoints[name] ??= { requests: 0, failures: 0, hist: create() });
      ep.requests++;
      record(ep.hist, ms);
      status.requests++;
      if (!failed) return;
      ep.failures++;
      status.failures++;
      const c = cls ?? 'error';
      status.error_classes[c] = (status.error_classes[c] ?? 0) + 1;
      sampled[c] = (sampled[c] ?? 0) + 1;
      if (sampled[c] <= SAMPLES_PER_CLASS) {
        try { appendLine(join(dir, 'errors.ndjson'), { t: Math.round(at * 1000) / 1000, name, class: c, error: mask(String(error ?? c)).slice(0, 300), correlation_id: correlation_id === null ? null : String(correlation_id).slice(0, 128) }); } catch { /* sample lost, count kept */ }
      }
    },
    // Realtime counters (perf-standard v1.1 draft, L): connected players, drops, reconnects, and
    // how late each server tick arrived.
    connected(delta) {
      status.ccu += delta;
      const t = tNow();
      if (t !== null && t >= 0) { const w = windowAt(t); w.realtime.ccu_max = Math.max(w.realtime.ccu_max, status.ccu); if (held) w.realtime.ccu_min = Math.min(w.realtime.ccu_min ?? status.ccu, status.ccu); }
    },
    drop() { const t = tNow(); if (t !== null && t >= 0) windowAt(t).realtime.drops++; },
    reconnect() { const t = tNow(); if (t !== null && t >= 0) windowAt(t).realtime.reconnects++; },
    tickLag(ms) { const t = tNow(); if (t !== null && t >= 0) record(windowAt(t).realtime.tick_lag, Math.max(0, ms)); },
    // The tick period measured on a session against the one the server announced.
    tickPeriod(measured, announced) { const t = tNow(); if (t !== null && t >= 0) windowAt(t).realtime.tick_period = { measured: Math.round(measured * 100) / 100, announced }; },
  };

  const flush = async () => {
    for (const k of [...dirty]) {
      dirty.delete(k);
      try { await writeJsonAsync(join(dir, `hist-${k}.json`), windows.get(k)); } catch { dirty.add(k); }
    }
  };
  const write = async () => { status.ts = hostNow(); try { await writeJsonAsync(join(dir, 'status.json'), status); } catch { /* next tick */ } };
  // How late this worker's own event loop runs (p99 per tick): a late loop timestamps late.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let engineStop = null;
  const stop = async (reason) => {
    status.state = 'stopping';
    try { await Promise.race([engineStop?.(), sleep(2000)]); } catch { /* stopping anyway */ }
    await flush();
    status.state = 'stopped';
    status.reason = reason;
    await write();
    process.exit(0);
  };

  // Generator CPU: this process's, as a share of the machine (like docker stats / NCPU).
  let cpuPrev = { usage: process.cpuUsage(), at: process.hrtime.bigint() };
  const cpu = () => {
    const usage = process.cpuUsage(cpuPrev.usage);
    const at = process.hrtime.bigint();
    const wall = Number(at - cpuPrev.at) / 1e6;
    cpuPrev = { usage: process.cpuUsage(), at };
    return wall > 0 ? Math.round(((usage.user + usage.system) / 1000 / wall / cpus().length) * 1000) / 10 : 0;
  };

  const hardEnd = Date.now() + T.barrier_timeout_s * 1000 + (bounds(spec.profile).end + 30) * 1000;
  const STALL_S = Math.max(1, (5 * T.tick_ms) / 1000);
  status.state = 'ready';
  let started = false;
  let last = hostNow();
  for (;;) {
    const read = await readJsonAsync(join(runDir, 'control.json'));
    if (read) { control = read; offset = Math.max(offset, read.heartbeat_at - Date.now()); }
    const now = hostNow();
    if (Date.now() > hardEnd) await stop('hard_end');
    if (control && now - control.heartbeat_at > T.heartbeat_timeout_s * 1000) await stop('heartbeat_lost');
    if (control?.stop) await stop(control.stop_reason ?? 'stop');
    if (control?.go_at && now >= control.go_at) {
      const t = (now - control.go_at) / 1000;
      if (!started) {
        started = true;
        status.state = 'running';
        engineStop = (await start(ctx)) ?? null;
      } else if ((now - last) / 1000 > STALL_S) {
        // A frozen process sent nothing in the gap: reported, never caught up (CONTRACTS §3).
        status.stalls.push({ from: Math.round(status.t * 1000) / 1000, to: Math.round(t * 1000) / 1000 });
      }
      status.t = t;
      status.users = ctx.users(t);
      if (!held && t >= steadyFrom && (status.ccu >= status.users || t >= steadyFrom + settle)) held = true;
      // Every window this worker runs through gets its count, events or not: idle players are online.
      const w = windowAt(t);
      w.realtime.ccu_max = Math.max(w.realtime.ccu_max, status.ccu);
      if (held) w.realtime.ccu_min = Math.min(w.realtime.ccu_min ?? status.ccu, status.ccu);
      status.cpu_pct = cpu();
      status.loop_lag_ms = Math.round(loop.percentile(99) / 1e5) / 10;
      loop.reset();
    }
    last = now;
    await flush();
    await write();
    await sleep(T.tick_ms);
  }
}
