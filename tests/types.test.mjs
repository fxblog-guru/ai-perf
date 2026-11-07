import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arrivalScenario, stages } from '../adapters/engines/k6/adapter.mjs';
import { stepBounds, spikeBounds, usersAt } from '../controller/profile.mjs';
import { recoveryOf } from '../controller/merge.mjs';
import { drift, theilSen } from '../lib/stats.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { PROFILES, norm, perf, result, runDir, spec, tmp } from './helpers.mjs';
import { readJson, writeJson } from '../controller/files.mjs';
import { JOURNEYS, OPS, project, runFake } from './project.mjs';

// M8: the test types a performance engineer runs besides load — a staircase to find capacity, a
// spike and its recovery, a soak and its drift — each judged on what it is for.
const T = { timeout: 120000 };

const slo = (profiles, extra = {}) => ({ profiles, transactions: OPS.map((name) => ({ name, slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' })), ...extra });
// A closed workload whose planned peak is `users`, consistent with Little's law (think 0.1 s).
const workload = (users) => ({
  model: 'closed', model_reason: 'a fixed pool of signed-in shoppers', target: { users, source: 'assumed' },
  personas: [{ name: 'buyer', share_pct: 100, source: 'assumed' }],
  journeys: JOURNEYS,
  littles_law: { rps: users * 10, response_s: 0, think_s: 0.1, users },
});
const report = (root, ...args) => perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', ...args]);
const verdictJson = (root) => JSON.parse(readFileSync(join(runDir(root), 'verdict.json'), 'utf8'));
// Rewrite a finished run's files, to put the verdict in front of a run that ended another way.
const doctor = (root, file, fn) => { const p = join(runDir(root), file); const x = readJson(p); fn(x); writeJson(p, x); };

// ---- staircase: capacity and headroom ----------------------------------------------------------

// Steps 4, 8, 16 users held 2 s each from t = 2; the target slows twentyfold from step 3 (t = 6).
const STAIRS = { name: 'stress', steps: [4, 8, 16], step_s: 2, warmup_s: 1, ramp_s: 1, rampdown_s: 0.5 };
const BREAKS_AT_16 = { faults: [{ kind: 'slow', factor: 20, from_s: 6 }] };

test('profile: a staircase holds each step for step_s, ramps to the first, and steady is their sum', () => {
  const { spec: s, errors } = norm(spec({ profile: STAIRS }));
  assert.deepEqual(errors, []);
  assert.equal(s.profile.steady_s, 6);
  assert.equal(s.profile.users, 16, 'the top step is the run users');
  assert.deepEqual(stepBounds(s.profile).map((b) => [b.value, b.from, b.to]), [[4, 2, 4], [8, 4, 6], [16, 6, 8]]);
  assert.deepEqual([1.5, 2.5, 4.5, 7.9].map((t) => usersAt(t, s.profile)), [3, 4, 8, 16]);
  assert.match(norm(spec({ profile: { ...STAIRS, steps: [8, 4] } })).errors.join(), /ascending/);
  assert.match(norm(spec({ profile: { ...STAIRS, steps: [4] } })).errors.join(), /at least two/);
  assert.match(norm(spec({ profile: { ...STAIRS, step_s: 0.5 } })).errors.join(), /fewer than two 0.5 s windows/);
  assert.match(norm(spec({ profile: { ...STAIRS, step_s: 1.2 } })).errors.join(), /not a whole number of 0.5 s windows/);
  assert.match(norm(spec({ profile: { ...STAIRS, spike: { users: 40, at_s: 2, for_s: 1 } } })).errors.join(), /steps or spike, not both/);
  // An open staircase sets arrival_rps: an engine that only runs closed loops is refused.
  assert.match(norm(spec({ engine: 'locust', script: 'locustfile.py', profile: { ...STAIRS, model: 'open' } })).errors.join(), /profile.arrival_rps: engine locust runs a closed loop/);
});

test('capacity: the staircase finds the highest step within the SLA, and fails below the planned peak', T, () => {
  const root = tmp();
  // min_rps 85: the capacity step serves 80 (8 users × 10); the staircase's average is about 93.
  project(root, { 'slo.json': slo(['stress'], { min_rps: 85 }), 'workload.json': workload(10) });
  assert.equal(runFake(root, { profile: STAIRS, engine_options: BREAKS_AT_16 }).code, 0);
  const steps = result(runDir(root)).steps;
  assert.deepEqual(steps.map((s) => [s.users, s.complete]), [[4, true], [8, true], [16, true]]);
  assert.ok(steps[1].total.p95_ms < 200 && steps[2].total.p95_ms > 400, `p95 by step: ${steps.map((s) => s.total.p95_ms)}`);
  const r = report(root);
  assert.match(r.out, /FAIL: capacity 8 users is below the planned peak of 10/);
  assert.match(r.out, /FAIL: throughput [\d.]+ rps at the capacity step < minimum 85/);
  assert.match(r.out, /summary: It holds 8 users \([\d.]+ requests\/s\) within the SLA; the planned peak is 10, so the headroom is 0\.8×/);
  const v = verdictJson(root);
  assert.deepEqual(v.capacity.steps.map((s) => s.within_sla), [true, true, false]);
  assert.match(readFileSync(join(runDir(root), 'verdict.md'), 'utf8'), /## Capacity\n\n\| users \| rps \| p95 ms \| error rate \| within SLA \|/);
});

test('capacity: under 20 % headroom is a warning; ample headroom passes; every step held says so', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(7) });
  runFake(root, { profile: STAIRS, engine_options: BREAKS_AT_16 });
  let r = report(root);
  assert.match(r.out, /WARN: capacity 8 users leaves only 14 % headroom over the planned peak of 7/);
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4) });
  r = report(root);
  assert.match(r.out, /VERDICT: PASS/);
  // The first window of a step is its settling time: a target slow only then still holds the step.
  runFake(root, { profile: STAIRS, engine_options: { faults: [{ kind: 'slow', factor: 20, from_s: 4, to_s: 4.5 }] } });
  assert.match(report(root).out, /every step held: the capacity is at least 16 users; add a higher step/);
});

