// perf-controller: runs one load test, detached from any AI session. Usage: node controller.mjs <runDir>
// Everything it knows is in files (CONTRACTS §2–§5), so a new session, /perf-status or
// /perf-doctor can pick a run up at any point.
import { existsSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ENGINES, METRICS, REMOTE, TARGETS } from '../adapters/index.mjs';
import { advertisedPort, openChannel } from './channel.mjs';
import { appendLine, isAlive, readJson, readLines, sleep, writeJson } from './files.mjs';
import { emit } from './events.mjs';
import { arrivalAt, bounds, phaseAt, spikeBounds, stepBounds, usersAt } from './profile.mjs';
import { PHASES, create, finalState, transition } from './state.mjs';
import { evaluate, rulesAt } from './rules.mjs';
import { mergeWindows, readWindows, recoveryOf, selectWindows, windowSeries } from './merge.mjs';
import { drift } from '../lib/stats.mjs';
import { mask } from '../lib/mask.mjs';
import { killChild, workerAlive } from '../lib/workers.mjs';
import { sample as sampleSignalsOnce } from '../adapters/metrics/signals.mjs';

const runDir = process.argv[2];
const spec = readJson(join(runDir, 'run.json'));
const T = spec.timing;
const B = bounds(spec.profile);
// A profile with a steady phase is judged on it only; one without (smoke, spike) on the whole run.
const hasSteady = B.steady.to > B.steady.from;
const paths = {
  state: join(runDir, 'state.json'),
  control: join(runDir, 'control.json'),
  stop: join(runDir, 'stop.request'),
  timeline: join(runDir, 'monitor', 'timeline.ndjson'),
  target: join(runDir, 'monitor', 'target.ndjson'),
};
mkdirSync(join(runDir, 'monitor'), { recursive: true });

const state = create({
  run_id: spec.run_id, slug: spec.slug, pid: process.pid, started_at: new Date().toISOString(),
  heartbeat_at: Date.now(), heartbeat_timeout_s: T.heartbeat_timeout_s, go_at: null,
  workers: [], stop_reason: null, problems: [],
});
const control = { heartbeat_at: Date.now(), go_at: null, stop: false, stop_reason: null };
const save = () => { state.heartbeat_at = Date.now(); writeJson(paths.state, state); };
const beat = () => { control.heartbeat_at = Date.now(); writeJson(paths.control, control); };
const statusOf = (w) => readJson(join(runDir, 'raw', w.id, 'status.json'));
const tNow = () => (control.go_at ? (Date.now() - control.go_at) / 1000 : null);

// data: the numbers a fix needs (lib/remedy.mjs), beside the sentence a person reads.
function problem(kind, detail, data) {
  state.problems.push({ kind, detail, t: tNow(), ...(data ? { data } : {}) });
}

function requestStop(reason) {
  if (control.stop) return;
  control.stop = true;
  control.stop_reason = reason;
  state.stop_reason = reason;
  beat();
}

beat();
save();
// The heartbeat runs on its own timer so a slow step (merging, collecting) never looks like death.
// It dies with the process, which is exactly when workers must notice and stop.
// A failed write (a scanner holding the file on Windows) skips one beat instead of killing the run.
const heartbeat = setInterval(() => { try { beat(); save(); } catch { /* next tick retries */ } }, T.tick_ms);
const engine = await ENGINES[spec.engine]();
const target = await TARGETS[spec.target]();
const metrics = await METRICS[spec.monitor?.metrics ?? 'none']();
// Workers on other machines reach the run through the network channel, opened before they start
// and closed when the run is over.
// The target is looked at once before any load: a host process is followed from here on, so one
// that dies before the first sample in the run is seen gone, not "never monitored"; its CPU rate
// has a starting point too.
if ((spec.monitor?.metrics ?? 'none') !== 'none') await metrics.sample({ containers: spec.monitor.containers ?? [], processes: spec.monitor.processes ?? [], t: null, exclude: { root: process.pid, text: runDir } }).catch(() => []);
const channel = REMOTE.has(spec.target) ? await openChannel({ runDir, spec, bind: spec.channel?.bind, port: spec.channel?.port ?? advertisedPort(spec.channel?.advertise), advertise: spec.channel?.advertise }) : null;
if (channel) state.channel = { url: channel.url };
state.workers = (await target.startWorkers({ runDir, spec, engine, channel }))
  .map((w) => ({ ...w, state: 'starting', lost: false, saturated: false, cpu_max_pct: null, requests: 0, failures: 0 }));
