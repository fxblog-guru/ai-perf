import { isAlive } from '../controller/files.mjs';
import { isRunning, stopWorker as stopContainer } from '../adapters/targets/docker.mjs';

// One answer to "is this worker still running?" for every target: a container is asked by name,
// a process by pid.
// A remote worker (ssh, k8s) cannot be asked or killed from here: nothing local is it.
export const workerAlive = (w) => (w.remote ? false : w.container ? isRunning(w.container) : isAlive(w.pid));

export function killWorker(w) {
  if (w.container) return stopContainer(w);
  try { process.kill(w.pid); return true; } catch { return false; }
}

// A sidecar worker (k6) runs the engine as its child and names it in status.json `child`. Killing
// the sidecar alone would leave the engine loading the target, so the child goes too.
export const childAlive = (child) => Boolean(child) && (child.container ? isRunning(child.container) : isAlive(child.pid));

export function killChild(child) {
  if (!child) return false;
  if (child.container) return stopContainer({ container: child.container });
  try { process.kill(child.pid); return true; } catch { return false; }
}
