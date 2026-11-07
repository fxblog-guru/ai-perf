import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { words } from './command.mjs';
import { readStaircase, unitOf } from './breakpoint.mjs';
import { capacityOf } from './verdict.mjs';

// Scalability (perf scale): does a second instance double the throughput? For each instance count,
// a command the project gives deploys that many (`docker compose up -d --scale api={n}`), ai-perf
// waits until the target answers again, runs the capacity staircase and reads the capacity. The
// scaling efficiency of a count n is capacity(n) / ((n / base) × capacity(base)), base being the
// smallest count (1, usually). A capacity no staircase observed is never claimed: a count whose
// steps all held has "at least" its top step, and a load generator that saturated is the limit,
// not the target.

export const SCALE_DEFAULT = { steps: 'scaled', ready_timeout_s: 120, timeout_s: 600 };
// At or above: linear. Below it, a count that adds at most FLAT_GAIN over the count before it is
// flat (nothing gained: a shared bottleneck), anything between is sublinear.
export const LINEAR = 0.8;
export const FLAT_GAIN = 1.1;
const MAX_COUNTS = 8;
const UNIT = { users: 'users', arrival_rps: 'arrivals/s' };

// "1,2,4" or [1, 2, 4]: whole numbers, ascending, at least two. Nothing else ever reaches the
// command, so a count can only be a number.
export function parseInstances(x) {
  const list = Array.isArray(x) ? x.map(String) : typeof x === 'string' ? x.split(',').map((s) => s.trim()) : null;
  if (!list) return { error: 'instances: the counts to measure, e.g. 1,2,4' };
  if (!list.every((s) => /^\d{1,4}$/.test(s) && Number(s) >= 1)) return { error: `instances: whole numbers from 1, comma-separated (got ${list.join(',')})` };
  const n = list.map(Number);
  if (n.length < 2 || n.length > MAX_COUNTS) return { error: `instances: between 2 and ${MAX_COUNTS} counts` };
  if (n.some((v, i) => i && v <= n[i - 1])) return { error: 'instances: ascending, each count above the one before' };
  return { list: n };
}

export function checkScale(m, root) {
  if (!m || typeof m !== 'object') return ['not a JSON object'];
  const errors = [];
  const known = ['name', 'spec', 'instances', 'command', 'steps', 'ready', 'timeout_s'];
  for (const k of Object.keys(m)) if (!known.includes(k)) errors.push(`${k}: unknown key (known: ${known.join(', ')})`);
  if (m.name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(String(m.name))) errors.push('name: lower-case letters, digits and dashes');
  if (typeof m.spec !== 'string' || !existsSync(resolve(root, m.spec))) errors.push('spec: the run spec (a staircase) each count runs, a path from the project root');
  const inst = parseInstances(m.instances);
  if (inst.error) errors.push(inst.error);
  if (typeof m.command !== 'string' || !m.command.trim()) errors.push('command: the command that deploys {n} instances, e.g. docker compose up -d --scale api={n}');
  else { try { words(m.command); } catch (e) { errors.push(`command: ${e.message}`); } }
  if (m.steps !== undefined && !['scaled', 'same'].includes(m.steps)) errors.push('steps: "scaled" (each count climbs the staircase times n / base, the default) or "same"');
  if (m.ready !== undefined) {
    const r = m.ready;
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => !['url', 'timeout_s'].includes(k))) errors.push('ready: { url?, timeout_s? }');
    else {
      if (r.url !== undefined && !/^https?:\/\/[^/\s]+/.test(String(r.url))) errors.push('ready.url: an http(s) URL that answers once the instances are up (default: the spec\'s target_url)');
      if (r.timeout_s !== undefined && !(typeof r.timeout_s === 'number' && r.timeout_s > 0)) errors.push('ready.timeout_s: seconds to wait for the target after scaling, > 0');
    }
  }
  if (m.timeout_s !== undefined && !(typeof m.timeout_s === 'number' && m.timeout_s > 0)) errors.push('timeout_s: seconds before the scale command is killed, > 0');
  return errors;
}

