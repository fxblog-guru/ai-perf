import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSignals, fromQuery, fromScrape, parseExposition, read, sample, showUrl } from '../adapters/metrics/signals.mjs';
import { bottleneck } from '../lib/analyze.mjs';
import { readLines } from '../controller/files.mjs';
import { ROOT, norm, perf, runDir, tmp } from './helpers.mjs';
import { project, runFake } from './project.mjs';

// M13: the target's own metrics. A pool, locks or GC read during the run let the analysis name a
// wait with evidence; one that stayed under its limit rules its cause out by name.

const T = { timeout: 120000 };
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const servers = [];
async function metricsServer(plan, envExtra = {}) {
  const port = await freePort();
  const c = spawn(process.execPath, [join(ROOT, 'mock', 'metrics-server.mjs'), String(port), JSON.stringify(plan)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...envExtra } });
  servers.push(c);
  await new Promise((resolve) => c.stdout.once('data', resolve));
  return `http://127.0.0.1:${port}`;
}
after(() => { for (const c of servers) c.kill(); });

const POOL_FULL = { hikaricp_connections_active: { labels: { pool: 'main' }, from: 20, to: 20 }, hikaricp_connections_max: { labels: { pool: 'main' }, from: 20, to: 20 }, pool_pct: { from: 100, to: 100 }, lag_s: { from: 0.25, to: 0.25 }, gc_s: { from: 40.3, to: 40.3 }, inf_one: { from: '+Inf', to: '+Inf' } };
const POOL_QUIET = { pool_pct: { from: 30, to: 30 }, locks: { from: 0, to: 0 } };
let full;
let quiet;
before(async () => { full = await metricsServer(POOL_FULL); quiet = await metricsServer(POOL_QUIET); });

// ---- reading -----------------------------------------------------------------------------------

test('exposition: names, labels with escapes, comments, timestamps, Inf; NaN is no value', () => {
  const text = [
    '# HELP x a help line',
    '# TYPE x gauge',
    'db_pool_active{pool="main",note="a \\"quoted\\", {braced} one"} 7 1700000000000',
    'db_pool_active{pool="replica"} 3',
    'up 1',
    'big +Inf',
    'nan_one NaN',
    '',
  ].join('\n');
  const p = parseExposition(text);
  assert.deepEqual(p.map((s) => [s.name, s.value]), [['db_pool_active', 7], ['db_pool_active', 3], ['up', 1], ['big', Infinity]]);
  assert.equal(p[0].labels.note, 'a "quoted", {braced} one');
  assert.equal(fromScrape(text, { metric: 'db_pool_active' }), 10, 'series of one metric are summed');
  assert.equal(fromScrape(text, { metric: 'db_pool_active', match: { pool: 'main' } }), 7);
  assert.equal(fromScrape(text, { metric: 'db_pool_active', match: { pool: 'none' } }), null, 'absent is null, never 0');
  assert.equal(fromScrape(text, { metric: 'db_pool' }), null, 'a prefix is not the metric');
  // Escapes are undone in one pass: a backslash before an n stays a backslash and an n.
  const win = parseExposition('files{path="C:\\\\new",msg="a\\nb"} 1');
  assert.deepEqual(win[0].labels, { path: 'C:\\new', msg: 'a\nb' });
});

test('prometheus: a vector is summed, a scalar read; an error or an empty result is no value', () => {
  assert.equal(fromQuery({ status: 'success', data: { resultType: 'vector', result: [{ value: [1, '2.5'] }, { value: [1, '1.5'] }] } }), 4);
  assert.equal(fromQuery({ status: 'success', data: { resultType: 'scalar', result: [1, '9'] } }), 9);
  assert.equal(fromQuery({ status: 'success', data: { resultType: 'vector', result: [] } }), null);
  assert.equal(fromQuery({ status: 'error', error: 'bad query' }), null);
  assert.equal(fromQuery({ status: 'success', data: { resultType: 'matrix', result: [{ values: [[1, '3']] }] } }), null);
});

