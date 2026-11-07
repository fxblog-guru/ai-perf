import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { perfHome, projectKey } from './learn.mjs';
import { listRuns } from './runs.mjs';

// Runs to a correct result (design §13, P2): per ai-perf version and profile, how many judged runs
// it took before one could be judged at all (PASS, WARN or FAIL, not NOT EVALUABLE), and why the
// ones before could not. A version whose projects need fewer runs is a better version; one that
// needs more has made something harder. Kept per project and, for all projects, under PERF_HOME.
const why = (v) => (v.reasons.find((r) => r.startsWith('NOT_EVALUABLE')) ?? 'NOT_EVALUABLE').replace(/^NOT_EVALUABLE: /, '').split(/[:(;]/)[0].trim().slice(0, 80);

export function scorecard(root, slug) {
  const card = {};
  // A profile already judged under an earlier version starts this one knowing its way: its runs
  // are kept apart (continued), so an upgrade cannot flatter the new version.
  const first = {};
  for (const r of listRuns(root, slug)) {
    const v = readJson(join(r.dir, 'verdict.json'));
    const spec = readJson(join(r.dir, 'run.json'));
    if (!v || !spec) continue;
    const version = spec.ai_perf_version ?? 'unknown';
    const profile = spec.profile?.name ?? 'unknown';
    first[profile] ??= version;
    const p = ((card[version] ??= {})[profile] ??= { runs: 0, runs_to_evaluable: null, outcomes: {}, not_evaluable: {}, ...(first[profile] !== version ? { continued: true } : {}) });
    p.runs++;
    p.outcomes[v.outcome] = (p.outcomes[v.outcome] ?? 0) + 1;
    if (v.outcome === 'NOT_EVALUABLE') p.not_evaluable[why(v)] = (p.not_evaluable[why(v)] ?? 0) + 1;
    else p.runs_to_evaluable ??= p.runs;
  }
  const doc = { updated_at: new Date().toISOString(), versions: card };
  writeJson(join(projectDir(root, slug), 'scorecard.json'), doc);
  const dir = join(perfHome(), 'scorecards');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${projectKey(root, slug)}.json`), doc);
  return doc;
}

// Across projects, per version: the median runs to an evaluable result, and how many project
// profiles never got one.
export function globalScorecard() {
  const dir = join(perfHome(), 'scorecards');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  const per = {};
  for (const f of files) for (const [version, profiles] of Object.entries(readJson(join(dir, f))?.versions ?? {})) {
    for (const p of Object.values(profiles)) if (!p.continued) (per[version] ??= []).push(p.runs_to_evaluable);
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
  return Object.fromEntries(Object.entries(per).map(([version, xs]) => [version, {
    project_profiles: xs.length, median_runs_to_evaluable: median(xs.filter((x) => x !== null)), never_evaluable: xs.filter((x) => x === null).length,
  }]));
}
