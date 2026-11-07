import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { windowIndex } from '../controller/profile.mjs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { errorClass, runner, shareOf, stages } from '../adapters/engines/k6/adapter.mjs';
import { toContainerHost } from '../adapters/targets/docker.mjs';
import { childAlive } from '../lib/workers.mjs';
import { ROOT, events, perf, result, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

// k6 runs from PERF_K6, `k6` on PATH, or the pinned image under Docker. Without any of them the
// end-to-end tests skip and say why; the unit tests always run.
const RUNNER = runner();
const T = { timeout: 240000, skip: RUNNER ? false : 'no k6 binary and no grafana/k6 image (docker pull grafana/k6:1.0.0)' };
// Container start and Docker Desktop's file sharing need production-like timeouts.
const TIMING = { tick_ms: 500, window_s: 2, heartbeat_timeout_s: 10, worker_timeout_s: 10, barrier_timeout_s: 120 };
const OPS = ['listItems', 'getItem', 'createOrder'];

async function startMock(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // 0.0.0.0: k6 in a container reaches the host as host.docker.internal.
  const child = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, MOCK_HOST: '0.0.0.0', ...env } });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

function k6Spec(root, url, over = {}) {
  copyFileSync(join(ROOT, 'mock', 'k6-load.js'), join(root, 'k6-load.js'));
  return spec({ engine: 'k6', script: 'k6-load.js', target_url: url, timing: TIMING, engine_options: {}, ...over, profile: { name: 'load', users: 8, warmup_s: 2, ramp_s: 2, steady_s: 8, rampdown_s: 3, ...over.profile } });
}

const containersOf = (runId) => spawnSync('docker', ['ps', '-q', '--filter', `name=aiperf-k6-${runId}`], { encoding: 'utf8' }).stdout.trim();

test('k6 stages: the run profile split exactly over workers, each stage at its target', () => {
  const p = { users: 10, warmup_users: 3, warmup_s: 2, ramp_s: 4, steady_s: 10, rampdown_s: 1 };
  assert.deepEqual(stages(p, 0, 3), ['0ms:1', '2000ms:1', '4000ms:4', '10000ms:4', '1000ms:0']);
  assert.deepEqual(stages(p, 2, 3), ['0ms:1', '2000ms:1', '4000ms:3', '10000ms:3', '1000ms:0']);
  for (const total of [1, 7, 20]) assert.equal([0, 1, 2].reduce((a, i) => a + shareOf(total, i, 3), 0), total);
  // No warmup and no rampdown are dropped; no ramp is a jump to the full load, or k6 would ramp
  // through steady.
  assert.deepEqual(stages({ users: 4, warmup_s: 0, ramp_s: 0, steady_s: 5, rampdown_s: 0 }, 0, 1), ['0ms:1', '0ms:4', '5000ms:4']);
});

test('k6 errors: a status is an HTTP class; no status is classed by the error-code range', () => {
  assert.equal(errorClass({ status: '503' }), 'HTTP 503');
  assert.equal(errorClass({ status: '0', error_code: '1050' }), 'RequestTimeout (k6 1050)');
  assert.equal(errorClass({ status: '0', error_code: '1212' }), 'ConnectionError (k6 1212)');
  assert.equal(errorClass({ status: '0', error_code: '1101' }), 'DNSError (k6 1101)');
  assert.equal(errorClass({ status: '0', error_code: '1500' }), 'k6 error 1500');
});

test('k6: 2 workers against the mock end done, every operation measured, containers removed', T, async () => {
  const mock = await startMock();
  try {
    const root = tmp();
    const r = perf(['run', writeSpec(root, k6Spec(root, mock.url)), '--root', root, '--wait'], 200000);
    const dir = runDir(root);
    const res = result(dir);
    assert.equal(r.code, 0, `${r.out}\n${readFileSync(join(dir, 'controller.log'), 'utf8')}`);
    assert.equal(res.run.tool, 'k6');
    assert.match(res.run.tool_version, /^k6 \d+\.\d+\.\d+/);
    for (const op of OPS) assert.ok(res.endpoints[op]?.requests > 0, `${op} measured`);
    assert.equal(res.total.failures, 0);
    // 8 users, 0.05-0.15 s think time: tens of requests per second, never zero or absurd.
    assert.ok(res.total.rps > 20 && res.total.rps < 200, `rps ${res.total.rps}`);
    assert.ok(res.generator.cpu_max_pct !== null && res.generator.cpu_max_pct < 80, `k6 CPU ${res.generator.cpu_max_pct}`);
    await waitFor(() => !containersOf(res.run.id), 30000, 'k6 containers removed');
  } finally { mock.stop(); }
});

