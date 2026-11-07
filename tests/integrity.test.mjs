import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runner } from '../adapters/engines/k6/adapter.mjs';
import { create, record } from '../controller/hist.mjs';
import { changed, fingerprint } from '../lib/fingerprint.mjs';
import { p95ChangeBound } from '../lib/stats.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { ROOT, norm, perf, result, runDir, spec, tmp, waitFor, writeSpec } from './helpers.mjs';
import { ENDPOINTS, project, runFake } from './project.mjs';

// M7 (from the five-pillar audit and a principal engineer's review): measure honestly under a
// stalling server, judge regressions above noise, and never pass an unplanned or unapproved run.
const T = { timeout: 120000 };

// ---- the open model and coordinated omission ---------------------------------------------

test('open model: the fake engine sends the arrival rate, whatever the users', T, () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec({ profile: { users: 5, arrival_rps: 120 } })), '--root', root, '--wait']);
  assert.equal(r.code, 0, r.out);
  const rps = result(runDir(root)).total.rps;
  assert.ok(rps > 105 && rps < 130, `rps ${rps} for 120 arrivals per second`);
});

test('open model: the k6 scenario holds the planned rate in steady, split exactly over workers', async () => {
  const { arrivalScenario } = await import('../adapters/engines/k6/adapter.mjs');
  const p = { users: 20, arrival_rps: 20, warmup_s: 4, ramp_s: 0, steady_s: 10, rampdown_s: 0 };
  const s = arrivalScenario(p, 0, 1);
  // Warmup holds 10 %, a 0 ms stage jumps to the full rate, and steady holds it.
  assert.deepEqual(s.stages, [{ duration: '4000ms', target: 120 }, { duration: '0ms', target: 1200 }, { duration: '10000ms', target: 1200 }]);
  assert.equal(s.timeUnit, '1m');
  // 0.3 rps over ten workers: 18 a minute in all, never 0.
  const small = { ...p, arrival_rps: 0.3, warmup_rps: 0.3 };
  assert.equal([...Array(10).keys()].reduce((a, i) => a + arrivalScenario(small, i, 10).stages.at(-1).target, 0), 18);
});

test('open model: an engine that runs closed loops refuses an arrival rate instead of running users', () => {
  for (const engine of ['locust', 'ws']) {
    const errors = norm(spec({ engine, script: 'x.py', profile: { arrival_rps: 50 } })).errors;
    assert.ok(errors.some((e) => new RegExp(`engine ${engine} runs a closed loop of users; an open model \\(arrival rate\\) needs k6`).test(e)), errors.join('\n'));
  }
  assert.ok(norm(spec({ profile: { arrival_rps: 0 } })).errors.some((e) => /profile.arrival_rps: a number > 0/.test(e)));
});

const K6 = runner();
async function stallingMock() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, MOCK_HOST: '0.0.0.0', MOCK_STALL_EVERY_S: '5', MOCK_STALL_S: '1.5' } });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}
const K6_TIMING = { tick_ms: 500, window_s: 5, heartbeat_timeout_s: 10, worker_timeout_s: 10, barrier_timeout_s: 120 };

test('coordinated omission: under a stalling server, a closed loop reads a small p95 and the verdict will not pass it; an open model measures the stalls', { timeout: 300000, skip: K6 ? false : 'no k6 binary and no grafana/k6 image' }, async () => {
  const mock = await stallingMock();
  try {
    const root = tmp();
    project(root);
    copyFileSync(join(ROOT, 'mock', 'k6-load.js'), join(root, 'k6-load.js'));
    const base = { engine: 'k6', script: 'k6-load.js', workers: 1, target_url: mock.url, timing: K6_TIMING, engine_options: {} };
    const closed = spec({ ...base, profile: { users: 10, warmup_s: 3, ramp_s: 2, steady_s: 20, rampdown_s: 3 } });
    perf(['run', writeSpec(root, closed), '--root', root, '--wait'], 200000);
    const c = result(runDir(root));
    assert.ok(c.total.p95_ms < 300 && c.total.p99_ms > 1000, `closed: p95 ${c.total.p95_ms}, p99 ${c.total.p99_ms}`);
    const v = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
    assert.doesNotMatch(v.out, /VERDICT: PASS/);
    assert.match(v.out, /heavy tail, p99 [\d.]+ ms is \d+× p95 .*coordinated omission/);
    // Open: 40 arrivals per second whatever the server does; 200 VUs are enough to wait out a stall.
    const open = spec({ ...base, profile: { users: 200, arrival_rps: 40, warmup_s: 3, ramp_s: 2, steady_s: 20, rampdown_s: 3 } });
    perf(['run', writeSpec(root, open), '--root', root, '--wait'], 200000);
    const o = result(runDir(root));
    assert.ok(o.total.p95_ms > 800, `open: p95 ${o.total.p95_ms} shows the stalls`);
  } finally { mock.stop(); }
});

