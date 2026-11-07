import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, readJson } from '../controller/files.mjs';
import { readEvents } from '../controller/events.mjs';
import { isTerminal } from '../controller/state.mjs';
import { workerAlive } from './workers.mjs';

export const perfRoot = (root) => join(root, '.perf');

const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

// Run ids start with a sortable timestamp, so name order is time order.
export function listRuns(root, slug) {
  const slugs = slug ? [slug] : dirs(perfRoot(root));
  return slugs.flatMap((s) => dirs(join(perfRoot(root), s, 'runs')).map((id) => ({ slug: s, id, dir: join(perfRoot(root), s, 'runs', id) })))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function findRun(root, { slug, run } = {}) {
  const runs = listRuns(root, slug);
  return run ? runs.find((r) => r.id === run) : runs[runs.length - 1];
}

// The controller is alive when its pid exists and it wrote state within its heartbeat timeout.
// A controller gets this long to write its first state.json before a dead pid means it is lost.
export const START_GRACE_MS = 5000;

function pidFile(dir) {
  try {
    const p = join(dir, 'controller.pid');
    return { pid: Number(readFileSync(p, 'utf8').trim()), at: statSync(p).mtimeMs };
  } catch { return null; }
}

export function describe(dir, now = Date.now()) {
  const state = readJson(join(dir, 'state.json'));
  const spec = readJson(join(dir, 'run.json')) ?? {};
  if (!state) {
    // `perf run` writes run.json, then starts the controller, then writes its pid: until the pid
    // file exists the folder's own age is the clock.
    const pf = pidFile(dir);
    let born = now;
    try { born = statSync(dir).mtimeMs; } catch { /* gone */ }
    const lost = pf ? !isAlive(pf.pid) && now - pf.at > START_GRACE_MS : now - born > START_GRACE_MS;
    return {
      dir, run_id: spec.run_id, slug: spec.slug, state: 'unknown', controller: lost ? 'lost' : 'starting',
      pid: pf?.pid ?? null, t: null, stop_reason: null, workers: [], last_events: [],
      problems: lost ? [{ kind: 'controller_never_started', detail: 'the controller exited before writing state.json' }] : [],
    };
  }
  const terminal = isTerminal(state);
  // Collecting reads every window file; on a long run that can stall beats despite the progress
  // callback, so a living pid gets three timeouts there before it is called lost.
  const timeoutMs = (state.heartbeat_timeout_s ?? 10) * 1000 * (state.state === 'collecting' ? 3 : 1);
  const fresh = now - state.heartbeat_at < timeoutMs;
  const controller = terminal ? 'finished' : fresh && isAlive(state.pid) ? 'alive' : 'lost';
  const workers = (state.workers ?? []).map((w) => {
    const s = readJson(join(dir, 'raw', w.id, 'status.json'));
    const reporting = s && s.state !== 'stopped' && now - s.ts < (spec.timing?.worker_timeout_s ?? 10) * 1000;
    // Liveness costs a docker call per container, so it is only asked when the controller is gone.
    return { id: w.id, pid: w.pid, container: w.container, state: s?.state ?? 'unknown', reason: s?.reason ?? null, reporting: Boolean(reporting), alive: controller === 'lost' ? workerAlive(w) : null };
  });
  const events = readEvents(dir);
  return {
    dir, run_id: state.run_id, slug: state.slug, state: state.state, controller, pid: state.pid,
    t: state.go_at ? Math.round((now - state.go_at) / 100) / 10 : null,
    stop_reason: state.stop_reason, problems: state.problems ?? [], workers,
    last_events: events.slice(-5),
  };
}
