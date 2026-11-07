import { fileURLToPath } from 'node:url';

// WebSocket as an ai-perf engine, built on the worker kit (adapters/engines/kit.mjs): one virtual
// user is one player with a session, running the product's player script (CONTRACTS §3a). It
// needs nothing but Node: WebSocket is built into Node 22 and later.
export const name = 'ws';
export const tool = 'other';
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export function detect() {
  const major = Number(process.versions.node.split('.')[0]);
  return typeof WebSocket === 'function'
    ? { ok: true, version: `node ${process.versions.node}` }
    : { ok: false, install: `Node 22 or later (this is ${major}): the ws engine uses Node's built-in WebSocket` };
}

export function workerCommand({ runDir, index, spec }) {
  return { cmd: process.execPath, args: [WORKER, runDir, String(index)], env: { AI_PERF_WORKER: String(index), AI_PERF_WORKERS: String(spec.workers) } };
}

// Pinned; the player script's folder is mounted at /perf/script by the docker target.
export function containerCommand({ index, spec }) {
  // The target as the container reaches it (host.docker.internal); run.json keeps the original.
  return { image: 'node:22-alpine', args: ['node', '/ai-perf/adapters/engines/ws/worker.mjs', '/perf/run', String(index), `/perf/script/${spec.script_path.split(/[\\/]/).pop()}`], env: { AI_PERF_TARGET_URL: spec.target_url } };
}