test('open model: too few virtual users to hold the rate is an arrival shortfall, and the run is degraded', { timeout: 300000, skip: K6 ? false : 'no k6 binary and no grafana/k6 image' }, async () => {
  const mock = await stallingMock();
  try {
    const root = tmp();
    copyFileSync(join(ROOT, 'mock', 'k6-load.js'), join(root, 'k6-load.js'));
    const s = spec({ engine: 'k6', script: 'k6-load.js', workers: 1, target_url: mock.url, timing: K6_TIMING, engine_options: {}, profile: { users: 10, arrival_rps: 40, warmup_s: 3, ramp_s: 2, steady_s: 15, rampdown_s: 3 } });
    const r = perf(['run', writeSpec(root, s), '--root', root, '--wait'], 200000);
    assert.equal(r.code, 4, r.out);
    assert.match(result(runDir(root)).problems.find((p) => p.kind === 'arrival_shortfall')?.detail ?? '', /planned arrivals in steady were never started/);
  } finally { mock.stop(); }
});

// ---- the verdict ---------------------------------------------------------------------------

test('verdict: a p99 limit in the plan is judged; the plan gate checks it', T, () => {
  const root = tmp();
  project(root);
  const p = join(root, '.perf', 'demo', 'slo.json');
  const slo = JSON.parse(readFileSync(p, 'utf8'));
  slo.transactions[0].sla.p99_ms = 1;
  slo.transactions[0].slo.p99_ms = 1;
  writeFileSync(p, JSON.stringify(slo));
  runFake(root);
  assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /FAIL: listItems: p99 [\d.]+ > SLA 1/);
  slo.transactions[0].slo.p99_ms = 5;
  writeFileSync(p, JSON.stringify(slo));
  assert.match(CHECKS.plan(root, 'demo').errors.join('\n'), /slo.p99_ms 5 is looser than sla.p99_ms 1/);
});

test('verdict: a run on an unfinished plan cannot pass: each gate failing is NOT EVALUABLE', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /VERDICT: PASS/);
  unlinkSync(join(root, '.perf', 'demo', 'workload.json'));
  const r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /NOT_EVALUABLE: the model gate fails \(perf check model\): workload.json missing/);
});

test('regression: sampling noise is not a regression; a real change is, at 95 % confidence', async () => {
  const lognormal = (n, f, seed) => {
    let s = seed;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const h = create();
    for (let i = 0; i < n; i++) record(h, 40 * f * Math.exp(0.3 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())));
    return h;
  };
  // The verdict's rule: past PS-F2 at the point (10 %) and significant (lower bound above 0).
  const { percentile } = await import('../controller/hist.mjs');
  const flagged = (a, b) => (percentile(b, 0.95) - percentile(a, 0.95)) / percentile(a, 0.95) > 0.1 && p95ChangeBound(a, b).rel_pct > 0;
  let false_ = 0;
  for (let k = 0; k < 40; k++) if (flagged(lognormal(100, 1, k + 1), lognormal(100, 1, k + 101))) false_++;
  assert.ok(false_ <= 2, `${false_} false regressions in 40 same-distribution pairs of 100 requests`);
  // A real change past PS-F2 is found at any n large enough to tell: +12 % at 20,000 requests.
  let found = 0;
  for (let k = 0; k < 5; k++) if (flagged(lognormal(20000, 1, k + 1), lognormal(20000, 1.12, k + 50))) found++;
  assert.equal(found, 5, 'a true +12 % at n = 20,000 is a regression every time');
  // The interval comes from the true n: at 50,000 requests a true +12 % is bounded close to +12 %.
  const tight = p95ChangeBound(lognormal(50000, 1, 7), lognormal(50000, 1.12, 77));
  assert.ok(tight.rel_pct > 8, `lower bound +${tight.rel_pct} % for a true +12 % at n = 50,000`);
});

