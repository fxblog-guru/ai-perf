import { fileURLToPath } from 'node:url';

// Deterministic synthetic load: no network, scripted latency, errors and faults. Every controller
// test runs on it, so the controller is proven without a real target.
export const name = 'fake';
export const tool = 'other';
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export function detect() {
  return { ok: true, version: '1' };
}

// Pinned, and already present on most machines that run Node in Docker.
export function containerCommand({ index }) {
  return { image: 'node:22-alpine', args: ['node', '/ai-perf/adapters/engines/fake/worker.mjs', '/perf/run', String(index)] };
}

// options.spawn_fail points the command at a missing binary, to test a worker that cannot start.
export function workerCommand({ runDir, index, options = {} }) {
  const cmd = options.spawn_fail ? `${process.execPath}-missing` : process.execPath;
  return { cmd, args: [WORKER, runDir, String(index)] };
}
