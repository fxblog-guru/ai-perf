import { join } from 'node:path';
import { appendLine, readLines } from './files.mjs';

// The AI is woken by these and nothing else; a new type is a MINOR contract change.
export const EVENT_TYPES = [
  'phase_changed', 'slo_breach', 'new_error_class', 'anomaly',
  'generator_saturated', 'worker_lost', 'auto_stopped', 'cleanup', 'run_finished',
];

export function emit(runDir, { t = null, type, severity = 'info', summary, data = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type: ${type}`);
  appendLine(join(runDir, 'events.ndjson'), { ts: new Date().toISOString(), t, type, severity, summary, data });
}

export const readEvents = (runDir) => readLines(join(runDir, 'events.ndjson'));