test('regression: a point change past 10 % that is within sampling noise is not a regression, and is said', async () => {
  const { compareBaseline } = await import('../lib/verdict.mjs');
  const { percentile } = await import('../controller/hist.mjs');
  const lognormal = (n, seed) => {
    let s = seed;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const h = create();
    for (let i = 0; i < n; i++) record(h, 40 * Math.exp(0.3 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())));
    return h;
  };
  // Two samples of 120 from the same distribution whose p95s differ by more than 10 %, a
  // difference the bootstrap does not find significant.
  let a;
  let b;
  for (let k = 1; ; k++) { a = lognormal(120, k); b = lognormal(120, k + 500); if ((percentile(b, 0.95) - percentile(a, 0.95)) / percentile(a, 0.95) > 0.12 && p95ChangeBound(a, b).rel_pct <= 0) break; }
  const run = (h, id) => ({ run: { id, environment: 'local', profile: 'load', tool_version: 'fake 1', target: 'x', users: 20 }, total: { rps: 100 }, endpoints: { op: { requests: 120, p95_ms: percentile(h, 0.95), error_rate: 0 } } });
  const c = compareBaseline(run(b, 'new'), run(a, 'old'), { cur: { endpoints: { op: b } }, base: { endpoints: { op: a } } });
  assert.deepEqual(c.regressions, []);
  assert.match(c.within_noise[0], /^op p95 \+\d+ % is not significant at 120 and 120 requests \(95 % lower bound -?[\d.]+ %\)/);
  // Without the histograms the point rule applies, and would call it a regression.
  assert.equal(compareBaseline(run(b, 'new'), run(a, 'old')).regressions.length, 1);
});

test('regression: the verdict uses the baselines histograms and says when a p95 move is within noise', T, () => {
  const root = tmp();
  project(root);
  runFake(root, { engine_options: { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true, seed: 1 } });
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  assert.ok(readFileSync(join(root, '.perf', 'demo', 'baselines', 'local', 'load.hist.json'), 'utf8').includes('"endpoints"'), 'the histograms are kept with the baseline');
  runFake(root, { engine_options: { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true, seed: 2, faults: [{ kind: 'slow', factor: 1.6 }] } });
  assert.match(perf(['report', '--root', root, '--slug', 'demo']).out, /regression vs .* significant: at least \+[\d.]+ % at 95 % confidence/);
});

// ---- safety ----------------------------------------------------------------------------------

test('approval: a host other than this machine needs who, when and which hosts; an owner always', () => {
  const s = spec({ target_url: 'http://staging.example.com', allow_hosts: ['staging.example.com'], environment: 'staging' });
  const errs = (approval, extra = {}) => norm(s, { platform: 'linux', envExtra: { approval, ...extra } }).errors.join('\n');
  assert.match(errs(undefined), /loading staging.example.com needs approval \{ by, at, hosts \}/);
  assert.equal(errs({ by: 'ana', at: new Date().toISOString(), hosts: ['staging.example.com'] }), '');
  assert.match(errs({ by: 'ana', at: new Date(Date.now() - 100 * 86400000).toISOString(), hosts: ['staging.example.com'] }), /older than 90 days; ask again/);
  assert.match(errs({ by: 'ana', at: new Date().toISOString(), hosts: ['other.example.com'] }), /does not cover host staging.example.com/);
  assert.match(errs({ by: 'ana', at: new Date(Date.now() + 5 * 86400000).toISOString(), hosts: ['staging.example.com'] }), /is in the future/);
  assert.match(norm(spec(), { platform: 'linux', envExtra: { owner: '' } }).errors.join('\n'), /owner \(who authorises load on it\) required/);
  assert.equal(norm(spec(), { platform: 'linux' }).errors.length, 0, 'this machine needs no approval');
});