test('capacity: a staircase that auto-stops where the target breaks is read from the steps it completed', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4) });
  // The stop comes after step 3 has measured a window or two, but before its end: it has numbers,
  // and is still not complete.
  runFake(root, { profile: STAIRS, auto_stop: [{ metric: 'error_rate', above: 0.5, for_s: 2 }], engine_options: { faults: [{ kind: 'errors', rate: 0.6, from_s: 6 }] } });
  const res = result(runDir(root));
  assert.equal(res.run_state, 'aborted');
  assert.ok(res.steps[2].total?.requests > 0, 'the broken step has numbers');
  assert.deepEqual(res.steps.map((s) => s.complete), [true, true, false], 'the broken step is not complete');
  const r = report(root);
  assert.match(r.out, /the staircase broke: auto-stop \(auto_stop:error_rate\) during step 3; capacity is read from the steps that completed/);
  assert.doesNotMatch(r.out, /the target failed under load/);
  assert.match(r.out, /It holds 8 users/);
});

test('capacity: a staircase cut short by a stop (not the target) is not evaluable, and the summary says only that', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(10) });
  runFake(root, { profile: STAIRS });
  doctor(root, 'result.json', (r) => { r.run_state = 'stopped'; r.steps[2].complete = false; });
  doctor(root, 'state.json', (s) => { s.stop_reason = 'stop'; });
  const r = report(root);
  assert.match(r.out, /NOT_EVALUABLE: capacity: the run ended \(stop\) during step 3 \(16 users\) before it completed; it held 8 users until then/);
  assert.doesNotMatch(r.out, /FAIL: capacity/);
  assert.match(r.out, /summary: The run cannot be judged: /);
});

