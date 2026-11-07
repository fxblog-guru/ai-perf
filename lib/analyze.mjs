import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, readLines, writeJson } from '../controller/files.mjs';
import { create, merge, percentile, round } from '../controller/hist.mjs';
import { readWindows } from '../controller/merge.mjs';
import { arrivalAt, phaseAt, usersAt } from '../controller/profile.mjs';
import { KINDS, limitOf } from '../adapters/metrics/signals.mjs';

// /perf-analyze, deterministic part: the timeline, failures by cause, and where the bottleneck
// probably is. The AI reads this and explains it; it does not recompute it.

// Failure categories (design §5.1 step 8). The category decides who acts on it.
export function categorize(cls) {
  const m = String(cls).match(/^HTTP (\d{3})$/);
  if (m) {
    const code = Number(m[1]);
    if (code === 429 || code === 503) return 'app: overloaded (throttling or unavailable)';
    if (code >= 500) return 'app: server error';
    if ([400, 401, 403, 404, 409, 422].includes(code)) return 'data or script: the request itself is wrong';
    return 'app: unexpected status';
  }
  if (/timeout|timed out/i.test(cls)) return 'network or app: timeout';
  if (/connect|refused|reset|dns|resolve|unreachable/i.test(cls)) return 'network: connection';
  if (/injected/i.test(cls)) return 'app: server error';
  return 'unknown: read the samples';
}

export function timeline(runDir, spec) {
  const byWindow = new Map();
  for (const w of readWindows(runDir)) {
    const k = w.window;
    const acc = byWindow.get(k) ?? { start: (w.origin_s ?? 0) + k * w.window_s, window_s: w.window_s, requests: 0, failures: 0, hist: create() };
    for (const e of Object.values(w.endpoints)) { acc.requests += e.requests; acc.failures += e.failures; merge(acc.hist, e.hist); }
    byWindow.set(k, acc);
  }
  return [...byWindow.values()].sort((a, b) => a.start - b.start).map((a) => ({
    t: round(a.start), phase: phaseAt(a.start + 1e-6, spec.profile),
    // The offered load mid-window: users (closed) or arrivals per second (open).
    load: round((spec.profile.arrival_rps ? arrivalAt : usersAt)(a.start + a.window_s / 2, spec.profile)),
    rps: round(a.requests / a.window_s), p95_ms: percentile(a.hist, 0.95), error_rate: a.requests ? round(a.failures / a.requests * 10000) / 10000 : 0,
  }));
}

// What the samples can show: a correlation id lets the failure be found in the server's logs. An
// engine that records none (k6, an in-house engine that does not pass one) is said so, never
// claimed to have them.
export function evidenceOf(s) {
  if (!s.length) return 'cause not established: no sampled request';
  const ids = s.filter((x) => x.correlation_id).length;
  if (ids === s.length) return `${s.length} sampled request(s) with correlation ids`;
  if (ids) return `${s.length} sampled request(s), ${ids} with a correlation id`;
  return `${s.length} sampled request(s), none with a correlation id: the engine records none. Send an X-Request-ID header from the script (Locust records the one the server answers with; the worker kit takes record(..., { correlation_id })) to find them in the server's logs`;
}

function failures(runDir, state) {
  const counts = {};
  for (const w of state.workers ?? []) {
    const s = readJson(join(runDir, 'raw', w.id, 'status.json'));
    for (const [cls, n] of Object.entries(s?.error_classes ?? {})) counts[cls] = (counts[cls] ?? 0) + n;
  }
  const samples = {};
  let dirs = [];
  try { dirs = readdirSync(join(runDir, 'raw')); } catch { /* none */ }
  for (const d of dirs) for (const e of readLines(join(runDir, 'raw', d, 'errors.ndjson'))) (samples[e.class] ??= []).push(e);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([cls, count]) => {
    const s = (samples[cls] ?? []).sort((a, b) => a.t - b.t);
    return {
      class: cls, category: categorize(cls), count, first_t: s[0]?.t ?? null,
      operations: [...new Set(s.map((x) => x.name))],
      samples: s.slice(0, 3),
      evidence: evidenceOf(s),
    };
  });
}

// The target's own signals (monitor.signals) over the loaded windows: each one's highest value,
// its limit, and when it first went above it. `defs` are the signals as planned, so one that
// never answered is listed as unread, never as quiet.
export function signalSummary(tl, samples, defs = []) {
  const loaded = tl.filter((w) => w.phase === 'steady' || w.phase === 'ramp');
  if (!defs.length) return [];
  const from = loaded[0]?.t ?? 0;
  const to = loaded.length ? loaded.at(-1).t + (loaded.length > 1 ? loaded[1].t - loaded[0].t : 10) : Infinity;
  return defs.map((d) => {
    const own = samples.filter((s) => s.name === 'signal' && s.labels?.signal === d.name && s.t >= from && s.t <= to);
    const above = limitOf(d);
    if (!own.length) return { name: d.name, kind: d.kind, above, read: false };
    const over = own.find((s) => s.value > above);
    return { name: d.name, kind: d.kind, unit: own[0].unit, above, read: true, max: Math.max(...own.map((s) => s.value)), first_over_t: over ? over.t : null };
  });
}

