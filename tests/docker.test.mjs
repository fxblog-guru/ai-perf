import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isRunning } from '../adapters/targets/docker.mjs';
import { parse, bytes, sample } from '../adapters/metrics/docker-stats.mjs';
import { HB_S, ROOT, events, perf, result, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

// Real Docker with the node:22-alpine image already pulled; otherwise these skip and say why.
const dockerOk = spawnSync('docker', ['image', 'inspect', 'node:22-alpine'], { timeout: 30000 }).status === 0;
const DOCKER_TIMING = { tick_ms: 500, window_s: 1, heartbeat_timeout_s: 10, worker_timeout_s: 10, barrier_timeout_s: 120 };
const D = { timeout: 360000, skip: dockerOk ? false : 'docker or the node:22-alpine image is not available' };

test('docker-stats: parses CPU, memory percent and bytes per container', () => {
  const line = JSON.stringify({ Name: 'shop-db', CPUPerc: '97.50%', MemPerc: '12.5%', MemUsage: '256MiB / 2GiB' });
  const s = parse(`${line}\n`, 3);
  assert.deepEqual(s.map((x) => [x.name, x.value]), [['target_cpu_pct', 97.5], ['target_cpu_cores', 0.975], ['target_mem_pct', 12.5], ['target_mem_bytes', 256 * 1024 ** 2]]);
  assert.equal(s[0].labels.container, 'shop-db');
  assert.equal(bytes('1.5GB'), 1.5e9);
});

test('a busy target trips the target_cpu_pct auto-stop (metrics from a stand-in docker)', { timeout: 30000 }, () => {
  const root = tmp();
  const fake = join(root, 'fake-docker.mjs');
  writeFileSync(fake, `console.log(JSON.stringify({ Name: 'shop-db', CPUPerc: '97.5%', MemPerc: '10%', MemUsage: '100MiB / 1GiB' }));`);
  const s = spec({ auto_stop: [{ metric: 'target_cpu_pct', above: 90, for_s: 0.5 }], profile: { steady_s: 8 } });
  const p = writeSpec(root, s, { monitor: { metrics: 'docker-stats', containers: ['shop-db'], interval_s: 0.2 } });
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', p, '--root', root, '--wait'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PERF_DOCKER: fake } });
  assert.equal(r.status, 5, r.stdout + r.stderr);
  const dir = runDir(root);
  assert.equal(state(dir).stop_reason, 'auto_stop:target_cpu_pct');
  const samples = readFileSync(join(dir, 'monitor', 'target.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(samples.some((x) => x.name === 'target_cpu_pct' && x.labels.container === 'shop-db'));
});

test('a container that yields no metrics is reported at once and the run cannot end done', { timeout: 30000 }, () => {
  // Docker answers `docker version` (doctor lets the run start), then: stats fails, or names
  // another container.
  const version = "if (process.argv[2] === 'version') { console.log('27.0'); process.exit(0); }\n";
  for (const body of ['process.exit(1);', `console.log(JSON.stringify({ Name: 'other', CPUPerc: '5%', MemPerc: '1%', MemUsage: '1MiB / 1GiB' }));`]) {
    const root = tmp();
    const fake = join(root, 'fake-docker.mjs');
    writeFileSync(fake, version + body);
    const s = spec({ auto_stop: [{ metric: 'target_cpu_pct', above: 90, for_s: 0.5 }] });
    const p = writeSpec(root, s, { monitor: { metrics: 'docker-stats', containers: ['shop-db'], interval_s: 0.2 } });
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', p, '--root', root, '--wait'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PERF_DOCKER: fake } });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    const dir = runDir(root);
    assert.match(result(dir).problems.find((x) => x.kind === 'monitoring_failed')?.detail ?? '', /shop-db/);
    assert.ok(events(dir).some((e) => e.type === 'anomaly' && e.data.container === 'shop-db'));
  }
});

test('a run that monitors with docker stats is refused when Docker does not answer', () => {
  const root = tmp();
  const fake = join(root, 'fake-docker.mjs');
  writeFileSync(fake, 'process.exit(1);');
  const p = writeSpec(root, spec(), { monitor: { metrics: 'docker-stats', containers: ['shop-db'], interval_s: 0.2 } });
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', p, '--root', root], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PERF_DOCKER: fake } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /run refused:[\s\S]*Docker not reachable/);
});

test('a docker command that cannot even start is no sample, never a thrown error (Docker gone mid-run)', async () => {
  const root = tmp();
  const fake = join(root, 'docker.dat');
  writeFileSync(fake, 'not a program');
  const before = process.env.PERF_DOCKER;
  process.env.PERF_DOCKER = fake;
  try { assert.deepEqual(await sample({ containers: ['shop-db'], t: 1 }), []); } finally { if (before === undefined) delete process.env.PERF_DOCKER; else process.env.PERF_DOCKER = before; }
});

test('a target_cpu_pct rule without a metrics source is refused', () => {
  const root = tmp();
  const r = perf(['run', writeSpec(root, spec({ auto_stop: [{ metric: 'target_cpu_pct', above: 90, for_s: 1 }] })), '--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /needs a metrics source/);
});

test('docker target: workers run as containers, finish done, and are removed', D, () => {
  const root = tmp();
  // Docker Desktop can take tens of seconds per container on a busy machine; the barrier waits.
  // Production-like timings: files on a Docker Desktop bind mount can lag seconds behind (CONTRACTS §3).
  const s = spec({ target: 'docker', profile: { warmup_s: 1, ramp_s: 1, steady_s: 6, rampdown_s: 1 }, timing: DOCKER_TIMING, engine_options: { ideal: false } });
  const r = perf(['run', writeSpec(root, s), '--root', root, '--wait'], 300000);
  const res = result(runDir(root));
  // Docker Desktop on a busy Windows host can freeze containers for a second or more. Two
  // outcomes are honest: done with the planned rate, or degraded because a worker stalled.
  // Anything else, or a quiet shortfall, fails.
  if (r.code === 4) assert.ok(res.problems.some((p) => p.kind === 'worker_stalled'), r.out);
  else {
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(res.run_state, 'done');
    assert.ok(res.total.rps > 170 && res.total.rps < 215, `rps ${res.total.rps}`);
  }
  const st = state(runDir(root));
  for (const w of st.workers) assert.match(w.container, /^aiperf-.*-w\d$/);
  return waitFor(() => st.workers.every((w) => !isRunning(w.container)), 20000, 'containers removed');
});

test('docker target: containers stop on a lost heartbeat', D, async () => {
  const root = tmp();
  assert.equal(perf(['run', writeSpec(root, spec({ target: 'docker', profile: { steady_s: 60 }, timing: DOCKER_TIMING })), '--root', root]).code, 0);
  const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 60000, 'steady');
  const st = state(dir);
  process.kill(st.pid);
  await waitFor(() => st.workers.every((w) => !isRunning(w.container)), (DOCKER_TIMING.heartbeat_timeout_s + 20) * 1000, 'containers to stop');
});

test('doctor reports the engine a dead sidecar left running, and --fix removes it', D, async () => {
  const root = tmp();
  const dir = join(root, '.perf', 'demo', 'runs', '20261030-000000-abcd');
  const container = `aiperf-k6-orphan-${process.pid}`;
  assert.equal(spawnSync('docker', ['run', '-d', '--rm', '--name', container, 'node:22-alpine', 'sleep', '300']).status, 0);
  try {
    mkdirSync(join(dir, 'raw', 'w0'), { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: '20261030-000000-abcd', slug: 'demo' }));
    // The controller is gone (a dead pid, an old heartbeat) and so is the sidecar; its k6 is not.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ run_id: '20261030-000000-abcd', slug: 'demo', state: 'steady', pid: 999999, heartbeat_at: 1, heartbeat_timeout_s: 10, workers: [{ id: 'w0', index: 0, pid: 999998 }], problems: [] }));
    writeFileSync(join(dir, 'raw', 'w0', 'status.json'), JSON.stringify({ worker: 0, pid: 999998, state: 'running', ts: 1, child: { container } }));
    const d = perf(['doctor', '--root', root]);
    assert.match(d.out, new RegExp(`orphan workers still loading the target: w0 engine \\(${container}\\)`));
    perf(['doctor', '--root', root, '--fix']);
    await waitFor(() => !isRunning(container), 30000, 'orphan engine removed');
  } finally { spawnSync('docker', ['rm', '-f', container]); }
});

test('docker target: ws players in containers reach a game on the host (host.docker.internal)', D, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { spawn } = await import('node:child_process');
  const game = spawn(process.execPath, [join(ROOT, 'mock', 'game.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, MOCK_HOST: '0.0.0.0' } });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'game mock');
    const root = tmp();
    writeFileSync(join(root, 'game-player.mjs'), readFileSync(join(ROOT, 'mock', 'game-player.mjs')));
    const s = spec({ engine: 'ws', script: 'game-player.mjs', target: 'docker', target_url: `ws://127.0.0.1:${port}`, profile: { users: 4, warmup_s: 1, ramp_s: 1, steady_s: 4, rampdown_s: 1 }, timing: DOCKER_TIMING, engine_options: {} });
    const r = perf(['run', writeSpec(root, s), '--root', root, '--wait'], 300000);
    const res = result(runDir(root));
    if (r.code === 4) assert.ok(res.problems.some((p) => p.kind === 'worker_stalled'), r.out);
    else assert.equal(r.code, 0, r.out);
    assert.ok(res.endpoints.move?.requests > 0 && res.realtime.ccu_max >= 4, JSON.stringify(res.realtime));
  } finally { game.kill(); }
});

test('docker-stats against a real container', D, async () => {
  const name = `aiperf-mock-${process.pid}`;
  const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'MOCK_HOST=0.0.0.0', '-v', `${ROOT}:/ai-perf:ro`, 'node:22-alpine', 'node', '/ai-perf/mock/server.mjs', '9990'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  try {
    const { sample } = await import('../adapters/metrics/docker-stats.mjs');
    const s = await sample({ containers: [name], t: 0 });
    assert.ok(s.some((x) => x.name === 'target_mem_bytes' && x.value > 0 && x.labels.container === name), JSON.stringify(s));
  } finally {
    spawnSync('docker', ['rm', '-f', name]);
  }
});
