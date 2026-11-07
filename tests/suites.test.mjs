import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { audit, auditSuite } from '../lib/audit.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { discover } from '../lib/discover.mjs';
import { nextStep } from '../lib/help.mjs';
import { importSuites } from '../lib/importer.mjs';
import { PARSERS, seconds } from '../lib/suites.mjs';
import { runner } from '../adapters/engines/k6/adapter.mjs';
import { ROOT, perf, result, runDir, tmp, waitFor } from './helpers.mjs';

// M3 exit check (design §15): import a k6 and a Locust suite; the audit finds planted defects.
const LEGACY = join(ROOT, 'examples', 'legacy-suite');
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const ids = (a, path) => a.suites.find((s) => s.path === path).findings.map((f) => f.id).sort();

function legacyCopy() {
  const root = tmp();
  cpSync(LEGACY, root, { recursive: true, filter: (p) => !p.includes('.perf') });
  return root;
}

function cleanCopy() {
  const root = tmp();
  copyFileSync(join(ROOT, 'mock', 'k6-load.js'), join(root, 'k6-load.js'));
  copyFileSync(join(ROOT, 'mock', 'locustfile.py'), join(root, 'locustfile.py'));
  return root;
}

test('audit: every defect planted in the legacy suites is found, at its line', () => {
  const a = audit(legacyCopy(), 'legacy');
  assert.deepEqual(ids(a, 'load-test.js'), ['averaged-percentiles', 'hardcoded-host', 'no-checks', 'no-slo', 'no-think-time', 'no-warmup', 'production-host', 'secret-in-script', 'shared-account', 'unnamed-requests']);
  assert.deepEqual(ids(a, 'locustfile.py'), ['no-checks', 'no-slo', 'no-think-time', 'shared-account', 'unnamed-requests']);
  const k6 = a.suites.find((s) => s.path === 'load-test.js');
  assert.deepEqual(k6.findings.find((f) => f.id === 'averaged-percentiles').lines, [17]);
  assert.deepEqual(k6.findings.find((f) => f.id === 'production-host').lines, [10, 12, 13]);
  assert.equal(k6.score, 0);
  // Ranked most severe first, each with the standard's rule and a fix.
  assert.deepEqual([...new Set(a.ranked.map((f) => f.severity))], ['high', 'medium', 'low']);
  assert.ok(a.ranked.every((f) => /^PS-[A-H]\d$/.test(f.ps) && f.fix));
});

test('audit: the good example suites have no high or medium finding', () => {
  const root = cleanCopy();
  mkdirSync(join(root, '.perf', 'demo'), { recursive: true });
  writeFileSync(join(root, '.perf', 'demo', 'slo.json'), '{}');
  const a = audit(root, 'demo');
  for (const s of a.suites) assert.deepEqual(s.findings.filter((f) => f.severity !== 'low').map((f) => f.id), [], s.path);
  // Without slo.json and without thresholds, nothing can fail the Locust suite.
  assert.deepEqual(auditSuite(root, { tool: 'locust', path: 'locustfile.py' }, { hasSlo: false }).findings.map((f) => f.id), ['no-slo']);
});

