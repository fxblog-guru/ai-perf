import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { hasCommand } from './help.mjs';
import { readContract } from './contract.mjs';

// /perf-discover, deterministic part (design §10). Tier 1 reads the repo; tier 3 fills safe
// defaults as logged assumptions; tier 4 asks at most three questions, each with a proposed answer,
// and never one whose answer the repo, an earlier answer or an earlier run already holds.

const SKIP = new Set(['node_modules', '.git', '.perf', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'coverage']);
const MAX_FILES = 5000;

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else yield p;
  }
}

const read = (p) => { try { return statSync(p).size < 2_000_000 ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };

// The share of the contract's traffic (x-traffic-classes rps × peak) that GET operations carry.
function contractKind(root, files) {
  for (const f of files) {
    let c;
    try { c = readContract(join(root, f)); } catch { continue; }
    const rate = (cls) => (c.classes[cls]?.rps ?? 0) * (c.classes[cls]?.peak_factor ?? 1);
    const classes = Object.keys(c.classes);
    if (!classes.length) continue;
    const getOnly = classes.filter((k) => c.operations.some((o) => o.traffic === k) && c.operations.filter((o) => o.traffic === k).every((o) => o.method === 'GET'));
    const total = classes.reduce((a, k) => a + rate(k), 0);
    if (total > 0) return getOnly.reduce((a, k) => a + rate(k), 0) / total >= 0.8 ? 'read-heavy' : 'transactional';
  }
  return null;
}

export function scan(root) {
  const facts = { openapi: [], operations: [], x_perf_budgets: 0, compose_services: [], datastores: [], stack: [], realtime: [], existing_suites: [], sdlc: false };
  let n = 0;
  for (const p of walk(root)) {
    if (++n > MAX_FILES) break;
    const rel = relative(root, p).replace(/\\/g, '/');
    const name = rel.split('/').pop().toLowerCase();
    if (rel.startsWith('.sdlc/')) facts.sdlc = true;
    if (/^(openapi|swagger)[\w.-]*\.(json|ya?ml)$/.test(name)) {
      const text = read(p);
      facts.openapi.push(rel);
      facts.operations.push(...[...text.matchAll(/"?operationId"?\s*:\s*"?([\w.-]+)"?/g)].map((m) => m[1]));
      facts.x_perf_budgets += (text.match(/x-perf/g) ?? []).length;
    }
    if (/^(docker-)?compose[\w.-]*\.ya?ml$/.test(name)) {
      const text = read(p);
      const services = text.split(/\n(?=\S)/).find((b) => b.startsWith('services:')) ?? '';
      facts.compose_services.push(...[...services.matchAll(/^ {2}([\w.-]+):\s*$/gm)].map((m) => m[1]));
      for (const db of ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'kafka', 'rabbitmq', 'elasticsearch']) if (text.includes(`image: ${db}`) || text.includes(`image: "${db}`)) facts.datastores.push(db);
    }
    if (name === 'package.json') {
      const deps = Object.keys({ ...readJson(p)?.dependencies, ...readJson(p)?.devDependencies });
      for (const d of ['express', 'fastify', 'next', '@nestjs/core', 'koa', 'hono']) if (deps.includes(d)) facts.stack.push(`node:${d}`);
      for (const d of ['ws', 'socket.io', 'uWebSockets.js', 'colyseus']) if (deps.includes(d)) facts.realtime.push(d);
      if (deps.includes('k6')) facts.existing_suites.push({ tool: 'k6', path: rel });
    }
    if (/^(requirements[\w-]*\.txt|pyproject\.toml)$/.test(name)) {
      const text = read(p).toLowerCase();
      for (const d of ['django', 'flask', 'fastapi']) if (text.includes(d)) facts.stack.push(`python:${d}`);
      for (const d of ['websockets', 'channels', 'python-socketio']) if (text.includes(d)) facts.realtime.push(d);
    }
    if (name === 'pom.xml' || name.startsWith('build.gradle')) facts.stack.push(read(p).includes('spring-boot') ? 'jvm:spring-boot' : 'jvm');
    if (name === 'go.mod') facts.stack.push('go');
    if (name.endsWith('.csproj')) facts.stack.push('dotnet');
    if (/^locustfile[\w-]*\.py$/.test(name)) facts.existing_suites.push({ tool: 'locust', path: rel });
    if (name.endsWith('.jmx')) facts.existing_suites.push({ tool: 'jmeter', path: rel });
    if (/\.(js|ts)$/.test(name) && /from ['"]k6(\/http)?['"]/.test(read(p))) facts.existing_suites.push({ tool: 'k6', path: rel });
    if (/\.(scala|java|kt)$/.test(name) && /io\.gatling/.test(read(p))) facts.existing_suites.push({ tool: 'gatling', path: rel });
    // An in-house load script (found dogfooding fx-blog): in a folder named perf, load, stress or
    // bench (or perf-tests, loadtest…), or a file named perf-*, stress-* or loadtest-*; that sends
    // requests in a load shape (a loop or concurrency); and is none of the tools above. A DataLoader
    // in src/loaders or a loadConfig.js is not one. Not run or parsed: listed.
    else if (/\.(m?js|ts|py)$/.test(name) && !/\.(test|spec)\.(m?js|ts)$/.test(name) && !/locustfile|k6/.test(name)
      && (/(^|\/)(perf|load|stress|bench)(s|test|tests|testing|-tests?)?\//i.test(rel.replace(/[^/]+$/, '')) || /^(perf|stress|load-?test)[\w-]*\./i.test(name))
      && /\b(fetch\(|http\.request|https?\.get|requests\.|aiohttp|WebSocket|net\.connect)/.test(read(p)) && !/from ['"]k6/.test(read(p))
      && /\b(for\s*\(|while\s*\(|while\s+True|for\s+\w+\s+in\s+range|setInterval|Promise\.all|concurrency|duration|--users|asyncio\.gather|ThreadPool)/.test(read(p))) facts.existing_suites.push({ tool: 'in-house', path: rel });
  }
  facts.operations = [...new Set(facts.operations)];
  facts.contract_kind = contractKind(root, facts.openapi);
  facts.stack = [...new Set(facts.stack)];
  facts.datastores = [...new Set(facts.datastores)];
  return facts;
}

// Candidate questions, most decisive first. `known` says when the answer is already in hand.
const QUESTIONS = [
  { key: 'peak_load', ask: 'What load must the system take at its peak?', choices: ['about 50 concurrent users', 'about 500', 'about 5,000', 'I know the requests per second'], proposed: 'about 50 concurrent users', default: 50,
    known: (f, a) => a.peak_load !== undefined || f.x_perf_budgets > 0 },
  { key: 'system_kind', ask: 'Which best describes the system?', choices: ['web or API, mostly reads', 'API with transactions (orders, payments)', 'realtime (chat, game, live updates)'], proposed: 'web or API, mostly reads', default: 'read-heavy',
    known: (f, a) => a.system_kind !== undefined || f.realtime.length > 0 || f.contract_kind !== null },
  { key: 'operations', ask: 'Which operations matter most to users? (no API description was found)', choices: ['I will list them', 'use the routes you find in the code'], proposed: 'use the routes you find in the code', default: 'from code',
    known: (f, a) => a.operations !== undefined || f.operations.length > 0 || f.existing_suites.length > 0 },
  { key: 'peak_event', ask: 'Is a traffic peak coming (a sale, a launch, an event)? When?', choices: ['no', 'yes, I will say when'], proposed: 'no', default: 'none known',
    known: (f, a) => a.peak_event !== undefined },
  { key: 'past_incidents', ask: 'Has it ever slowed down or failed under load? What happened?', choices: ['no', 'yes, I will describe it'], proposed: 'no', default: 'none known',
    known: (f, a) => a.past_incidents !== undefined },
];
export const MAX_QUESTIONS = 3;

const SLO_DEFAULTS = {
  'read-heavy': { p95_ms: 500, error_rate: 0.01 },
  transactional: { p95_ms: 800, error_rate: 0.005 },
  realtime: { p95_ms: 150, error_rate: 0.01, tick_lag_p95_ms: 50 },
};

export function discover(root, slug, answers = {}) {
  const dir = projectDir(root, slug);
  mkdirSync(dir, { recursive: true });
  const prev = readJson(join(dir, 'context.json'));
  const all = { ...prev?.answers, ...answers };
  const facts = scan(root);
  const questions = QUESTIONS.filter((q) => !q.known(facts, all)).slice(0, MAX_QUESTIONS)
    .map(({ key, ask, choices, proposed }) => ({ key, ask, choices, proposed }));
  const kind = all.system_kind ? (/transaction/i.test(all.system_kind) ? 'transactional' : /realtime/i.test(all.system_kind) ? 'realtime' : 'read-heavy') : facts.realtime.length ? 'realtime' : facts.contract_kind ?? 'read-heavy';
  // Every unknown value used later is an assumption with its source and what it affects if wrong.
  const assumptions = [];
  const assume = (key, value, source, impact, confirmed) => assumptions.push({ key, value, source, confidence: confirmed ? 'high' : source === 'default' ? 'low' : 'medium', impact, status: confirmed ? 'confirmed' : 'assumed' });
  const peak = all.peak_load ?? (facts.x_perf_budgets ? 'from x-perf load plan' : QUESTIONS[0].default);
  assume('peak_load', peak, all.peak_load !== undefined ? 'confirmed' : facts.x_perf_budgets ? 'contract' : 'default', 'the target load of every profile', all.peak_load !== undefined);
  assume('system_kind', kind, all.system_kind !== undefined ? 'confirmed' : facts.realtime.length ? 'measured' : facts.contract_kind ? 'contract' : 'default', 'which SLO defaults apply', all.system_kind !== undefined);
  const d = SLO_DEFAULTS[kind];
  assume('slo_p95_ms', d.p95_ms, 'default', 'what counts as slow', false);
  assume('slo_error_rate', d.error_rate, 'default', 'what counts as failing', false);
  const ctx = { slug, scanned_at: new Date().toISOString(), facts, answers: all, questions, slo_defaults: d, system_kind: kind };
  writeJson(join(dir, 'context.json'), ctx);
  writeJson(join(dir, 'assumptions.json'), mergeAssumptions(readJson(join(dir, 'assumptions.json')) ?? [], assumptions));
  writeFileSync(join(dir, 'context.md'), renderContext(ctx));
  return ctx;
}

// A confirmed value is never downgraded back to an assumption by a later scan.
function mergeAssumptions(old, fresh) {
  const byKey = new Map(old.map((a) => [a.key, a]));
  for (const a of fresh) if (byKey.get(a.key)?.status !== 'confirmed' || a.status === 'confirmed') byKey.set(a.key, a);
  return [...byKey.values()];
}

function renderContext(c) {
  const f = c.facts;
  const lines = [`# Context: ${c.slug}`, '', `Scanned ${c.scanned_at}.`, '', '## What the repo says', ''];
  lines.push(`- API description: ${f.openapi.length ? `${f.openapi.join(', ')} (${f.operations.length} operations, ${f.x_perf_budgets} x-perf budgets)` : 'none found'}`);
  lines.push(`- Stack: ${f.stack.join(', ') || 'unknown'}`);
  lines.push(`- Services (compose): ${f.compose_services.join(', ') || 'none'}; datastores: ${f.datastores.join(', ') || 'none seen'}`);
  lines.push(`- Realtime: ${f.realtime.join(', ') || 'none seen'}`);
  lines.push(`- Existing perf suites: ${f.existing_suites.map((s) => `${s.tool} ${s.path}`).join(', ') || 'none'}${f.existing_suites.length ? ` → ${hasCommand('/perf-import') ? '/perf-import' : 'plan alongside it (/perf-import comes in M3)'}` : ''}`);
  lines.push(`- sdlc contract: ${f.sdlc ? 'yes (.sdlc/)' : 'no'}`, '');
  lines.push(`System kind: ${c.system_kind}. SLO defaults until confirmed: p95 ${c.slo_defaults.p95_ms} ms, error rate ${c.slo_defaults.error_rate}.`, '');
  lines.push('## Questions', '', ...(c.questions.length ? c.questions.map((q) => `- ${q.ask} Proposed: **${q.proposed}** (choices: ${q.choices.join(' / ')})`) : ['None: everything needed is known.']), '');
  return lines.join('\n');
}
