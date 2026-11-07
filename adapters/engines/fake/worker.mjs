// One fake worker. Speaks the worker file protocol (CONTRACTS §3): waits for go_at, writes
// status.json every tick and one perf-hist window file per window, stops on stop or lost heartbeat.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, readJson, sleep, writeJson } from '../../../controller/files.mjs';
import { randomUUID } from 'node:crypto';
import { create, record } from '../../../controller/hist.mjs';
import { arrivalAt, bounds, usersAt, windowIndex, windowOrigin } from '../../../controller/profile.mjs';

const [runDir, indexArg] = process.argv.slice(2);
const index = Number(indexArg);
const spec = readJson(join(runDir, 'run.json'));
const T = spec.timing;
const opts = spec.engine_options ?? {};
const dir = join(runDir, 'raw', `w${index}`);
mkdirSync(dir, { recursive: true });

const faults = (opts.faults ?? []).filter((f) => f.worker === undefined || f.worker === index);
const fault = (kind) => faults.find((f) => f.kind === kind);
const active = (f, t) => f && t >= (f.from_s ?? 0) && t < (f.to_s ?? Infinity);
const endpoints = opts.endpoints ?? [{ name: 'GET /items', weight: 1, median_ms: 50, sigma: 0.3, error_rate: 0 }];
const totalWeight = endpoints.reduce((a, e) => a + e.weight, 0);

let seed = ((opts.seed ?? 1) * 7919 + index * 104729) >>> 0;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let x = seed;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
function pick() {
  let r = rand() * totalWeight;
  for (const e of endpoints) if ((r -= e.weight) < 0) return e;
  return endpoints[endpoints.length - 1];
}

const status = {
  worker: index, pid: process.pid, state: 'starting', reason: null, ts: Date.now(), t: null,
  users: 0, requests: 0, failures: 0, cpu_pct: 0, error_classes: {},
};
const windows = new Map();
let carry = 0;
let queueing = 1;
let queued = 0;
let waitMs = 0;

function windowOf(k) {
  if (!windows.has(k)) windows.set(k, { schema: 'perf-hist-window/v1', worker: index, window: k, window_s: T.window_s, origin_s: windowOrigin(spec.profile, T.window_s), endpoints: {} });
  return windows.get(k);
}

// Requests are spread over the elapsed span in 10 ms slices, each timed and windowed on its own,
// the way a real engine timestamps each request. A late tick then neither loses load nor dumps it
// all into one window.
const SLICE_S = 0.01;
function generate(t, dt) {
  status.users = Math.round((usersAt(t, spec.profile) / spec.workers) * 100) / 100;
  const sat = fault('saturate');
  // cpu_pct_per_user: a generator whose CPU grows with the users it carries, as a real one's does,
  // so more workers cool each one down.
  const busy = opts.cpu_pct_per_user ? Math.min(100, Math.round(status.users * opts.cpu_pct_per_user)) : (opts.cpu_pct ?? 10);
  status.cpu_pct = active(sat, t) ? sat.pct : busy;
  const hang = fault('hang');
  for (let s = Math.max(0, t - dt); s < t - 1e-9; s += SLICE_S) {
    const at = Math.min(s + SLICE_S, t);
    // A hung target: the worker is healthy and keeps reporting, but no request completes.
    if (active(hang, at)) continue;
    // Open: the arrival rate itself. Closed: each user sends rps_per_user.
    const offered = spec.profile.arrival_rps ? arrivalAt(at, spec.profile) : usersAt(at, spec.profile) * (opts.rps_per_user ?? 2);
    // max_rps: a target that serves at most this many requests per second in all. Past it,
    // throughput stays flat and requests queue: latency grows faster than the excess, a knee.
    const rate = opts.max_rps ? Math.min(offered, opts.max_rps) : offered;
    queueing = opts.max_rps && offered > opts.max_rps ? (offered / opts.max_rps) ** 2 : 1;
    let served = (rate / spec.workers) * (at - s);
    // backlog (with max_rps): requests past the limit wait in a queue that drains only with the
    // capacity left over, so a target comes back after an overload in the time that takes, or
    // never when the normal load leaves nothing over. Each waits for the queue ahead of it.
    if (opts.max_rps && opts.backlog) {
      const cap = (opts.max_rps / spec.workers) * (at - s);
      queued += (offered / spec.workers) * (at - s);
      served = Math.min(queued, cap);
      queued -= served;
      queueing = 1;
      waitMs = (queued / (opts.max_rps / spec.workers)) * 1000;
    }
    const expected = served + carry;
    const n = Math.floor(expected);
    carry = expected - n;
    if (n) dirty.add(emitRequests(at, n));
  }
  flush();
}

// A write that fails (a scanner holding the file) is retried next tick, never lost or fatal.
const dirty = new Set();
const sampled = {};
function flush() {
  for (const k of dirty) {
    try { writeJson(join(dir, `hist-${k}.json`), windows.get(k)); dirty.delete(k); } catch { /* next tick */ }
  }
}