// The staircase a count climbs. "scaled": each step times n / base, so every count is read on the
// same grid relative to what it should carry, and an efficiency compares like with like.
export function scaledSteps(steps, n, base, mode = SCALE_DEFAULT.steps) {
  if (mode === 'same') return [...steps];
  const out = [];
  for (const s of steps) out.push(Math.max(1, Math.round((s * n) / base), (out.at(-1) ?? 0) + 1));
  return out;
}

// Ready: the URL answers below 500 (a 503 while instances start is not ready). Polled until the
// timeout; the time it took is part of the evidence.
export async function waitReady(url, timeoutS, { intervalMs = 250 } = {}) {
  const t0 = Date.now();
  let last = 'no answer';
  for (;;) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      last = `HTTP ${r.status}`;
      if (r.status < 500) return { ready: true, waited_s: Math.round((Date.now() - t0) / 100) / 10, last };
    } catch (e) { last = e.cause?.code ?? e.name; }
    if (Date.now() - t0 > timeoutS * 1000) return { ready: false, waited_s: Math.round((Date.now() - t0) / 100) / 10, last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// One count's staircase: its reading (lib/breakpoint.mjs) and the highest step that held. When the
// generator saturated, only the steps that ended before it did are the target's.
export function readCount(res, slo, stopReason = '') {
  const reading = readStaircase(res, slo, stopReason);
  const unit = unitOf(res);
  const { cap, ok } = capacityOf(res.steps ?? [], slo);
  let held = cap ? cap[unit] : null;
  let rps = cap?.total?.rps ?? null;
  if (reading.kind === 'generator') {
    const sat = Math.min(...(res.problems ?? []).filter((p) => p.kind === 'generator_saturated').map((p) => p.t ?? Infinity));
    let last = null;
    for (const s of res.steps ?? []) { if (ok(s) && (s.to_s ?? Infinity) <= sat) last = s; else break; }
    held = last ? last[unit] : null;
    rps = last?.total?.rps ?? null;
  }
  return { reading, unit, held, rps };
}

const r2 = (x) => Math.round(x * 100) / 100;

// The efficiency and the verdict of every count after the base. points: [{ instances, reading?,
// held, unit, run_id, bottleneck?, why? }] in ascending order; the first is the base.
export function scaling(points) {
  const base = points[0];
  const baseKnown = base?.reading?.kind === 'broke' && base.held > 0;
  const baseWhy = !base?.reading ? `the base count (${base?.instances}) was not measured${base?.why ? `: ${base.why}` : ''}`
    : base.reading.kind === 'held' ? `every step held at ${base.instances} instance(s), so its capacity is only "at least ${base.held}"; add higher steps`
      : base.reading.kind === 'generator' ? `the load generator saturated at ${base.instances} instance(s): its capacity is not the target's`
        : base.reading.kind === 'broke' ? `no step held at ${base.instances} instance(s): its capacity is below the first step`
          : `the base count's run cannot be read: ${base.reading.why}`;
  base.capacity = base.reading ? { value: base.held ?? 0, at_least: base.reading.kind !== 'broke' } : null;
  let prev = baseKnown ? base : null;
  for (const p of points.slice(1)) {
    const k = p.instances / base.instances;
    if (!p.reading) { p.verdict = 'not_measured'; p.why_verdict = p.why ?? 'not run'; continue; }
    const value = p.reading.kind === 'broke' ? p.held ?? 0 : p.held;
    p.capacity = { value: value ?? 0, at_least: p.reading.kind !== 'broke' };
    if (p.reading.kind === 'generator') { p.verdict = 'generator'; p.why_verdict = `the load generator saturated: it, not the target, is the limit at ${p.instances} instance(s); the target held at least ${value ?? 0} ${UNIT[p.unit]}. Add workers or machines and measure this count again`; continue; }
    if (p.reading.kind === 'unjudged') { p.verdict = 'not_measured'; p.why_verdict = p.reading.why; continue; }
    if (!baseKnown) { p.verdict = 'unknown'; p.why_verdict = `no efficiency without the base capacity: ${baseWhy}`; continue; }
    p.efficiency = r2((value ?? 0) / (k * base.held));
    if (p.reading.kind === 'held') {
      // Every step held: the capacity is a floor, so the efficiency is too.
      if (p.efficiency >= LINEAR) { p.verdict = 'linear'; p.why_verdict = `at least ${p.efficiency}: every step held up to ${value} ${UNIT[p.unit]}`; }
      else { p.verdict = 'unknown'; p.efficiency_at_least = true; p.why_verdict = `every step held up to ${value} ${UNIT[p.unit]}, so the capacity is at least that and the efficiency at least ${p.efficiency}; add higher steps to find it`; }
      continue;
    }
    const before = prev;
    prev = value > 0 ? p : prev;
    if (p.efficiency >= LINEAR) { p.verdict = 'linear'; p.why_verdict = `${value} ${UNIT[p.unit]} against ${r2(k * base.held)} for ${k}× the base`; continue; }
    const shared = p.bottleneck?.cause?.length ? `a shared bottleneck: ${p.bottleneck.hint} (${p.bottleneck.evidence})` : `a shared bottleneck no signal named${p.bottleneck?.hint ? ` (${p.bottleneck.hint})` : ''}: add monitor.signals for what the instances share (the database pool, locks, a cache)`;
    if (before && value <= before.held * FLAT_GAIN) {
      p.verdict = 'flat';
      p.why_verdict = `${value} ${UNIT[p.unit]} at ${p.instances} instance(s) against ${before.held} at ${before.instances}: ${value < before.held ? 'less than' : 'no more than'} before; ${shared}`;
    } else {
      p.verdict = 'sublinear';
      p.why_verdict = `${value} ${UNIT[p.unit]} against ${r2(k * base.held)} for ${k}× the base; ${shared}`;
    }
  }
  const rest = points.slice(1);
  const measured = points.filter((p) => p.reading && p.reading.kind !== 'unjudged').length;
  const summary = !baseKnown ? `Scaling cannot be read: ${baseWhy}.`
    : `From ${base.instances} instance(s) at ${base.held} ${UNIT[base.unit]}: ${rest.map((p) => `${p.instances} ${p.verdict}${p.efficiency !== undefined ? ` (${p.efficiency_at_least || (p.verdict === 'linear' && p.reading?.kind === 'held') ? 'at least ' : ''}${p.efficiency})` : ''}`).join(', ')}.`;
  return { base: base.instances, base_known: baseKnown, measured, points, summary };
}

export function renderScale(s) {
  const lines = [`# Scale: ${s.name}`, '', `**${s.summary}**`, '', `Spec \`${s.spec}\`, command \`${s.command}\`, steps ${s.steps}. Efficiency = capacity(n) / ((n / ${s.base}) × capacity(${s.base})); linear at ${LINEAR} or more, flat when a count adds at most ${Math.round((FLAT_GAIN - 1) * 100)} % over the count before it.`, '',
    '| Instances | Steps | Run | Ready | Capacity | rps | Efficiency | Verdict |', '|---|---|---|---|---|---|---|---|'];
  for (const p of s.points) {
    const cap = p.capacity ? `${p.capacity.at_least ? 'at least ' : ''}${p.capacity.value} ${UNIT[p.unit] ?? ''}` : '—';
    lines.push(`| ${p.instances} | ${p.steps?.join(', ') ?? '—'} | ${p.run_id ? `\`${p.run_id}\`` : '—'} | ${p.ready_s ?? '—'} s | ${cap} | ${p.rps ?? '—'} | ${p.efficiency ?? '—'} | ${p === s.points[0] ? 'base' : `${p.verdict}: ${p.why_verdict}`} |`);
  }
  lines.push('');
  for (const p of s.points.filter((x) => x.why)) lines.push(`- ${p.instances} instance(s): ${p.why}`);
  lines.push('');
  return lines.join('\n');
}

export function writeScale(root, slug, s) {
  const base = join(projectDir(root, slug), `scale-${s.name}`);
  writeJson(`${base}.json`, s);
  writeFileSync(`${base}.md`, renderScale(s));
  return `${base}.md`;
}
