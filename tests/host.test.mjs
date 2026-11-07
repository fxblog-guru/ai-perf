import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import * as hp from '../adapters/metrics/host-process.mjs';
import { PROFILES, ROOT, norm, perf, result, runDir, spec, state, tmp, waitFor } from './helpers.mjs';
import { OPS, project, runFake } from './project.mjs';

// M10: a target that runs on the machine itself, not in Docker, is monitored by its process:
// found by pid, port or command line; its CPU and memory sampled; its death is the finding.
const T = { timeout: 180000 };
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function busyServer({ busy = 0.5, mib = 64, leak = 0, tag = 'x' } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, 'mock', 'busy-server.mjs'), String(port), String(busy), String(mib), String(leak), tag], { stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } }, 10000, 'busy-server');
  return { port, pid: child.pid, child, stop: () => child.kill() };
}
const env = (processes, extra = {}) => ({ environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: PROFILES, owner: 'test', parity: 'laptop', third_party: [{ name: 'payments', stubbed: true }], monitor: { metrics: 'host-process', interval_s: 0.5, processes }, ...extra } } });
const LOAD = { name: 'load', users: 4, warmup_s: 1, ramp_s: 1, steady_s: 6, rampdown_s: 0.5 };

test('host-process: a process found by port, pid or command line is sampled for CPU and memory, and its death is seen', T, async () => {
  const s = await busyServer({ busy: 0.6, mib: 64 });
  try {
    hp.reset();
    const procs = [{ name: 'byport', port: s.port }, { name: 'bypid', pid: s.pid }, { name: 'bymatch', match: `busy-server\\.mjs ${s.port}\\b` }];
    assert.deepEqual((await hp.find(procs)).map((f) => f.pids), [[s.pid], [s.pid], [s.pid]]);
    // Its CPU so far (seconds of it) must not be read as its rate: let it burn some first.
    await new Promise((r) => setTimeout(r, 4000));
    await hp.sample({ processes: procs, t: 0 });
    await new Promise((r) => setTimeout(r, 2000));
    const live = await hp.sample({ processes: procs, t: 2 });
    for (const name of ['byport', 'bypid', 'bymatch']) {
      const of = (m) => live.find((x) => x.labels.container === name && x.name === m)?.value;
      assert.equal(of('target_process_up'), 1);
      assert.ok(of('target_cpu_cores') > 0.25 && of('target_cpu_cores') < 1.2, `${name} cores ${of('target_cpu_cores')}`);
      assert.ok(of('target_mem_bytes') > 64 * 1024 * 1024, `${name} memory ${of('target_mem_bytes')}`);
    }
    s.stop();
    await new Promise((r) => setTimeout(r, 800));
    const gone = await hp.sample({ processes: procs, t: 3 });
    assert.deepEqual(gone.map((x) => [x.labels.container, x.name, x.value]), [['byport', 'target_process_up', 0], ['bypid', 'target_process_up', 0], ['bymatch', 'target_process_up', 0]]);
    assert.deepEqual(await hp.sample({ processes: procs, t: 4 }), [], 'a gone target is reported once');
  } finally { s.stop(); }
});

// The Linux path reads /proc; on another OS it is run in a container when the image is there.
const alpine = spawnSync('docker', ['image', 'inspect', 'node:22-alpine'], { timeout: 30000 }).status === 0;
test('host-process: a target of several processes follows its workers as they are replaced, and dies only with the last', T, async () => {
  const tag = `pool${Date.now()}`;
  const a = await busyServer({ busy: 0.2, mib: 16, tag });
  const b = await busyServer({ busy: 0.2, mib: 16, tag });
  let c = null;
  try {
    hp.reset();
    const procs = [{ name: 'pool', match: `busy-server\\.mjs .* ${tag}$` }];
    await hp.sample({ processes: procs, t: 0 });
    a.stop();
    c = await busyServer({ busy: 0.2, mib: 16, tag });
    const s1 = await hp.sample({ processes: procs, t: 1 });
    const exited = s1.find((x) => x.name === 'target_process_exited');
    assert.equal(exited?.labels.exited, String(a.pid), 'the worker that went is said');
    assert.deepEqual(s1.find((x) => x.name === 'target_process_up').labels.pids.split(',').map(Number).sort(), [b.pid, c.pid].sort(), 'the new worker is followed');
    b.stop(); c.stop();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await hp.sample({ processes: procs, t: 2 })).find((x) => x.name === 'target_process_up').value, 0);
  } finally { a.stop(); b.stop(); c?.stop(); }
});