function emitRequests(t, n) {
  const slow = fault('slow');
  // fault drift { pct_per_s }: latency grows with run time, as a leak or a filling cache does (soak).
  const drifting = fault('drift');
  const errs = fault('errors');
  const k = windowIndex(t, spec.profile, T.window_s);
  const w = windowOf(k);
  for (let i = 0; i < n; i++) {
    const e = pick();
    const ms = e.median_ms * Math.exp((e.sigma ?? 0.3) * gauss()) * queueing * (active(slow, t) ? slow.factor : 1) * (drifting ? 1 + (drifting.pct_per_s * Math.max(0, t)) / 100 : 1) + waitMs;
    const injected = active(errs, t) && rand() < errs.rate;
    const failed = injected || rand() < (e.error_rate ?? 0);
    const ep = (w.endpoints[e.name] ??= { requests: 0, failures: 0, hist: create() });
    ep.requests++;
    record(ep.hist, ms);
    status.requests++;
    if (failed) {
      const cls = injected ? (errs.class ?? 'injected') : (e.error_class ?? 'HTTP 500');
      // Sampled like a real engine (CONTRACTS §3): up to 20 per class, with a correlation id.
      sampled[cls] = (sampled[cls] ?? 0) + 1;
      if (sampled[cls] <= 20) {
        try { appendLine(join(dir, 'errors.ndjson'), { t: Math.round(t * 1000) / 1000, name: e.name, class: cls, error: `${cls} (fake)`, correlation_id: randomUUID() }); } catch { /* sample lost, count kept */ }
      }
      ep.failures++;
      status.failures++;
      status.error_classes[cls] = (status.error_classes[cls] ?? 0) + 1;
    }
  }
  return k;
}

// The controller's clock is the run's clock (CONTRACTS §3). A worker in a container or on another
// machine can be seconds off. Each control read bounds the offset from below, because the
// controller wrote heartbeat_at before this read, so the max over reads converges on the truth.
let offset = -Infinity;
// fault clock_skew { ms } stands in for a worker machine whose clock is off.
const skew = fault('clock_skew')?.ms ?? 0;
const localNow = () => Date.now() + skew;
function hostNow() {
  return localNow() + (Number.isFinite(offset) ? offset : 0);
}

function stop(reason) {
  flush();
  status.state = 'stopped';
  status.reason = reason;
  status.ts = hostNow();
  writeJson(join(dir, 'status.json'), status);
  process.exit(0);
}

// Last resort: a worker never outlives its profile by more than 30 s, even if every signal is lost.
const hardEnd = Date.now() + T.barrier_timeout_s * 1000 + (bounds(spec.profile).end + 30) * 1000;
// A gap longer than this between ticks is a stall: the process, its container or its disk froze,
// and no load went out. It is reported (CONTRACTS §3), never papered over by catching up.
const STALL_S = Math.max(1, (5 * T.tick_ms) / 1000);
// engine_options.ideal: an ideal generator for controller tests on a busy machine. It catches up
// after any gap and reports only scripted stalls (fault stall), never the host's own starvation.
const ideal = opts.ideal === true;
status.stalls = [];
let stalledOnce = false;
let forced = false;
let control = null;
let last = hostNow();
// capacity_url: a simulated target that says what it serves (mock/scale-lb.mjs, a deployment of N
// instances). It is asked before the worker is ready, and told on every tick the rate this worker
// offers; its answer is max_rps, the deployment's capacity in all.
async function askCapacity(rps) {
  const u = new URL(opts.capacity_url);
  u.searchParams.set('worker', String(index));
  u.searchParams.set('offered', String(Math.round(rps * 100) / 100));
  const j = await (await fetch(u, { signal: AbortSignal.timeout(2000) })).json();
  if (j.capacity_rps > 0) opts.max_rps = j.capacity_rps;
}
if (opts.capacity_url) {
  try { await askCapacity(0); } catch (e) { status.reason = `capacity_url: ${e.message}`; stop('capacity_unknown'); }
}
if (!fault('never_ready')) status.state = 'ready';
for (;;) {
  const read = readJson(join(runDir, 'control.json'));
  if (read) { control = read; offset = Math.max(offset, read.heartbeat_at - localNow()); }
  const now = hostNow();
  status.ts = now;
  const stalled = status.state === 'running' && (now - last) / 1000 > STALL_S && (!ideal || forced);
  forced = false;
  if (stalled) status.stalls.push({ from: Math.round(status.t * 1000) / 1000, to: Math.round(((now - control.go_at) / 1000) * 1000) / 1000 });
  if (Date.now() > hardEnd) stop('hard_end');
  if (!fault('ignore_heartbeat') && control && now - control.heartbeat_at > T.heartbeat_timeout_s * 1000) stop('heartbeat_lost');
  if (control?.stop) stop(control.stop_reason ?? 'stop');
  if (status.state !== 'starting' && control?.go_at && now >= control.go_at) {
    status.state = 'running';
    const t = (now - control.go_at) / 1000;
    status.t = t;
    const crash = fault('crash');
    if (crash && t >= crash.at_s) process.exit(1);
    // A late tick catches up (a real engine timestamps each request); a stall does not.
    generate(t, stalled ? T.tick_ms / 1000 : (now - Math.max(last, control.go_at)) / 1000);
    if (opts.capacity_url) askCapacity((spec.profile.arrival_rps ? arrivalAt(t, spec.profile) : usersAt(t, spec.profile) * (opts.rps_per_user ?? 2)) / spec.workers).catch(() => { /* next tick */ });
    const freeze = fault('stall');
    // fault stall { at_s, for_s }: the whole process freezes, as a starved container does; the next
    // tick must see the gap like any real stall.
    if (freeze && t >= freeze.at_s && !stalledOnce) {
      stalledOnce = true;
      forced = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, freeze.for_s * 1000);
    }
  }
  last = now;
  try { writeJson(join(dir, 'status.json'), status); } catch { /* next tick */ }
  await sleep(T.tick_ms);
}