test('signals: env.json is checked, every mistake named', () => {
  const ok = { name: 'db_pool', kind: 'pool_used_pct', scrape: 'http://app:9000/metrics', metric: 'pool_pct' };
  assert.deepEqual(checkSignals([ok, { name: 'locks', kind: 'db_locks_waiting', prometheus: 'http://prom:9090', query: 'sum(pg_locks_waiting)' }]), []);
  assert.deepEqual(checkSignals(undefined), []);
  const bad = (s) => checkSignals([s]).join('; ');
  assert.match(bad({ ...ok, prometheus: 'http://p' }), /exactly one of scrape .* or prometheus/);
  assert.match(bad({ ...ok, kind: 'pool' }), /kind: one of pool_used_pct/);
  assert.match(bad({ ...ok, kind: 'custom' }), /kind custom has no default limit; set one/);
  assert.deepEqual(checkSignals([{ ...ok, kind: 'custom', above: 3 }]), []);
  assert.match(bad({ ...ok, scrape: 'ftp://x/metrics' }), /scrape: an http\(s\) URL/);
  assert.match(bad({ ...ok, scrape: 'http://u:p@app/metrics' }), /scrape: carries a credential; put the token in an environment variable named by auth_env/);
  assert.match(bad({ ...ok, scrape: 'http://app/metrics?api_key=SECRET' }), /scrape: carries a credential/);
  assert.match(bad({ name: 'q', kind: 'queue_depth', above: 9, prometheus: 'http://p/?x=1', query: 'up' }), /prometheus: the server's URL, without a query string/);
  assert.match(bad({ ...ok, scale: 0 }), /scale: a number > 0/);
  assert.match(bad({ ...ok, kind: 'gc_time_pct', counter: true }), /scale: a counter of kind gc_time_pct is a rate per second/);
  assert.deepEqual(checkSignals([{ ...ok, kind: 'gc_time_pct', counter: true, scale: 100 }]), []);
  assert.match(bad({ ...ok, metric: 'pool-pct' }), /metric: the metric name/);
  assert.match(bad({ name: 'q', kind: 'queue_depth', above: 9, prometheus: 'http://p', metric: 'x' }), /query: the PromQL query.*metric: only for scrape/);
  assert.match(bad({ ...ok, match: { pool: 1 } }), /match: labels/);
  assert.match(bad({ ...ok, above: '5' }), /above: a number/);
  assert.match(bad({ ...ok, counter: 'yes' }), /counter: true or false/);
  assert.match(bad({ ...ok, auth_env: 'not a name' }), /auth_env/);
  assert.match(bad({ ...ok, interval: 5 }), /interval: unknown key/);
  assert.match(bad({ ...ok, name: 'db pool' }), /name: a short name/);
  assert.match(checkSignals([ok, ok]).join(), /name db_pool is used twice/);
  assert.match(checkSignals({}).join(), /a list/);
  // A spec's environment with a bad signal is refused before any load.
  assert.match(norm({ slug: 'demo', target_url: 'http://127.0.0.1:8080', engine: 'fake' }, { envExtra: { monitor: { signals: [{ ...ok, kind: 'nope' }] } } }).errors.join(), /monitor.signals\[0\].kind/);
  assert.equal(showUrl('http://user:secret@prom:9090/api'), 'http://prom:9090/api', 'credentials never shown');
  assert.equal(showUrl('http://prom:9090/metrics?token=abc#x'), 'http://prom:9090/metrics', 'nor a query string');
});

test('signals: read from a scrape and from a Prometheus server; a missing metric and a dead URL are errors', async () => {
  assert.deepEqual(await read({ scrape: `${full}/metrics`, metric: 'pool_pct' }), { value: 100 });
  assert.deepEqual(await read({ scrape: `${full}/metrics`, metric: 'hikaricp_connections_active', match: { pool: 'main' } }), { value: 20 });
  assert.deepEqual(await read({ prometheus: `${full}/`, query: 'pool_pct' }), { value: 100 });
  // A Prometheus behind a path keeps it: the API is under /prom/, not at the root.
  assert.match((await read({ prometheus: `${full}/prom`, query: 'pool_pct' })).error, /HTTP 404/);
  assert.match((await read({ scrape: `${full}/metrics`, metric: 'nothing' })).error, /no series nothing/);
  assert.match((await read({ prometheus: full, query: 'nothing' })).error, /no number/);
  assert.match((await read({ scrape: `${full}/nope`, metric: 'pool_pct' })).error, /HTTP 404/);
  const dead = `http://127.0.0.1:${await freePort()}/metrics`;
  assert.ok((await read({ scrape: dead, metric: 'x' }, 1000)).error, 'a dead URL is an error, never a throw');
  // A URL with a credential slipped past the check: the error never quotes it.
  const leaked = (await read({ scrape: `http://user:pw@127.0.0.1:${new URL(full).port}/metrics`, metric: 'x' })).error;
  assert.ok(leaked && !/pw|user:/.test(leaked), leaked);
});

test('signals: a bearer token comes from the environment variable named, never from the file', async () => {
  const guarded = await metricsServer({ pool_pct: { from: 50, to: 50 } }, { MOCK_TOKEN: 'tok-123' });
  assert.match((await read({ scrape: `${guarded}/metrics`, metric: 'pool_pct' })).error, /HTTP 401/);
  process.env.SIGNALS_TEST_TOKEN = 'tok-123';
  assert.deepEqual(await read({ scrape: `${guarded}/metrics`, metric: 'pool_pct', auth_env: 'SIGNALS_TEST_TOKEN' }), { value: 50 });
});

test('signals: a counter is a rate; its first reading and a reset give no sample', async () => {
  const s = [{ name: 'slow', kind: 'db_slow_queries', scrape: `${full}/metrics`, metric: 'pool_pct', counter: true }];
  const prev = new Map();
  let clock = 1000;
  const now = () => clock;
  assert.deepEqual((await sample(s, 1, prev, now)).samples, [], 'first reading: no rate yet');
  prev.set('slow', { value: 40, at: 0 });
  clock = 2000;
  const r = await sample(s, 2, prev, now);
  assert.deepEqual(r.samples, [{ t: 2, name: 'signal', unit: 'queries/s', value: 30, labels: { signal: 'slow', kind: 'db_slow_queries' } }], '(100 - 40) / 2 s');
  prev.set('slow', { value: 500, at: 2000 });
  clock = 3000;
  assert.deepEqual((await sample(s, 3, prev, now)).samples, [], 'the counter went down (a restart): no sample');
  const g = await sample([{ name: 'pool', kind: 'pool_used_pct', scrape: `${full}/metrics`, metric: 'pool_pct' }, { name: 'gone', kind: 'pool_waiting', scrape: `${full}/metrics`, metric: 'missing' }], 4);
  assert.deepEqual(g.samples.map((x) => [x.labels.signal, x.value, x.unit]), [['pool', 100, '%']]);
  assert.deepEqual(g.errors.map((e) => e.signal), ['gone']);
  assert.deepEqual(g.answered, ['pool']);
});

test('signals: a scale puts the reading in the kind\'s unit; a counter of seconds becomes a share of time', async () => {
  // Seconds of lag to ms: 0.25 s reads 250 ms, over the 100 ms limit, not 0.25 "ms" and quiet.
  const lag = await sample([{ name: 'loop', kind: 'event_loop_lag_ms', scrape: `${full}/metrics`, metric: 'lag_s', scale: 1000 }], 1);
  assert.deepEqual(lag.samples.map((x) => [x.value, x.unit]), [[250, 'ms']]);
  // GC seconds per second × 100 = % of time: (40.3 - 40.0) s over 1 s is 30 %.
  const prev = new Map([['gc', { value: 40, at: 0 }]]);
  const gc = await sample([{ name: 'gc', kind: 'gc_time_pct', scrape: `${full}/metrics`, metric: 'gc_s', counter: true, scale: 100 }], 2, prev, () => 1000);
  assert.deepEqual(gc.samples.map((x) => [x.value, x.unit]), [[30, '%']]);
  // An infinite reading is no sample: it would be written as null and lost without a word.
  const inf = await sample([{ name: 'inf', kind: 'custom', above: 1, scrape: `${full}/metrics`, metric: 'inf_one' }], 3);
  assert.deepEqual([inf.samples, inf.errors.map((e) => e.error)], [[], ['not a finite number (Infinity)']]);
});

// ---- the exam: what the analysis may claim -----------------------------------------------------

function series(after) {
  const tl = [10, 20, 30, 40].map((rps, i) => ({ t: i * 10, phase: 'ramp', load: (i + 1) * 5, rps, p95_ms: 50, error_rate: 0 }));
  after.forEach((w, i) => tl.push({ t: 40 + i * 10, phase: 'steady', load: 25, error_rate: 0, ...w }));
  return tl;
}
const KNEE = series([{ rps: 41, p95_ms: 180 }, { rps: 40, p95_ms: 260 }]);
const cpuAt = (value) => [30, 40, 50].map((t) => ({ t, name: 'target_cpu_pct', value, labels: { container: 'app' } }));
const POOL = { name: 'db_pool', kind: 'pool_used_pct' };
const LOCKS = { name: 'locks', kind: 'db_locks_waiting' };
const sig = (name, kind, pairs) => pairs.map(([t, value]) => ({ t, name: 'signal', unit: kind === 'pool_used_pct' ? '%' : 'locks', value, labels: { signal: name, kind } }));

test('exam: a pool full when latency broke is named, with its reading as evidence', () => {
  const s = [...sig('db_pool', 'pool_used_pct', [[30, 60], [40, 100], [50, 100]]), ...sig('locks', 'db_locks_waiting', [[40, 0], [50, 0]])];
  const b = bottleneck(KNEE, [], cpuAt(20), [], s, [POOL, LOCKS]);
  assert.match(b.hint, /^waiting on db_pool: a connection pool was full: requests waited for a connection$/);
  assert.deepEqual(b.cause, ['pool_used_pct']);
  assert.match(b.evidence, /p95 50 -> 180 ms at t=40s, rps flat at 41, CPU max 20 % \(app\), db_pool 100 % > 95; under their limits then: locks$/);
});

test('exam: a signal over its limit all along did not make latency break; it is said, not named the cause', () => {
  // A lock held from the start, while latency was fine for four windows: not why it broke at 25 users.
  const held = sig('locks', 'db_locks_waiting', [[0, 1], [10, 1], [20, 1], [30, 1], [40, 1], [50, 1]]);
  const b = bottleneck(KNEE, [], cpuAt(96), [], held, [LOCKS]);
  assert.match(b.hint, /^CPU-bound: app above 85 %/);
  assert.equal(b.cause, undefined);
  assert.match(b.evidence, /; over their limits before latency broke, so not its cause: locks 1 locks > 0$/);
  // The same signal rising with the load is the cause: higher at the knee than it ever was before.
  const rising = sig('locks', 'db_locks_waiting', [[0, 1], [10, 1], [20, 1], [30, 1], [40, 9], [50, 12]]);
  assert.match(bottleneck(KNEE, [], cpuAt(20), [], rising, [LOCKS]).hint, /^waiting on locks: transactions waited on database locks$/);
});

test('exam: a pool exactly at its limit is not over it; a custom limit is used', () => {
  const at = sig('db_pool', 'pool_used_pct', [[40, 95]]);
  assert.doesNotMatch(bottleneck(KNEE, [], cpuAt(20), [], at, [POOL]).hint, /waiting on/);
  assert.match(bottleneck(KNEE, [], cpuAt(20), [], at, [{ ...POOL, above: 90 }]).hint, /^waiting on db_pool/);
});

test('exam: signals read and quiet at the knee rule themselves out by name; CPU still decides', () => {
  const s = sig('db_pool', 'pool_used_pct', [[40, 30], [50, 35]]);
  const b = bottleneck(KNEE, [], cpuAt(20), [], s, [POOL, LOCKS]);
  assert.match(b.hint, /^not CPU in app/);
  assert.match(b.evidence, /under their limits then: db_pool$/, 'locks was never read: not claimed quiet');
  assert.match(bottleneck(KNEE, [], cpuAt(96), [], s, [POOL]).hint, /^CPU-bound: app above 85 %/);
});

test('exam: a signal over its limit long before the knee is not its cause; the generator still comes first', () => {
  const early = sig('db_pool', 'pool_used_pct', [[0, 100], [10, 100], [20, 40], [40, 40], [50, 40]]);
  assert.doesNotMatch(bottleneck(KNEE, [], cpuAt(20), [], early, [POOL]).hint, /waiting on/);
  const s = sig('db_pool', 'pool_used_pct', [[40, 100]]);
  assert.match(bottleneck(KNEE, [{ kind: 'generator_saturated' }], cpuAt(20), [], s, [POOL]).hint, /load generator/);
  // Both a full pool and a hot CPU at the knee: both said.
  assert.match(bottleneck(KNEE, [], cpuAt(96), [], s, [POOL]).hint, /^waiting on db_pool: .*; the CPU of app was also above 85 %$/);
});

// ---- end to end ----------------------------------------------------------------------------------

// Steps of 4, 8 and 16 users at 10 rps each against a target that serves at most 70 rps: the third
// step queues (160 rps offered), so latency more than doubles while throughput stays flat.
const STAIRS = { name: 'stress', steps: [4, 8, 16], step_s: 2, warmup_s: 1, ramp_s: 1, rampdown_s: 0.5 };
const QUEUES = { max_rps: 70 };
const envWith = (signals) => ({ environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['smoke', 'load', 'stress'], owner: 'test', parity: 'laptop mock', third_party: [{ name: 'payments', stubbed: true }], monitor: { metrics: 'none', interval_s: 0.3, signals } } } });
const slo = { profiles: ['stress'], transactions: ['listItems', 'getItem', 'createOrder'].map((name) => ({ name, slo: { p95_ms: 2000, error_rate: 0.01 }, sla: { p95_ms: 4000, error_rate: 0.02 }, source: 'assumed' })) };
const analyze = (root) => { const r = perf(['analyze', '--root', root, '--slug', 'demo']); return { ...r, a: JSON.parse(readFileSync(join(runDir(root), 'analysis.json'), 'utf8')), md: readFileSync(join(runDir(root), 'analysis.md'), 'utf8') }; };