test('k6: failed requests are classed, sampled and masked; a failed check is counted', T, async () => {
  const mock = await startMock({ MOCK_ERROR_RATE: '0.5' });
  try {
    const root = tmp();
    perf(['run', writeSpec(root, k6Spec(root, mock.url)), '--root', root, '--wait'], 200000);
    const dir = runDir(root);
    const res = result(dir);
    // MOCK_ERROR_RATE fails /orders only.
    assert.ok(res.endpoints.createOrder.error_rate > 0.2, `createOrder error rate ${res.endpoints.createOrder.error_rate}`);
    assert.equal(res.endpoints.listItems.failures, 0);
    const classes = Object.assign({}, ...res.workers.map((w) => JSON.parse(readFileSync(join(dir, 'raw', w.id, 'status.json'), 'utf8')).error_classes));
    assert.ok(classes['HTTP 500'] > 0, JSON.stringify(classes));
    assert.ok(classes['check failed: order created'] > 0, JSON.stringify(classes));
    // Failed business checks are counted in the measured window, where the verdict reads them (PS-D3).
    assert.ok(res.checks?.failed > 0 && res.checks.passed > 0, JSON.stringify(res.checks));
    const sample = readFileSync(join(dir, 'raw', 'w0', 'errors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
    assert.equal(sample.class, 'HTTP 500');
    assert.match(sample.error, /-> 500/);
    assert.ok(events(dir).some((e) => e.type === 'new_error_class' && e.data.class === 'HTTP 500'));
  } finally { mock.stop(); }
});

test('k6: a slow setup() delays the load; points follow k6 own start, setup is not an operation, and a lag past the rampdown degrades the run', T, async () => {
  const mock = await startMock();
  try {
    const root = tmp();
    writeFileSync(join(root, 'slow-setup.js'), `import http from 'k6/http';
import { sleep } from 'k6';
export function setup() { http.get(__ENV.BASE_URL + '/health', { tags: { name: 'setupCall' } }); sleep(4); }
export default function () { http.get(__ENV.BASE_URL + '/health?id=42'); sleep(0.1); }
`);
    const s = spec({ engine: 'k6', script: 'slow-setup.js', target_url: mock.url, timing: TIMING, engine_options: {}, profile: { name: 'load', users: 4, warmup_s: 2, ramp_s: 2, steady_s: 8, rampdown_s: 1 } });
    const r = perf(['run', writeSpec(root, s), '--root', root, '--wait'], 200000);
    const dir = runDir(root);
    const res = result(dir);
    assert.equal(r.code, 4, r.out);
    assert.ok(res.problems.some((p) => p.kind === 'engine_start_lag'), JSON.stringify(res.problems));
    assert.ok(res.workers.every((w) => w.stalled));
    const lag = JSON.parse(readFileSync(join(dir, 'raw', 'w0', 'status.json'), 'utf8')).start_lag_s;
    assert.ok(lag >= 4, `start lag ${lag}`);
    // Points are placed on k6's own clock: its first request falls in the window of t = 0, not
    // seconds later, where it would have pushed ramp load into the steady windows.
    const first = Math.min(...readdirSync(join(dir, 'raw', 'w0')).filter((f) => f.startsWith('hist-')).map((f) => Number(f.slice(5, -5))));
    assert.equal(first, windowIndex(0, s.profile, TIMING.window_s));
    // setup() is not load; an unnamed URL is keyed without its query (ids, tokens: lib/mask.mjs masks the rest).
    assert.deepEqual(Object.keys(res.endpoints), [`${toContainerHost(mock.url)}/health`.replace(/^https?:\/\/[^/]+/, (h) => (RUNNER.mode === 'docker' ? h : mock.url))]);
    assert.ok(!readFileSync(join(dir, 'result.json'), 'utf8').includes('?id=42'));
  } finally { mock.stop(); }
});

test('k6: a sidecar that dies mid-run has its k6 stopped by the controller', T, async () => {
  const mock = await startMock();
  try {
    const root = tmp();
    assert.equal(perf(['run', writeSpec(root, k6Spec(root, mock.url, { profile: { steady_s: 120 } })), '--root', root]).code, 0);
    const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 120000, 'steady');
    const st = state(dir);
    const w0 = JSON.parse(readFileSync(join(dir, 'raw', 'w0', 'status.json'), 'utf8'));
    process.kill(w0.pid);
    const child = w0.child;
    await waitFor(() => !childAlive(child), (TIMING.worker_timeout_s + 30) * 1000, 'the dead sidecar k6 to be stopped');
    spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'stop', '--root', root]);
    await waitFor(() => !containersOf(st.run_id), 60000, 'all k6 containers removed');
  } finally { mock.stop(); }
});

test('k6: a lost controller stops the sidecars and removes the k6 containers', T, async () => {
  const mock = await startMock();
  try {
    const root = tmp();
    assert.equal(perf(['run', writeSpec(root, k6Spec(root, mock.url, { profile: { steady_s: 120 } })), '--root', root]).code, 0);
    const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 120000, 'steady');
    const st = state(dir);
    process.kill(st.pid);
    await waitFor(() => !containersOf(st.run_id), (TIMING.heartbeat_timeout_s + 30) * 1000, 'k6 containers to stop');
    await waitFor(() => st.workers.every((w) => JSON.parse(readFileSync(join(dir, 'raw', w.id, 'status.json'), 'utf8')).reason === 'heartbeat_lost'), 20000, 'sidecars stopped on heartbeat_lost');
  } finally { mock.stop(); }
});
