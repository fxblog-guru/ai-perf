import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { capacityOf } from './verdict.mjs';

// The breakpoint (perf run --breakpoint): how far past the peak the target goes before it breaks.
// A staircase finds it only when one of its steps breaks; when every step holds, the next run
// climbs on from the last step that held, by `factor`, up to the ceiling the profile sets
// (profile.breakpoint.max: never unbounded). Each run is an ordinary run with its own folder;
// this file reads them. A breakpoint is only ever a step that was measured breaking, next to the
// last one measured holding: what no run observed is never claimed.

export const FACTOR = 1.5;
const UNIT = { users: 'users', arrival_rps: 'arrivals/s' };
// A measured transaction past any of its SLA limits.
const overSla = (e, tx) => Boolean(e?.requests) && (e.p95_ms > tx.sla.p95_ms || e.error_rate > tx.sla.error_rate || (tx.sla.p99_ms !== undefined && e.p99_ms > tx.sla.p99_ms));
export const unitOf = (res) => (res.run.model === 'open' ? 'arrival_rps' : 'users');

// The next staircase: from the last step that held, each step `factor` above the one before (at
// least one more), as many steps as the first staircase had, the last one cut at the ceiling.
// null when the last step already reached it.
export function extendSteps(from, count, { factor = FACTOR, max }) {
  if (!(from < max)) return null;
  const steps = [from];
  while (steps.length < Math.max(2, count)) {
    const next = Math.max(steps.at(-1) + 1, Math.round(steps.at(-1) * factor));
    if (next >= max) { steps.push(max); break; }
    steps.push(next);
  }
  return steps;
}

// What one staircase run says: `broke` (a step measured past its SLA, or where the target broke
// under load), `held` (every step within the SLA), `generator` (the load generator was the limit:
// nothing about the target), or `unjudged` (the run ended another way, a planned transaction was
// not measured in the step that would have broken, or the verdict found the plan unfinished).
const GATE = /^NOT_EVALUABLE: the (plan|model|env|data) gate fails/;
export function readStaircase(res, slo, stopReason = '', verdict = null) {
  const unit = unitOf(res);
  // Read against a plan that fails its own gates, a step means nothing either way.
  const gate = (verdict?.reasons ?? []).find((r) => GATE.test(r));
  if (gate) return { kind: 'unjudged', why: gate.replace(/^NOT_EVALUABLE: /, '') };
  if ((res.problems ?? []).some((p) => p.kind === 'generator_saturated') || res.workers?.some((w) => w.saturated)) {
    return { kind: 'generator', why: 'the load generator saturated: the steps above where it did measure the generator, not the target' };
  }
  const targetBroke = res.run_state === 'aborted' && /^auto_stop:(error_rate|target_cpu_pct|target_gone)$/.test(stopReason);
  if (!res.steps?.length) return { kind: 'unjudged', why: 'not a staircase' };
  if (res.run_state !== 'done' && !targetBroke) return { kind: 'unjudged', why: `the run ended ${res.run_state}${stopReason ? ` (${stopReason})` : ''}: no step can be read as held or broken` };
  const { cap, ok } = capacityOf(res.steps, slo);
  const bad = res.steps.find((s) => !ok(s));
  const held = cap ? cap[unit] : null;
  if (bad && !bad.complete && !targetBroke) return { kind: 'unjudged', why: `step ${bad.index + 1} (${bad[unit]} ${UNIT[unit]}) was not completed` };
  // Stopped on errors or CPU after every step held: the break came after the staircase, at a load
  // no step measured.
  if (!bad && targetBroke) return { kind: 'unjudged', why: `the run auto-stopped (${stopReason}) after its last step held: where it broke was not measured` };
  if (!bad) return { kind: 'held', held, unit };
  // A planned transaction with no requests in the step is not a break: nothing was measured.
  const missing = slo.transactions.filter((tx) => !bad.endpoints?.[tx.name]?.requests).map((tx) => tx.name);
  if (bad.complete && missing.length && !slo.transactions.some((tx) => overSla(bad.endpoints?.[tx.name], tx))) {
    return { kind: 'unjudged', why: `step ${bad.index + 1} (${bad[unit]} ${UNIT[unit]}) did not measure ${missing.join(', ')}: neither held nor broken` };
  }
  // Why it broke, with the numbers: the transactions past their SLA, or the auto-stop.
  const why = bad.complete
    ? slo.transactions.map((tx) => {
      const e = bad.endpoints?.[tx.name];
      if (!e) return `${tx.name} not measured`;
      const over = [e.p95_ms > tx.sla.p95_ms && `p95 ${e.p95_ms} > SLA ${tx.sla.p95_ms} ms`, e.error_rate > tx.sla.error_rate && `error rate ${e.error_rate} > SLA ${tx.sla.error_rate}`, tx.sla.p99_ms !== undefined && e.p99_ms > tx.sla.p99_ms && `p99 ${e.p99_ms} > SLA ${tx.sla.p99_ms} ms`].filter(Boolean);
      return over.length ? `${tx.name} ${over.join(', ')}` : null;
    }).filter(Boolean).join('; ')
    : `the run auto-stopped (${stopReason}) during the step`;
  return { kind: 'broke', held, broke: bad[unit], why, unit };
}

