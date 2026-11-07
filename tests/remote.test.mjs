import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openChannel } from '../controller/channel.mjs';
import { manifest } from '../adapters/targets/k8s.mjs';
import { quote, remoteCommand } from '../adapters/targets/ssh.mjs';
import { ROOT, norm, perf, result, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

// M11: workers on other machines. The controller opens a network channel; a perf-agent on each
// machine mirrors the worker protocol's files over it. ssh and kubectl are stand-ins here
// (mock/fake-ssh.mjs, mock/fake-kubectl.mjs) that run the "remote" side on this machine: the
// channel, the agent and the targets' commands are the real ones; a real cluster is not.
const T = { timeout: 180000 };
const TIMING = { tick_ms: 200, window_s: 0.5, heartbeat_timeout_s: 10, worker_timeout_s: 10, barrier_timeout_s: 30 };
const PERF = join(ROOT, 'bin', 'perf.mjs');
const perfEnv = (args, env) => { const r = spawnSync(process.execPath, [PERF, ...args], { encoding: 'utf8', timeout: 150000, env: { ...process.env, ...env } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const sshSpec = (hosts, over = {}) => spec({ target: 'ssh', workers: hosts.length, ssh: { hosts, ai_perf: '/opt/ai-perf' }, channel: { advertise: 'http://127.0.0.1' }, timing: TIMING, profile: { users: 10, steady_s: 3 }, ...over });
const SSH = (root) => ({ PERF_SSH: join(ROOT, 'mock', 'fake-ssh.mjs'), FAKE_SSH_AI_PERF: '/opt/ai-perf', FAKE_SSH_LOG: join(root, 'ssh.log') });

test('ssh: workers on two machines load through the channel; the token never appears on a command line', T, () => {
  const root = tmp();
  const r = perfEnv(['run', writeSpec(root, sshSpec(['load1', 'deploy@load2'])), '--root', root, '--wait'], SSH(root));
  assert.equal(r.code, 0, r.out + r.err);
  const res = result(runDir(root));
  assert.equal(res.run_state, 'done');
  assert.ok(res.total.rps > 85 && res.total.rps < 115, `rps ${res.total.rps}`);
  assert.ok(res.workers.every((w) => Number.isFinite(w.clock_skew_ms) && w.host), JSON.stringify(res.workers));
  const calls = readFileSync(join(root, 'ssh.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => !c.line.includes('--probe'));
  assert.deepEqual(calls.map((c) => c.host), ['load1', 'deploy@load2'], 'workers spread over the hosts in turn');
  for (const c of calls) {
    assert.match(c.line, /^node \/opt\/ai-perf\/bin\/perf-agent\.mjs --controller http:\/\/127\.0\.0\.1:\d+ --worker \d --token-stdin$/);
    assert.equal(c.args[c.args.indexOf(c.host) - 1], '--', 'the host comes after --: never read as an option');
    assert.doesNotMatch(c.line, /[0-9a-f]{64}/, 'no token in the command');
  }
  assert.equal(state(runDir(root)).channel.url.startsWith('http://127.0.0.1:'), true);
});

test('ssh: a machine lost mid-run loses its worker, and the run is degraded, not done', T, () => {
  const root = tmp();
  const r = perfEnv(['run', writeSpec(root, sshSpec(['load1', 'flaky2'], { profile: { users: 10, steady_s: 20 } })), '--root', root, '--wait'], { ...SSH(root), FAKE_SSH_KILL_AFTER_S: '4' });
  assert.equal(r.code, 4, r.out + r.err);
  const res = result(runDir(root));
  assert.deepEqual(res.workers.map((w) => w.lost), [false, true]);
  assert.ok(res.problems.some((p) => p.kind === 'worker_lost' && /w1/.test(p.detail)));
});

test('ssh: perf run refuses when a machine cannot be reached; the doctor says how far each clock is', T, () => {
  const root = tmp();
  const refused = perfEnv(['run', writeSpec(root, sshSpec(['load1', 'down2'])), '--root', root], SSH(root));
  assert.equal(refused.code, 2);
  assert.match(refused.out, /down2: cannot run perf-agent: ssh: connect to host down2 port 22: Connection refused/);
  const d = perfEnv(['doctor', '--root', root, '--spec', writeSpec(root, sshSpec(['load1']))], { ...SSH(root), FAKE_SSH_SKEW_MS: '5000' });
  assert.match(d.out, /\[ok\] {3}machine\/ssh\.load1: load1: ai-perf [\d.]+, engine fake installed/);
  assert.match(d.out, /\[warn\] clock\/clock\.load1: load1: clock \+(4[5-9]|5[0-4])\d\d ms from this one \(± \d{1,3} ms\)/);
  const ok = perfEnv(['doctor', '--root', root, '--spec', writeSpec(root, sshSpec(['load1']))], SSH(root));
  assert.match(ok.out, /\[ok\] {3}clock\/clock\.load1/);
});

test('ssh: a machine that cannot start the agent stops its worker at once, with the reason, not at the barrier', T, () => {
  const root = tmp();
  const t0 = Date.now();
  const r = perfEnv(['run', writeSpec(root, sshSpec(['load1', 'noagent2'], { timing: { ...TIMING, barrier_timeout_s: 60 } })), '--root', root, '--wait'], SSH(root));
  assert.equal(r.code, 5, r.out + r.err);
  assert.ok(Date.now() - t0 < 45000, 'well before the 60 s barrier');
  assert.match(JSON.stringify(state(runDir(root)).problems), /ssh to noagent2 ended \(exit 127\): bash: node: command not found/);
  assert.match(readFileSync(join(runDir(root), 'raw', 'w1', 'agent.log'), 'utf8'), /node: command not found/);
});

test('ssh: the doctor checks that each machine reaches the controller back', T, () => {
  const root = tmp();
  // 192.0.2.1 is TEST-NET: no machine answers there.
  const d = perfEnv(['doctor', '--root', root, '--spec', writeSpec(root, sshSpec(['load1'], { channel: { advertise: 'http://192.0.2.1' } }))], SSH(root));
  assert.match(d.out, /\[FAIL\] network\/reach\.load1: load1 cannot reach this controller at http:\/\/192\.0\.2\.1:\d+/);
  assert.doesNotMatch(perfEnv(['doctor', '--root', root, '--spec', writeSpec(root, sshSpec(['load1']))], SSH(root)).out, /reach\.load1/);
});

test('ssh: hosts and paths are words, never options or commands; the channel needs an address', () => {
  const errs = (over) => norm(sshSpec(['load1'], over)).errors.join('\n');
  assert.equal(errs({}), '');
  assert.match(errs({ ssh: { hosts: ['-oProxyCommand=calc'], ai_perf: '/opt/ai-perf' } }), /ssh.hosts/);
  assert.match(errs({ ssh: { hosts: ['load1;rm -rf /'], ai_perf: '/opt/ai-perf' } }), /ssh.hosts/);
  assert.match(errs({ ssh: { hosts: ['-E'], ai_perf: '/opt/ai-perf' } }), /ssh.hosts/);
  assert.equal(errs({ ssh: { hosts: ['load1'], ai_perf: '~/ai-perf' } }), '');
  assert.match(errs({ ssh: { hosts: ['load1'], ai_perf: '/opt/~x' } }), /ssh.ai_perf/);
  assert.match(errs({ ssh: { hosts: ['load1'], ai_perf: '/opt/ai perf' } }), /ssh.ai_perf/);
  assert.match(errs({ channel: {} }), /channel.advertise/);
  assert.match(errs({ channel: { advertise: 'https://10.0.0.5' } }), /channel.advertise/);
  assert.match(norm(spec({ target: 'k8s', k8s: { namespace: 'Perf_NS', image: 'x' }, channel: { advertise: 'http://10.0.0.5:7777' } })).errors.join(), /k8s.namespace/);
  // What the remote shell gets: plain words as they are, anything else quoted.
  assert.equal(quote('/opt/ai-perf/bin/perf-agent.mjs'), '/opt/ai-perf/bin/perf-agent.mjs');
  assert.equal(quote('a b$c'), '"a b\\$c"');
  assert.equal(remoteCommand({ ai_perf: '/opt/ai-perf/' }, ['--probe']), 'node /opt/ai-perf/bin/perf-agent.mjs --probe');
  // A leading ~/ stays outside quotes, so the remote shell expands it.
  assert.equal(remoteCommand({ ai_perf: '~/ai-perf' }, []), 'node ~/ai-perf/bin/perf-agent.mjs');
});

test('k8s: workers are pods of one Indexed Job; the token is in a Secret; both are deleted at the end', T, () => {
  const root = tmp();
  const s = spec({ target: 'k8s', workers: 3, k8s: { namespace: 'perf', image: 'registry.example.com/ai-perf-agent:1' }, channel: { advertise: 'http://127.0.0.1' }, timing: TIMING, profile: { users: 9, steady_s: 3 } });
  const env = { PERF_KUBECTL: join(ROOT, 'mock', 'fake-kubectl.mjs'), FAKE_KUBECTL_STATE: join(root, 'kube.json'), FAKE_KUBECTL_AI_PERF: '/ai-perf' };
  const r = perfEnv(['run', writeSpec(root, s), '--root', root, '--wait'], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(result(runDir(root)).run_state, 'done');
  const kube = JSON.parse(readFileSync(join(root, 'kube.json'), 'utf8'));
  const [job] = Object.values(kube.runs);
  assert.equal(job.pids.length, 3);
  assert.equal(job.deleted, true, 'the Job and its Secret are deleted when the run ends');
  // The manifest: the token only in the Secret, the Job reads it from there.
  const m = manifest({ spec: { ...s, run_id: '20261031-000000-abcd' }, channel: { url: 'http://10.0.0.5:7777', token: 'f'.repeat(64) } });
  const jobDoc = JSON.stringify(m.items.find((x) => x.kind === 'Job'));
  assert.doesNotMatch(jobDoc, /f{64}/);
  assert.match(jobDoc, /"secretKeyRef":\{"name":"ai-perf-20261031-000000-abcd","key":"token"\}/);
  assert.match(jobDoc, /"completionMode":"Indexed","completions":3,"parallelism":3,"backoffLimitPerIndex":0,"maxFailedIndexes":3,"activeDeadlineSeconds":\d+/);
  assert.match(jobDoc, /"automountServiceAccountToken":false/);
  assert.doesNotMatch(jobDoc, /"backoffLimit":0/, 'one failed pod must not fail the others');
  // Without rights to create Jobs, the doctor fails before anything is sent.
  const d = perfEnv(['run', writeSpec(root, s), '--root', root], { ...env, FAKE_KUBECTL_CAN_I: 'no' });
  assert.equal(d.code, 2);
  assert.match(d.out, /kubectl may not create jobs, create secrets, delete jobs, delete secrets in namespace perf/);
  // Without delete rights the Job would outlive the run: refused too.
  assert.match(perfEnv(['run', writeSpec(root, s), '--root', root], { ...env, FAKE_KUBECTL_DENY: 'delete' }).out, /kubectl may not delete jobs, delete secrets in namespace perf/);
});

test('k8s: after a lost controller, perf doctor --fix deletes the run\'s Job', T, async () => {
  const root = tmp();
  const s = spec({ target: 'k8s', workers: 2, k8s: { namespace: 'perf', image: 'x/agent:1' }, channel: { advertise: 'http://127.0.0.1' }, timing: TIMING, profile: { users: 4, steady_s: 30 } });
  const env = { ...process.env, PERF_KUBECTL: join(ROOT, 'mock', 'fake-kubectl.mjs'), FAKE_KUBECTL_STATE: join(root, 'kube.json'), FAKE_KUBECTL_AI_PERF: '/ai-perf' };
  spawn(process.execPath, [PERF, 'run', writeSpec(root, s), '--root', root], { stdio: 'ignore', env }).unref();
  const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 60000, 'steady');
  process.kill(Number(readFileSync(join(dir, 'controller.pid'), 'utf8')));
  await waitFor(() => perfEnv(['status', '--root', root], env).out.includes('controller lost'), 30000, 'lost');
  perfEnv(['doctor', '--root', root, '--fix'], env);
  assert.equal(Object.values(JSON.parse(readFileSync(join(root, 'kube.json'), 'utf8')).runs)[0].deleted, true);
});

test('channel: whatever a body holds, the controller lives on; a remote child is never a local one', async () => {
  const runDir0 = tmp();
  writeFileSync(join(runDir0, 'run.json'), JSON.stringify({ run_id: 'x' }));
  const ch = await openChannel({ runDir: runDir0, spec: { workers: 1 }, bind: '127.0.0.1', advertise: 'http://127.0.0.1' });
  try {
    const put = (body) => fetch(`${ch.url}/v1/workers/w0/status.json`, { method: 'PUT', body, headers: { authorization: `Bearer ${ch.token}` } });
    for (const bad of ['null', '[]', '{"state":"running"}', '"x"']) assert.equal((await put(bad)).status, 400, bad);
    assert.equal((await put(JSON.stringify({ state: 'running', ts: 1, child: { pid: process.pid } }))).status, 204);
    assert.equal(JSON.parse(readFileSync(join(runDir0, 'raw', 'w0', 'status.json'), 'utf8')).child, undefined);
  } finally { await ch.close(); }
});

test('channel: only the run token, only the run\'s workers, only protocol files', async () => {
  const runDir0 = tmp();
  writeFileSync(join(runDir0, 'run.json'), JSON.stringify({ run_id: 'x' }));
  writeFileSync(join(runDir0, 'control.json'), JSON.stringify({ heartbeat_at: 1 }));
  const ch = await openChannel({ runDir: runDir0, spec: { workers: 2 }, bind: '127.0.0.1', advertise: 'http://127.0.0.1' });
  try {
    const call = (method, path, body, token = ch.token) => fetch(`${ch.url}${path}`, { method, body, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await call('GET', '/v1/control', undefined, 'wrong')).status, 401);
    assert.equal((await call('GET', '/v1/control')).status, 200);
    assert.ok(Number((await call('GET', '/v1/control')).headers.get('x-perf-time')) > 0);
    assert.equal((await call('PUT', '/v1/workers/w0/status.json', '{"state":"running","ts":1}')).status, 204);
    assert.equal(JSON.parse(readFileSync(join(runDir0, 'raw', 'w0', 'status.json'), 'utf8')).state, 'running');
    assert.equal((await call('PUT', '/v1/workers/w5/status.json', '{}')).status, 404, 'not a worker of this run');
    assert.equal((await call('PUT', '/v1/workers/w0/run.json', '{}')).status, 404, 'not a protocol file');
    assert.equal((await call('PUT', '/v1/workers/w0/..%2F..%2Fcontrol.json', '{}')).status, 404);
    assert.equal((await call('PUT', '/v1/workers/w0/status.json', 'not json')).status, 400);
    assert.equal((await call('GET', '/v1/control')).status, 200, 'still serving');
  } finally { await ch.close(); }
});

test('agent: without a token it refuses; --probe reports its version and clock', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf-agent.mjs'), '--controller', 'http://127.0.0.1:9', '--worker', '0'], { encoding: 'utf8', env: { ...process.env, AI_PERF_TOKEN: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs --controller <url>, a worker index .* and a token/);
  const p = JSON.parse(spawnSync(process.execPath, [join(ROOT, 'bin', 'perf-agent.mjs'), '--probe'], { encoding: 'utf8', input: 'now\n' }).stdout.split('\n').filter((l) => l.startsWith('{'))[0]);
  assert.equal(p.version, readFileSync(join(ROOT, 'VERSION'), 'utf8').trim());
  assert.ok(Math.abs(p.now - Date.now()) < 5000);
  assert.equal(p.engines.fake, true);
});

