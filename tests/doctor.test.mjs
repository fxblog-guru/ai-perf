import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { doctor } from '../lib/doctor.mjs';
import { ROOT, perf, spec, tmp, waitFor, writeSpec } from './helpers.mjs';
import { project, runFake } from './project.mjs';

function plant(root, text) {
  const dir = join(root, '.perf', 'demo', 'scripts', 'locust');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'locustfile.py'), text);
}

test('a clean machine and project pass; an engine nobody asked for is only a warning', () => {
  const r = perf(['doctor', '--root', tmp(), '--json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.notEqual(out.verdict, 'fail');
  assert.ok(out.checks.filter((c) => c.status === 'fail').length === 0);
});

test('an engine the spec needs but the machine lacks fails doctor and blocks the run', () => {
  const root = tmp();
  writeFileSync(join(root, 'locustfile.py'), '');
  const p = writeSpec(root, spec({ engine: 'locust', script: 'locustfile.py' }));
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'doctor', '--root', root, '--spec', p], { encoding: 'utf8', env: { ...process.env, PERF_PYTHON: 'python-that-does-not-exist' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[FAIL\] machine\/engine\.locust: locust not installed/);
});

test('a literal token in a script fails doctor and blocks perf run', () => {
  const root = tmp();
  plant(root, 'headers = {"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz0123"}\n');
  const d = perf(['doctor', '--root', root]);
  assert.equal(d.code, 1);
  assert.match(d.out, /\[FAIL\] safety\/secrets: .*bearer token/);
  const r = perf(['run', writeSpec(root, spec()), '--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /bearer token/);
});

test('each credential shape is caught; references to variables are not', () => {
  const cases = {
    'key = "AKIAABCDEFGHIJKLMNOP"': 'AWS access key',
    '-----BEGIN RSA PRIVATE KEY-----': 'private key',
    'password: "hunter22"': 'literal credential',
    '"api_key": "s3cr3t-value"': 'literal credential',
    'BASE = "http://admin:hunter22@10.0.0.5"': 'credential in a URL',
    'url = "/orders?access_token=abc123def456"': 'token in a query string',
    'headers["Authorization"] = "Basic YWRtaW46aHVudGVyMjI="': 'basic auth header',
    'Cookie: session=0123456789abcdef': 'cookie value',
  };
  for (const [text, what] of Object.entries(cases)) {
    const root = tmp();
    plant(root, text);
    assert.match(perf(['doctor', '--root', root]).out, new RegExp(`secrets: .*${what}`), text);
  }
  const root = tmp();
  plant(root, 'password: "${PERF_PASSWORD}"\ntoken = os.environ["TOKEN"]\n');
  assert.equal(perf(['doctor', '--root', root]).code, 0);
});

test('the load script is scanned wherever it lives, and sampled errors in raw/ are scanned too', () => {
  const root = tmp();
  writeFileSync(join(root, 'locustfile.py'), 'headers = {"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz0123"}\n');
  const p = writeSpec(root, spec({ engine: 'locust', script: 'locustfile.py' }));
  assert.match(perf(['doctor', '--root', root, '--spec', p]).out, /safety\/secrets: .*locustfile\.py: bearer token/);
  const other = tmp();
  const raw = join(other, '.perf', 'demo', 'runs', '20261030-000000-abcd', 'raw', 'w0');
  mkdirSync(raw, { recursive: true });
  writeFileSync(join(raw, 'errors.ndjson'), '{"class":"HTTP 401","error":"401 for url: http://10.0.0.5/x?token=abc123secret"}\n');
  writeFileSync(join(raw, 'hist-0.json'), '{"note":"numbers only; not scanned"}');
  assert.match(perf(['doctor', '--root', other]).out, /secrets: .*errors\.ndjson: token in a query string/);
});

test('run folders are scanned for secrets too', () => {
  const root = tmp();
  const dir = join(root, '.perf', 'demo', 'runs', '20261030-000000-abcd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), '{"run": {"target": "http://admin:hunter22@10.0.0.5"}}');
  assert.match(perf(['doctor', '--root', root]).out, /secrets: .*result\.json: credential in a URL/);
});

test('a controller that died before writing state is reported, and --fix closes the run', async () => {
  const root = tmp();
  const dir = join(root, '.perf', 'demo', 'runs', '20261030-000000-dead');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...spec(), run_id: '20261030-000000-dead' }));
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(join(dir, 'controller.pid'), `${gone}\n`);
  const old = new Date(Date.now() - 60000);
  utimesSync(join(dir, 'controller.pid'), old, old);
  assert.match(perf(['status', '--root', root]).out, /controller lost/);
  assert.match(perf(['doctor', '--root', root]).out, /controller of demo\/20261030-000000-dead never started/);
  perf(['doctor', '--root', root, '--fix']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).state, 'aborted');
  assert.equal(perf(['doctor', '--root', root]).code, 0);
});

// A run folder in a given state, without a real controller: pid is this test process (alive) or a
// finished one (dead).
function fakeRun(root, id, { state: st, heartbeatAgeMs, alive }) {
  const dir = join(root, '.perf', 'demo', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...spec(), run_id: id }));
  const pid = alive ? process.pid : spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: st, run_id: id, slug: 'demo', pid, heartbeat_at: Date.now() - heartbeatAgeMs, heartbeat_timeout_s: 3, workers: [], problems: [], history: [] }));
  return dir;
}