test('capacity: a staircase that falls below the promoted one is a regression', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4) });
  runFake(root, { profile: STAIRS });
  report(root, '--promote');
  runFake(root, { profile: STAIRS, engine_options: BREAKS_AT_16 });
  assert.match(report(root).out, /FAIL: capacity regression vs .*: 16 -> 8 users/);
  // Without --bootstrap, the baseline gates apply as to any run.
  assert.match(perf(['report', '--root', root, '--slug', 'demo']).out, /FAIL: capacity regression/);
  // Another staircase is another experiment.
  runFake(root, { profile: { ...STAIRS, steps: [2, 8, 16] }, engine_options: BREAKS_AT_16 });
  const r = report(root);
  assert.match(r.out, /climbed other steps \(4,8,16, this run 2,8,16\): capacity not compared/);
  assert.doesNotMatch(r.out, /capacity regression/);
});

test('capacity: a first staircase needs --bootstrap, like any first run (PS-F4)', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4) });
  runFake(root, { profile: STAIRS });
  assert.match(perf(['report', '--root', root, '--slug', 'demo']).out, /NOT_EVALUABLE: no baseline at baselines\/local\/stress.json \(PS-F4\)/);
});

test('k6 and the profile agree on a staircase: jumps between steps, each held step_s', () => {
  const p = norm(spec({ profile: STAIRS })).spec.profile;
  assert.deepEqual(stages(p, 0, 1), ['0ms:2', '1000ms:2', '1000ms:4', '2000ms:4', '0ms:8', '2000ms:8', '0ms:16', '2000ms:16', '500ms:0']);
  const open = norm(spec({ profile: { ...STAIRS, model: 'open', arrival_rps: 1 } })).spec.profile;
  assert.equal(open.arrival_rps, 16);
  const sc = arrivalScenario(open, 0, 1);
  assert.deepEqual(sc.stages.filter((s) => s.duration === '0ms').map((s) => s.target), [480, 960], 'the rate jumps at each step (k6 counts per minute)');
});

// ---- spike: recovery -----------------------------------------------------------------------

// Base 4 users, a jump to 12 at steady + 4 s (t = 7) for 3 s; the target stays slow until t = 13,
// so it comes back 3 s after the spike ends.
const SPIKE = { name: 'spike', users: 4, spike: { users: 12, at_s: 4, for_s: 3 }, warmup_s: 2, ramp_s: 1, steady_s: 14, rampdown_s: 1 };
const LINGERS = (to_s) => ({ faults: [{ kind: 'slow', factor: 4, from_s: 7, ...(to_s ? { to_s } : {}) }] });

test('profile: a spike jumps inside steady and comes back; it needs steady before and after it', () => {
  const p = norm(spec({ profile: SPIKE })).spec.profile;
  assert.deepEqual(spikeBounds(p), { from: 7, to: 10 });
  assert.deepEqual([6.9, 7, 9.9, 10].map((t) => usersAt(t, p)), [4, 12, 12, 4]);
  assert.deepEqual(stages(p, 0, 1), ['0ms:1', '2000ms:1', '1000ms:4', '4000ms:4', '0ms:12', '3000ms:12', '0ms:4', '7000ms:4', '1000ms:0']);
  assert.match(norm(spec({ profile: { ...SPIKE, spike: { users: 3, at_s: 4, for_s: 3 } } })).errors.join(), /spike.users: a number above the base users/);
  assert.match(norm(spec({ profile: { ...SPIKE, spike: { users: 12, at_s: 12, for_s: 2 } } })).errors.join(), /steady before it and after it/);
  assert.match(norm(spec({ profile: { ...SPIKE, spike: { users: 12, at_s: 4, for_s: 0.3 } } })).errors.join(), /whole numbers of 0.5 s windows/);
  assert.match(norm(spec({ profile: { ...SPIKE, spike: { users: 12, at_s: 0.5, for_s: 3 } } })).errors.join(), /fewer than two 0.5 s windows of base/);
  assert.match(norm(spec({ profile: { ...SPIKE, spike: { users: 12, at_s: 4, for_s: 9.5 } } })).errors.join(), /0.5 s of steady after the spike holds fewer than two/);
});

