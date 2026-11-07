import { join } from 'node:path';
import { readJson } from '../controller/files.mjs';
import { isNum } from '../controller/spec.mjs';
import { listRuns } from './runs.mjs';
import { checkVolume } from './volume.mjs';

// The gate of each lifecycle step (design §5.1), over the files that step writes in .perf/<slug>/.
// Each returns { step, ok, errors[], warnings[] }; a skill moves on only when ok.

// imported: read from an existing suite (its thresholds, its users), not yet agreed with an owner.
export const SOURCES = ['contract', 'measured', 'confirmed', 'imported', 'assumed', 'default'];
export const PROFILES = ['smoke', 'baseline', 'load', 'stress', 'spike', 'soak', 'capacity', 'recovery', 'volume'];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
export const projectDir = (root, slug) => join(root, '.perf', slug);
const file = (root, slug, name) => readJson(join(projectDir(root, slug), name));
const result = (step, errors, warnings = []) => ({ step, ok: errors.length === 0, errors, warnings });

function needSource(where, x, errors) {
  if (!SOURCES.includes(x?.source)) errors.push(`${where}: "source" must be one of ${SOURCES.join(', ')} (P3: no number without its origin)`);
}

export function checkPlan(root, slug) {
  const slo = file(root, slug, 'slo.json');
  const errors = [];
  const warnings = [];
  if (!slo) return result('plan', ['slo.json missing; /perf-plan writes it']);
  if (!Array.isArray(slo.transactions) || !slo.transactions.length) errors.push('transactions: at least one critical transaction');
  for (const [i, tx] of (slo.transactions ?? []).entries()) {
    const at = `transactions[${i}] ${tx?.name ?? '?'}`;
    if (!tx?.name) errors.push(`${at}: name (the operationId) required`);
    for (const k of ['p95_ms', 'error_rate']) {
      if (!isNum(tx?.slo?.[k])) errors.push(`${at}: slo.${k} must be a number`);
      if (!isNum(tx?.sla?.[k])) errors.push(`${at}: sla.${k} must be a number`);
      if (isNum(tx?.slo?.[k]) && isNum(tx?.sla?.[k]) && tx.slo[k] > tx.sla[k]) errors.push(`${at}: slo.${k} ${tx.slo[k]} is looser than sla.${k} ${tx.sla[k]}`);
    }
    // p99 is optional; when set, a number, and the SLO no looser than the SLA.
    for (const side of ['slo', 'sla']) if (tx?.[side]?.p99_ms !== undefined && !isNum(tx[side].p99_ms)) errors.push(`${at}: ${side}.p99_ms must be a number`);
    if (isNum(tx?.slo?.p99_ms) && isNum(tx?.sla?.p99_ms) && tx.slo.p99_ms > tx.sla.p99_ms) errors.push(`${at}: slo.p99_ms ${tx.slo.p99_ms} is looser than sla.p99_ms ${tx.sla.p99_ms}`);
    needSource(at, tx, errors);
  }
  for (const p of slo.profiles ?? []) if (!PROFILES.includes(p)) errors.push(`profiles: unknown "${p}"`);
  if (!(slo.profiles ?? []).length) errors.push('profiles: name the profiles this plan runs');
  if (slo.min_rps !== undefined && !isNum(slo.min_rps)) errors.push('min_rps must be a number');
  // Spike, recovery and soak limits (optional; defaults apply and the verdict says so).
  for (const [block, keys] of [['spike', ['recovery_s']], ['recovery', ['recovery_s']], ['soak', ['max_p95_drift_pct', 'max_memory_growth_pct']]]) {
    for (const [k, v] of Object.entries(slo[block] ?? {})) {
      if (!keys.includes(k)) errors.push(`${block}.${k}: not a judged limit (known: ${keys.join(', ')})`);
      else if (!(isNum(v) && v > 0)) errors.push(`${block}.${k} must be a number above 0`);
    }
  }
  if (slo.realtime) {
    // Only what the verdict judges: a limit under any other name would be read by nobody.
    const KNOWN = ['tick_lag_p95_ms', 'drops_per_min'];
    for (const side of ['slo', 'sla']) for (const [k, v] of Object.entries(slo.realtime[side] ?? {})) {
      if (!KNOWN.includes(k)) errors.push(`realtime.${side}.${k}: not a judged limit (known: ${KNOWN.join(', ')})`);
      else if (!isNum(v)) errors.push(`realtime.${side}.${k} must be a number`);
    }
    const hold = slo.realtime.ccu_hold_pct;
    if (hold !== undefined && !(isNum(hold) && hold > 0 && hold <= 100)) errors.push('realtime.ccu_hold_pct: a number in (0, 100]');
    for (const k of ['tick_lag_p95_ms', 'drops_per_min']) {
      const a = slo.realtime.slo?.[k];
      const b = slo.realtime.sla?.[k];
      if (isNum(a) && isNum(b) && a > b) errors.push(`realtime.slo.${k} ${a} is looser than realtime.sla.${k} ${b}`);
    }
    needSource('realtime', slo.realtime, errors);
  }
  return result('plan', errors, warnings);
}