test('import: a suite is read, never changed; drafts and run specs are written; the gate passes', async () => {
  const root = cleanCopy();
  const before = ['k6-load.js', 'locustfile.py'].map((f) => hash(join(root, f)));
  const imp = await importSuites(root, 'demo');
  assert.deepEqual(['k6-load.js', 'locustfile.py'].map((f) => hash(join(root, f))), before, 'the suite files are untouched');
  const k6 = imp.suites.find((s) => s.tool === 'k6');
  const locust = imp.suites.find((s) => s.tool === 'locust');
  assert.deepEqual(k6.operations.map((o) => o.name).sort(), ['createOrder', 'getItem', 'listItems', 'login']);
  assert.deepEqual(k6.thresholds, [{ metric: 'p95_ms', below: 500, op: 'listItems' }, { metric: 'error_rate', below: 0.01, op: null }]);
  assert.equal(k6.peak_users, 2);
  assert.deepEqual(locust.operations.map((o) => o.name).sort(), ['createOrder', 'getItem', 'listItems', 'login']);
  assert.equal(locust.think_s, 0.05);
  assert.deepEqual(imp.wrote, ['workload.json', 'slo.json', 'run-k6-k6-load.json', 'run-locust-locustfile.json']);
  const slo = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'slo.json'), 'utf8'));
  assert.ok(slo.transactions.every((t) => t.source === 'imported' && t.slo.p95_ms === 500 && t.slo.error_rate === 0.01));
  assert.equal(JSON.parse(readFileSync(join(root, '.perf', 'demo', 'run-k6-k6-load.json'), 'utf8')).script, 'k6-load.js');
  assert.ok(CHECKS.import(root, 'demo').ok, JSON.stringify(CHECKS.import(root, 'demo')));
  assert.ok(CHECKS.plan(root, 'demo').ok, 'an imported slo.json passes the plan gate');
});

test('import: a suite weighing its tasks drafts one journey per operation at that weight, so the mix check holds', async () => {
  const root = tmp();
  copyFileSync(join(ROOT, 'mock', 'locustfile.py'), join(root, 'locustfile.py'));
  await importSuites(root, 'demo');
  const w = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'workload.json'), 'utf8'));
  const share = Object.fromEntries(w.journeys.map((j) => [j.steps[0], j.weight_pct]));
  assert.deepEqual(share, { listItems: 60, getItem: 30, createOrder: 10 }, 'login (on_start) is setup, not part of the mix');
  assert.equal(Math.round(w.journeys.reduce((a, j) => a + j.weight_pct, 0) * 10) / 10, 100);
  assert.ok(CHECKS.model(root, 'demo').errors.every((e) => !/weights add up/.test(e)));
});

test('import: a file the project already has is kept; a suite with unnamed requests fails the gate', async () => {
  const root = legacyCopy();
  mkdirSync(join(root, '.perf', 'legacy'), { recursive: true });
  writeFileSync(join(root, '.perf', 'legacy', 'workload.json'), '{"mine":true}');
  const imp = await importSuites(root, 'legacy');
  assert.equal(readFileSync(join(root, '.perf', 'legacy', 'workload.json'), 'utf8'), '{"mine":true}');
  assert.ok(!imp.wrote.includes('workload.json'));
  const gate = CHECKS.import(root, 'legacy');
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join('\n'), /load-test\.js:10,12,13: requests with ids in the URL have no name/);
  assert.match(gate.errors.join('\n'), /load-test\.js: no operation found; name its requests \(PS-D4\)/);
});

test('import: thresholds map to their own operation; a body "name" is data; specs are per suite and never overwritten', async () => {
  const root = tmp();
  mkdirSync(join(root, 'a'), { recursive: true });
  mkdirSync(join(root, 'b'), { recursive: true });
  writeFileSync(join(root, 'a', 'load.js'), `import http from 'k6/http';
export const options = { thresholds: { 'http_req_duration{name:login}': ['p(95)<3000'], 'http_req_duration{name:list}': ['p(95)<200'], http_req_duration: ['p(95)<800'] } };
export default function () {
  http.post(__ENV.BASE_URL + '/login', JSON.stringify({ name: 'Widget' }), { tags: { name: 'login' } });
  http.get(__ENV.BASE_URL + '/items', { tags: { name: 'list' } });
  http.get(__ENV.BASE_URL + '/orders', { tags: { name: 'orders' } });
}
`);
  writeFileSync(join(root, 'b', 'other.js'), "import http from 'k6/http';\nexport default function () { http.get(__ENV.BASE_URL + '/x', { tags: { name: 'x' } }); }\n");
  mkdirSync(join(root, '.perf', 's'), { recursive: true });
  writeFileSync(join(root, '.perf', 's', 'run-k6-b-other.json'), '{"tuned":true}');
  const imp = await importSuites(root, 's');
  const a = imp.suites.find((s) => s.path === 'a/load.js');
  assert.deepEqual(a.operations.map((o) => o.name), ['login', 'list', 'orders']);
  const slo = Object.fromEntries(JSON.parse(readFileSync(join(root, '.perf', 's', 'slo.json'), 'utf8')).transactions.map((t) => [t.name, t.slo.p95_ms]));
  assert.deepEqual(slo, { login: 3000, list: 200, orders: 800 });
  assert.deepEqual(imp.suites.map((s) => s.run_spec).sort(), ['.perf/s/run-k6-a-load.json', '.perf/s/run-k6-b-other.json']);
  assert.equal(readFileSync(join(root, '.perf', 's', 'run-k6-b-other.json'), 'utf8'), '{"tuned":true}');
  assert.ok(!imp.wrote.includes('run-k6-b-other.json'));
});