// A target that could not start a worker says so the way a worker would, so the barrier reacts.
for (const w of state.workers) if (w.spawn_error) {
  mkdirSync(join(runDir, 'raw', w.id), { recursive: true });
  writeJson(join(runDir, 'raw', w.id, 'status.json'), { worker: w.index, pid: null, state: 'stopped', reason: `spawn_failed: ${w.spawn_error}`, ts: Date.now() });
}
save();

// Target metrics are sampled asynchronously every interval_s; the tick never waits for them.
let targetCpu = null;
let sampling = null;
// A container or process that never yields a sample (a misspelt name, docker down, nothing on
// that port) is not monitored: its auto-stop rule cannot fire. That is said at once, and the run
// cannot end done. A host process that was there and is gone is the target dying under load.
const hostProcess = spec.monitor?.metrics === 'host-process';
const watched = hostProcess ? (spec.monitor.processes ?? []).map((p) => p.name) : spec.monitor?.containers ?? [];
const what = hostProcess ? 'process' : 'container';
let targetGone = null;
let rounds = 0;
const sampled = new Set();
const missing = new Set();
let nextSample = 0;
// The target's own metrics (monitor.signals), read on the same interval and never waited for. A
// signal that fails is said once; one that never answered is a problem at the end. Neither changes
// what was measured: only how far the analysis can see.
const signals = spec.monitor?.signals ?? [];
const signalPrev = new Map();
const signalSeen = new Set();
const signalAnswered = new Set();
const signalFailed = new Map();
let signalling = null;
let nextSignal = 0;
function sampleSignals(t) {
  if (!signals.length || signalling || Date.now() < nextSignal) return;
  nextSignal = Date.now() + (spec.monitor.interval_s ?? 5) * 1000;
  signalling = sampleSignalsOnce(signals, t, signalPrev).then(({ samples, errors, answered }) => {
    for (const s of samples) { appendLine(paths.target, s); signalSeen.add(s.labels.signal); }
    for (const name of answered) signalAnswered.add(name);
    for (const e of errors) {
      if (signalFailed.has(e.signal)) continue;
      signalFailed.set(e.signal, e.error);
      emit(runDir, { t, type: 'anomaly', severity: 'warn', summary: `signal ${e.signal} could not be read: ${e.error}`, data: { signal: e.signal, error: e.error } });
    }
  }).catch(() => {}).finally(() => { signalling = null; });
}

function sampleTarget(t) {
  if (sampling || spec.monitor?.metrics === 'none' || Date.now() < nextSample) return;
  nextSample = Date.now() + (spec.monitor.interval_s ?? 5) * 1000;
  sampling = metrics.sample({ containers: spec.monitor.containers ?? [], processes: spec.monitor.processes ?? [], t, exclude: { root: process.pid, text: runDir } }).then((samples) => {
    for (const s of samples) appendLine(paths.target, s);
    const cpus = samples.filter((s) => s.name === 'target_cpu_pct');
    targetCpu = cpus.length ? Math.max(...cpus.map((s) => s.value)) : null;
    rounds++;
    for (const c of watched) {
      if (cpus.some((s) => s.labels?.container === c)) { sampled.add(c); missing.delete(c); continue; }
      // A host process's CPU is a rate over two samples: its first has none yet.
      if (missing.has(c) || (hostProcess && rounds < 2 && samples.some((s) => s.labels?.container === c))) continue;
      missing.add(c);
      emit(runDir, { t, type: 'anomaly', severity: 'warn', summary: `no metrics from ${what} ${c}; target_cpu_pct cannot be judged`, data: { container: c, metric: 'target_cpu_pct' } });
    }
    // Some processes of a target exited (a crashed or recycled worker): said; the target goes on.
    for (const s of samples.filter((x) => x.name === 'target_process_exited')) emit(runDir, { t, type: 'anomaly', severity: 'warn', summary: `${s.value} process(es) of ${s.labels.container} exited (pid ${s.labels.exited}); now ${s.labels.pids}`, data: { container: s.labels.container, exited: s.labels.exited, pids: s.labels.pids } });
    const gone = samples.find((s) => s.name === 'target_process_up' && s.value === 0);
    if (gone && !targetGone) targetGone = { name: gone.labels.container, pids: gone.labels.pids, t };
  }).finally(() => { sampling = null; });
}

