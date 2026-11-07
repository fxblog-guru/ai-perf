import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { bucketOf } from '../controller/hist.mjs';
import { usersAt, windowIndex } from '../controller/profile.mjs';
import { ROOT, events, norm, perf, result, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

// The Locust template's venv on this machine, or PERF_PYTHON. Without either the tests skip and
// say why; they never pass silently.
const PY = process.env.PERF_PYTHON || join(ROOT, '..', 'locust-performance-testing', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HAVE = existsSync(PY) && spawnSync(PY, ['-c', 'import locust'], { timeout: 30000 }).status === 0;
const T = { timeout: 90000, skip: HAVE ? false : `no python with locust at ${PY}; set PERF_PYTHON` };

async function startMock(env = {}, port = 20000 + Math.floor(Math.random() * 20000)) {
  const child = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, ...env } });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

function perfWithPython(args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PERF_PYTHON: PY } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A real engine on a busy machine can be starved: the run then ends degraded with worker_stalled,
// which is ai-perf telling the truth, not the lifecycle failing. Such a run is retried (twice at
// most); any other outcome is returned as it is.
function runRetryingStalls(run, args) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = run(args);
    if (r.code !== 4) return r;
    const root = args[args.indexOf('--root') + 1];
    const st = state(runDir(root));
    if (!(st?.problems ?? []).every((p) => p.kind === 'worker_stalled')) return r;
  }
  return r;
}

function locustSpec(url, over = {}) {
  return spec({
    engine: 'locust', script: 'locustfile.py', workers: 4, target_url: url,
    profile: { name: 'load', users: 20, warmup_s: 1, ramp_s: 1, steady_s: 4, rampdown_s: 0.5, warmup_users: 4 },
    timing: { tick_ms: 200, window_s: 1, barrier_timeout_s: 40 },
    engine_options: {},
    ...over,
  });
}

test('python and node agree on every bucket and window index', { skip: T.skip }, () => {
  const values = [0.05, 0.1, 0.11, 1, 1.01, 7.3, 50, 99.99, 100, 1234.5, 600000];
  const code = `import json,os,sys,math
os.environ['AI_PERF_RUN_DIR']=sys.argv[1]; os.environ['AI_PERF_WORKER']='0'
sys.argv=[sys.argv[0]]
import importlib.util
spec=importlib.util.spec_from_file_location('shim', ${JSON.stringify(join(ROOT, 'adapters', 'engines', 'locust', 'ai_perf_locust.py'))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({'b':[m.bucket_of(v) for v in ${JSON.stringify(values)}],'w':[m.window_index(t) for t in [0,0.69,0.7,1.2,5.55]]}))`;
  const root = tmp();
  const s = spec({ profile: { warmup_s: 0.3, ramp_s: 0.4 } });
  writeSpec(root, s);
  const runDirPath = join(root, 'fake-run');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(runDirPath)},{recursive:true});require('fs').writeFileSync(${JSON.stringify(join(runDirPath, 'run.json'))}, JSON.stringify(${JSON.stringify({ ...s, timing: { ...s.timing, window_s: 0.5 } })}))`]);
  const r = spawnSync(PY, ['-c', code, runDirPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(py.b, values.map(bucketOf));
  assert.deepEqual(py.w, [0, 0.69, 0.7, 1.2, 5.55].map((t) => windowIndex(t, s.profile, 0.5)));
});

test('shim: a staircase and a spike follow the same users as profile.mjs', { skip: T.skip }, () => {
  const shapes = [
    { name: 'stress', steps: [4, 8, 16], step_s: 2, warmup_s: 1, ramp_s: 1, rampdown_s: 0.5 },
    { name: 'spike', users: 4, spike: { users: 12, at_s: 4, for_s: 3 }, warmup_s: 2, ramp_s: 1, steady_s: 14, rampdown_s: 1 },
  ];
  const ts = [0.5, 1.5, 2.1, 3.9, 4.1, 6.5, 7, 9.9, 10, 16.9, 17.5, 7.9, 8.2];
  for (const profile of shapes) {
    const s = norm(spec({ profile })).spec;
    const root = tmp();
    const dir = join(root, 'fake-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(s));
    const code = `import json,os,sys
