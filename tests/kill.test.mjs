import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isAlive, readJson } from '../controller/files.mjs';
import { HB_S, perf, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

const T = { timeout: 30000 };

async function startAndKillController(s) {
  const root = tmp();
  assert.equal(perf(['run', writeSpec(root, s), '--root', root]).code, 0);
  const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 10000, 'steady');
  const st = state(dir);
  process.kill(st.pid);
  await waitFor(() => !isAlive(st.pid), 5000, 'controller to die');
  return { root, dir, st };
}

const status = (dir, w) => readJson(join(dir, 'raw', w.id, 'status.json'));

test('workers stop on their own when the controller dies (heartbeat)', T, async () => {
  const { root, dir, st } = await startAndKillController(spec({ profile: { steady_s: 8 } }));
  // Every worker must be gone within the heartbeat timeout plus two seconds.
  await waitFor(() => st.workers.every((w) => !isAlive(w.pid)), (HB_S + 2) * 1000, 'workers to stop');
  for (const w of st.workers) assert.equal(status(dir, w).reason, 'heartbeat_lost');

  const before = perf(['doctor', '--root', root]);
  assert.equal(before.code, 1);
  assert.match(before.out, /\[FAIL\] controller\/run\..*controller of demo\/.* is gone/);
  assert.equal(perf(['doctor', '--root', root, '--fix']).code, 1);
  assert.equal(state(dir).state, 'aborted');
  assert.equal(state(dir).stop_reason, 'controller_lost');
  assert.equal(perf(['doctor', '--root', root]).code, 0);
});

test('doctor finds a worker that ignores the heartbeat, and --fix stops it', T, async () => {
  const s = spec({ profile: { steady_s: 10 }, engine_options: { faults: [{ kind: 'ignore_heartbeat', worker: 1 }] } });
  const { root, st } = await startAndKillController(s);
  const w1 = st.workers.find((w) => w.id === 'w1');
  await waitFor(() => !isAlive(st.workers[0].pid), (HB_S + 2) * 1000, 'w0 to stop');
  assert.ok(isAlive(w1.pid), 'w1 should still be running');

  const r = perf(['doctor', '--root', root]);
  assert.match(r.out, new RegExp(`orphan workers still loading the target: w1 \\(pid ${w1.pid}\\)`));
  perf(['doctor', '--root', root, '--fix']);
  await waitFor(() => !isAlive(w1.pid), 3000, 'orphan to be stopped');
});
