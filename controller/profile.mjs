import { PHASES } from './state.mjs';

export function bounds(p) {
  const b = {};
  let at = 0;
  for (const ph of PHASES) {
    b[ph] = { from: at, to: at + (p[`${ph}_s`] ?? 0) };
    at = b[ph].to;
  }
  b.end = at;
  return b;
}

// Windows are laid so one starts exactly where steady starts; otherwise a warmup that is not a
// multiple of window_s would cost up to two windows of the measured phase. The origin is <= 0, so
// every t >= 0 has a window index k >= 0.
// A stepped profile (stress, capacity): steady is a staircase of `steps` (users, or arrivals per
// second for an open profile), each held `step_s`. Step i covers [steady.from + i·step_s, +step_s).
export function stepAt(t, p) {
  if (!p.steps?.length) return null;
  const b = bounds(p);
  if (t < b.steady.from || t >= b.steady.to) return null;
  return Math.min(p.steps.length - 1, Math.floor((t - b.steady.from) / p.step_s + 1e-9));
}
export function stepBounds(p) {
  const from = bounds(p).steady.from;
  return (p.steps ?? []).map((value, i) => ({ index: i, value, from: from + i * p.step_s, to: from + (i + 1) * p.step_s }));
}
const rampTarget = (p, top) => (p.steps?.length ? p.steps[0] : top);
const steadyValue = (t, p, top) => (p.steps?.length ? p.steps[stepAt(t, p) ?? p.steps.length - 1] : top);
// A spike (spike profile): { users | arrival_rps, at_s, for_s } inside steady.
export function spikeBounds(p) {
  if (!p.spike) return null;
  const from = bounds(p).steady.from + p.spike.at_s;
  return { from, to: from + p.spike.for_s };
}
const inSpike = (t, p) => { const s = spikeBounds(p); return Boolean(s && t >= s.from && t < s.to); };

export function windowOrigin(p, windowS) {
  const from = bounds(p).steady.from;
  return from - windowS * Math.ceil(from / windowS - 1e-9);
}

export function windowIndex(t, p, windowS) {
  return Math.floor((t - windowOrigin(p, windowS)) / windowS + 1e-9);
}

// A zero-length phase is skipped: t < to never holds for it.
export function phaseAt(t, p) {
  const b = bounds(p);
  for (const ph of PHASES) if (t < b[ph].to) return ph;
  return 'end';
}

export function warmupUsers(p) {
  return p.warmup_users ?? Math.max(1, Math.ceil(p.users * 0.1));
}

// The open model (arrival rate, PS-B5): new requests or iterations start at this rate whatever the
// server does, the way internet traffic arrives. Same shape as users: a warmup rate, a linear ramp,
// steady, a rampdown. null for a closed profile.
export function arrivalAt(t, p) {
  if (!p.arrival_rps) return null;
  const b = bounds(p);
  const low = p.warmup_rps ?? Math.max(1, p.arrival_rps * 0.1);
  const frac = (ph) => (t - b[ph].from) / (b[ph].to - b[ph].from);
  switch (phaseAt(t, p)) {
    case 'warmup': return low;
    case 'ramp': return low + (rampTarget(p, p.arrival_rps) - low) * frac('ramp');
    case 'steady': return inSpike(t, p) ? p.spike.arrival_rps ?? p.arrival_rps : steadyValue(t, p, p.arrival_rps);
    case 'rampdown': return steadyValue(b.steady.to - 1e-9, p, p.arrival_rps) * (1 - frac('rampdown'));
    default: return 0;
  }
}

export function usersAt(t, p) {
  const b = bounds(p);
  const low = warmupUsers(p);
  const frac = (ph) => (t - b[ph].from) / (b[ph].to - b[ph].from);
  // An open profile's users are its VU cap, constant; a closed stepped profile climbs its steps.
  const stepped = p.steps?.length && !p.arrival_rps;
  switch (phaseAt(t, p)) {
    case 'warmup': return low;
    case 'ramp': return low + ((stepped ? p.steps[0] : p.users) - low) * frac('ramp');
    case 'steady': return !p.arrival_rps && inSpike(t, p) ? p.spike.users : stepped ? steadyValue(t, p, p.users) : p.users;
    case 'rampdown': return (stepped ? p.steps.at(-1) : p.users) * (1 - frac('rampdown'));
    default: return 0;
  }
}
