import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { events, perf, perfAsync, result, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

const T = { timeout: 30000 };
const faults = (...f) => ({ engine_options: { faults: f } });

test('a crashed worker makes the run degraded, never done (exit 4)', T, () => {
  const root = tmp();
  const s = spec({ ...faults({ kind: 'crash', worker: 1, at_s: 1.5 }), profile: { steady_s: 6 } });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 4, r.out);
  const dir = runDir(root);
  assert.equal(result(dir).run_state, 'degraded');
  const lost = events(dir).find((e) => e.type === 'worker_lost');
  assert.equal(lost?.data.worker, 'w1');
  assert.equal(lost?.data.reason, 'stale');
});

test('a worker that dies too late to be noticed during load still makes the run degraded', T, () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec(faults({ kind: 'crash', worker: 1, at_s: 3.2 }))), '--root', root, '--wait']);
  assert.equal(r.code, 4, r.out);
  const dir = runDir(root);
  assert.equal(events(dir).find((e) => e.type === 'worker_lost')?.data.reason, 'no_stop_ack');
});

test('a saturated generator makes the run not evaluable (PS-A5, exit 3)', T, () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec(faults({ kind: 'saturate', worker: 0, pct: 95 }))), '--root', root, '--wait']);
  assert.equal(r.code, 3, r.out);
  const dir = runDir(root);
  assert.equal(result(dir).run_state, 'not_evaluable');
  assert.equal(result(dir).generator.cpu_max_pct, 95);
  assert.ok(events(dir).some((e) => e.type === 'generator_saturated'));
});

test('an error storm trips the hard auto-stop within its bound (exit 5)', T, () => {
  const root = tmp();
  const s = spec({
    ...faults({ kind: 'errors', from_s: 1.2, rate: 0.6, class: 'HTTP 503' }),
    auto_stop: [{ metric: 'error_rate', above: 0.2, for_s: 0.5, min_requests: 10 }],
    profile: { steady_s: 6 },
  });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 5, r.out);
  const dir = runDir(root);
  const st = state(dir);
  assert.equal(st.state, 'aborted');
  assert.equal(st.stop_reason, 'auto_stop:error_rate');
  // Errors start at 1.2 s and the rule needs 0.5 s of them; 3 s of slack covers a busy machine and
  // is still far below the 8 s the run would otherwise last.
  const stopped = events(dir).find((e) => e.type === 'auto_stopped');
  assert.ok(stopped.t <= 1.2 + 0.5 + 3, `stopped at t=${stopped.t}`);
  assert.ok(events(dir).some((e) => e.type === 'new_error_class' && e.data.class === 'HTTP 503'));
});

test('a worker that never gets ready aborts the run at the barrier; no load is sent', T, () => {
  const root = tmp();
  const s = spec({ ...faults({ kind: 'never_ready', worker: 1 }), timing: { barrier_timeout_s: 1.5 } });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 5, r.out);
  const dir = runDir(root);
  assert.equal(state(dir).stop_reason, 'barrier_timeout');
  assert.equal(state(dir).go_at, null);
  assert.equal(result(dir).total.requests, 0);
  assert.equal(result(dir).generator.cpu_max_pct, null, 'nothing measured is null, not 0');
});

test('perf stop aborts a live run (reason manual)', T, async () => {
  const root = tmp();
  const waiting = perfAsync(['run', writeSpec(root, spec({ profile: { steady_s: 8 } })), '--root', root, '--wait']);
  const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 10000, 'steady');
  await waitFor(() => (state(dir)?.go_at && Date.now() - state(dir).go_at > 3000), 10000, 't > 3 s');
  const stopAt = Date.now();
  assert.equal(perf(['stop', '--root', root]).code, 0);
  const r = await waiting;
  assert.equal(r.code, 5);
  assert.equal(state(dir).stop_reason, 'manual');
  // The window holding the stop is partial: it must neither count as whole nor dilute the rate.
  const res = result(dir);
  assert.equal(res.run.window.kind, 'steady');
  const loadStopped = Date.parse(state(dir).history.find((h) => h.state === 'collecting').at);
  assert.ok(stopAt < loadStopped);
  assert.ok(Date.parse(res.run.window.to) <= loadStopped, 'the window holding the stop is not counted');
  assert.ok(res.total.rps > 170 && res.total.rps < 215, `rps ${res.total.rps}`);
  const again = perf(['stop', '--root', root, '--run', res.run.id]);
  assert.equal(again.code, 1, 'a finished run cannot be stopped');
  assert.match(again.err, /already finished \(aborted\)/);
  assert.equal(perf(['stop', '--root', root]).code, 1, 'no live run left');
});

