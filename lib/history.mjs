import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { listRuns } from './runs.mjs';
import { REGRESSION, compareBaseline, sameBuild } from './verdict.mjs';
import { theilSen } from './stats.mjs';

// /perf-compare and /perf-trend (design §12): runs side by side, and results across releases.
// Both compare like with like only, by the same rule as the baseline (another environment,
// profile, load tool, target or user count is refused), and read only runs that ended done.

const pct = (a, b) => (a ? Math.round(((b - a) / a) * 1000) / 10 : null);

export function compareRuns(dirA, dirB) {
  const a = readJson(join(dirA, 'result.json'));
  const b = readJson(join(dirB, 'result.json'));
  if (!a || !b) return { refused: `no result.json in ${!a ? dirA : dirB}` };
  for (const r of [a, b]) if (r.run_state !== 'done') return { refused: `run ${r.run.id} ended ${r.run_state}; only a done run is compared` };
  const c = compareBaseline(b, a);
  if (c.refused) return { a: a.run.id, b: b.run.id, refused: c.refused };
  const names = [...new Set([...Object.keys(a.endpoints), ...Object.keys(b.endpoints)])].sort();
  const rows = names.map((name) => {
    const x = a.endpoints[name];
    const y = b.endpoints[name];
    return { name, a_p95_ms: x?.p95_ms ?? null, b_p95_ms: y?.p95_ms ?? null, p95_change_pct: x && y ? pct(x.p95_ms, y.p95_ms) : null,
      a_error_rate: x?.error_rate ?? null, b_error_rate: y?.error_rate ?? null, a_requests: x?.requests ?? 0, b_requests: y?.requests ?? 0 };
  });
  return {
    a: a.run.id, b: b.run.id, rows,
    total: { a_rps: a.total.rps, b_rps: b.total.rps, rps_change_pct: pct(a.total.rps, b.total.rps), a_p95_ms: a.total.p95_ms, b_p95_ms: b.total.p95_ms },
    regressions: c.regressions, scope: c.scope, not_compared: c.not_compared,
    same_build: sameBuild(a, b),
  };
}

export function renderCompare(c) {
  if (c.refused) return `# Compare\n\nNot compared: ${c.refused}\n`;
  const lines = [`# Compare \`${c.a}\` → \`${c.b}\``, '', '| Operation | p95 before | p95 after | change | errors before | errors after |', '|---|---|---|---|---|---|'];
  for (const r of c.rows) lines.push(`| ${r.name} | ${r.a_p95_ms ?? '—'} | ${r.b_p95_ms ?? '—'} | ${r.p95_change_pct === null ? '—' : `${r.p95_change_pct > 0 ? '+' : ''}${r.p95_change_pct} %`} | ${r.a_error_rate ?? '—'} | ${r.b_error_rate ?? '—'} |`);
  lines.push('', `Throughput ${c.total.a_rps} → ${c.total.b_rps} rps (${c.total.rps_change_pct ?? '—'} %).`, '');
  if (c.same_build) lines.push('Both runs are the same build under the same fingerprint: every difference here is the environment\'s noise, and it sets the floor below which a regression cannot be told apart.', '');
  lines.push(c.regressions.length ? `Regressions (PS-F2, ${c.scope ?? 'total'}): ${c.regressions.map((r) => `${r.name} ${r.what}`).join('; ')}.` : 'No regression past the PS-F2 thresholds.', '');
  if (c.not_compared.length) lines.push(`Not compared (too few requests): ${c.not_compared.join(', ')}.`, '');
  return lines.join('\n');
}

// Slow decay (design §12): every step under the PS-F2 step limit, yet the series drifts. It is
// judged on the recent window only (the last DECAY.window runs, and none before the last step,
// which starts a new level), as a Theil-Sen line: the median of the pairwise slopes, so one noisy
// run neither makes nor hides a trend. Flagged when the fitted line moves more than
// DECAY.total_pct across at least DECAY.min_runs runs.
export const DECAY = { min_runs: 5, window: 8, total_pct: 12 };