test('host-process: the load generator is never part of the target (the controller\'s children, the run folder)', T, async () => {
  const s = await busyServer({ busy: 0.1, mib: 8, tag: 'RUNDIR-abc123' });
  try {
    hp.reset();
    const procs = [{ name: 'node', match: 'busy-server' }];
    assert.deepEqual((await hp.find(procs)).map((f) => f.pids), [[s.pid]], 'found without an exclusion');
    assert.deepEqual(await hp.sample({ processes: procs, t: 0, exclude: { text: 'RUNDIR-abc123' } }), [], 'its command line holds the run folder');
    hp.reset();
    assert.deepEqual(await hp.sample({ processes: procs, t: 0, exclude: { root: process.pid } }), [], 'a child of the controller');
  } finally { s.stop(); }
});

test('host-process on Linux: /proc finds the port, the pid and the command line, and measures them', { ...T, skip: process.platform === 'linux' || alpine ? false : 'not Linux, and no node:22-alpine image to run the Linux path in' }, () => {
  const r = process.platform === 'linux'
    ? spawnSync(process.execPath, [join(ROOT, 'mock', 'host-process-probe.mjs')], { encoding: 'utf8', timeout: 60000 })
    : spawnSync('docker', ['run', '--rm', '-v', `${ROOT}:/ai-perf:ro`, 'node:22-alpine', 'node', '/ai-perf/mock/host-process-probe.mjs'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.platform, 'linux');
  assert.deepEqual(out.found.map((f) => f.pids), [[out.child], [out.child], [out.child]]);
  const cores = out.live.filter(([, m]) => m === 'target_cpu_cores').map(([, , v]) => v);
  assert.ok(cores.length === 3 && cores.every((c) => c > 0.4 && c < 1.2), JSON.stringify(cores));
  assert.ok(out.gone.every(([, m, v]) => m === 'target_process_up' && v === 0));
});

test('host-process: the spec names each process once, by exactly one of pid, port or match', () => {
  const errs = (processes) => norm(spec(), { envExtra: { monitor: { metrics: 'host-process', processes } } }).errors.join('\n');
  assert.equal(errs([{ name: 'api', port: 8080 }, { name: 'db', match: 'postgres' }]), '');
  assert.match(errs(undefined), /host-process needs the target processes/);
  assert.match(errs([{ name: 'api', port: 8080, pid: 3 }]), /exactly one of pid, port, match/);
  assert.match(errs([{ name: 'api', port: 'web' }]), /port: a whole number > 0/);
  assert.match(errs([{ name: 'api', match: '(' }]), /match: not a regular expression/);
  assert.match(errs([{ name: 'api', port: 1 }, { name: 'api', port: 2 }]), /name api is used twice/);
});

test('host-process: a run refuses to start while its target process is not running', T, async () => {
  const root = tmp();
  const port = await freePort();
  project(root, { 'env.json': env([{ name: 'api', port }]) });
  const r = runFake(root, { profile: LOAD });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, new RegExp(`target process not running: api \\(port ${port}\\)`));
});