test('a controller busy collecting is not called lost too early', () => {
  const root = tmp();
  fakeRun(root, '20261030-000001-coll', { state: 'collecting', heartbeatAgeMs: 5000, alive: true });
  assert.match(perf(['status', '--root', root]).out, /collecting .*controller alive/);
  fakeRun(root, '20261030-000002-stdy', { state: 'steady', heartbeatAgeMs: 5000, alive: true });
  assert.match(perf(['status', '--root', root]).out, /steady .*controller lost/);
});

test('a just-created run folder with no pid yet is starting, not lost', () => {
  const root = tmp();
  const dir = join(root, '.perf', 'demo', 'runs', '20261030-000003-new0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...spec(), run_id: '20261030-000003-new0' }));
  assert.match(perf(['status', '--root', root]).out, /controller starting/);
});

test('perf stop picks the live run, never a newer one whose controller is lost', () => {
  const root = tmp();
  const liveDir = fakeRun(root, '20261030-000010-live', { state: 'steady', heartbeatAgeMs: 0, alive: true });
  const deadDir = fakeRun(root, '20261030-000020-dead', { state: 'steady', heartbeatAgeMs: 60000, alive: false });
  assert.equal(perf(['stop', '--root', root]).code, 0);
  assert.ok(existsSync(join(liveDir, 'stop.request')));
  assert.ok(!existsSync(join(deadDir, 'stop.request')));
  const r = perf(['stop', '--root', root, '--run', '20261030-000020-dead']);
  assert.equal(r.code, 1);
  assert.match(r.err, /controller is lost.*perf doctor --fix/);
});

test('doctor --spec reports every spec error as a safety failure', () => {
  const root = tmp();
  const p = writeSpec(root, spec({ target_url: 'https://api.example.com', environment: 'production' }));
  const r = perf(['doctor', '--root', root, '--spec', p]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not in allow_hosts/);
  assert.match(r.out, /never loads production/);
});

// ---- design §11: machine, generator, network, safety, project (M9) ----------------------------
// Each check is made to fail by planting its fault; machine facts a test cannot change (CPU load,
// port range, descriptor limit, platform) are injected as probes.

const byId = (checks, id) => checks.find((c) => c.id === id);
const HEALTHY = { docker: '27.0', python: 'Python 3.12', cpu_busy_pct: 5, ports: 16384, fd_limit: 65536, platform: 'linux' };

test('doctor machine: Docker missing is a warning, and fails a run that monitors with docker stats', () => {
  const root = tmp();
  const fake = join(root, 'no-docker.mjs');
  writeFileSync(fake, 'process.exit(1);');
  const env = { ...process.env, PERF_DOCKER: fake, PERF_PYTHON: 'python-that-does-not-exist' };
  const d = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'doctor', '--root', root], { encoding: 'utf8', env });
  assert.match(d.stdout, /\[warn\] machine\/docker: Docker not reachable/);
  assert.match(d.stdout, /\[warn\] machine\/python: no python/);
  const p = writeSpec(root, spec(), { monitor: { metrics: 'docker-stats', containers: ['db'], interval_s: 1 } });
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', p, '--root', root], { encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /Docker not reachable/);
});

test('doctor generator: a busy CPU, too few ports or file descriptors for the planned users warn', async () => {
  const root = tmp();
  const p = writeSpec(root, spec({ profile: { users: 500 } }));
  const ok = await doctor({ root, specPath: p, probes: HEALTHY });
  for (const id of ['cpu', 'ports', 'fd']) assert.equal(byId(ok, id).status, 'ok', id);
  const bad = await doctor({ root, specPath: p, probes: { ...HEALTHY, cpu_busy_pct: 95, ports: 1000, fd_limit: 1024 } });
  assert.match(byId(bad, 'cpu').detail, /CPU 95 % busy before any load/);
  assert.match(byId(bad, 'ports').detail, /1000 ephemeral ports; this run may hold about 2000/);
  assert.match(byId(bad, 'fd').detail, /open files limit 1024 for 500 users/);
  for (const id of ['cpu', 'ports', 'fd']) assert.equal(byId(bad, id).status, 'warn', id);
});

