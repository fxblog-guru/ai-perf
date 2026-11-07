import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, tmp, waitFor } from './helpers.mjs';

// Pillar 5: the README's Quick Start is the first thing a new user runs, so its commands are run
// here exactly as written, on a copy of examples/quickstart with no runs and no baselines.
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const block = README.split('## Quick Start')[1].split('```bash')[1].split('```')[0];
const [demo1, demo2] = block.split(/^# 2\./m).map((part) => part.split('\n')
  .map((l) => l.trim()).filter((l) => l.startsWith('node bin/perf.mjs'))
  .map((l) => l.replace('node bin/perf.mjs ', '').split(/\s+/)));

const PY = process.env.PERF_PYTHON || join(ROOT, '..', 'locust-performance-testing', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HAVE = existsSync(PY) && spawnSync(PY, ['-c', 'import locust'], { timeout: 30000 }).status === 0;

function cleanCopy() {
  const dir = join(tmp(), 'quickstart');
  cpSync(join(ROOT, 'examples', 'quickstart'), dir, { recursive: true, filter: (p) => !/[\\/](runs|baselines)([\\/]|$)/.test(p) });
  return dir;
}

function run(dir, args) {
  const a = args.map((x) => x.replace(/^examples\/quickstart/, dir));
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), ...a], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, PERF_PYTHON: PY } });
  return { args, code: r.status, out: r.stdout + r.stderr };
}

test('quick start: the README has both demos', () => {
  assert.ok(demo1.length >= 4 && demo2.length >= 2, JSON.stringify({ demo1, demo2 }));
  assert.deepEqual(demo1[0], ['doctor']);
});

test('quick start, demo 1: every command as written succeeds on a clean copy and says PASS', { timeout: 240000 }, () => {
  const dir = cleanCopy();
  for (const args of demo1) {
    const r = run(dir, args);
    assert.equal(r.code, 0, `${args.join(' ')}\n${r.out}`);
    if (args[0] === 'report') assert.match(r.out, /VERDICT: PASS/);
  }
  assert.equal(existsSync(join(dir, '.perf', 'demo', 'baselines')), false, 'simulated numbers are never promoted');
});

test('quick start, demo 2: Locust against the mock promotes the first real baseline', { timeout: 300000, skip: HAVE ? false : `no python with locust at ${PY}; set PERF_PYTHON` }, async () => {
  const dir = cleanCopy();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const mock = spawn(process.execPath, [join(ROOT, 'mock', 'server.mjs'), String(port)], { stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'mock');
    // The README's mock listens on 9990; the test moves it to a free port so parallel tests cannot collide.
    const specPath = join(dir, 'locust.json');
    writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('127.0.0.1:9990', `127.0.0.1:${port}`));
    for (const args of [...demo1.filter((a) => a[0] !== 'doctor'), ...demo2]) {
      let r = run(dir, args);
      // A starved worker ends the run degraded (exit 4): ai-perf telling the truth on a busy machine.
      for (let i = 0; r.code === 4 && args[0] === 'run' && i < 2; i++) r = run(dir, args);
      assert.equal(r.code, 0, `${args.join(' ')}\n${r.out}`);
      if (args[0] === 'report') assert.match(r.out, /VERDICT: PASS/);
    }
    const base = JSON.parse(readFileSync(join(dir, '.perf', 'demo', 'baselines', 'local', 'load.json'), 'utf8'));
    assert.match(base.run.tool_version, /^locust /);
  } finally {
    mock.kill();
  }
});