test('import: unnamed requests with ids fail the gate, even when other names exist', async () => {
  const root = tmp();
  writeFileSync(join(root, 'load.js'), "import http from 'k6/http';\nexport default function () {\n  http.post(__ENV.BASE_URL + '/w', JSON.stringify({ name: 'Widget' }), { tags: { name: 'create' } });\n  http.get(`${__ENV.BASE_URL}/items/${Math.random()}`);\n}\n");
  await importSuites(root, 's');
  const gate = CHECKS.import(root, 's');
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join('\n'), /load\.js:4: requests with ids in the URL have no name/);
});

test('audit: a literal identity outside a login call is not a shared account', () => {
  const root = tmp();
  writeFileSync(join(root, 'load.js'), "import http from 'k6/http';\nimport { check } from 'k6';\nexport default function () {\n  const r = http.post(__ENV.BASE_URL + '/users', JSON.stringify({ email: 'new@example.com' }), { tags: { name: 'createUser' } });\n  check(r, { ok: (x) => x.status === 201 });\n}\n// thresholds tagged {name:login} elsewhere\n");
  assert.ok(!auditSuite(root, { tool: 'k6', path: 'load.js' }).findings.some((f) => f.id === 'shared-account'));
});

test('import: old results are kept as reference, never promoted to a baseline', async () => {
  const root = cleanCopy();
  mkdirSync(join(root, 'results'), { recursive: true });
  writeFileSync(join(root, 'results', 'run_stats.csv'), 'Type,Name,Request Count,Failure Count,95%\nGET,listItems,1000,10,120\n,Aggregated,1000,10,120\n');
  writeFileSync(join(root, 'results', 'summary.json'), JSON.stringify({ metrics: { http_reqs: { count: 500 }, http_req_duration: { 'p(95)': 88.5 }, http_req_failed: { value: 0.002 } } }));
  const imp = await importSuites(root, 'demo');
  const byKind = Object.fromEntries(imp.results.map((r) => [r.kind, r]));
  assert.deepEqual(byKind['locust-csv'].endpoints, { listItems: { requests: 1000, p95_ms: 120, error_rate: 0.01 } });
  assert.deepEqual(byKind['k6-summary'].endpoints.total, { requests: 500, p95_ms: 88.5, error_rate: 0.002 });
  assert.equal(existsSync(join(root, '.perf', 'demo', 'baselines')), false);
});

test('parsers: Gatling and JMeter suites give their operations, users, pauses and assertions', () => {
  const g = PARSERS.gatling(`setUp(scn.inject(nothingFor(5), rampUsers(200).during(60))).protocols(http.baseUrl(System.getProperty("baseUrl")))
    .assertions(global.responseTime.percentile3.lt(800), global.failedRequests.percent.lt(1))
  val scn = scenario("s").exec(http("listItems").get("/items").check(status.is(200))).pause(1, 3).exec(http("getItem").get("/items/7"))`);
  assert.deepEqual(g.operations.map((o) => o.name), ['listItems', 'getItem']);
  assert.equal(g.peak_users, 200);
  assert.equal(g.think_s, 1);
  assert.deepEqual(g.thresholds, [{ metric: 'p95_ms', below: 800 }, { metric: 'error_rate', below: 0.01 }]);
  assert.ok(g.facts.ramps && g.facts.checks && g.facts.host_from_env && g.facts.think_random);
  const j = PARSERS.jmeter('<ThreadGroup><stringProp name="ThreadGroup.num_threads">40</stringProp><stringProp name="ThreadGroup.ramp_time">30</stringProp></ThreadGroup><HTTPSamplerProxy guiclass="x" testname="listItems"></HTTPSamplerProxy><UniformRandomTimer><stringProp name="ConstantTimer.delay">500</stringProp></UniformRandomTimer>');
  assert.deepEqual([j.operations.map((o) => o.name), j.peak_users, j.think_s, j.facts.ramps], [['listItems'], 40, 0.5, true]);
  assert.equal(seconds('1m30s'), 90);
  assert.equal(seconds('500ms'), 0.5);
});