test('doctor network: a target that does not answer fails, a name that does not resolve says DNS, localhost on Windows warns', async () => {
  const root = tmp();
  writeFileSync(join(root, 'script.js'), '');
  const k6 = (target_url, hosts) => writeSpec(root, spec({ engine: 'k6', script: 'script.js', target_url, allow_hosts: hosts }));
  // A port nothing listens on (taken, then freed): the connection is refused.
  const free = await new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
  let c = await doctor({ root, specPath: k6(`http://127.0.0.1:${free}`, ['127.0.0.1']), probes: HEALTHY });
  assert.equal(byId(c, 'target').status, 'fail');
  assert.match(byId(c, 'target').detail, /does not answer/);
  // A host other than this machine is probed only once it is approved, like any run on it.
  const approved = writeSpec(root, spec({ engine: 'k6', script: 'script.js', target_url: 'http://no-such-host.invalid', allow_hosts: ['no-such-host.invalid'] }), { approval: { by: 'test', at: new Date().toISOString(), hosts: ['no-such-host.invalid'] } });
  c = await doctor({ root, specPath: approved, probes: HEALTHY });
  assert.match(byId(c, 'target').detail, /DNS: no-such-host.invalid not found/);
  const mock = await startMock();
  try {
    c = await doctor({ root, specPath: k6(mock.url, ['127.0.0.1']), probes: HEALTHY });
    assert.equal(byId(c, 'target').status, 'ok');
    assert.match(byId(c, 'target').detail, /answered HTTP \d+ in \d+ ms/);
  } finally { mock.stop(); }
  // A host the spec refuses (not allowlisted) is never sent a request.
  c = await doctor({ root, specPath: k6(`http://127.0.0.1:${free}`, ['10.0.0.1']), probes: HEALTHY });
  assert.equal(byId(c, 'target'), undefined);
  const lh = k6('http://localhost:9', ['localhost']);
  assert.equal(byId(await doctor({ root, specPath: lh, probes: { ...HEALTHY, platform: 'win32' } }), 'localhost').status, 'warn');
  assert.equal(byId(await doctor({ root, specPath: lh, probes: HEALTHY }), 'localhost'), undefined);
});

test('doctor safety: a third party called for real under load warns', async () => {
  const root = tmp();
  const p = writeSpec(root, spec(), { third_party: [{ name: 'payments', stubbed: false }, { name: 'mail', stubbed: true }] });
  const c = byId(await doctor({ root, specPath: p, probes: HEALTHY }), 'third_party');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /called for real under load: payments$/);
});

test('doctor project: broken files fail; unfinished gates, stale baselines, contract drift and open assumptions warn', async () => {
  const root = tmp();
  project(root);
  let c = await doctor({ root, probes: HEALTHY });
  assert.equal(byId(c, 'demo.files').status, 'ok');
  for (const id of ['demo.baselines', 'demo.contract', 'demo.assumptions', 'demo.gates']) assert.equal(byId(c, id), undefined, id);
  // The contract the plan was drafted from: its budget for listItems has since moved, and it
  // gained an x-perf operation the workload does not run.
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ paths: {
    '/items': { get: { operationId: 'listItems', 'x-perf': { p95_ms: 150 } } },
    '/items/{id}': { get: { operationId: 'getItem' } },
    '/orders': { post: { operationId: 'createOrder' } },
    '/search': { get: { operationId: 'search', 'x-perf': { p95_ms: 300 } } },
    // Left out on purpose: a POST, and a traffic class the plan does not cover.
    '/carts': { post: { operationId: 'addToCart', 'x-perf': { p95_ms: 300 } } },
    '/admin/report': { get: { operationId: 'adminReport', 'x-traffic': 'admin', 'x-perf': { p95_ms: 3000 } } },
  } }));
  writeFileSync(join(root, '.perf', 'demo', 'context.json'), JSON.stringify({ facts: { openapi: ['openapi.json'] } }));
  // A baseline, then the workload changes under it.
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  const wPath = join(root, '.perf', 'demo', 'workload.json');
  const w = JSON.parse(readFileSync(wPath, 'utf8'));
  writeFileSync(wPath, JSON.stringify({ ...w, target: { ...w.target, users: 30 }, littles_law: { ...w.littles_law, users: 30, rps: 300 } }));
  const sPath = join(root, '.perf', 'demo', 'slo.json');
  const s = JSON.parse(readFileSync(sPath, 'utf8'));
  s.transactions[0].source = 'contract';
  writeFileSync(sPath, JSON.stringify(s));
  writeFileSync(join(root, '.perf', 'demo', 'baselines', 'README.md'), 'a stray file');
  writeFileSync(join(root, '.perf', 'demo', 'assumptions.json'), JSON.stringify([{ key: 'peak_load', status: 'assumed' }, { key: 'system_kind', status: 'confirmed' }]));
  c = await doctor({ root, probes: HEALTHY });
  assert.match(byId(c, 'demo.baselines').detail, /stale baselines: local\/load \(workload changed\)/);
  assert.match(byId(c, 'demo.contract').detail, /listItems budget is 150 ms in the contract, 400 ms in slo.json; search has an x-perf budget but no journey runs it$/);
  assert.match(byId(c, 'demo.assumptions').detail, /1 open assumption\(s\): peak_load$/);
  // A gate that fails is a warning (the plan is unfinished); a file that is not JSON fails.
  writeFileSync(wPath, JSON.stringify({ ...w, journeys: [] }));
  assert.match(byId(await doctor({ root, probes: HEALTHY }), 'demo.gates').detail, /model: journeys: at least one/);
  writeFileSync(sPath, '{ not json');
  c = byId(await doctor({ root, probes: HEALTHY }), 'demo.files');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /not valid JSON: slo.json/);
});

async function startMock(port = 20000 + Math.floor(Math.random() * 20000)) {
  const child = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}