// Last resort, like the workers' hard_end: whatever else breaks, the controller never outlives
// barrier + profile + drain by more than a minute.
const hardDeadline = Date.now() + (T.barrier_timeout_s + B.end + T.worker_timeout_s + 62) * 1000;
// `perf run --wait` waits on this: starting containers can take minutes before it is known.
state.hard_deadline = hardDeadline;
const pastDeadline = () => {
  if (Date.now() <= hardDeadline) return false;
  problem('hard_deadline', 'the run outlived barrier + profile + drain + 60 s');
  requestStop('hard_deadline');
  return true;
};

// Barrier: no load until every worker is ready, so the ramp is the same on every worker.
const barrierEnd = Date.now() + T.barrier_timeout_s * 1000;
for (;;) {
  beat();
  save();
  if (pastDeadline()) break;
  if (existsSync(paths.stop)) { requestStop('manual'); break; }
  const failed = state.workers.map((w) => [w, statusOf(w)]).filter(([, s]) => s?.state === 'stopped');
  if (failed.length) {
    for (const [w, s] of failed) problem('worker_failed', `${w.id} stopped before the start: ${s.reason}`);
    requestStop('worker_failed');
    break;
  }
  const ready = state.workers.filter((w) => statusOf(w)?.state === 'ready').length;
  if (ready === state.workers.length) break;
  if (Date.now() > barrierEnd) {
    problem('barrier_timeout', `${ready}/${state.workers.length} workers ready after ${T.barrier_timeout_s} s`);
    requestStop('barrier_timeout');
    break;
  }
  await sleep(T.tick_ms);
}