test('help: an existing suite goes import → audit → plan', async () => {
  const root = cleanCopy();
  discover(root, 'demo');
  assert.equal(nextStep(root, 'demo').command, '/perf-import');
  await importSuites(root, 'demo');
  assert.equal(nextStep(root, 'demo').command, '/perf-audit');
  audit(root, 'demo');
  assert.notEqual(nextStep(root, 'demo').command, '/perf-audit');
});

// The imported run spec runs the suite's own scripts under the controller.
const K6 = runner();
test('import → run: the imported k6 suite runs as it is under ai-perf', { timeout: 240000, skip: K6 ? false : 'no k6 binary and no grafana/k6 image' }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const mock = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, MOCK_HOST: '0.0.0.0' } });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
    const root = cleanCopy();
    await importSuites(root, 'demo');
    writeFileSync(join(root, '.perf', 'demo', 'env.json'), JSON.stringify({ environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['smoke', 'load'], owner: 'test', parity: 'laptop mock' } } }));
    const specPath = join(root, '.perf', 'demo', 'run-k6-k6-load.json');
    const s = JSON.parse(readFileSync(specPath, 'utf8'));
    writeFileSync(specPath, JSON.stringify({ ...s, target_url: `http://127.0.0.1:${port}`, profile: { ...s.profile, steady_s: 6 }, timing: { tick_ms: 500, window_s: 2, heartbeat_timeout_s: 10, worker_timeout_s: 10, barrier_timeout_s: 120 } }));
    const r = perf(['run', specPath, '--root', root, '--wait'], 200000);
    assert.equal(r.code, 0, r.out);
    const res = result(runDir(root));
    assert.ok(['listItems', 'getItem'].every((op) => res.endpoints[op]?.requests > 0), JSON.stringify(Object.keys(res.endpoints)));
  } finally { mock.kill(); }
});

const PY = process.env.PERF_PYTHON || join(ROOT, '..', 'locust-performance-testing', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HAVE_LOCUST = existsSync(PY) && spawnSync(PY, ['-c', 'import locust'], { timeout: 30000 }).status === 0;
test('import → run: the imported Locust suite runs as it is under ai-perf', { timeout: 240000, skip: HAVE_LOCUST ? false : `no python with locust at ${PY}` }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const mock = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
    const root = cleanCopy();
    process.env.PERF_PYTHON = PY;
    await importSuites(root, 'demo');
    writeFileSync(join(root, '.perf', 'demo', 'env.json'), JSON.stringify({ environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['smoke', 'load'], owner: 'test', parity: 'laptop mock' } } }));
    const specPath = join(root, '.perf', 'demo', 'run-locust-locustfile.json');
    const s = JSON.parse(readFileSync(specPath, 'utf8'));
    writeFileSync(specPath, JSON.stringify({ ...s, target_url: `http://127.0.0.1:${port}`, profile: { ...s.profile, steady_s: 6 }, timing: { window_s: 2, barrier_timeout_s: 60 } }));
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', specPath, '--root', root, '--wait'], { encoding: 'utf8', timeout: 200000, env: { ...process.env, PERF_PYTHON: PY } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const res = result(runDir(root));
    assert.ok(['listItems', 'getItem'].every((op) => res.endpoints[op]?.requests > 0), JSON.stringify(Object.keys(res.endpoints)));
  } finally { mock.kill(); }
});
