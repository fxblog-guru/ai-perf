import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { create, merge, percentile } from '../controller/hist.mjs';
import { readWindows, selectWindows } from '../controller/merge.mjs';
import { ROOT, events, perf, result, runDir, spec, state, tmp, validate, waitFor, writeSpec } from './helpers.mjs';

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'schemas', 'perf-result.schema.json'), 'utf8'));
const T = { timeout: 30000 };

test('a clean run ends done, exit 0, with a valid perf-result/v1 over the steady window', T, () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec()), '--root', root, '--wait']);
  assert.equal(r.code, 0, r.out + r.err);
  const dir = runDir(root);
  const res = result(dir);
  assert.deepEqual(validate(SCHEMA, res), []);
  assert.equal(res.run_state, 'done');
  assert.equal(res.run.window.kind, 'steady');
  assert.equal(res.generator.workers, 2);
  assert.deepEqual([res.run.users, res.workers.map((w) => w.stalled)], [20, [false, false]]);
  // `--wait` waits on the controller's own deadline, set once its workers started: after the
  // start, at least barrier + profile + drain away.
  const st = state(dir);
  assert.ok(st.hard_deadline - Date.parse(st.started_at) >= (5 + 3.5 + 3) * 1000, `hard_deadline ${st.hard_deadline}`);
  // 20 users × 10 rps = 200; tick jitter costs a few percent.
  assert.ok(res.total.rps > 170 && res.total.rps < 215, `rps ${res.total.rps}`);
  assert.ok(res.total.p50_ms > 40 && res.total.p50_ms < 60, `p50 ${res.total.p50_ms}`);
  const s = state(dir);
  assert.deepEqual(s.history.map((h) => h.state), ['preparing', 'warmup', 'ramp', 'steady', 'rampdown', 'collecting', 'done']);
  const types = events(dir).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'phase_changed').length, 4);
  assert.equal(types.at(-1), 'run_finished');
});

test('ramps never reach the measured numbers (PS-D1)', T, () => {
  const root = tmp();
  const s = spec({ engine_options: { faults: [{ kind: 'slow', from_s: 0, to_s: 1.0, factor: 20 }] } });
  assert.equal(perf(['run', writeSpec(root, s), '--root', root, '--wait']).code, 0);
  const res = result(runDir(root));
  // Slowed samples are about 1 s; steady samples stay near 50 ms (sigma 0.3).
  assert.ok(res.total.max_ms < 400, `max ${res.total.max_ms} leaked from the ramp`);
});

test('percentiles come from merged histograms, not averaged per worker', T, () => {
  const root = tmp();
  const s = spec({ engine_options: { faults: [{ kind: 'slow', worker: 1, factor: 10 }] } });
  assert.equal(perf(['run', writeSpec(root, s), '--root', root, '--wait']).code, 0);
  const dir = runDir(root);
  const res = result(dir);
  const steady = selectWindows(readWindows(dir), 0.5, 1.0, 3.0);
  const perWorker = [0, 1].map((w) => {
    const h = create();
    for (const win of steady.filter((x) => x.worker === w)) for (const e of Object.values(win.endpoints)) merge(h, e.hist);
    return h;
  });
  const all = merge(merge(create(), perWorker[0]), perWorker[1]);
  assert.equal(res.total.p95_ms, percentile(all, 0.95));
  const averaged = (percentile(perWorker[0], 0.95) + percentile(perWorker[1], 0.95)) / 2;
  assert.notEqual(res.total.p95_ms, averaged);
});

test('a profile with no steady phase is judged on the whole run', T, () => {
  const root = tmp();
  // 1.2 s is not a multiple of the 0.5 s window, so the last window is partial.
  const s = spec({ profile: { name: 'smoke', users: 2, warmup_users: 2, warmup_s: 1.2, ramp_s: 0, steady_s: 0, rampdown_s: 0 } });
  assert.equal(perf(['run', writeSpec(root, s), '--root', root, '--wait']).code, 0);
  const res = result(runDir(root));
  assert.equal(res.run.window.kind, 'whole-run');
  assert.equal(res.run_state, 'done');
  // 2 users × 10 rps over 1.2 s: the partial last window must not dilute the rate.
  assert.ok(res.total.rps > 17.5 && res.total.rps < 22.5, `rps ${res.total.rps}`);
});

test('a warmup that is not a multiple of window_s still measures the whole steady phase', T, () => {
  const root = tmp();
  const s = spec({ profile: { warmup_s: 0.3, ramp_s: 0.4 } });
  assert.equal(perf(['run', writeSpec(root, s), '--root', root, '--wait']).code, 0);
  const res = result(runDir(root));
  assert.equal(res.run.window.kind, 'steady');
  assert.equal(Date.parse(res.run.window.to) - Date.parse(res.run.window.from), 2000);
  assert.ok(res.total.rps > 170 && res.total.rps < 215, `rps ${res.total.rps}`);
});

test('generator CPU counts only in the measured window', T, () => {
  const root = tmp();
  const s = spec({ engine_options: { faults: [{ kind: 'saturate', pct: 95, from_s: 0, to_s: 0.8 }] } });
  assert.equal(perf(['run', writeSpec(root, s), '--root', root, '--wait']).code, 0);
  const res = result(runDir(root));
  assert.equal(res.run_state, 'done');
  assert.equal(res.generator.cpu_max_pct, 10);
});

test('the run survives the session: perf run returns at once and the run completes alone', T, async () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec({ profile: { steady_s: 6 } })), '--root', root]);
  assert.equal(r.code, 0);
  const dir = runDir(root);
  // The property, not a stopwatch: when perf run has returned, the run is still going.
  assert.ok(!['done', 'degraded', 'not_evaluable', 'aborted'].includes(state(dir)?.state), 'perf run must not wait for the run');
  await waitFor(() => state(dir)?.state === 'done', 15000, 'detached run to finish');
  assert.match(perf(['status', '--root', root]).out, /done .*controller finished/);
});
