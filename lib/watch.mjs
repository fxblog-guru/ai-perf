import { join } from 'node:path';
import { readEvents } from '../controller/events.mjs';
import { readJson, sleep, writeJson } from '../controller/files.mjs';
import { describe } from './runs.mjs';

// `perf watch`: blocks until something worth the AI's attention happens (design §7.4), so the AI
// is woken by events, not by polling. Info events (phase changes) are passed along with the next
// wake, never wake it on their own. Past the wake budget per hour, non-critical events wait for
// the next batch; critical ones always wake.
export const CRITICAL = new Set(['auto_stopped', 'run_finished', 'worker_lost']);
const DEFAULT_WAKES_PER_HOUR = 12;

export async function watch(runDir, { since = 0, timeoutS = 3600, now = () => Date.now(), pollMs = 500 } = {}) {
  const spec = readJson(join(runDir, 'run.json'));
  const budget = spec?.watch?.max_wakes_per_hour ?? DEFAULT_WAKES_PER_HOUR;
  const wakesPath = join(runDir, 'watch-wakes.json');
  const end = now() + timeoutS * 1000;
  for (;;) {
    const all = readEvents(runDir);
    const fresh = all.slice(since);
    const wakes = (readJson(wakesPath) ?? []).filter((t) => now() - t < 3600_000);
    const critical = fresh.some((e) => CRITICAL.has(e.type));
    const notable = fresh.some((e) => e.severity !== 'info');
    const lost = describe(runDir).controller === 'lost';
    if (critical || lost || (notable && wakes.length < budget)) {
      writeJson(wakesPath, [...wakes, now()]);
      return { events: fresh, next: all.length, reason: lost ? 'controller lost' : critical ? 'critical event' : 'notable event' };
    }
    if (now() > end) return { events: fresh, next: all.length, reason: notable ? 'wake budget spent; batched' : 'timeout, nothing notable' };
    await sleep(pollMs);
  }
}