test('host-process: a run samples its target process; when the process dies the run stops and fails', T, async () => {
  const s = await busyServer({ busy: 0.3 });
  try {
    const root = tmp();
    project(root, { 'env.json': env([{ name: 'api', port: s.port }]) });
    assert.equal(runFake(root, { profile: LOAD }).code, 0);
    const samples = readFileSync(join(runDir(root), 'monitor', 'target.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(samples.some((x) => x.name === 'target_cpu_pct' && x.labels.container === 'api'));
    assert.ok(!(result(runDir(root)).problems ?? []).some((p) => p.kind === 'monitoring_failed'));
    // The first sample has memory but no CPU yet (a rate needs two): that is not "no metrics".
    assert.ok(!readFileSync(join(runDir(root), 'events.ndjson'), 'utf8').includes('no metrics from process api'));
    // Killed in the middle of a staircase: a crash is a FAIL, not where capacity ran out.
    writeFileSync(join(root, 'spec.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'spec.json'), 'utf8')), profile: { name: 'load', steps: [2, 4], step_s: 4, warmup_s: 1, ramp_s: 1, rampdown_s: 0.5 } }));
    const run = new Promise((res) => { const c = spawn(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', join(root, 'spec.json'), '--root', root, '--wait'], { stdio: 'ignore' }); c.on('close', res); });
    await waitFor(() => { const d = runDir(root); const st = d && state(d); return st && st.state === 'steady' && !st.stop_reason && d; }, 30000, 'steady');
    s.stop();
    assert.equal(await run, 5);
    const dir = runDir(root);
    assert.equal(state(dir).stop_reason, 'auto_stop:target_gone');
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, new RegExp(`FAIL: the target failed under load: run auto-stopped \\(auto_stop:target_gone\\): process api \\(pid ${s.pid}\\) exited at t=`));
  } finally { s.stop(); }
});

test('host-process: a target that dies before the load starts is gone, not "never monitored"', T, async () => {
  const s = await busyServer({ busy: 0.1 });
  try {
    const root = tmp();
    project(root, { 'env.json': env([{ name: 'api', port: s.port }]) });
    runFake(root, { profile: LOAD }); // writes spec.json (and a first, healthy run)
    // Killed while the workers are still starting: after the look before the load, before any in it.
    const run = new Promise((res) => { const c = spawn(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', join(root, 'spec.json'), '--root', root, '--wait'], { stdio: 'ignore' }); c.on('close', res); });
    await waitFor(() => { const d = runDir(root); const st = d && state(d); return st && st.state === 'preparing' && st.workers?.length && !existsSync(join(d, 'result.json')) && d; }, 30000, 'preparing');
    s.stop();
    assert.equal(await run, 5);
    assert.equal(state(runDir(root)).stop_reason, 'auto_stop:target_gone');
  } finally { s.stop(); }
});

test('host-process: a soak watches the process memory, and a leak fails it', T, async () => {
  const s = await busyServer({ busy: 0.1, mib: 32, leak: 8 });
  try {
    const root = tmp();
    project(root, { 'env.json': env([{ name: 'api', port: s.port }]), 'slo.json': { profiles: ['soak'], transactions: OPS.map((name) => ({ name, slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' })) } });
    runFake(root, { profile: { name: 'soak', users: 4, warmup_s: 1, ramp_s: 1, steady_s: 16, rampdown_s: 0.5 } });
    assert.ok(result(runDir(root)).drift.memory_pct.api > 50, JSON.stringify(result(runDir(root)).drift));
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /FAIL: soak: memory of api grew \+[\d.]+ % over steady/);
  } finally { s.stop(); }
});

test('analysis: failures claim correlation ids only when the engine recorded them', async () => {
  const { evidenceOf } = await import('../lib/analyze.mjs');
  assert.equal(evidenceOf([{ correlation_id: 'a' }, { correlation_id: 'b' }]), '2 sampled request(s) with correlation ids');
  assert.equal(evidenceOf([{ correlation_id: 'a' }, { correlation_id: null }]), '2 sampled request(s), 1 with a correlation id');
  assert.match(evidenceOf([{ correlation_id: null }]), /^1 sampled request\(s\), none with a correlation id: the engine records none\. Send an X-Request-ID header/);
  assert.equal(evidenceOf([]), 'cause not established: no sampled request');
});