// The search so far, from each run's reading in order: the breakpoint is the first step seen
// breaking, beside the highest step seen holding below it (in that run, or an earlier one).
export function breakpointOf(runs) {
  let held = null;
  for (const r of runs) {
    if (r.reading.kind === 'broke') {
      if (r.reading.held !== null) held = { value: r.reading.held, run: r.run_id };
      const broke = { value: r.reading.broke, run: r.run_id, why: r.reading.why };
      // A load that held in one run and broke in the next: the edge, or the environment's noise.
      return { found: true, unit: r.reading.unit, held, broke, ...(held && broke.value <= held.value ? { unstable: true } : {}) };
    }
    if (r.reading.kind === 'held') held = { value: r.reading.held, run: r.run_id };
    else break;
  }
  return { found: false, unit: runs.find((r) => r.reading.unit)?.reading.unit ?? null, held, broke: null };
}

export function renderBreakpoint(b) {
  const u = UNIT[b.unit] ?? '';
  const lines = ['# Breakpoint', '', b.summary, '', '| Run | Steps | Reading | Verdict |', '|---|---|---|---|'];
  for (const r of b.runs) lines.push(`| \`${r.run_id}\` | ${r.steps.join(', ')} | ${r.reading.kind}${r.reading.kind === 'broke' ? ` at ${r.reading.broke}` : r.reading.kind === 'held' ? ` up to ${r.reading.held}` : `: ${r.reading.why}`} | ${r.outcome} |`);
  lines.push('', `Stopped: ${b.stopped}.`, '');
  if (b.found) lines.push(`Last step that held: ${b.held ? `${b.held.value} ${u} (run \`${b.held.run}\`)` : 'none: the first step measured already broke'}. First step that broke: ${b.broke.value} ${u} (run \`${b.broke.run}\`): ${b.broke.why}.`, '');
  return lines.join('\n');
}

export function writeBreakpoint(root, slug, b) {
  writeJson(join(projectDir(root, slug), 'breakpoint.json'), b);
  writeFileSync(join(projectDir(root, slug), 'breakpoint.md'), renderBreakpoint(b));
}

// One sentence: what was observed, and nothing more.
export function summarizeBreakpoint(b) {
  const u = UNIT[b.unit] ?? '';
  if (b.found && b.unstable) return `It is at its edge at ${b.broke.value} ${u}: that load held in run ${b.held.run} and broke in run ${b.broke.run}; repeat the run before trusting either.`;
  if (b.found) return b.held
    ? `It breaks between ${b.held.value} and ${b.broke.value} ${u}: ${b.held.value} held (run ${b.held.run}), ${b.broke.value} broke (run ${b.broke.run}).`
    : `It broke at the first step measured, ${b.broke.value} ${u} (run ${b.broke.run}); no step below it was seen holding.`;
  const at = b.held ? `it held ${b.held.value} ${u} (run ${b.held.run})` : 'no step was seen holding';
  if (b.limit === 'generator') return `No breakpoint found: the load generator, not the target, was the limit; ${at}. Add workers (or machines) and search again.`;
  if (b.limit === 'ceiling') return `No breakpoint found below the ceiling of ${b.max} ${u}: ${at}.`;
  if (b.limit === 'runs') return `No breakpoint found in ${b.runs.length} run(s): ${at}; search again with more runs (--max-runs) or a larger factor.`;
  return `No breakpoint found: ${b.stopped}; ${at}.`;
}
