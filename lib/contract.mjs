import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { isNum } from '../controller/spec.mjs';

// Performance budgets from an API contract (an sdlc OpenAPI file with `x-perf`, `x-traffic` and
// `info.x-traffic-classes`). A project that already wrote its budgets down should not be asked for
// them again (asking policy): /perf-plan and /perf-model start from these, with source `contract`.
//
// YAML is read line by line, so the bundle needs no YAML parser. The reader is strict rather than
// clever: operations are read under `paths:` only (never webhooks, callbacks, links or components);
// an operation's own keys are read only at its child indent; `x-perf` and classes may be flow or
// block maps; comments are dropped. Whatever it cannot place exactly, it refuses (ContractError)
// instead of guessing: a misread budget would become a wrong SLO that still passes the gate.

export class ContractError extends Error {}

const METHODS = /^(get|post|put|patch|delete|head|options|trace)$/;
const scalar = (v) => {
  const s = String(v).trim().replace(/^["']|["']$/g, '');
  return s !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
};
// Drops a trailing ` # comment` that is not inside quotes.
function uncomment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
}
const flow = (s) => Object.fromEntries([...String(s).matchAll(/([\w-]+)\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/g)].map(([, k, v]) => [k, scalar(v)]));
const keyOf = (body) => body.match(/^("[^"]+"|'[^']+'|[^:\s][^:]*?)\s*:(\s|$)/)?.[1]?.replace(/^["']|["']$/g, '');

export function readContract(file) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const j = JSON.parse(text);
    const ops = [];
    for (const [p, item] of Object.entries(j.paths ?? {})) for (const [method, op] of Object.entries(item ?? {})) {
      if (METHODS.test(method)) ops.push({ path: p, method: method.toUpperCase(), id: op?.operationId ?? null, traffic: op?.['x-traffic'] ?? null, perf: op?.['x-perf'] ?? null });
    }
    return { classes: j.info?.['x-traffic-classes'] ?? {}, operations: ops };
  }
  const lines = text.split(/\r?\n/).map(uncomment);
  const classes = {};
  const ops = [];
  let top = null; // the top-level key we are under
  let infoKids = null; // the indent of info's children
  let classesAt = null; // the indent of x-traffic-classes, when inside it
  let clsIndent = null;
  let cls = null;
  let pathIndent = null;
  let methodIndent = null;
  let childIndent = null;
  let path = null;
  let cur = null;
  let block = null; // { into, indent }: a block map being read (x-perf, a class)
  let perfLines = 0;
  let pathsPerf = 0; // every x-perf line under paths, at any depth, outside callbacks
  let callbacksAt = null; // a callbacks subtree: its operations are the API calling out, not load
  for (const raw of lines) {
    const body = raw.trim();
    if (!body || body === '---') continue;
    const indent = raw.match(/^ */)[0].length;
    if (callbacksAt !== null && indent <= callbacksAt) callbacksAt = null;
    if (top === 'paths' && indent > 0 && callbacksAt === null && /^x-perf\s*:/.test(body)) pathsPerf++;
    if (indent === 0) {
      top = keyOf(body);
      path = cur = block = null; classesAt = null;
      continue;
    }
    if (block && indent > block.indent) {
      const m = body.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (m && m[2] !== '') block.into[m[1]] = scalar(m[2]);
      continue;
    }
    block = null;
    if (top === 'info') {
      infoKids ??= indent;
      if (classesAt !== null && indent <= classesAt) classesAt = null;
      if (indent === infoKids && keyOf(body) === 'x-traffic-classes') { classesAt = indent; clsIndent = null; continue; }
      if (classesAt !== null) {
        clsIndent ??= indent;
        if (indent !== clsIndent) continue;
        const name = keyOf(body);
        const rest = body.slice(body.indexOf(':') + 1).trim();
        classes[name] = rest.startsWith('{') ? flow(rest.slice(1, rest.lastIndexOf('}'))) : {};
        if (!rest) block = { into: classes[name], indent };
      }
      continue;
    }
    if (top !== 'paths') continue;
    pathIndent ??= indent;
    if (indent === pathIndent) {
      path = keyOf(body);
      if (!path?.startsWith('/')) throw new ContractError(`${file}: "${body}" under paths is not a path`);
      cur = null;
      continue;
    }
    if (!path) continue;
    if (cur === null || indent <= methodIndent) {
      methodIndent ??= indent;
      if (indent !== methodIndent) continue;
      const k = keyOf(body);
      if (METHODS.test(k ?? '')) { cur = { path, method: k.toUpperCase(), id: null, traffic: null, perf: null }; ops.push(cur); } else cur = null;
      continue;
    }
    childIndent ??= indent;
    if (indent !== childIndent) continue; // deeper: responses, links, callbacks, parameters
    const k = keyOf(body);
    const v = body.slice(body.indexOf(':') + 1).trim();
    if (k === 'callbacks') { callbacksAt = indent; continue; }
    if (k === 'operationId') {
      if (cur.id) throw new ContractError(`${file}: ${cur.method} ${path} has two operationIds`);
      cur.id = scalar(v);
    } else if (k === 'x-traffic') cur.traffic = scalar(v);
    else if (k === 'x-perf') {
      perfLines++;
      cur.perf = v.startsWith('{') ? flow(v.slice(1, v.lastIndexOf('}'))) : {};
      if (!v) block = { into: cur.perf, indent };
    }
  }
  // Every x-perf line under paths belongs to exactly one operation, or the file was not understood.
  if (pathsPerf !== perfLines) throw new ContractError(`${file}: ${pathsPerf} x-perf lines under paths, but only ${perfLines} sit where an operation's own keys are; the layout was not understood, so nothing is drafted`);
  return { classes, operations: ops };
}