export function checkModel(root, slug) {
  const w = file(root, slug, 'workload.json');
  const errors = [];
  const warnings = [];
  if (!w) return result('model', ['workload.json missing; /perf-model writes it']);
  if (!['open', 'closed'].includes(w.model)) errors.push('model: "open" (arrival rate) or "closed" (users), chosen on purpose (PS-B5)');
  if (!w.model_reason) errors.push('model_reason: say why this injection model');
  const personas = w.personas ?? [];
  const journeys = w.journeys ?? [];
  if (!personas.length) errors.push('personas: at least one');
  if (!journeys.length) errors.push('journeys: at least one');
  const share = personas.reduce((a, p) => a + (isNum(p.share_pct) ? p.share_pct : NaN), 0);
  if (!near(share, 100, 0.5)) errors.push(`personas: shares add up to ${share}, not 100`);
  const weight = journeys.reduce((a, j) => a + (isNum(j.weight_pct) ? j.weight_pct : NaN), 0);
  if (!near(weight, 100, 0.5)) errors.push(`journeys: weights add up to ${weight}, not 100`);
  for (const p of personas) needSource(`persona ${p.name}`, p, errors);
  const names = new Set(personas.map((p) => p.name));
  for (const j of journeys) {
    if (!names.has(j.persona)) errors.push(`journey ${j.name}: persona "${j.persona}" is not defined`);
    if (!Array.isArray(j.steps) || !j.steps.length) errors.push(`journey ${j.name}: steps (operationIds in order) required (PS-B2)`);
    if (!isNum(j.think_time_s)) errors.push(`journey ${j.name}: think_time_s must be a number (PS-B4)`);
    needSource(`journey ${j.name}`, j, errors);
  }
  const tgt = w.target ?? {};
  if (w.model === 'closed' && !isNum(tgt.users)) errors.push('target.users: a number for a closed model');
  if (w.model === 'open' && !isNum(tgt.arrival_rps)) errors.push('target.arrival_rps: a number for an open model');
  needSource('target', tgt, errors);
  // Little's law: users = throughput × (response time + think time). The model must show it holds.
  const L = w.littles_law;
  if (!L) errors.push("littles_law: show users = rps × (response_s + think_s) (PS-B1)");
  else if ([L.rps, L.response_s, L.think_s, L.users].every(isNum)) {
    const expect = L.rps * (L.response_s + L.think_s);
    if (!near(L.users, expect, Math.max(1, expect * 0.15))) errors.push(`littles_law: ${L.rps} × (${L.response_s} + ${L.think_s}) = ${Math.round(expect * 10) / 10}, not ${L.users}`);
  } else errors.push('littles_law: rps, response_s, think_s, users must be numbers');
  const slo = file(root, slug, 'slo.json');
  const sloNames = new Set((slo?.transactions ?? []).map((t) => t.name));
  for (const op of new Set(journeys.flatMap((j) => j.steps ?? []))) {
    if (slo && !sloNames.has(op)) warnings.push(`operation ${op} has no SLO; it is measured but not judged`);
  }
  return result('model', errors, warnings);
}

// `only`: check that one environment (the verdict of a run judges the one it used).
export function checkEnv(root, slug, only = null) {
  const env = file(root, slug, 'env.json');
  const errors = [];
  if (!env) return result('env', ['env.json missing; /perf-env writes it']);
  const names = Object.keys(env.environments ?? {});
  if (!names.length) errors.push('environments: at least one');
  for (const [name, e] of Object.entries(env.environments ?? {})) {
    if (only && name !== only) continue;
    if (e.production === true) errors.push(`${name}: marked production; never a load target`);
    if (e.approval !== undefined && !Array.isArray(e.approval.hosts)) errors.push(`${name}: approval.hosts must be a list of hosts`);
    if (!Array.isArray(e.allow_hosts) || !e.allow_hosts.length) errors.push(`${name}: allow_hosts must list the hosts this environment may load`);
    for (const p of e.allowed_profiles ?? []) if (!PROFILES.includes(p)) errors.push(`${name}: unknown profile "${p}"`);
    if (!(e.allowed_profiles ?? []).length) errors.push(`${name}: allowed_profiles must name at least smoke`);
    for (const tp of e.third_party ?? []) if (tp.stubbed !== true) errors.push(`${name}: third party "${tp.name}" is not stubbed`);
    if (!e.owner) errors.push(`${name}: owner (who authorises load on it) required`);
    if (!e.parity) errors.push(`${name}: parity (how close to production it is) required; the verdict quotes it`);
    // The ceilings of a breakpoint search, set by the owner (CONTRACTS §1a).
    for (const k of ['max_users', 'max_arrival_rps']) if (e[k] !== undefined && !(isNum(e[k]) && e[k] > 0)) errors.push(`${name}: ${k} must be a number above 0`);
  }
  return result('env', errors);
}