export function judgeSeries(points, worse, stepLimit) {
  const flags = [];
  let level = 0;
  for (let i = 1; i < points.length; i++) {
    const step = pct(points[i - 1].value, points[i].value);
    if (step === null || worse(step) <= stepLimit) continue;
    level = i;
    // A step that later came back within the limit of where it started was fixed: not a finding now.
    const before = points[i - 1].value;
    if (!points.slice(i + 1).some((p) => worse(pct(before, p.value)) <= stepLimit)) flags.push({ kind: 'step', at: points[i].run_id, change_pct: step });
  }
  const win = points.slice(Math.max(level, points.length - DECAY.window));
  if (win.length >= DECAY.min_runs) {
    const { slope, intercept } = theilSen(win.map((p) => p.value));
    const total = pct(intercept, intercept + slope * (win.length - 1));
    if (total !== null && worse(total) > DECAY.total_pct) flags.push({ kind: 'slow_decay', from: win[0].run_id, to: win.at(-1).run_id, change_pct: total, runs: win.length });
  }
  return flags;
}

export function trend(root, slug, { environment, profile } = {}) {
  const runs = listRuns(root, slug).map((r) => readJson(join(r.dir, 'result.json'))).filter((r) => r?.run_state === 'done')
    .filter((r) => (!environment || r.run.environment === environment) && (!profile || r.run.profile === profile));
  if (!runs.length) return { runs: [], series: {}, flags: [], refused: 'no done run to trend' };
  // The latest run sets what is comparable; earlier runs of another kind are left out, and said so.
  const latest = runs.at(-1);
  const comparable = runs.filter((r) => r === latest || !compareBaseline(latest, r).refused);
  const left_out = runs.filter((r) => !comparable.includes(r)).map((r) => ({ run_id: r.run.id, why: compareBaseline(latest, r).refused }));
  const series = { 'total rps': comparable.map((r) => ({ run_id: r.run.id, value: r.total.rps })) };
  for (const name of Object.keys(latest.endpoints)) {
    series[`${name} p95_ms`] = comparable.filter((r) => r.endpoints[name]?.requests >= REGRESSION.min_requests).map((r) => ({ run_id: r.run.id, value: r.endpoints[name].p95_ms }));
  }
  const flags = [];
  for (const [name, points] of Object.entries(series)) {
    // Latency is worse going up; throughput is worse going down.
    const worse = name === 'total rps' ? (x) => -x : (x) => x;
    for (const f of judgeSeries(points, worse, name === 'total rps' ? REGRESSION.rps_pct : REGRESSION.p95_pct)) flags.push({ series: name, ...f });
  }
  const t = { environment: latest.run.environment, profile: latest.run.profile, runs: comparable.map((r) => r.run.id), left_out, series, flags };
  writeJson(join(projectDir(root, slug), 'trend.json'), t);
  writeFileSync(join(projectDir(root, slug), 'trend.md'), renderTrend(t));
  return t;
}

function renderTrend(t) {
  const lines = [`# Trend: ${t.environment}/${t.profile}`, '', `${t.runs.length} comparable run(s).`, ''];
  for (const [name, pts] of Object.entries(t.series)) lines.push(`- ${name}: ${pts.map((p) => p.value).join(' → ') || 'not enough requests'}`);
  lines.push('', t.flags.length ? '## Flags' : 'No step regression and no slow decay.', '');
  for (const f of t.flags) lines.push(f.kind === 'slow_decay'
    ? `- **slow decay** in ${f.series}: ${f.change_pct > 0 ? '+' : ''}${f.change_pct} % over ${f.runs} runs (${f.from} → ${f.to}), each step under ${REGRESSION.p95_pct} %`
    : `- **step** in ${f.series} at ${f.at}: ${f.change_pct > 0 ? '+' : ''}${f.change_pct} %`);
  if (t.left_out.length) lines.push('', `Left out (not comparable): ${t.left_out.map((x) => `${x.run_id} (${x.why})`).join('; ')}`);
  lines.push('');
  return lines.join('\n');
}