test('spike: back means two windows in a row near the base, serving near its requests', () => {
  const base = { requests: 400, p95_ms: 50, error_rate: 0 };
  const w = (start, p95_ms, requests = 100, error_rate = 0) => ({ start, p95_ms, requests, error_rate });
  const baseSeries = [w(0, 48), w(1, 52), w(2, 51), w(3, 49)];
  // One good window between bad ones is noise, not recovery.
  assert.equal(recoveryOf(base, baseSeries, [w(10, 300), w(11, 55), w(12, 300), w(13, 55), w(14, 52)]).back.start, 13);
  // Fast but serving a third of the requests: not back.
  assert.equal(recoveryOf(base, baseSeries, [w(10, 40, 30), w(11, 40, 30), w(12, 50), w(13, 50)]).back.start, 12);
  // 20 % + 5 ms of 50 is 65 ms; errors within 0.5 pp.
  assert.equal(recoveryOf(base, baseSeries, [w(10, 66), w(11, 65), w(12, 65), w(13, 50, 100, 0.006), w(14, 50)]).back.start, 11);
  assert.equal(recoveryOf(base, baseSeries, [w(10, 300), w(11, 300)]).back, null);
  assert.equal(recoveryOf(base, baseSeries, []).steady_pct, 100);
  assert.equal(recoveryOf({ ...base, requests: 200 }, [w(0, 48), w(1, 300)], []).steady_pct, 50);
});

test('spike: recovery is the time back to the base after the spike, judged against the budget', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['spike']) });
  assert.equal(runFake(root, { profile: SPIKE, engine_options: LINGERS(13) }).code, 0);
  const s = result(runDir(root)).spike;
  assert.equal(s.recovered, true);
  // Back from the window 13-13.5 s on, counted at its end: 3.5 s after the spike ended at 10 s.
  assert.equal(s.recovery_s, 3.5);
  assert.ok(s.base_steady_pct >= 50, `the base passes its own recovery test (${s.base_steady_pct} %)`);
  assert.ok(s.peak_p95_ms > 4 * s.base.total.p95_ms * 0.8, `peak ${s.peak_p95_ms} against base ${s.base.total.p95_ms}`);
  let r = report(root);
  assert.match(r.out, /VERDICT: PASS/);
  assert.match(r.out, /no recovery budget was planned .* the default 30 s applied/);
  assert.match(r.out, /summary: After a spike to 12 users, it came back in 3.5 s \(budget 30 s\)/);
  project(root, { 'slo.json': slo(['spike'], { spike: { recovery_s: 2 } }) });
  r = report(root);
  assert.match(r.out, /FAIL: spike: recovery took 3.5 s, over the budget of 2 s/);
  // A base that does not pass its own test cannot say when the target is back.
  doctor(root, 'result.json', (x) => { x.spike.base_steady_pct = 20; });
  assert.match(report(root).out, /NOT_EVALUABLE: spike: the base is too noisy .* only 20 % of its own windows/);
});

test('spike: a target that never comes back fails; the base, not the spike, is judged against the SLA', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['spike'], { spike: { recovery_s: 5 } }) });
  runFake(root, { profile: SPIKE, engine_options: LINGERS() });
  let r = report(root);
  assert.match(r.out, /FAIL: spike: the target did not come back to its base .* within 7 s, more than the 5 s budget/);
  assert.match(r.out, /summary: After a spike to 12 users, it did not come back before the load ended/);
  // Transactions are those of the steady before the spike: within the SLA though the spike was not.
  assert.ok(verdictJson(root).transactions.every((t) => t.outcome === 'PASS'));
  // A budget longer than the steady after the spike: not back yet is not "never back".
  project(root, { 'slo.json': slo(['spike'], { spike: { recovery_s: 10 } }) });
  r = report(root);
  assert.match(r.out, /NOT_EVALUABLE: spike: the load ended 7 s after the spike, before the 10 s recovery budget ran out/);
  assert.doesNotMatch(r.out, /FAIL: spike/);
});

// ---- soak: drift ---------------------------------------------------------------------------

// 16 s of steady in 0.5 s windows: 32, past the 30 a drift needs.
const SOAK = { name: 'soak', users: 4, warmup_s: 1, ramp_s: 1, steady_s: 16, rampdown_s: 0.5 };

