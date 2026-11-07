import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { ENGINES } from '../adapters/index.mjs';
import { projectDir } from './checks.mjs';
import { scan } from './discover.mjs';
import { readSuite } from './suites.mjs';

// /perf-import, deterministic part (design §4): an existing suite is read, never changed. What it
// says about the workload and its thresholds becomes draft project files (source "imported"),
// kept only where the project has none yet; its old results are kept as reference, never as a
// baseline (another tool, an unknown environment: PS-F3). A suite whose engine ai-perf runs gets
// a run spec, so the same scripts run under the controller.

// Old results a suite may have left: k6 --summary-export, Locust --csv stats, perf-result/v1.
function oldResults(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', '.perf', '.venv'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      const rel = relative(root, p).replace(/\\/g, '/');
      if (e.name.endsWith('_stats.csv')) out.push({ kind: 'locust-csv', path: rel, endpoints: locustCsv(p) });
      else if (e.name.endsWith('.json')) {
        const j = readJson(p);
        if (j?.schema === 'perf-result/v1') out.push({ kind: 'perf-result/v1', path: rel, endpoints: Object.fromEntries(Object.entries(j.endpoints ?? {}).map(([k, v]) => [k, { requests: v.requests, p95_ms: v.p95_ms, error_rate: v.error_rate }])) });
        else if (j?.metrics?.http_req_duration && j?.metrics?.http_reqs) out.push({ kind: 'k6-summary', path: rel, endpoints: { total: { requests: j.metrics.http_reqs.count, p95_ms: j.metrics.http_req_duration['p(95)'], error_rate: j.metrics.http_req_failed?.value ?? null } } });
      }
    }
  };
  walk(root, 0);
  return out;
}

function locustCsv(path) {
  const [head, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.replace(/"/g, ''));
  const at = (r, name) => r[cols.indexOf(name)];
  const out = {};
  for (const line of rows) {
    const r = line.split(',').map((c) => c.replace(/"/g, ''));
    const name = at(r, 'Name');
    if (!name || name === 'Aggregated') continue;
    const n = Number(at(r, 'Request Count'));
    out[name] = { requests: n, p95_ms: Number(at(r, '95%')), error_rate: n ? Number(at(r, 'Failure Count')) / n : 0 };
  }
  return out;
}

export async function importSuites(root, slug) {
  const dir = projectDir(root, slug);
  mkdirSync(dir, { recursive: true });
  const found = scan(root).existing_suites.filter((s) => s.path.split('.').pop() !== 'json');
  const suites = [];
  for (const s of found) {
    if (s.tool === 'in-house') {
      suites.push({ tool: s.tool, path: s.path, engine: null, runnable: false, operations: [], think_s: null, peak_users: null, thresholds: [], unnamed: [],
        reason: 'an in-house load script: ai-perf does not run or parse it. Keep running it as it is; for its operations and budgets, use perf contract or name them in workload.json, and compare its numbers with an ai-perf run of the same operations' });
      continue;
    }
    const parsed = readSuite(join(root, s.path), s.tool);
    const engine = ENGINES[s.tool] ? s.tool : null;
    const detected = engine ? (await ENGINES[engine]()).detect() : null;
    suites.push({
      tool: s.tool, path: s.path, engine,
      runnable: Boolean(engine && detected.ok),
      reason: engine ? (detected.ok ? null : `engine ${engine} not installed: ${detected.install}`) : `ai-perf has no ${s.tool} engine yet: its results can be imported, its scripts not run`,
      operations: parsed.operations.map(({ name, weight }) => ({ name, ...(weight ? { weight } : {}) })),
      think_s: parsed.think_s, peak_users: parsed.peak_users, thresholds: parsed.thresholds,
      // Lines with requests that have no name and an id in the URL: results would split per id.
      unnamed: parsed.facts.unnamed,
    });
  }
  const results = oldResults(root);
  const imp = { imported_at: new Date().toISOString(), suites, results, wrote: [] };

  // Drafts from the first suite that names its operations; a file the project already has is kept.
  const lead = suites.find((s) => s.operations.length);
  if (lead && !existsSync(join(dir, 'workload.json'))) {
    // One journey per operation, weighted as the suite weighs it (a Locust @task(6)), so the plan
    // is the mix the suite sends; the shares are rounded to 0.1 and sum to 100.
    // When the suite weighs its operations, one without a weight is setup (a login in on_start):
    // run once per user, not part of the mix.
    const weighed = lead.operations.some((o) => o.weight > 0);
    const ops = weighed ? lead.operations.filter((o) => o.weight > 0) : lead.operations;
    const ws = ops.map((o) => (weighed ? o.weight : 1));
    const sum = ws.reduce((a, x) => a + x, 0);
    const pct = ws.map((x) => Math.round((x / sum) * 1000) / 10);
    pct[0] = Math.round((100 - pct.slice(1).reduce((a, x) => a + x, 0)) * 10) / 10;
    const users = lead.peak_users ?? 10;
    writeJson(join(dir, 'workload.json'), {
      model: 'closed', model_reason: `imported from ${lead.path}: virtual users with think time`,
      target: { users, source: 'imported' },
      personas: [{ name: 'user', share_pct: 100, source: 'imported' }],
      journeys: ops.map((o, i) => ({ name: o.name, persona: 'user', weight_pct: pct[i], steps: [o.name], think_time_s: lead.think_s ?? 1, source: 'imported' })),
      imported_from: lead.path,
    });
    imp.wrote.push('workload.json');
  }
  // Each operation takes its own threshold when the suite scopes one to it, else the unscoped one.
  const limit = (metric, op) => (lead.thresholds.find((t) => t.metric === metric && t.op === op) ?? lead.thresholds.find((t) => t.metric === metric && !t.op))?.below;
  if (lead?.thresholds.some((t) => ['p95_ms', 'error_rate'].includes(t.metric)) && !existsSync(join(dir, 'slo.json'))) {
    // The suite's thresholds are its team's SLOs; the SLA is not in a suite, so it stays at the SLO
    // until someone agrees one (the verdict says so).
    writeJson(join(dir, 'slo.json'), {
      profiles: ['smoke', 'load'],
      transactions: lead.operations.map((o) => {
        const slo = { p95_ms: limit('p95_ms', o.name) ?? 500, error_rate: limit('error_rate', o.name) ?? 0.01 };
        return { name: o.name, slo, sla: { ...slo }, source: 'imported' };
      }),
      imported_from: lead.path,
    });
    imp.wrote.push('slo.json');
  }
  // A run spec per runnable suite: the same scripts, run under the controller.
  // One spec per suite, named after it; a spec the project already has (perhaps tuned) is kept.
  for (const s of suites.filter((x) => x.engine)) {
    const name = `run-${s.tool}-${s.path.replace(/\.[^./]+$/, '').replace(/[^\w-]+/g, '-').toLowerCase()}.json`;
    s.run_spec = `.perf/${slug}/${name}`;
    if (existsSync(join(dir, name))) continue;
    writeJson(join(dir, name), {
      slug, engine: s.engine, script: s.path, workers: 1, target_url: 'http://127.0.0.1:8080',
      profile: { name: 'smoke', users: Math.min(4, s.peak_users ?? 4), warmup_s: 0, ramp_s: 0, steady_s: 30, rampdown_s: 5 },
      note: 'set target_url to an allow-listed host from env.json before the first run',
    });
    imp.wrote.push(name);
  }
  writeJson(join(dir, 'import.json'), imp);
  return imp;
}