const series = [];
const seenClasses = new Set();
const last = new Map();
if (!control.stop) {
  control.go_at = Date.now() + T.tick_ms;
  state.go_at = control.go_at;
  beat();
  save();
  await sleep(T.tick_ms);
  for (;;) {
    beat();
    const t = tNow();
    const phase = phaseAt(t, spec.profile);
    // Walk through every phase passed since the last tick, so short phases still appear in history.
    const reach = phase === 'end' ? PHASES.length - 1 : PHASES.indexOf(phase);
    while (state.state === 'preparing' || PHASES.indexOf(state.state) < reach) {
      const next = state.state === 'preparing' ? PHASES[0] : PHASES[PHASES.indexOf(state.state) + 1];
      transition(state, next);
      emit(runDir, { t, type: 'phase_changed', summary: `phase ${next}`, data: { phase: next } });
    }

    let dReq = 0;
    let dFail = 0;
    let cpuMax = 0;
    const cpu = {};
    for (const w of state.workers) {
      if (w.lost) continue;
      const s = statusOf(w) ?? last.get(w.id);
      if (!s) continue;
      last.set(w.id, s);
      const stale = Date.now() - s.ts > T.worker_timeout_s * 1000;
      if (stale || s.state === 'stopped') {
        w.lost = true;
        w.state = 'lost';
        // A sidecar that died leaves its engine loading the target: stop that child now. A remote
        // worker's child is on its machine, and stops when its control goes stale.
        if (!w.remote) killChild(s.child);
        problem('worker_lost', `${w.id} ${stale ? 'stopped reporting' : `stopped (${s.reason})`}`);
        emit(runDir, { t, type: 'worker_lost', severity: 'warn', summary: `${w.id} lost; its share of the load is missing`, data: { worker: w.id, reason: stale ? 'stale' : s.reason } });
        continue;
      }
      w.state = s.state;
      dReq += s.requests - w.requests;
      dFail += s.failures - w.failures;
      w.requests = s.requests;
      w.failures = s.failures;
      cpu[w.id] = s.cpu_pct;
      cpuMax = Math.max(cpuMax, s.cpu_pct);
      // Generator CPU counts where the numbers are measured: steady, or the whole run without one.
      // The sample is judged at its own time, not the controller's: a status read late belongs to
      // the phase it was taken in.
      const sPhase = s.t === null || s.t === undefined ? null : phaseAt(s.t, spec.profile);
      const measuring = hasSteady ? sPhase === 'steady' : sPhase !== null && sPhase !== 'end';
      if (measuring) w.cpu_max_pct = Math.max(w.cpu_max_pct ?? 0, s.cpu_pct);
      if (measuring && s.cpu_pct > T.saturation_pct && !w.saturated) {
        w.saturated = true;
        problem('generator_saturated', `${w.id} at ${s.cpu_pct} % CPU in the measured window`);
        emit(runDir, { t, type: 'generator_saturated', severity: 'warn', summary: `${w.id} generator CPU ${s.cpu_pct} % > ${T.saturation_pct} %: the run measures the tool`, data: { worker: w.id, cpu_pct: s.cpu_pct } });
      }
      // A worker that reports its event-loop lag (the kit does) is saturated when that lag is above
      // the limit: what it receives is timestamped late, so its latencies describe the worker.
      if (measuring && s.loop_lag_ms > T.loop_lag_ms && !w.saturated) {
        w.saturated = true;
        problem('generator_saturated', `${w.id} event loop ${s.loop_lag_ms} ms late (> ${T.loop_lag_ms} ms) in the measured window`);
        emit(runDir, { t, type: 'generator_saturated', severity: 'warn', summary: `${w.id} event loop ${s.loop_lag_ms} ms late: the run measures the tool`, data: { worker: w.id, loop_lag_ms: s.loop_lag_ms } });
      }
      for (const cls of Object.keys(s.error_classes ?? {})) if (!seenClasses.has(cls)) {
        seenClasses.add(cls);
        emit(runDir, { t, type: 'new_error_class', severity: 'warn', summary: `new error class: ${cls}`, data: { class: cls, worker: w.id } });
      }
    }
    sampleTarget(t);
    sampleSignals(t);
    series.push({ t, requests: dReq, failures: dFail, cpu_max: cpuMax, target_cpu: targetCpu });
    appendLine(paths.timeline, { t, phase, target_users: usersAt(t, spec.profile), requests: dReq, failures: dFail, cpu });
    save();

    if (state.workers.every((w) => w.lost)) { problem('all_workers_lost', 'no worker left'); requestStop('all_workers_lost'); break; }
    // A recovery test's overload, and the time it has to come back, run under the safety bound only.
    const { rules: active, eased } = rulesAt(spec.auto_stop, t, spec.overload_grace);
    const fired = evaluate(active, series, t);
    if (fired) {
      emit(runDir, { t, type: 'auto_stopped', severity: 'error', summary: `auto-stop: ${fired.rule.metric} ${Math.round(fired.value * 1000) / 1000} > ${fired.rule.above} over ${fired.rule.for_s} s${eased ? ' (the overload safety bound)' : ''}`, data: fired });
      requestStop(eased ? 'auto_stop:overload_safety' : `auto_stop:${fired.rule.metric}`);
      break;
    }
    // The target process died: loading nothing measures nothing, and the death is the finding.
    if (targetGone) {
      problem('target_gone', `process ${targetGone.name} (pid ${targetGone.pids}) exited at t=${Math.round(targetGone.t * 10) / 10} s`);
      emit(runDir, { t, type: 'auto_stopped', severity: 'error', summary: `auto-stop: target process ${targetGone.name} (pid ${targetGone.pids}) is gone`, data: targetGone });
      requestStop('auto_stop:target_gone');
      break;
    }
    if (existsSync(paths.stop)) { requestStop('manual'); break; }
    if (pastDeadline()) break;
    if (phase === 'end') break;
    await sleep(T.tick_ms);
  }
}

// When load really ended: the planned end, or earlier if the run was stopped. Windows past it are
// partial and must not count as whole.
const loadEnd = control.go_at ? Math.max(0, Math.min(tNow(), B.end)) : 0;
transition(state, 'collecting');
if (!control.stop) { control.stop = true; control.stop_reason = 'complete'; }
beat();
save();
const drainEnd = Date.now() + (T.worker_timeout_s + 2) * 1000;
while (Date.now() < drainEnd && state.workers.some((w) => !w.lost && statusOf(w)?.state !== 'stopped')) {
  beat();
  await sleep(T.tick_ms);
}
// A worker that never confirmed the stop either died late (its last data is missing) or ignored it
// (it may still be loading the target). Both make the run degraded, never done.
for (const w of state.workers) {
  const s = statusOf(w);
  if (w.lost || s?.state === 'stopped') continue;
  // Kill only a worker that is demonstrably still ours: alive and still reporting. A stale pid
  // may already belong to another process.
  const ours = !w.remote && workerAlive(w) && s && Date.now() - s.ts < T.worker_timeout_s * 1000;
  const killed = ours && target.stopWorker?.(w);
  if (killed) killChild(s.child);
  w.lost = true;
  w.state = 'lost';
  problem('worker_not_stopped', `${w.id} did not confirm the stop; ${w.remote ? `on ${w.host ?? 'another machine'}: it stops itself when its control goes stale` : killed ? 'killed' : `not running any more (pid ${w.pid})`}`);
  emit(runDir, { t: tNow(), type: 'worker_lost', severity: 'warn', summary: `${w.id} did not confirm the stop`, data: { worker: w.id, reason: 'no_stop_ack' } });
}