const reading = (value, unit) => `${value}${unit ? ` ${unit}` : ''}`;

// The signals around a time: the window that broke, padded by one sampling interval on each side
// so a reading taken just before or after it counts. A signal over its limit there is the cause
// only if it got there with the load: under its limit earlier in the loaded run, or higher now than
// it ever was before. One over its limit all along (a lock held since the start) did not make
// latency break at this load: it is "already over", never the cause.
function signalsAt(t, span, samples, defs, pad, from) {
  const cause = [];
  const already = [];
  const quiet = [];
  for (const d of defs) {
    const own = samples.filter((s) => s.name === 'signal' && s.labels?.signal === d.name);
    const near = own.filter((s) => s.t >= t - pad && s.t <= t + span + pad);
    if (!near.length) continue;
    const top = Math.max(...near.map((s) => s.value));
    if (top <= limitOf(d)) { quiet.push(d); continue; }
    const before = own.filter((s) => s.t >= from && s.t < t - pad).map((s) => s.value);
    const rose = !before.length || Math.min(...before) <= limitOf(d) || top > Math.max(...before);
    (rose ? cause : already).push({ d, top, unit: near[0].unit });
  }
  return { cause, already, quiet };
}

// The knee: the first measured window whose p95 is more than twice the run's early steady p95
// while throughput no longer grows, where the offered load has just grown (into this window or
// the one before). Latency that rises at constant load (a soak's drift, a slow dependency) is not
// a knee: more load did not cause it. A symptom → likely-bottleneck read follows (references/bottlenecks.md).
export function bottleneck(tl, problems, targetCpu, targetCores = [], signals = [], defs = [], pad = 5) {
  if (problems.some((p) => p.kind === 'generator_saturated')) return { hint: 'load generator: its CPU was saturated, so the numbers describe the tool', evidence: 'generator_saturated' };
  const loaded = tl.filter((w) => w.phase === 'steady' || w.phase === 'ramp');
  const base = loaded.find((w) => w.p95_ms !== null)?.p95_ms;
  if (!base) return null;
  const grew = (i) => [i, i - 1].some((j) => j > 0 && loaded[j].load > loaded[j - 1].load * 1.01);
  const knee = loaded.find((w, i) => i > 0 && w.p95_ms > 2 * base && w.rps <= loaded[i - 1].rps * 1.05 && grew(i));
  if (!knee) return null;
  const near = targetCpu.filter((s) => s.t >= knee.t - 5 && s.t <= knee.t + 5);
  const cpu = near.map((s) => s.value);
  const hot = near.filter((s) => s.value > 85);
  // Name what was watched: a quiet database says nothing about an app server nobody monitored
  // (dogfood on fx-blog: only Postgres was monitored, and "the target is waiting" overclaimed).
  const watched = [...new Set(near.map((s) => s.labels?.container).filter(Boolean))].join(', ') || 'the target';
  // A share far below 85 % can still be one core pegged: a single-threaded part (an event loop, a
  // Redis) is CPU-bound at 1 core whatever the machine has.
  const pegged = targetCores.filter((s) => s.t >= knee.t - 5 && s.t <= knee.t + 5 && s.value >= 0.9);
  const loadedSpan = loaded.length > 1 ? loaded[1].t - loaded[0].t : 10;
  const sig = signalsAt(knee.t, loadedSpan, signals, defs, pad, loaded[0].t);
  // Signals read at the knee and under their limits rule their causes out, by name; one over its
  // limit since before the load grew is said, and is not the cause.
  const ruled = `${sig.quiet.length ? `; under their limits then: ${sig.quiet.map((d) => d.name).join(', ')}` : ''}${sig.already.length ? `; over their limits before latency broke, so not its cause: ${sig.already.map((h) => `${h.d.name} ${reading(h.top, h.unit)} > ${limitOf(h.d)}`).join(', ')}` : ''}`;
  const evidence = `p95 ${base} -> ${knee.p95_ms} ms at t=${knee.t}s, rps flat at ${knee.rps}${cpu.length ? `, CPU max ${Math.max(...cpu)} % (${watched})` : ''}`;
  // A signal that rose over its limit when latency broke is evidence, not a guess: it names the wait.
  if (sig.cause.length) {
    return {
      t: knee.t, cause: sig.cause.map((h) => h.d.kind),
      hint: `waiting on ${sig.cause.map((h) => `${h.d.name}: ${KINDS[h.d.kind].means}`).join('; ')}${hot.length ? `; the CPU of ${[...new Set(hot.map((s) => s.labels?.container).filter(Boolean))].join(', ') || 'the target'} was also above 85 %` : ''}`,
      evidence: `${evidence}, ${sig.cause.map((h) => `${h.d.name} ${reading(h.top, h.unit)} > ${limitOf(h.d)}`).join(', ')}${ruled}`,
    };
  }
  return {
    t: knee.t,
    hint: !cpu.length ? 'latency more than doubled while throughput stopped growing; target not monitored, so the resource is unknown'
      : !hot.length && pegged.length ? `maybe CPU-bound on one thread: ${[...new Set(pegged.map((s) => s.labels?.container).filter(Boolean))].join(', ') || 'the target'} had about ${Math.max(...pegged.map((s) => s.value))} cores busy while its share stayed under 85 %. A single-threaded part (an event loop, a Redis) is saturated at one core; otherwise the wait is in a pool, locks or I/O`
      : hot.length ? `CPU-bound: ${[...new Set(hot.map((s) => s.labels?.container).filter(Boolean))].join(', ') || 'the target'} above 85 % when latency broke`
        : `not CPU in ${watched}: it stayed under 85 % while latency rose. The wait is in a pool, locks, a slow dependency or I/O, or in a part that was not monitored (the app server?)`,
    evidence: `${evidence}${ruled}`,
  };
}

