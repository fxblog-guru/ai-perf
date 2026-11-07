import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { scan } from './discover.mjs';
import { scanSecrets } from './doctor.mjs';
import { readSuite } from './suites.mjs';

// /perf-audit, deterministic part (design §4): an existing suite scored against perf-standard,
// with ranked fixes. It only reports; the skill applies a fix when the owner approves it.

const WEIGHT = { high: 15, medium: 8, low: 3 };
const PROD = /(^|[.\-/])(prod(?!uct(?!ion))|prd)[a-z0-9]*([.-]|$)/i;

// Each rule: id, severity, the standard's rule, and a check over the parsed suite that returns
// the evidence lines (or true) when the defect is there.
export const RULES = [
  { id: 'secret-in-script', severity: 'high', ps: 'PS-A3', title: 'a credential is written in the script',
    fix: 'move it to an environment variable and read it at run time', test: (s, path) => scanSecrets([path]).length > 0 },
  { id: 'production-host', severity: 'high', ps: 'PS-A1', title: 'the script names a production-looking host',
    fix: 'take the host from the environment (env.json allow_hosts); never load production', test: (s) => s.facts.literal_hosts.filter((h) => PROD.test(h.host.replace(/^https?:\/\//, ''))).map((h) => h.line) },
  { id: 'shared-account', severity: 'high', ps: 'PS-B7', title: 'every virtual user logs in with the same account',
    fix: 'give each virtual user its own account (a counter, the VU id, or a data file partitioned by AI_PERF_WORKER)',
    // A literal identity counts only inside a login or auth call: a create-user payload is data.
    test: (s) => !s.facts.per_user_identity && [...s.text.matchAll(/(?:username|email|login)["']?\s*[:=]\s*["'`][^"'`$]+["'`]/gi)]
      .filter((m) => /login|signin|sign_in|auth|token/i.test(s.text.slice(Math.max(0, m.index - 160), m.index)))
      .map((m) => s.text.slice(0, m.index).split('\n').length) },
  { id: 'averaged-percentiles', severity: 'high', ps: 'PS-D2', title: 'percentiles are averaged (a mean of p95s is not a p95)',
    fix: 'merge histograms or raw samples, then take the percentile once',
    test: (s) => [...s.text.matchAll(/(?:avg|mean|average|sum)\w*\s*\([^\n]*\b(?:p\(?9\d\)?|p9\d|percentile)/gi)].map((m) => s.text.slice(0, m.index).split('\n').length) },
  // SLOs kept in the project's slo.json count: ai-perf judges every run against them.
  { id: 'no-slo', severity: 'medium', ps: 'PS-E1', title: 'no threshold or assertion, and no slo.json: nothing can fail the suite',
    fix: 'write the SLOs per transaction (/perf-plan), or add thresholds to the suite', test: (s, path, ctx) => !ctx.hasSlo && !s.thresholds.length && !/thresholds\s*:|assertions?\s*\(|setUp\([\s\S]*assertions/.test(s.text) },
  { id: 'no-checks', severity: 'medium', ps: 'PS-B8', title: 'responses are not checked: a 200 with an error body counts as success',
    fix: 'check the business outcome of each step, not only the status', test: (s) => !s.facts.checks },
  { id: 'no-warmup', severity: 'medium', ps: 'PS-D1', title: 'full load from the first second: no warm-up or ramp',
    fix: 'ramp up and measure only the steady state (ai-perf does when it runs the suite)', test: (s) => !s.facts.ramps },
  { id: 'no-think-time', severity: 'medium', ps: 'PS-B4', title: 'no think time: each user hammers in a loop, unlike a person',
    fix: 'add think time measured from real sessions, or a pacing', test: (s) => !s.facts.think },
  { id: 'unnamed-requests', severity: 'medium', ps: 'PS-D4', title: 'requests with ids in the URL are not named: results split per id',
    fix: 'name each request after its operation (the operationId)', test: (s) => s.facts.unnamed },
  { id: 'hardcoded-host', severity: 'low', ps: 'PS-A1', title: 'the target host is written in the script',
    fix: 'read it from the environment (BASE_URL), so the same script runs on any allowed environment',
    test: (s) => !s.facts.host_from_env && s.facts.literal_hosts.map((h) => h.line) },
  { id: 'fixed-think-time', severity: 'low', ps: 'PS-B4', title: 'think time is fixed: users move in lockstep',
    fix: 'randomise it within a measured range', test: (s) => s.facts.think && !s.facts.think_random },
];

const hit = (r) => (Array.isArray(r) ? r.length > 0 : Boolean(r));

export function auditSuite(root, suite, ctx = {}) {
  const path = join(root, suite.path);
  const s = readSuite(path, suite.tool);
  const findings = [];
  for (const rule of RULES) {
    const r = rule.test(s, path, ctx);
    if (!hit(r)) continue;
    findings.push({ id: rule.id, severity: rule.severity, ps: rule.ps, title: rule.title, fix: rule.fix, lines: Array.isArray(r) ? [...new Set(r)] : [] });
  }
  const score = Math.max(0, 100 - findings.reduce((a, f) => a + WEIGHT[f.severity], 0));
  return { tool: suite.tool, path: suite.path, score, findings };
}

export function audit(root, slug) {
  const suites = scan(root).existing_suites.filter((s) => !s.path.endsWith('.json') && s.tool !== 'in-house').map((s) => auditSuite(root, s, { hasSlo: existsSync(join(projectDir(root, slug), 'slo.json')) }));
  const order = { high: 0, medium: 1, low: 2 };
  const ranked = suites.flatMap((s) => s.findings.map((f) => ({ ...f, path: s.path }))).sort((a, b) => order[a.severity] - order[b.severity]);
  const a = { audited_at: new Date().toISOString(), suites, ranked };
  const dir = projectDir(root, slug);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'audit.json'), a);
  writeFileSync(join(dir, 'audit.md'), render(a));
  return a;
}

function render(a) {
  const lines = ['# Perf suite audit', ''];
  if (!a.suites.length) lines.push('No perf suite found.', '');
  for (const s of a.suites) lines.push(`- \`${s.path}\` (${s.tool}): ${s.score}/100, ${s.findings.length} finding(s)`);
  lines.push('', '## Fixes, most severe first', '', '| # | Severity | Where | Problem | Fix |', '|---|---|---|---|---|');
  a.ranked.forEach((f, i) => lines.push(`| ${i + 1} | ${f.severity} | \`${f.path}\`${f.lines.length ? `:${f.lines.join(',')}` : ''} | ${f.title} (${f.ps}) | ${f.fix} |`));
  lines.push('', 'Each fix is applied only when the suite owner approves it.', '');
  return lines.join('\n');
}
