import { execFile, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Workers as containers on the local Docker engine, one per worker. The run folder and ai-perf are
// bind-mounted, so the worker protocol (CONTRACTS §3) is the same files as on `local`. A target on
// the host is reached as host.docker.internal; the allowlist is still checked on the spec's host.
export const name = 'docker';
const AI_PERF = fileURLToPath(new URL('../..', import.meta.url));
export const docker = () => process.env.PERF_DOCKER || 'docker';
const run = (args) => spawnSync(docker(), args, { encoding: 'utf8', timeout: 120000 });

export function detect() {
  const r = run(['version', '--format', '{{.Server.Version}}']);
  return r.status === 0 ? { ok: true, version: r.stdout.trim() } : { ok: false, install: 'start Docker Desktop or the docker daemon' };
}

export const containerName = (runId, index) => `aiperf-${runId}-w${index}`.toLowerCase();
export const toContainerHost = (url) => url.replace(/\/\/(127\.0\.0\.1|localhost)([:/]|$)/, '//host.docker.internal$2');

// `docker run` takes a second or more per container: async, so the controller keeps beating.
const runAsync = (args) => new Promise((resolve) => {
  execFile(docker(), args, { encoding: 'utf8', timeout: 120000, windowsHide: true }, (err, stdout, stderr) => resolve({ status: err ? 1 : 0, stdout, stderr }));
});

export async function startWorkers({ runDir, spec, engine }) {
  if (!engine.containerCommand) throw new Error(`engine ${engine.name} has no container image; use target local`);
  const workers = [];
  for (let index = 0; index < spec.workers; index++) {
    const id = `w${index}`;
    const container = containerName(spec.run_id, index);
    const c = engine.containerCommand({ index, spec: { ...spec, target_url: toContainerHost(spec.target_url) } });
    const mounts = ['-v', `${runDir}:/perf/run`, '-v', `${AI_PERF}:/ai-perf:ro`];
    if (spec.script_path) mounts.push('-v', `${dirname(spec.script_path)}:/perf/script:ro`);
    const envArgs = Object.entries({ AI_PERF_RUN_DIR: '/perf/run', AI_PERF_WORKER: String(index), AI_PERF_WORKERS: String(spec.workers), ...c.env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = await runAsync(['run', '-d', '--rm', '--name', container, '--add-host', 'host.docker.internal:host-gateway',
      '--label', `ai-perf.run=${spec.run_id}`, ...mounts, ...envArgs, ...(c.entrypoint ? ['--entrypoint', c.entrypoint] : []), c.image, ...c.args]);
    if (r.status !== 0) {
      // Same signal as a failed local spawn: the barrier sees a stopped worker and ends the run.
      return workers.concat({ id, index, pid: null, container, spawn_error: (r.stderr || r.stdout).trim().slice(0, 300) });
    }
    workers.push({ id, index, pid: null, container });
  }
  return workers;
}

export function isRunning(container) {
  const r = run(['inspect', '-f', '{{.State.Running}}', container]);
  return r.status === 0 && r.stdout.trim() === 'true';
}

export function stopWorker(w) {
  return run(['rm', '-f', w.container]).status === 0;
}