export function findContract(root, slug) {
  const f = (readJson(join(projectDir(root, slug), 'context.json'))?.facts?.openapi ?? []).find((p) => /\.(ya?ml|json)$/.test(p));
  return f ? join(root, f) : null;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Draft slo.json and workload.json from the contract, only where the project has none. Which
// operations: the GETs that carry x-perf in the given traffic classes (default: all classes), or the
// ones named. The p95 budget is the SLA (what the contract promises); the SLO is stricter by
// `margin` (20 %). The contract states no error rate: that part is a default, and the verdict
// names it.
export function fromContract(root, slug, { traffic, ops: only, margin = 0.2 } = {}) {
  const path = findContract(root, slug);
  if (!path) return { refused: 'no OpenAPI contract in context.json: run perf discover first' };
  let c;
  try { c = readContract(path); } catch (e) { if (e instanceof ContractError) return { refused: e.message, contract: path }; throw e; }
  const classes = traffic ?? Object.keys(c.classes);
  const named = c.operations.filter((o) => o.id);
  const picked = named.filter((o) => o.perf && (only ? only.includes(o.id) : o.method === 'GET' && classes.includes(o.traffic)));
  if (!picked.length) return { refused: `no x-perf operation matches (classes: ${classes.join(', ') || 'none'})`, contract: path };
  const bad = picked.filter((o) => !(isNum(o.perf.p95_ms) && o.perf.p95_ms > 0));
  if (bad.length) return { refused: `x-perf.p95_ms is not a number of milliseconds for ${bad.map((o) => `${o.id} (${JSON.stringify(o.perf.p95_ms)})`).join(', ')}`, contract: path };
  const dir = projectDir(root, slug);
  const wrote = [];
  const warnings = [];
  if (!existsSync(join(dir, 'slo.json'))) {
    writeJson(join(dir, 'slo.json'), {
      profiles: ['smoke', 'load'],
      transactions: picked.map((o) => ({
        name: o.id, source: 'contract', error_rate_source: 'default',
        slo: { p95_ms: Math.round(o.perf.p95_ms * (1 - margin)), error_rate: 0.005 },
        sla: { p95_ms: o.perf.p95_ms, error_rate: 0.01 },
      })),
      from_contract: path.slice(root.length + 1).replace(/\\/g, '/'),
    });
    wrote.push('slo.json');
  }
  if (!existsSync(join(dir, 'workload.json'))) {
    // One persona and journey per traffic class. A class with `concurrency` is that many clients in
    // a closed loop with no think time (the contract's own model). A class with only a rate gets
    // the users Little's law needs to carry its peak at its budget, and the think time that holds
    // them to it. The rate the loop will drive is computed at the budget, so an overdrive shows.
    const used = [...new Set(picked.map((o) => o.traffic))].filter((t) => c.classes[t]);
    const plan = used.map((t) => {
      const k = c.classes[t];
      const budget = median(picked.filter((o) => o.traffic === t).map((o) => o.perf.p95_ms)) / 1000;
      const peak = (k.rps ?? 0) * (k.peak_factor ?? 1);
      const users = isNum(k.concurrency) && k.concurrency > 0 ? k.concurrency : Math.max(1, Math.ceil(peak * budget));
      const think = isNum(k.concurrency) || !peak ? 0 : Math.max(0, users / peak - budget);
      return { t, budget, peak, users, think, drives: users / (budget + think) };
    });
    const users = plan.reduce((a, p) => a + p.users, 0);
    const shares = plan.map((p) => Math.round((p.users / users) * 100));
    shares[0] += 100 - shares.reduce((a, x) => a + x, 0);
    const rps = plan.reduce((a, p) => a + p.drives, 0);
    const peak = plan.reduce((a, p) => a + p.peak, 0);
    for (const p of plan) if (p.peak && p.drives > 3 * p.peak) warnings.push(`class ${p.t}: ${p.users} clients with no think time drive about ${Math.round(p.drives)} rps at its ${p.budget * 1000} ms budget, ${Math.round(p.drives / p.peak)}× its peak of ${p.peak}; if the peak is a target, not a floor, add think time or pick fewer clients`);
    writeJson(join(dir, 'workload.json'), {
      model: 'closed', model_reason: 'the contract sets each traffic class as concurrent clients in a closed loop (a rate-only class gets the clients its peak needs)',
      target: { users, source: 'contract' },
      personas: plan.map((p, i) => ({ name: p.t, share_pct: shares[i], source: 'contract' })),
      journeys: plan.map((p, i) => ({ name: p.t, persona: p.t, weight_pct: shares[i], steps: picked.filter((o) => o.traffic === p.t).map((o) => o.id), think_time_s: Math.round(p.think * 1000) / 1000, source: 'contract' })),
      // At the budget, the loop drives `rps`; the contract's peak is `peak_rps`, the floor to reach.
      littles_law: { rps: Math.round(rps * 100) / 100, response_s: Math.round((users / rps - plan.reduce((a, p) => a + p.think * p.users, 0) / users) * 1000) / 1000, think_s: Math.round((plan.reduce((a, p) => a + p.think * p.users, 0) / users) * 1000) / 1000, users, peak_rps: peak, source: 'contract' },
      traffic_classes: Object.fromEntries(used.map((t) => [t, c.classes[t]])),
    });
    wrote.push('workload.json');
  }
  return { contract: path, operations: picked.map((o) => ({ id: o.id, method: o.method, path: o.path, traffic: o.traffic, p95_ms: o.perf.p95_ms })), wrote, warnings };
}