export function checkData(root, slug) {
  const m = file(root, slug, 'data/manifest.json');
  const w = file(root, slug, 'workload.json');
  const errors = [];
  if (!m) return result('data', ['data/manifest.json missing; /perf-data writes it']);
  const users = w?.target?.users ?? 0;
  if (!isNum(m.accounts?.count)) errors.push('accounts.count must be a number');
  else if (m.accounts.count < users && !m.accounts.shared_reason) {
    errors.push(`accounts.count ${m.accounts.count} < ${users} target users: users would share accounts and caches would flatter the result; add accounts or give shared_reason`);
  }
  if (!m.cleanup?.command) errors.push('cleanup.command: how run-id-prefixed data is removed after each run (PS-B6)');
  if (m.cleanup?.timeout_s !== undefined && !(isNum(m.cleanup.timeout_s) && m.cleanup.timeout_s > 0)) errors.push('cleanup.timeout_s: seconds before a hung cleanup is killed, a number > 0');
  if (m.run_id_prefix !== true) errors.push('run_id_prefix: written data must carry the run id so cleanup can find it');
  if (m.accounts?.secrets_in_repo) errors.push('accounts: credentials must come from an environment variable or a file outside git');
  // The volume plan (lib/volume.mjs): a target size per entity, and how to seed and count it.
  errors.push(...checkVolume(m.volume));
  return result('data', errors);
}

// The script step passes on a smoke run of the current scripts: done, no errors, every operation
// of the workload exercised.
export function checkScript(root, slug) {
  const w = file(root, slug, 'workload.json');
  const smokes = listRuns(root, slug)
    .map((r) => ({ r, spec: readJson(join(r.dir, 'run.json')), res: readJson(join(r.dir, 'result.json')) }))
    .filter((x) => x.spec?.profile?.name === 'smoke' && x.res);
  const last = smokes.at(-1);
  if (!last) return result('script', ['no smoke run yet: perf run with profile smoke']);
  const errors = [];
  if (last.res.run_state !== 'done') errors.push(`smoke ${last.r.id} ended ${last.res.run_state}`);
  if (last.res.total.failures > 0) errors.push(`smoke ${last.r.id} had ${last.res.total.failures} failures; smoke must be clean (PS-C3)`);
  const seen = new Set(Object.keys(last.res.endpoints ?? {}));
  for (const op of new Set((w?.journeys ?? []).flatMap((j) => j.steps ?? []))) if (!seen.has(op)) errors.push(`operation ${op} never ran in smoke ${last.r.id}`);
  return result('script', errors);
}

// The import step passes when every suite found was read: it names its operations, and either
// ai-perf can run it or the reason it cannot is written down.
export function checkImport(root, slug) {
  const imp = file(root, slug, 'import.json');
  if (!imp) return result('import', ['import.json missing; /perf-import writes it']);
  const errors = [];
  if (!imp.suites?.length) errors.push('suites: none imported; with no existing suite, use /perf-start');
  for (const s of imp.suites ?? []) {
    if (s.unnamed?.length) errors.push(`${s.path}:${s.unnamed.join(',')}: requests with ids in the URL have no name, so results split per id; name them (PS-D4)`);
    if (!s.operations?.length && s.tool !== 'in-house') errors.push(`${s.path}: no operation found; name its requests (PS-D4) or list them in workload.json by hand`);
    if (!s.runnable && !s.reason) errors.push(`${s.path}: not runnable and no reason given`);
  }
  return result('import', errors, (imp.suites ?? []).filter((s) => s.reason).map((s) => `${s.path}: ${s.reason}`));
}

export const CHECKS = { import: checkImport, plan: checkPlan, model: checkModel, env: checkEnv, data: checkData, script: checkScript };
