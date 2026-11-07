import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Locust as an ai-perf engine: each worker is one standalone, headless Locust process running the
// product's locustfile plus the shim, which speaks the worker protocol. Python comes from
// PERF_PYTHON (a venv's python) or `python` on PATH.
export const name = 'locust';
export const tool = 'locust';
const SHIM = fileURLToPath(new URL('./ai_perf_locust.py', import.meta.url));
const python = () => process.env.PERF_PYTHON || 'python';

let cached;
export function detect() {
  if (cached) return cached;
  const r = spawnSync(python(), ['-c', 'import locust, psutil; print(locust.__version__)'], { encoding: 'utf8', timeout: 30000 });
  cached = r.status === 0
    ? { ok: true, version: r.stdout.trim() }
    : { ok: false, install: `pip install locust (into the python at PERF_PYTHON=${python()})` };
  return cached;
}

// Pinned image; the product script's folder is mounted at /perf/script.
export const IMAGE = 'locustio/locust:2.43.1';
export function containerCommand({ spec }) {
  const script = `/perf/script/${spec.script_path.split(/[\\/]/).pop()}`;
  return {
    image: IMAGE,
    args: ['-f', `${script},/ai-perf/adapters/engines/locust/ai_perf_locust.py`, '--headless', '--host', spec.target_url, '--loglevel', 'WARNING', '--skip-log-setup', '--only-summary'],
    env: { PYTHONUNBUFFERED: '1' },
  };
}

export function workerCommand({ runDir, index, spec }) {
  return {
    cmd: python(),
    args: ['-m', 'locust', '-f', `${spec.script_path},${SHIM}`, '--headless', '--host', spec.target_url, '--loglevel', 'WARNING', '--skip-log-setup', '--only-summary'],
    // AI_PERF_WORKER / AI_PERF_WORKERS let a script take its own data partition (index mod workers).
    env: { AI_PERF_RUN_DIR: runDir, AI_PERF_WORKER: String(index), AI_PERF_WORKERS: String(spec.workers), PYTHONUNBUFFERED: '1' },
  };
}