test('run: a pool that fills as the load climbs, read from /metrics, is the named bottleneck, with its own table', T, async () => {
  const root = tmp();
  // 40 % for the first dozen readings (the doctor's and about 4 s of run at 0.3 s), then full: it
  // fills during the second step, before the third one breaks.
  const filling = await metricsServer({ pool_pct: { from: 40, to: 100, after_n: 12 } });
  project(root, { 'slo.json': slo, 'env.json': envWith([{ name: 'db_pool', kind: 'pool_used_pct', scrape: `${filling}/metrics`, metric: 'pool_pct' },{ name: 'active', kind: 'custom', above: 50, prometheus: full, query: 'hikaricp_connections_active' }]) });
  const r = runFake(root, { profile: STAIRS, engine_options: QUEUES });
  assert.equal(r.code, 0, r.out + r.err);
  const read = readLines(join(runDir(root), 'monitor', 'target.ndjson')).filter((s) => s.name === 'signal');
  assert.ok(read.some((s) => s.labels.signal === 'db_pool' && s.value === 100), 'the scrape was read during the run');
  assert.ok(read.some((s) => s.labels.signal === 'active' && s.value === 20), 'the Prometheus query was read during the run');
  const { a, md } = analyze(root);
  assert.ok(a.bottleneck, `a knee: ${JSON.stringify(a.timeline.map((w) => [w.t, w.rps, w.p95_ms]))}`);
  assert.deepEqual(a.bottleneck.cause, ['pool_used_pct']);
  assert.match(a.bottleneck.hint, /^waiting on db_pool: a connection pool was full/);
  assert.deepEqual(a.signals.map((s) => [s.name, s.read, s.max, s.above]), [['db_pool', true, 100, 95], ['active', true, 20, 50]]);
  assert.equal(a.signals[1].first_over_t, null);
  assert.match(md, /## Signals\n\n\| Signal \| Kind \| Highest \| Limit \| First above \|\n\|---\|---\|---\|---\|---\|\n\| db_pool \| pool_used_pct \| 100 % \| 95 \| t=[\d.]+s \|\n\| active \| custom \| 20 \| 50 \| never \|/);
});

test('run: a quiet pool is ruled out by name; a signal that never answers is said, and the run is still done', T, async () => {
  const root = tmp();
  const dead = `http://127.0.0.1:${await freePort()}/metrics`;
  project(root, { 'slo.json': slo, 'env.json': envWith([{ name: 'db_pool', kind: 'pool_used_pct', scrape: `${quiet}/metrics`, metric: 'pool_pct' }, { name: 'gc', kind: 'gc_time_pct', scrape: dead, metric: 'gc' }]) });
  const r = runFake(root, { profile: STAIRS, engine_options: QUEUES });
  assert.equal(r.code, 0, r.out + r.err);
  const state = JSON.parse(readFileSync(join(runDir(root), 'state.json'), 'utf8'));
  assert.equal(state.state, 'done', 'a missing signal does not change what was measured');
  assert.match(state.problems.find((p) => p.kind === 'signal_missing')?.detail ?? '', /signal gc \(/);
  const anomalies = readLines(join(runDir(root), 'events.ndjson')).filter((e) => e.type === 'anomaly' && e.data?.signal === 'gc');
  assert.equal(anomalies.length, 1, 'said once, not at every interval');
  const { a, md } = analyze(root);
  assert.match(a.bottleneck.hint, /^not CPU in the target|^latency more than doubled/);
  assert.match(a.bottleneck.evidence, /under their limits then: db_pool$/);
  assert.match(md, /\| gc \| gc_time_pct \| no sample \| 10 \| - \|/);
  // The run said so before loading, and the lesson points to the env step.
  assert.match(r.err, /\[warn\] signals: gc: /);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  const lessons = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'lessons.json'), 'utf8'));
  assert.equal(lessons.lessons.find((l) => l.id === 'problem:signal_missing')?.step, 'env');
});

