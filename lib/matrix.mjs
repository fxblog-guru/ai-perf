import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { REGRESSION, capacityOf, compareBaseline } from './verdict.mjs';
import { p95ChangeBound } from './stats.mjs';
import { mask } from './mask.mjs';

// A configuration matrix (perf matrix <matrix.json>): which setting is faster. Each variant sets
// one thing (an `apply` command run before its run, with its `env`, and/or a `spec` override such
// as engine_options), and every variant runs the same spec: same workload, same profile, same
// generator. The variants are ranked by one measure, and a difference the statistics cannot tell
// from noise is a tie, never a winner. A variant measured under another fingerprint than the one
// its setting declares changing is STALE: it is shown, not ranked. So is one that is fast because
// it fails: a variant is ranked only when its own verdict holds and its errors are the control's.

export const MEASURES = ['p95', 'capacity'];
// What a variant's spec override may not touch: those make it another test, or another generator,
// not another setting of the target.
export const FIXED = ['slug', 'environment', 'profile', 'target_url', 'engine', 'target', 'workers', 'timing', 'auto_stop'];
const PARTS = ['workload', 'architecture', 'environment', 'script', 'data'];
export const MATRIX_DEFAULT = { min_diff_pct: 5, min_diff_ms: 1, recheck: true };
// Variables a variant may not set: ai-perf's own (a worker's AI_PERF_TARGET_URL would load a host
// the allowlist never saw), the tools ai-perf runs (PERF_DOCKER, PERF_SSH, PERF_KUBECTL, PERF_HOME),
// Node's, and the ones that decide which program or library runs.
const ENV_DENY = /^(AI_PERF_|PERF_|NODE_|NPM_|LD_|DYLD_)|^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|SHELL|PYTHONPATH|PYTHONHOME|SYSTEMROOT|TEMP|TMP|TMPDIR)$/i;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function checkMatrix(m, root) {
  const errors = [];
  if (!isObject(m)) return ['not a JSON object'];
  if (m.name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(String(m.name))) errors.push('name: lower-case letters, digits and dashes');
  if (typeof m.spec !== 'string' || !existsSync(resolve(root, m.spec))) errors.push('spec: the run spec every variant runs, a path from the project root');
  if (m.measure !== undefined && !MEASURES.includes(m.measure)) errors.push(`measure: one of ${MEASURES.join(', ')}`);
  for (const k of ['min_diff_pct', 'min_diff_ms']) if (m[k] !== undefined && !(typeof m[k] === 'number' && Number.isFinite(m[k]) && m[k] >= 0)) errors.push(`${k}: a number >= 0`);
  if (m.recheck !== undefined && typeof m.recheck !== 'boolean') errors.push('recheck: true or false');
  if (m.transaction !== undefined && typeof m.transaction !== 'string') errors.push('transaction: an operation name');
  const vs = m.variants;
  if (!Array.isArray(vs) || vs.length < 2) { errors.push('variants: at least two'); return errors; }
  const names = new Set();
  for (const [i, v] of vs.entries()) {
    const at = `variants[${i}]`;
    if (!isObject(v)) { errors.push(`${at}: an object { name, apply?, env?, spec?, changes? }`); continue; }
    if (typeof v.name !== 'string' || !/^[\w.-]+$/.test(v.name)) errors.push(`${at}.name: letters, digits, . _ -`);
    else if (names.has(v.name)) errors.push(`${at}.name: ${v.name} is used twice`);
    else names.add(v.name);
    if (v.apply !== undefined && (typeof v.apply !== 'string' || !v.apply.trim())) errors.push(`${at}.apply: a shell command`);
    if (v.env !== undefined) {
      if (!isObject(v.env) || Object.values(v.env).some((x) => typeof x !== 'string')) errors.push(`${at}.env: { NAME: "value" }`);
      else for (const k of Object.keys(v.env)) if (ENV_DENY.test(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push(`${at}.env.${k}: a variant may not set this variable (ai-perf's own, its tools', Node's, or one that picks the program that runs)`);
    }
    if (v.spec !== undefined) {
      if (!isObject(v.spec)) errors.push(`${at}.spec: an object merged into the run spec`);
      else for (const k of FIXED) if (k in v.spec) errors.push(`${at}.spec.${k}: every variant runs the same ${k}; a matrix varies a setting, not the test`);
    }
    if (v.changes !== undefined && !Array.isArray(v.changes)) errors.push(`${at}.changes: a list of fingerprint parts`);
    else for (const c of v.changes ?? []) if (!PARTS.includes(c)) errors.push(`${at}.changes: ${c} is not a fingerprint part (${PARTS.join(', ')})`);
  }
  return errors;
}

// Objects merge key by key; anything else (arrays included) replaces.
export function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object' || Array.isArray(a)) return structuredClone(b);
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

// What goes into the matrix report: a value under a key that names a secret is hidden, and every
// string is masked as run evidence is (lib/mask.mjs).
const SECRET_KEY = /pass(word|wd)?|secret|token|api_?key|auth|credential|cookie/i;
export function maskDeep(x) {
  if (Array.isArray(x)) return x.map(maskDeep);
  if (isObject(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SECRET_KEY.test(k) ? '***' : maskDeep(v)]));
  return typeof x === 'string' ? mask(x) : x;
}

const pct = (a, b) => (a ? Math.round(((b - a) / a) * 1000) / 10 : null);

// p95: is `a` (lower) really faster than `b`? The bootstrap of both histograms must put the
// change's 95 % lower bound above zero in %, and at least min_diff_ms in ms; and the point change
// must reach min_diff_pct: a real but negligible difference is still a tie.
function fasterP95(a, b, minDiff, minMs) {
  if (!(b.value > a.value)) return { better: false, why: 'equal' };
  const change = pct(a.value, b.value);
  if (change < minDiff) return { better: false, why: `${change} % apart, under the ${minDiff} % that counts` };
  if (!a.hist || !b.hist) return { better: false, why: 'no histogram to test the difference' };
  const bound = p95ChangeBound(a.hist, b.hist);
  if (!(bound && bound.rel_pct > 0)) return { better: false, why: `+${change} % is not significant (95 % lower bound ${bound?.rel_pct ?? '?'} %)` };
  if (!(bound.abs_ms >= minMs)) return { better: false, why: `+${change} %, but at 95 % confidence only ${bound.abs_ms} ms, under the ${minMs} ms that counts` };
  return { better: true, why: `+${change} %, at least +${bound.rel_pct} % (${bound.abs_ms} ms) at 95 % confidence` };
}

// capacity: is `a` (higher) really above `b`? Only when b's first broken step broke clearly: past
// its SLA by more than the PS-F2 noise floor (p95 +10 % and +5 ms, or errors +0.5 pp). A step
// that missed by less could have held on another run.
export function brokeClearly(step, slo) {
  return slo.transactions.some((tx) => {
    const e = step?.endpoints?.[tx.name];
    if (!e || !tx.sla) return false;
    const p95 = e.p95_ms > tx.sla.p95_ms * (1 + REGRESSION.p95_pct / 100) && e.p95_ms - tx.sla.p95_ms > REGRESSION.p95_floor_ms;
    return p95 || (e.error_rate - tx.sla.error_rate) * 100 > REGRESSION.error_pp;
  });
}
function higherCapacity(a, b, slo) {
  if (!(a.value > b.value)) return { better: false, why: 'equal' };
  const { ok } = capacityOf(b.res.steps, slo);
  const broke = b.res.steps.find((s) => !ok(s));
  if (!broke?.complete) return { better: false, why: 'its first broken step was not completed' };
  if (!brokeClearly(broke, slo)) return { better: false, why: `its step ${broke.index + 1} missed the SLA by less than the noise floor` };
  return { better: true, why: `${b.name} broke clearly at step ${broke.index + 1}` };
}

const measured = (e, transaction) => (transaction ? e.res.endpoints?.[transaction] : e.res.total);

// Why an entry cannot be ranked, or null. The control is held to the same rules: the others are
// compared with it.
function unrankable(e, control, { measure, transaction, slo }) {
  if (e.status === 'apply_failed') return `not run: apply failed (${e.why})`;
  if (!e.res) return `no result${e.why ? `: ${e.why}` : ''}`;
  if (e.res.run_state !== 'done') return `run ended ${e.res.run_state}: not ranked`;
  // Fast because it fails is not faster: its own verdict must hold.
  if (e.outcome === 'FAIL' || e.outcome === 'NOT_EVALUABLE') return `verdict ${e.outcome}: not ranked${e.outcome_why ? ` (${e.outcome_why})` : ''}`;
  if (measure === 'p95') {
    const ep = measured(e, transaction);
    const sla = Math.min(...(slo?.transactions ?? []).map((t) => t.sla?.error_rate ?? Infinity));
    if (ep && ep.error_rate > sla) return `errors ${ep.error_rate} above the SLA error rate ${sla}: not ranked`;
    const ref = control?.res ? measured(control, transaction) : null;
    if (ep && ref && e !== control && (ep.error_rate - ref.error_rate) * 100 > REGRESSION.error_pp) return `errors ${ep.error_rate} against the control's ${ref.error_rate} (more than ${REGRESSION.error_pp} pp): not ranked`;
  }
  return null;
}

// entries: [{ name, run_id, res, hist, changes, status, outcome?, outcome_why?, recheck? }]; the
// first one is the control, and a { recheck: true } entry is the control run again at the end.
export function rank(entries, { measure = 'p95', transaction = null, slo = null, min_diff_pct: minDiff = MATRIX_DEFAULT.min_diff_pct, min_diff_ms: minMs = MATRIX_DEFAULT.min_diff_ms, recheck = null } = {}) {
  const variants = entries.filter((x) => !x.recheck);
  const control = variants[0];
  const opts = { measure, transaction, slo };
  const controlFlag = control ? unrankable(control, control, opts) : 'no variant';
  const rows = [];
  for (const e of variants) {
    const row = { name: e.name, run_id: e.run_id ?? null, status: e.status ?? 'ran', outcome: e.outcome ?? null, value: null, rank: null };
    rows.push(row);
    const flag = unrankable(e, control, opts);
    if (flag) { row.flag = flag; continue; }
    // Without its control, a variant has nothing it was meant to be compared with.
    if (e !== control && controlFlag) { row.flag = `not ranked: the control ${control.name} could not be (${controlFlag})`; continue; }
    if (e !== control) {
      // The setting may declare the fingerprint parts it changes (an apply that edits the script);
      // any other part that differs makes the variant another experiment.
      const fp = e.res.run.fingerprint && control.res.run.fingerprint
        ? { ...e.res.run.fingerprint, ...Object.fromEntries((e.changes ?? []).map((k) => [k, control.res.run.fingerprint[k]])) }
        : e.res.run.fingerprint;
      // A setting that declares the data changes its counted volume too.
      const volume = (e.changes ?? []).includes('data') ? control.res.run.volume : e.res.run.volume;
      const c = compareBaseline({ ...e.res, run: { ...e.res.run, fingerprint: fp, volume } }, control.res);
      if (c.stale) { row.flag = `STALE: the ${c.stale.join(', ')} changed beyond the setting; not ranked`; row.stale = c.stale; continue; }
      if (c.refused) { row.flag = `incomparable: ${c.refused}`; continue; }
    }
    if (measure === 'capacity') {
      if (!e.res.steps?.length || !slo) { row.flag = 'no staircase to read a capacity from'; continue; }
      const grid = (r) => r.steps.map((s) => s.users ?? s.arrival_rps).join(',');
      if (control.res.steps && grid(e.res) !== grid(control.res)) { row.flag = `incomparable: other steps (${grid(e.res)})`; continue; }
      const unit = e.res.run.model === 'open' ? 'arrival_rps' : 'users';
      row.value = capacityOf(e.res.steps, slo).cap?.[unit] ?? 0;
    } else {
      const ep = measured(e, transaction);
      if (!ep?.requests) { row.flag = `${transaction ?? 'total'} not measured`; continue; }
      row.value = ep.p95_ms;
      row.error_rate = ep.error_rate;
      row.requests = ep.requests;
      row.hist = transaction ? e.hist?.endpoints?.[transaction] : e.hist?.total;
      if (ep.requests < REGRESSION.min_requests) row.note = `${ep.requests} requests: too few to tell a difference`;
    }
    row.res = e.res;
  }
  // Groups: the best remaining variant leads; every variant it does not clearly beat ties with it.
  const better = measure === 'capacity' ? (a, b) => higherCapacity(a, b, slo) : (a, b) => fasterP95(a, b, minDiff, minMs);
  let left = rows.filter((r) => r.value !== null).sort((a, b) => (measure === 'capacity' ? b.value - a.value : a.value - b.value));
  const groups = [];
  while (left.length) {
    const lead = left[0];
    const group = [lead];
    for (const r of left.slice(1)) {
      const d = better(lead, r);
      if (d.better) r.behind = { of: lead.name, why: d.why };
      else { group.push(r); r.tie = { with: lead.name, why: d.why }; delete r.behind; }
    }
    groups.push(group.map((r) => r.name));
    for (const r of group) r.rank = groups.length;
    left = left.filter((r) => !group.includes(r));
  }
  // The control run again at the end: how far the environment itself moved during the matrix.
  const again = entries.find((e) => e.recheck);
  const asked = recheck ?? Boolean(again);
  let drift = null;
  if (asked) {
    const first = rows.find((r) => r.name === control?.name);
    const twiceFlag = again ? unrankable(again, control, opts) : 'the recheck did not run';
    if (twiceFlag || first?.value === null || first?.value === undefined) drift = { checked: false, why: `the control was not measured twice (${twiceFlag ?? 'its first run was not ranked'})` };
    else {
      const twice = measure === 'capacity'
        ? { value: capacityOf(again.res.steps ?? [], slo).cap?.[again.res.run.model === 'open' ? 'arrival_rps' : 'users'] ?? 0 }
        : { value: measured(again, transaction)?.p95_ms ?? null, hist: transaction ? again.hist?.endpoints?.[transaction] : again.hist?.total };
      const moved = measure === 'capacity'
        ? twice.value !== first.value
        : ([fasterP95(first, twice, minDiff, minMs), fasterP95(twice, first, minDiff, minMs)].some((d) => d.better));
      drift = { checked: true, run_id: again.run_id, first: first.value, again: twice.value, moved, moved_pct: Math.abs(pct(first.value, twice.value) ?? 0) };
    }
  }
  const ranked = rows.filter((r) => r.rank !== null);
  const top = groups[0] ?? [];
  // The winner's lead over the best of the rest: it must be larger than the control's own move.
  const runnerUp = ranked.filter((r) => r.rank > 1).sort((a, b) => (measure === 'capacity' ? b.value - a.value : a.value - b.value))[0];
  const lead = top.length === 1 && runnerUp ? Math.abs(pct(rows.find((r) => r.name === top[0]).value, runnerUp.value)) : null;
  let winner = null;
  let verdict;
  if (controlFlag) verdict = `no ranking: the control ${control?.name ?? '?'} could not be ranked (${controlFlag})`;
  else if (ranked.length < 2) verdict = `fewer than two variants could be ranked: ${rows.filter((r) => r.flag).map((r) => `${r.name} (${r.flag})`).join('; ') || 'none measured'}`;
  else if (drift && !drift.checked) verdict = `no winner: a recheck of the control was asked for and could not be made (${drift.why})`;
  else if (drift?.moved) verdict = `no winner: the control ${control.name} measured ${drift.first} then ${drift.again} (${drift.moved_pct} %), a significant change: the environment moved during the matrix`;
  // The control's own move is the environment's noise this time: the lead must still count after it.
  else if (top.length === 1 && drift && lead !== null && measure === 'p95' && lead - drift.moved_pct < minDiff) verdict = `no winner: ${top[0]} leads ${runnerUp.name} by ${lead} %, not enough over the ${drift.moved_pct} % the control moved between its two runs (${minDiff} % must remain)`;
  else if (top.length === 1) { winner = top[0]; verdict = `${winner} wins on ${measure === 'capacity' ? 'capacity' : `p95 of ${transaction ?? 'all requests'}`}`; }
  else verdict = `no winner: ${top.join(', ')} tie (within noise)`;
  for (const r of rows) { delete r.res; delete r.hist; }
  return { measure, transaction, min_diff_pct: minDiff, min_diff_ms: minMs, rows, groups, winner, lead_pct: lead, drift, verdict, ranked: ranked.length };
}

export function renderMatrix(m) {
  const unit = m.measure === 'capacity' ? 'capacity' : `p95 ms (${m.transaction ?? 'all requests'})`;
  const lines = [`# Matrix: ${m.name}`, '', `**${m.verdict}.**`, '', `Spec \`${m.spec}\`, ranked by ${unit}; a difference counts when it is significant at 95 % and at least ${m.min_diff_pct} % and ${m.min_diff_ms} ms (p95), or a clear break past the SLA (capacity). A variant whose verdict is FAIL or NOT EVALUABLE, or whose errors exceed the SLA or the control's by more than ${REGRESSION.error_pp} pp, is not ranked.`, '',
    `| Rank | Variant | ${unit} | Run | Against the leader |`, '|---|---|---|---|---|'];
  for (const r of [...m.rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))) {
    lines.push(`| ${r.rank ?? '—'} | ${r.name} | ${r.value ?? '—'} | ${r.run_id ? `\`${r.run_id}\`` : '—'} | ${r.flag ?? (r.tie ? `tie with ${r.tie.with}: ${r.tie.why}` : r.behind ? `behind ${r.behind.of}: ${r.behind.why}` : 'leads')}${r.note ? `; ${r.note}` : ''} |`);
  }
  lines.push('');
  if (m.drift?.checked) lines.push(`Control run twice: ${m.drift.first} then ${m.drift.again} (\`${m.drift.run_id}\`), a move of ${m.drift.moved_pct} %: ${m.drift.moved ? 'significant, so the environment moved and no winner is declared' : `not significant${m.lead_pct !== null && m.lead_pct !== undefined ? `; the leader's margin is ${m.lead_pct} %` : ''}`}.`, '');
  else if (m.drift) lines.push(`Control not rechecked: ${m.drift.why}; no winner is declared without it.`, '');
  else lines.push('Control not rechecked (recheck: false): drift of the environment during the matrix is not ruled out.', '');
  return lines.join('\n');
}

export function writeMatrix(root, slug, m) {
  const base = join(projectDir(root, slug), `matrix-${m.name}`);
  writeJson(`${base}.json`, m);
  writeFileSync(`${base}.md`, renderMatrix(m));
  return `${base}.md`;
}