test('drift: a robust line through the series, in % of its fitted start', () => {
  assert.equal(drift([100, 110, 120, 130]), 30);
  assert.equal(drift([100, 100, 500, 100, 100]), 0, 'one outlier is not a trend');
  assert.equal(drift([1, 2, 3]), null, 'too few points');
  assert.equal(theilSen([2, 4, 6]).slope, 2);
  // On time, not on sample order: a gap in the samples does not bend the line.
  assert.equal(drift([100, 110, 120, 200, 210, 220], [0, 1, 2, 10, 11, 12]), 120);
  // A day of samples every 5 s (17 280) is binned: fast, and still the right answer.
  const t0 = Date.now();
  const ts = Array.from({ length: 17280 }, (_, i) => i * 5);
  assert.equal(drift(ts.map((t) => 100 + t / 1000), ts), 86.4);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('soak: p95 that grows at constant load fails; flat p95 without memory warns; a short soak is not evaluable', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['soak'], { soak: { max_p95_drift_pct: 25, max_memory_growth_pct: 10 } }) });
  runFake(root, { profile: SOAK, engine_options: { faults: [{ kind: 'drift', pct_per_s: 8 }] } });
  const d = result(runDir(root)).drift;
  assert.ok(d.windows >= 30 && d.p95_pct > 40, JSON.stringify(d));
  let r = report(root);
  assert.match(r.out, /FAIL: soak: p95 drifted \+[\d.]+ % over steady at constant load \(limit 25 %\)/);
  // Not a knee: the load did not grow when latency did.
  assert.match(perf(['analyze', '--root', root, '--slug', 'demo']).out, /bottleneck: none found/);
  runFake(root, { profile: SOAK });
  r = report(root);
  assert.match(r.out, /VERDICT: WARN/);
  assert.match(r.out, /WARN: soak: target memory not measured \(monitor.metrics is none\); a leak cannot be ruled out/);
  // Too few windows to tell drift from noise.
  runFake(root, { profile: { ...SOAK, steady_s: 10 } });
  assert.match(report(root).out, /NOT_EVALUABLE: soak: 20 steady windows with requests; drift needs at least 30/);
  assert.match(r.out, /summary: At constant load, p95 moved [+-][\d.]+ % over steady \(memory not measured\)/);
});

test('soak: memory that grows over steady is a leak until shown otherwise (stand-in docker)', T, () => {
  const root = tmp();
  // Each `docker stats` call reports 20 MiB more than the last.
  const fake = join(root, 'fake-docker.cjs');
  writeFileSync(fake, `const fs = require('fs'); const f = ${JSON.stringify(join(root, 'n.txt'))};
let n = 0; try { n = Number(fs.readFileSync(f, 'utf8')); } catch {}
fs.writeFileSync(f, String(n + 1));
console.log(JSON.stringify({ Name: 'shop-api', CPUPerc: '20%', MemPerc: '10%', MemUsage: (100 + 20 * n) + 'MiB / 1GiB' }));`);
  project(root, {
    'slo.json': slo(['soak']),
    'env.json': { environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: PROFILES, owner: 'test', parity: 'laptop mock', third_party: [{ name: 'payments', stubbed: true }], monitor: { metrics: 'docker-stats', containers: ['shop-api'], interval_s: 0.5 } } } },
  });
  process.env.PERF_DOCKER = fake;
  try { runFake(root, { profile: SOAK }); } finally { delete process.env.PERF_DOCKER; }
  const d = result(runDir(root)).drift;
  assert.ok(d.memory_pct['shop-api'] > 50, JSON.stringify(d));
  const r = report(root);
  assert.match(r.out, /FAIL: soak: memory of shop-api grew \+[\d.]+ % over steady \(limit 10 %\): a leak until shown otherwise/);
  assert.match(r.out, /soak: no max_p95_drift_pct, max_memory_growth_pct was planned/);
});

test('slo.json: spike and soak limits are checked like any other', () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['soak'], { soak: { max_p95_drift: 5 }, spike: { recovery_s: -1 } }) });
  const errs = CHECKS.plan(root, 'demo').errors.join('\n');
  assert.match(errs, /soak.max_p95_drift: not a judged limit/);
  assert.match(errs, /spike.recovery_s must be a number above 0/);
});
