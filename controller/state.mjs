export const PHASES = ['warmup', 'ramp', 'steady', 'rampdown'];
export const TERMINAL = ['done', 'degraded', 'not_evaluable', 'aborted'];

const NEXT = {
  preparing: ['warmup', 'collecting'],
  warmup: ['ramp', 'collecting'],
  ramp: ['steady', 'collecting'],
  steady: ['rampdown', 'collecting'],
  rampdown: ['collecting'],
  collecting: TERMINAL,
};

export function create(fields) {
  const at = new Date().toISOString();
  return { schema: 'perf-state/v1', state: 'preparing', history: [{ state: 'preparing', at }], ...fields };
}

export function transition(s, to) {
  if (!NEXT[s.state]?.includes(to)) throw new Error(`illegal transition ${s.state} -> ${to}`);
  s.state = to;
  s.history.push({ state: to, at: new Date().toISOString() });
  return s;
}

export const isTerminal = (s) => TERMINAL.includes(s?.state);

// A lost worker is a degraded run; a saturated generator or no measured window means the numbers
// describe the tool, not the target, so the run cannot be judged. Abort outranks both.
export function finalState({ stopReason, saturated, measured, lostWorkers, unmonitored = false }) {
  if (stopReason) return 'aborted';
  if (saturated || !measured) return 'not_evaluable';
  if (lostWorkers > 0 || unmonitored) return 'degraded';
  return 'done';
}