os.environ['AI_PERF_RUN_DIR']=sys.argv[1]; os.environ['AI_PERF_WORKER']='0'
sys.argv=[sys.argv[0]]
import importlib.util
spec=importlib.util.spec_from_file_location('shim', ${JSON.stringify(join(ROOT, 'adapters', 'engines', 'locust', 'ai_perf_locust.py'))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([round(m.users_at(t), 6) for t in ${JSON.stringify(ts)}]))`;
    const r = spawnSync(PY, ['-c', code, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ts.map((t) => Math.round(usersAt(t, s.profile) * 1e6) / 1e6), profile.name);
  }
});

test('shim: errors are classed by the response, never by digits in the message; secrets are masked; warmup_users 0 stays 0', { skip: T.skip }, () => {
  const code = `import json,os,sys
os.environ['AI_PERF_RUN_DIR']=sys.argv[1]; os.environ['AI_PERF_WORKER']='0'
sys.argv=[sys.argv[0]]
import importlib.util
spec=importlib.util.spec_from_file_location('shim', ${JSON.stringify(join(ROOT, 'adapters', 'engines', 'locust', 'ai_perf_locust.py'))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class R:
    def __init__(s, c): s.status_code = c
class HTTPError(Exception):
    def __init__(s, msg, c): super().__init__(msg); s.response = R(c)
print(json.dumps({
  'refused': m.error_class(ConnectionRefusedError(111, '[Errno 111] Connection refused to 127.0.0.1:9990'), R(0)),
  'status': m.error_class(Exception('anything'), R(503)),
  'nested': m.error_class(HTTPError('401 Client Error for url: http://10.0.0.1/x', 401)),
  'mask': m.mask('401 for url: http://u:pw@10.0.0.1/x?a=1&token=abc123secret&key=K9 Bearer eyJhbGciOiJIUzI1NiJ9.x'),
  'warmup': m.users_at(0.1)}))`;
  const root = tmp();
  const runDirPath = join(root, 'fake-run');
  mkdirSync(runDirPath, { recursive: true });
  writeFileSync(join(runDirPath, 'run.json'), JSON.stringify(spec({ profile: { warmup_users: 0 } })));
  const r = spawnSync(PY, ['-c', code, runDirPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(py.refused, 'ConnectionRefusedError');
  assert.equal(py.status, 'HTTP 503');
  assert.equal(py.nested, 'HTTP 401');
  assert.equal(py.mask, '401 for url: http://***@10.0.0.1/x?a=1&token=***&key=*** Bearer ***');
  assert.equal(py.warmup, 0);
});

test('locust: 4 workers against the mock end done with every operation measured', T, async () => {
  const mock = await startMock();
  try {
    const root = tmp();
    copyFileSync(join(ROOT, 'mock', 'locustfile.py'), join(root, 'locustfile.py'));
    const r = runRetryingStalls(perfWithPython, ['run', writeSpec(root, locustSpec(mock.url)), '--root', root, '--wait']);
    assert.equal(r.code, 0, r.out + r.err);
    const res = result(runDir(root));
    assert.equal(res.run.tool, 'locust');
    assert.equal(res.generator.workers, 4);
    for (const op of ['listItems', 'getItem', 'createOrder']) assert.ok(res.endpoints[op]?.requests > 0, `${op} measured`);
    assert.equal(res.total.failures, 0);
    assert.ok(res.total.rps > 20, `rps ${res.total.rps}`);
    assert.ok(res.workers.every((w) => w.requests > 0), 'every worker carried load');
    assert.equal(res.run.window.kind, 'steady');
  } finally { mock.stop(); }
});

test('locust: failures are classified and sampled with a correlation id', T, async () => {
  const mock = await startMock({ MOCK_ERROR_RATE: '0.5' });
  try {
    const root = tmp();
    copyFileSync(join(ROOT, 'mock', 'locustfile.py'), join(root, 'locustfile.py'));
    const r = runRetryingStalls(perfWithPython, ['run', writeSpec(root, locustSpec(mock.url, { workers: 2 })), '--root', root, '--wait']);
    assert.equal(r.code, 0, r.out + r.err);
    const dir = runDir(root);
    const res = result(dir);
    assert.ok(res.endpoints.createOrder.failures > 0);
    assert.equal(res.endpoints.listItems.failures, 0);
    assert.ok(events(dir).some((e) => e.type === 'new_error_class' && e.data.class === 'HTTP 500'));
    const samples = readFileSync(join(dir, 'raw', 'w0', 'errors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(samples.length > 0 && samples.length <= 20);
    assert.match(samples[0].correlation_id, /^[0-9a-f-]{36}$/);
  } finally { mock.stop(); }
});

test('M2 exit: the whole lifecycle with locust, 4 workers, against the mock', { ...T, timeout: 400000 }, async () => {
  const root = tmp();
  copyFileSync(join(ROOT, 'mock', 'locustfile.py'), join(root, 'locustfile.py'));
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ paths: {
    '/items': { get: { operationId: 'listItems' } }, '/items/{id}': { get: { operationId: 'getItem' } }, '/orders': { post: { operationId: 'createOrder' } },
  } }));
  const ops = ['listItems', 'getItem', 'createOrder'];
  const run = (args) => perfWithPython([...args, '--root', root]);
  // 1 discover: the API description answers "which operations", so it is not asked.
  const d = JSON.parse(run(['discover', '--slug', 'demo', '--json']).out);
  assert.deepEqual(d.facts.operations, ops);
  assert.ok(!d.questions.some((q) => q.key === 'operations'));
  // 2–5 what the plan, model, env and data skills write; each gate must pass.
  const dir = join(root, '.perf', 'demo');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const put = (f, v) => writeFileSync(join(dir, f), JSON.stringify(v, null, 2));
  put('slo.json', { profiles: ['smoke', 'load'], transactions: ops.map((name) => ({ name, slo: { p95_ms: 300, error_rate: 0.01 }, sla: { p95_ms: 1000, error_rate: 0.02 }, source: 'assumed' })) });
  put('workload.json', { model: 'closed', model_reason: 'signed-in shoppers', target: { users: 20, source: 'assumed' },
    personas: [{ name: 'buyer', share_pct: 100, source: 'assumed' }],
    // mock/locustfile.py weighs its tasks 6:3:1: the plan says the same, or the mix check warns.
    journeys: ops.map((op, i) => ({ name: op, persona: 'buyer', weight_pct: [60, 30, 10][i], steps: [op], think_time_s: 0.1, source: 'assumed' })),
    littles_law: { rps: 160, response_s: 0.025, think_s: 0.1, users: 20 } });
  put('env.json', { environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['smoke', 'load'], owner: 'test', parity: 'laptop mock' } } });
  put('data/manifest.json', { accounts: { count: 20, source: 'generated' }, cleanup: { command: 'none: the mock keeps no state' }, run_id_prefix: true });
  for (const step of ['plan', 'model', 'env', 'data']) assert.equal(run(['check', step, '--slug', 'demo']).code, 0, step);
  const mock = await startMock();
  try {
    const timing = { tick_ms: 200, window_s: 1, barrier_timeout_s: 60 };
    const go = (profile) => {
      writeFileSync(join(root, 'spec.json'), JSON.stringify({ slug: 'demo', engine: 'locust', script: 'locustfile.py', workers: 4, target_url: mock.url, profile, timing }));
      return runRetryingStalls(run, ['run', join(root, 'spec.json'), '--wait', '--root', root]);
    };
    // 6 smoke, then the script gate.
    assert.equal(go({ name: 'smoke', users: 4, warmup_users: 4, warmup_s: 3 }).code, 0);
    assert.equal(run(['check', 'script', '--slug', 'demo']).code, 0, run(['check', 'script', '--slug', 'demo']).out);
    // 7 load, analyze, report with bootstrap and promote.
    const load = { name: 'load', users: 20, warmup_users: 4, warmup_s: 1, ramp_s: 1, steady_s: 5, rampdown_s: 0.5 };
    assert.equal(go(load).code, 0);
    assert.equal(run(['analyze', '--slug', 'demo']).code, 0);
    const first = run(['report', '--slug', 'demo', '--bootstrap', '--promote']);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /VERDICT: PASS[\s\S]*baseline promoted/);
    assert.equal(run(['help', '--slug', 'demo', '--json']).code, 0);
  } finally { mock.stop(); }
  // 8 the same scripts against a slower build of the same target (same URL): a regression, so FAIL.
  // The old build must be gone first, or the health check would answer from it.
  await waitFor(async () => { try { await fetch(`${mock.url}/health`); return false; } catch { return true; } }, 10000, 'old mock gone');
  const slow = await startMock({ MOCK_LATENCY_MS: '60' }, Number(new URL(mock.url).port));
  assert.equal(slow.url, mock.url);
  try {
    writeFileSync(join(root, 'spec.json'), JSON.stringify({ slug: 'demo', engine: 'locust', script: 'locustfile.py', workers: 4, target_url: slow.url, profile: { name: 'load', users: 20, warmup_users: 4, warmup_s: 1, ramp_s: 1, steady_s: 5, rampdown_s: 0.5 }, timing: { tick_ms: 200, window_s: 1, barrier_timeout_s: 60 } }));
    assert.equal(runRetryingStalls(run, ['run', join(root, 'spec.json'), '--wait', '--root', root]).code, 0);
    const second = run(['report', '--slug', 'demo']);
    assert.equal(second.code, 1, second.out);
    assert.match(second.out, /regression vs .*systemic/);
  } finally { slow.stop(); }
});

test('locust: workers stop on a lost heartbeat like any other engine', T, async () => {
  const mock = await startMock();
  try {
    const root = tmp();
    copyFileSync(join(ROOT, 'mock', 'locustfile.py'), join(root, 'locustfile.py'));
    const s = locustSpec(mock.url, { workers: 2, profile: { ...locustSpec('').profile, steady_s: 30 } });
    assert.equal(perfWithPython(['run', writeSpec(root, s), '--root', root]).code, 0);
    const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 40000, 'steady');
    const st = state(dir);
    process.kill(st.pid);
    await waitFor(() => st.workers.every((w) => JSON.parse(readFileSync(join(dir, 'raw', w.id, 'status.json'), 'utf8')).reason === 'heartbeat_lost'), 10000, 'locust workers to stop');
  } finally { mock.stop(); }
});
