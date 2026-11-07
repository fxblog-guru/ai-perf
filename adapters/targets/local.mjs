import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../../controller/files.mjs';

export const name = 'local';

// Workers are detached on purpose: if the controller dies they keep running until their heartbeat
// check stops them, which is the behaviour every other target must also have.
export function startWorkers({ runDir, spec, engine }) {
  const workers = [];
  for (let index = 0; index < spec.workers; index++) {
    const id = `w${index}`;
    const { cmd, args, env } = engine.workerCommand({ runDir, index, count: spec.workers, options: spec.engine_options ?? {}, spec });
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    // A worker that cannot start reports it the way any worker reports a stop, so the barrier sees it.
    child.on('error', (e) => {
      mkdirSync(join(runDir, 'raw', id), { recursive: true });
      writeJson(join(runDir, 'raw', id, 'status.json'), { worker: index, pid: null, state: 'stopped', reason: `spawn_failed: ${e.code ?? e.message}`, ts: Date.now() });
    });
    child.unref();
    workers.push({ id, index, pid: child.pid ?? null });
  }
  return workers;
}

export function stopWorker(w) {
  try { process.kill(w.pid); return true; } catch { return false; }
}