// Remote workers' clocks, as their agents measured them against ours: far off means NTP is broken
// on that machine. The workers align to the controller anyway; this is said, not corrected.
if (channel) {
  for (const w of state.workers) { const s = channel.seen.get(w.id); if (s) { w.host = s.host ?? w.host; w.clock_skew_ms = s.skew_ms; } }
  const far = state.workers.filter((w) => Math.abs(w.clock_skew_ms ?? 0) > 1000);
  if (far.length) emit(runDir, { t: tNow(), type: 'anomaly', severity: 'warn', summary: `clock of ${far.map((w) => `${w.host ?? w.id} ${w.clock_skew_ms} ms`).join(', ')} off the controller's: fix NTP there`, data: { skew: far.map((w) => ({ worker: w.id, host: w.host, ms: w.clock_skew_ms })) } });
}
await target.finish?.({ runDir, spec, workers: state.workers });
await channel?.close();

const windows = readWindows(runDir, () => { beat(); save(); });
save();
let kind = 'steady';
let from = B.steady.from;
let to = Math.min(B.steady.to, loadEnd);
let picked = selectWindows(windows, T.window_s, from, to);
// Rates are over the planned whole windows, not over the windows that happen to hold samples: a
// target that hung for a window completed nothing in it, and that window still took its seconds.
const wholeWindows = Math.floor((to - from) / T.window_s + 1e-9);
let duration = wholeWindows * T.window_s;
if (!picked.length || !hasSteady) {
  // No steady state (smoke, or stopped before it): judge the whole run and say so.
  kind = 'whole-run';
  from = 0;
  to = loadEnd;
  picked = windows;
  duration = loadEnd;
}
const merged = mergeWindows(picked, T.window_s, duration);
// A spike is judged on how the target comes back: the steady before it is the base (recoveryOf: a
// window back near it serves near its requests too; a target that answers few requests fast has
// not recovered). Recovery is the end of the first of two such windows in a row, counted from the
// end of the spike: never earlier than it could have been. The same test on the base's own windows
// says whether the base is steady enough for it to mean anything.
const sb = spikeBounds(spec.profile);
let spike = null;
if (sb) {
  const baseW = selectWindows(windows, T.window_s, B.steady.from, sb.from);
  const base = baseW.length ? mergeWindows(baseW, T.window_s, Math.floor((sb.from - B.steady.from) / T.window_s + 1e-9) * T.window_s) : null;
  const baseSeries = windowSeries(windows, T.window_s, B.steady.from, sb.from);
  const end = Math.min(B.steady.to, loadEnd);
  const after = windowSeries(windows, T.window_s, sb.to, end);
  const rec = base ? recoveryOf(base.total, baseSeries, after) : { back: null, steady_pct: null };
  const back = rec.back;
  const during = windowSeries(windows, T.window_s, sb.from, sb.to);
  spike = {
    from_s: sb.from, to_s: sb.to, [spec.profile.arrival_rps ? 'arrival_rps' : 'users']: spec.profile.spike.arrival_rps ?? spec.profile.spike.users,
    base: base ? { total: base.total, endpoints: base.endpoints } : null,
    peak_p95_ms: during.length ? Math.max(...during.map((w) => w.p95_ms ?? 0)) : null,
    peak_error_rate: during.length ? Math.max(...during.map((w) => w.error_rate)) : null,
    recovered: Boolean(back), recovery_s: back ? Math.round((back.start + T.window_s - sb.to) * 10) / 10 : null,
    observed_after_s: Math.round(Math.max(0, end - sb.to) * 10) / 10,
    base_steady_pct: rec.steady_pct,
    // A recovery test is judged per window against the plan's SLO (lib/verdict.mjs), from the
    // start of steady to where load stopped: the base, the overload and the time after it.
    window_s: T.window_s,
    // What really ran: the overload up to where load stopped, and the end of the watch after it.
    ran_to_s: Math.min(sb.to, end), end_s: end,
    ...(spec.profile.name === 'recovery' ? { windows: windowSeries(windows, T.window_s, B.steady.from, end, { perEndpoint: true }) } : {}),
  };
}
// Drift at constant load (soak): a Theil-Sen line through each steady window's p95, and through
// each monitored container's memory. Not for a staircase or a spike, whose load moves on purpose.
let driftOut = null;
if (!stepBounds(spec.profile).length && !sb) {
  const end = Math.min(B.steady.to, loadEnd);
  const pts = windowSeries(windows, T.window_s, B.steady.from, end).filter((w) => w.p95_ms !== null);
  const mem = {};
  for (const s of readLines(paths.target)) {
    if (s.name !== 'target_mem_bytes' || s.t < B.steady.from || s.t >= end) continue;
    const c = (mem[s.labels?.container ?? 'target'] ??= { t: [], v: [] });
    c.t.push(s.t);
    c.v.push(s.value);
  }
  driftOut = {
    windows: pts.length, p95_pct: drift(pts.map((w) => w.p95_ms), pts.map((w) => w.start)),
    memory_pct: Object.fromEntries(Object.entries(mem).map(([k, c]) => [k, drift(c.v, c.t)]).filter(([, v]) => v !== null)),
  };
}
// A stepped profile (stress, capacity) is judged step by step. Each step's first window is its
// settling time; the whole windows after it, up to where load stopped, are its numbers. A step the
// run never finished (an auto-stop, a stop) is marked incomplete, never read as passed.
const steps = stepBounds(spec.profile).map((s) => {
  const end = Math.min(s.to, loadEnd);
  const w = selectWindows(windows, T.window_s, s.from + T.window_s, end);
  const whole = Math.floor((end - s.from - T.window_s) / T.window_s + 1e-9);
  const m = whole > 0 && w.length ? mergeWindows(w, T.window_s, whole * T.window_s) : null;
  return {
    index: s.index, [spec.profile.arrival_rps ? 'arrival_rps' : 'users']: s.value, from_s: s.from, to_s: s.to,
    complete: end >= s.to - 1e-9 && Boolean(m),
    ...(m ? { total: m.total, endpoints: Object.fromEntries(Object.entries(m.endpoints).map(([k, e]) => [k, { requests: e.requests, p95_ms: e.p95_ms, p99_ms: e.p99_ms, error_rate: e.error_rate }])) } : {}),
  };
});
// Report the span the numbers really cover: the whole windows, not a partial one at a stop.
if (kind === 'steady') to = from + duration;
const measured = merged.total.requests > 0 && (kind === 'steady' || !hasSteady);
// A worker that froze for more than 5 % of the measured span sent less load than planned, so the
// numbers describe a lighter test than the one asked for: the run is degraded.
const span = Math.max(1e-9, to - from);
for (const w of state.workers) {
  const frozen = (statusOf(w)?.stalls ?? []).reduce((a, s) => a + Math.max(0, Math.min(s.to, to) - Math.max(s.from, from)), 0);
  if (!w.lost && frozen > 0.05 * span) {
    w.stalled = true;
    problem('worker_stalled', `${w.id} froze for ${Math.round(frozen * 10) / 10} s of the ${Math.round(span * 10) / 10} s measured; it sent less load than planned`);
    emit(runDir, { t: tNow(), type: 'anomaly', severity: 'warn', summary: `${w.id} stalled ${Math.round(frozen * 10) / 10} s in the measured window`, data: { worker: w.id, stalled_s: frozen } });
  }
}
// A sidecar engine that started its stages late (k6 after a slow setup) runs its profile shifted
// by that lag; the stop at the profile's end then cuts its steady state when the lag exceeds the
// rampdown, so that worker sent less steady load than planned.
const rampdown = B.end - B.steady.to;
for (const w of state.workers) {
  const lag = statusOf(w)?.start_lag_s;
  if (!w.lost && lag > rampdown + T.tick_ms / 1000) {
    w.stalled = true;
    problem('engine_start_lag', `${w.id} started its load ${Math.round(lag * 10) / 10} s after go; with ${rampdown} s of rampdown its steady state was cut short`, { lag_s: Math.round(lag * 10) / 10, rampdown_s: rampdown });
  }
}
// Open model: arrivals the engine could not start in steady (k6 dropped_iterations: every VU was
// busy) mean the planned rate was not held. From 1 % of the planned arrivals the run is degraded:
// its numbers describe a lighter load than the one asked for.
if (spec.profile.arrival_rps) {
  const dropped = state.workers.reduce((a, w) => a + (statusOf(w)?.dropped_steady ?? 0), 0);
  let planned = 0;
  for (let t = B.steady.from; t < B.steady.to - 1e-9; t += 0.1) planned += arrivalAt(t + 0.05, spec.profile) * Math.min(0.1, B.steady.to - t);
  if (planned > 0 && dropped >= 0.01 * planned) {
    for (const w of state.workers) if (statusOf(w)?.dropped_steady) w.stalled = true;
    problem('arrival_shortfall', `${dropped} of about ${Math.round(planned)} planned arrivals in steady were never started: every virtual user was busy. Raise profile.users (the VU cap), or the target is too slow to hold ${spec.profile.arrival_rps} rps`);
  }
}
const saturated = state.workers.some((w) => w.saturated);
const lostWorkers = state.workers.filter((w) => w.lost || w.stalled).length;
const unmonitored = spec.monitor?.metrics !== 'none' ? watched.filter((c) => !sampled.has(c)) : [];
if (unmonitored.length) problem('monitoring_failed', `no ${spec.monitor.metrics} sample ever arrived for ${what} ${unmonitored.join(', ')}${hostProcess ? ' (not running, or not found by its pid, port or match)' : ''}; the target was not monitored and its auto-stop could not fire`);
if (signalling) await signalling;
const unread = signals.filter((s) => !signalSeen.has(s.name));
// A counter that answered once has no rate yet: said as such, not as a signal that never answered.
const why = (s) => (signalAnswered.has(s.name) ? 'one reading only; a counter needs two' : signalFailed.get(s.name) ?? 'not read before the run ended');
if (unread.length) problem('signal_missing', `no sample from signal ${unread.map((s) => `${s.name} (${why(s)})`).join(', ')}; the analysis cannot use it`, { signals: unread.map((s) => s.name) });
const finalName = finalState({ stopReason: state.stop_reason === 'complete' ? null : state.stop_reason, saturated, measured, lostWorkers, unmonitored: unmonitored.length > 0 });
if (!measured && !state.stop_reason) problem('no_measured_window', 'no complete steady-state window with samples');