export function analyze(runDir) {
  const spec = readJson(join(runDir, 'run.json'));
  const state = readJson(join(runDir, 'state.json'));
  const res = readJson(join(runDir, 'result.json'));
  const tl = timeline(runDir, spec);
  const targetSamples = readLines(join(runDir, 'monitor', 'target.ndjson'));
  const targetCpu = targetSamples.filter((s) => s.name === 'target_cpu_pct');
  const targetCores = targetSamples.filter((s) => s.name === 'target_cpu_cores');
  const signals = targetSamples.filter((s) => s.name === 'signal');
  const defs = spec.monitor?.signals ?? [];
  const a = {
    run_id: spec.run_id, run_state: res?.run_state ?? state.state, timeline: tl,
    failures: failures(runDir, state), bottleneck: bottleneck(tl, state.problems ?? [], targetCpu, targetCores, signals, defs, spec.monitor?.interval_s ?? 5),
    signals: signalSummary(tl, signals, defs),
    problems: state.problems ?? [], target_monitored: targetCpu.length > 0,
  };
  writeJson(join(runDir, 'analysis.json'), a);
  writeFileSync(join(runDir, 'analysis.md'), renderAnalysis(a));
  return a;
}

export function renderAnalysis(a) {
  const lines = [`# Analysis of ${a.run_id} (${a.run_state})`, ''];
  lines.push('## Bottleneck', '', a.bottleneck ? `${a.bottleneck.hint}. Evidence: ${a.bottleneck.evidence}.` : 'No knee found: latency did not break while load grew.', '');
  if (a.signals?.length) {
    lines.push('## Signals', '', '| Signal | Kind | Highest | Limit | First above |', '|---|---|---|---|---|');
    for (const s of a.signals) lines.push(s.read ? `| ${s.name} | ${s.kind} | ${reading(s.max, s.unit)} | ${s.above} | ${s.first_over_t === null ? 'never' : `t=${s.first_over_t}s`} |` : `| ${s.name} | ${s.kind} | no sample | ${s.above} | - |`);
    lines.push('');
  }
  lines.push('## Failures', '');
  if (!a.failures.length) lines.push('None.', '');
  else lines.push('| Class | Category | Count | First at | Evidence |', '|---|---|---|---|---|', ...a.failures.map((f) => `| ${f.class} | ${f.category} | ${f.count} | ${f.first_t ?? '-'} s | ${f.evidence} |`), '');
  if (a.problems.length) lines.push('## Run problems', '', ...a.problems.map((p) => `- ${p.kind}: ${p.detail}`), '');
  lines.push('## Timeline', '', '| t (s) | phase | rps | p95 ms | error rate |', '|---|---|---|---|---|', ...a.timeline.map((w) => `| ${w.t} | ${w.phase} | ${w.rps} | ${w.p95_ms ?? '-'} | ${w.error_rate} |`), '');
  if (!a.target_monitored) lines.push('Target not monitored: add a metrics source in env.json to tell CPU-bound from waiting.', '');
  return lines.join('\n');
}