test('auto-stop: a spec with no rule gets the default, and the verdict says so', T, () => {
  assert.deepEqual(norm(spec()).spec.auto_stop, [{ metric: 'error_rate', above: 0.5, for_s: 30, min_requests: 50 }]);
  assert.equal(norm(spec({ auto_stop: [{ metric: 'error_rate', above: 0.1, for_s: 5 }] })).spec.auto_stop.length, 1, 'planned rules replace it');
  const root = tmp();
  project(root);
  runFake(root);
  assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /auto-stop: none was planned, so the default applied/);
});

test('fingerprint: an open-model rate change makes the run another experiment', () => {
  const root = tmp();
  project(root, { 'workload.json': { model: 'open', model_reason: 'internet traffic', target: { arrival_rps: 50, source: 'assumed' }, personas: [{ name: 'p', share_pct: 100, source: 'assumed' }], journeys: [{ name: 'j', persona: 'p', weight_pct: 100, steps: ['listItems'], think_time_s: 0, source: 'assumed' }] } });
  const s = { slug: 'demo', environment: 'local' };
  const before = fingerprint(root, s);
  const p = join(root, '.perf', 'demo', 'workload.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), target: { arrival_rps: 80, source: 'assumed' } }));
  assert.deepEqual(changed(before, fingerprint(root, s)), ['workload']);
});

// ---- from the independent review of M7 -----------------------------------------------------

test('baseline: an open run is compared only with an open run at the same rate', async () => {
  const { compareBaseline } = await import('../lib/verdict.mjs');
  const run = (extra) => ({ run: { id: 'x', environment: 'local', profile: 'load', tool_version: 'k6 1', target: 't', users: 50, ...extra }, total: { rps: 40 }, endpoints: {} });
  assert.match(compareBaseline(run({ model: 'open', arrival_rps: 20 }), run({ model: 'open', arrival_rps: 40 })).refused, /baseline was taken at 40 arrivals per second, this run at 20/);
  assert.match(compareBaseline(run({ model: 'open', arrival_rps: 40 }), run({})).refused, /baseline is a closed model, this run open/);
  assert.equal(compareBaseline(run({ model: 'open', arrival_rps: 40 }), run({ model: 'open', arrival_rps: 40 })).refused, null);
});

test('verdict: the env gate judges the environment the run used, not a draft beside it', T, () => {
  const root = tmp();
  project(root);
  const p = join(root, '.perf', 'demo', 'env.json');
  const env = JSON.parse(readFileSync(p, 'utf8'));
  env.environments.staging = { allow_hosts: ['staging.example.com'], allowed_profiles: ['smoke'], owner: 'ana' }; // no parity yet
  writeFileSync(p, JSON.stringify(env));
  runFake(root);
  assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /VERDICT: PASS/);
  assert.match(CHECKS.env(root, 'demo').errors.join('\n'), /staging: parity/, 'the gate itself still sees it');
});

test('approval: hosts is a list, so one host cannot approve another by substring', () => {
  const s = spec({ target_url: 'http://staging.example.com', allow_hosts: ['staging.example.com'], environment: 'staging' });
  const errors = norm(s, { platform: 'linux', envExtra: { approval: { by: 'ana', at: new Date().toISOString(), hosts: 'api.staging.example.com' } } }).errors.join('\n');
  assert.match(errors, /approval.hosts must be a list of hosts/);
});

test('heavy tail: needs enough requests to mean something, and is not raised when the plan judges p99', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  const dir = runDir(root);
  const res = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  const report = (requests) => {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...res, endpoints: { ...res.endpoints, listItems: { ...res.endpoints.listItems, requests, p95_ms: 30, p99_ms: 400 } } }));
    return perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out;
  };
  assert.doesNotMatch(report(50), /heavy tail/, 'with 50 requests p99 is the slowest one');
  assert.match(report(500), /WARN: listItems: heavy tail, p99 400 ms is 13× p95 30 ms/);
  const sp = join(root, '.perf', 'demo', 'slo.json');
  const slo = JSON.parse(readFileSync(sp, 'utf8'));
  slo.transactions[0].slo.p99_ms = 500;
  slo.transactions[0].sla.p99_ms = 800;
  writeFileSync(sp, JSON.stringify(slo));
  assert.doesNotMatch(report(500), /heavy tail/, 'p99 is judged against the plan already');
});