test('run: a counter read only once has no rate, and says so instead of "never answered"', T, () => {
  const root = tmp();
  const env = envWith([{ name: 'slowq', kind: 'db_slow_queries', scrape: `${full}/metrics`, metric: 'pool_pct', counter: true }]);
  env.environments.local.monitor.interval_s = 120;
  project(root, { 'env.json': env });
  const r = runFake(root, { profile: { name: 'smoke', users: 2, warmup_s: 0, ramp_s: 0, steady_s: 1, rampdown_s: 0 } });
  assert.equal(r.code, 0, r.out + r.err);
  const state = JSON.parse(readFileSync(join(runDir(root), 'state.json'), 'utf8'));
  assert.match(state.problems.find((p) => p.kind === 'signal_missing')?.detail ?? '', /signal slowq \(one reading only; a counter needs two\)/);
});

test('doctor: a signal that does not answer is a warning before the run; one that does shows its value', T, async () => {
  const root = tmp();
  const dead = `http://127.0.0.1:${await freePort()}/metrics`;
  project(root, { 'env.json': envWith([{ name: 'db_pool', kind: 'pool_used_pct', scrape: `${full}/metrics`, metric: 'pool_pct' }, { name: 'gc', kind: 'gc_time_pct', scrape: dead, metric: 'gc', auth_env: 'SIGNALS_UNSET_TOKEN' }]) });
  runFake(root, { profile: { name: 'smoke', users: 2, warmup_s: 0, ramp_s: 0, steady_s: 1, rampdown_s: 0 } });
  const r = perf(['doctor', '--root', root, '--spec', join(root, 'spec.json'), '--json']);
  const c = JSON.parse(r.out).checks.find((x) => x.id === 'signals');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /^gc: .*\(http:\/\/127\.0\.0\.1:\d+\/metrics\); gc: SIGNALS_UNSET_TOKEN is not set$/);
  project(root, { 'env.json': envWith([{ name: 'db_pool', kind: 'pool_used_pct', scrape: `${full}/metrics`, metric: 'pool_pct' }]) });
  const ok = JSON.parse(perf(['doctor', '--root', root, '--spec', join(root, 'spec.json'), '--json']).out).checks.find((x) => x.id === 'signals');
  assert.deepEqual([ok.status, ok.detail], ['ok', '1 signal(s) read: db_pool 100']);
});