test('workers whose clocks are 5 s off either way still run on the controller clock', T, () => {
  const root = tmp();
  const s = spec(faults({ kind: 'clock_skew', worker: 0, ms: -5000 }, { kind: 'clock_skew', worker: 1, ms: 5000 }));
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 0, r.out);
  const res = result(runDir(root));
  assert.equal(res.run_state, 'done');
  assert.ok(res.workers.every((w) => w.requests > 0 && !w.lost));
  assert.ok(res.total.rps > 170 && res.total.rps < 215, `rps ${res.total.rps}`);
});

test('a worker that freezes sends no catch-up load and makes the run degraded', T, () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec({ ...faults({ kind: 'stall', worker: 1, at_s: 1.5, for_s: 1.5 }), profile: { steady_s: 4 } })), '--root', root, '--wait']);
  assert.equal(r.code, 4, r.out);
  const dir = runDir(root);
  const st = state(dir);
  // At least the injected 1.5 s (one tick of rounding); a busy machine can only add to it.
  const frozen = st.problems.find((p) => p.kind === 'worker_stalled')?.detail.match(/^w1 froze for ([\d.]+) s/);
  assert.ok(frozen && Number(frozen[1]) >= 1.4, JSON.stringify(st.problems));
  assert.ok(events(dir).some((e) => e.type === 'anomaly'));
  // The frozen worker's steady load is short by about the freeze, not caught up afterwards.
  const res = result(dir);
  const [w0, w1] = res.workers;
  assert.ok(w1.requests < w0.requests * 0.85, `w0 ${w0.requests}, w1 ${w1.requests}`);
  assert.deepEqual([w0.stalled, w1.stalled], [false, true]);
});

test('a target that completes nothing for a window lowers the rate; empty windows still count', T, () => {
  const root = tmp();
  // Steady runs 1-3 s in 0.5 s windows; the target hangs for the whole 1.5-2 s window.
  const r = perf(['run', writeSpec(root, spec(faults({ kind: 'hang', from_s: 1.5, to_s: 2 }))), '--root', root, '--wait']);
  assert.equal(r.code, 0, r.out);
  const res = result(runDir(root));
  assert.ok(res.total.rps > 130 && res.total.rps < 165, `rps ${res.total.rps}: 3 of 4 windows at 200 rps is 150`);
  assert.equal(Date.parse(res.run.window.to) - Date.parse(res.run.window.from), 2000);
});

test('a target that completes nothing at all leaves the run not evaluable, and says why', T, () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec(faults({ kind: 'hang' }))), '--root', root, '--wait']);
  assert.equal(r.code, 3, r.out);
  assert.deepEqual(result(runDir(root)).problems.map((p) => p.kind), ['no_measured_window']);
});

test('all workers lost aborts the run', T, () => {
  const root = tmp();
  const s = spec({ ...faults({ kind: 'crash', at_s: 1.5 }), profile: { steady_s: 6 } });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 5, r.out);
  assert.equal(state(runDir(root)).stop_reason, 'all_workers_lost');
});

test('sustained generator CPU trips its auto-stop rule', T, () => {
  const root = tmp();
  const s = spec({ ...faults({ kind: 'saturate', pct: 95 }), auto_stop: [{ metric: 'generator_cpu_pct', above: 90, for_s: 0.3 }] });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 5, r.out);
  assert.equal(state(runDir(root)).stop_reason, 'auto_stop:generator_cpu_pct');
});

test('a saturated generator in a profile without steady is still not evaluable', T, () => {
  const root = tmp();
  const s = spec({ ...faults({ kind: 'saturate', pct: 95 }), profile: { name: 'smoke', users: 2, warmup_s: 1.5, ramp_s: 0, steady_s: 0, rampdown_s: 0 } });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 3, r.out + r.err);
});

test('a worker that cannot start aborts at the barrier with the reason', T, () => {
  const root = tmp();
  const started = Date.now();
  const s = spec({ engine_options: { spawn_fail: true }, timing: { barrier_timeout_s: 30 } });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait']);
  assert.equal(r.code, 5, r.out);
  assert.ok(Date.now() - started < 15000, 'does not wait for the 30 s barrier timeout');
  const st = state(runDir(root));
  assert.equal(st.stop_reason, 'worker_failed');
  assert.match(st.problems[0].detail, /spawn_failed: ENOENT/);
});

test('a foreign host or production is refused before anything starts (exit 2)', T, () => {
  for (const over of [{ target_url: 'https://shop.example.com' }, { environment: 'prod' }]) {
    const root = tmp();
    const r = perf(['run', writeSpec(root, spec(over)), '--root', root, '--wait']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /run refused/);
    assert.equal(existsSync(join(root, '.perf', 'demo', 'runs')), false);
  }
});