// Cleanup (PS-B6): the data manifest's command runs after every run, once the load has stopped,
// with the run id in $RUN_ID (and substituted in the command, for any shell). "none: <reason>"
// declares a target that keeps no data. A failed cleanup does not change what was measured; the
// verdict says the run's data may be left behind.
async function cleanup() {
  const manifest = readJson(join(runDir, '..', '..', 'data', 'manifest.json'));
  const command = manifest?.cleanup?.command;
  if (!command) return null;
  if (/^none\b/i.test(command.trim())) return { skipped: command.trim() };
  const cmd = command.replace(/\$\{RUN_ID\}|\$RUN_ID|%RUN_ID%/g, spec.run_id);
  const timeout = (Number(manifest.cleanup.timeout_s) > 0 ? Number(manifest.cleanup.timeout_s) : 120) * 1000;
  const started = Date.now();
  const out = await new Promise((resolve) => {
    let text = '';
    let child;
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    // Its own process group (posix), so a hung cleanup is killed with everything it started.
    try { child = spawn(cmd, { cwd: spec.root ?? join(runDir, '..', '..', '..', '..'), shell: true, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, RUN_ID: spec.run_id } }); } catch (e) { resolve({ exit_code: null, output: String(e.message) }); return; }
    // A hung cleanup is killed as a tree: the shell alone would leave its child holding the pipes,
    // and the controller waiting on them.
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      finish({ exit_code: null, output: `${text.trim().slice(-400)}\n(killed after ${timeout / 1000} s)`.trim() });
    }, timeout);
    child.stdout.on('data', (d) => { text = (text + d).slice(-2000); });
    child.stderr.on('data', (d) => { text = (text + d).slice(-2000); });
    child.on('error', (e) => finish({ exit_code: null, output: String(e.message) }));
    // Done when the command exits: a background process it left behind may hold the pipes open,
    // and is not this run's to wait for. Its last output gets a moment to arrive.
    child.on('exit', (code) => setTimeout(() => finish({ exit_code: code, output: text.trim().slice(-500) }), 500));
    child.on('close', (code) => finish({ exit_code: code, output: text.trim().slice(-500) }));
  });
  // Evidence never holds a credential the command or its output carried (design §7.3).
  const res = { command: mask(cmd), exit_code: out.exit_code, output: mask(out.output), duration_s: Math.round((Date.now() - started) / 100) / 10 };
  emit(runDir, { t: tNow(), type: 'cleanup', severity: out.exit_code === 0 ? 'info' : 'warn', summary: `cleanup ${out.exit_code === 0 ? 'done' : `failed (exit ${out.exit_code})`}`, data: res });
  return res;
}
mkdirSync(join(runDir, 'hist'), { recursive: true });
writeJson(join(runDir, 'hist', 'merged.json'), merged.hist);
const iso = (s) => (control.go_at && Number.isFinite(s) ? new Date(control.go_at + s * 1000).toISOString() : undefined);
const result = {
  schema: 'perf-result/v1',
  run: {
    id: spec.run_id, tool: engine.tool, tool_version: spec.tool_version ?? engine.name,
    environment: spec.environment, profile: spec.profile.name, target: spec.target_url, users: spec.profile.users,
    model: spec.profile.arrival_rps ? 'open' : 'closed', ...(spec.profile.arrival_rps ? { arrival_rps: spec.profile.arrival_rps } : {}),
    ...(spec.fingerprint ? { fingerprint: spec.fingerprint } : {}),
    // The data counted just before the run (a volume plan), and the instances a perf scale step ran.
    ...(spec.volume ? { volume: spec.volume } : {}),
    ...(spec.instances ? { instances: spec.instances } : {}),
    git_sha: spec.git_sha ?? 'unknown', git_dirty: spec.git_dirty ?? null,
    started_at: state.started_at, ended_at: new Date().toISOString(),
    window: { kind, from: iso(from), to: iso(to) },
  },
  generator: {
    host: hostname(), workers: spec.workers,
    // null = not measured (schema): no CPU sample fell inside the measured window.
    cpu_max_pct: state.workers.some((w) => w.cpu_max_pct !== null) ? Math.max(...state.workers.map((w) => w.cpu_max_pct ?? 0)) : null,
  },
  total: merged.total,
  // Business checks the engine evaluates outside the request (k6 check()); failed ones are failures (PS-D3).
  ...(merged.checks ? { checks: merged.checks } : {}),
  // Players online, drops, reconnects and tick lag over the measured window (v1.1 draft, L).
  ...(merged.realtime ? { realtime: merged.realtime } : {}),
  ...(steps.length ? { steps } : {}),
  ...(spike ? { spike } : {}),
  ...(driftOut?.windows >= 4 ? { drift: driftOut } : {}),
  endpoints: merged.endpoints,
  run_state: finalName,
  problems: state.problems,
  workers: state.workers.map(({ id, pid, state: s, lost, saturated: sat, stalled = false, cpu_max_pct, requests, failures, host, clock_skew_ms }) => ({ id, pid, state: s, lost, saturated: sat, stalled, cpu_max_pct, requests, failures, ...(host ? { host } : {}), ...(clock_skew_ms !== undefined ? { clock_skew_ms } : {}) })),
  hist: 'hist/merged.json',
};
writeJson(join(runDir, 'result.json'), result);
// Cleanup runs once the result is on disk (a controller killed during it loses nothing measured),
// and after ended_at (its time is not the run's).
const cleaned = await cleanup();
if (cleaned) { result.cleanup = cleaned; writeJson(join(runDir, 'result.json'), result); }
transition(state, finalName);
state.ended_at = result.run.ended_at;
emit(runDir, { t: tNow(), type: 'run_finished', severity: finalName === 'done' ? 'info' : 'warn', summary: `run ${finalName}${state.stop_reason && state.stop_reason !== 'complete' ? ` (${state.stop_reason})` : ''}`, data: { state: finalName, stop_reason: state.stop_reason } });
clearInterval(heartbeat);
save();
process.exit(0);
