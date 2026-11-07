import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { mask } from './mask.mjs';
import { listRuns } from './runs.mjs';
import { markPushed, perfHome } from './learn.mjs';
import { FIXES } from './remedy.mjs';
import { mkdirSync } from 'node:fs';

// What ai-perf knows about a project, in two forms (design §13, P2):
// - the brief: everything that matters in one short page, written after every judged run and read
//   at the start of every step instead of the dozen files behind it. Its size is capped, so a
//   project with a hundred runs costs the AI as many tokens as one with two;
// - the outbox: the same knowledge as one fact per entry, for Recall, the team's shared memory.
//   The AI pushes what is pending and records it; what changed later is pushed again as a
//   successor of the entry it replaces. What the team already knows comes back with --import and
//   is part of the brief.

export const BRIEF_MAX_LINES = 60;
// About 1500 tokens: every section fits at its own cap, so in practice nothing is left out.
export const BRIEF_MAX_CHARS = 6000;
const LINE_MAX = 160;
// Lines per section; a section with more says how many it left out.
const SECTION_MAX = 6;
const RECALL_BODY_MAX = 2000;
const RECALLED_KEEP = 50;

const clip = (s, n = LINE_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const listOf = (xs, n = 4) => (xs.length > n ? `${xs.slice(0, n).join(', ')} +${xs.length - n}` : xs.join(', '));

function lastJudged(root, slug) {
  for (const r of [...listRuns(root, slug)].reverse()) {
    const v = readJson(join(r.dir, 'verdict.json'));
    if (v) return { id: r.id, v, res: readJson(join(r.dir, 'result.json')) };
  }
  return null;
}

function baselines(dir) {
  const out = [];
  const b = join(dir, 'baselines');
  let envs = [];
  try { envs = readdirSync(b); } catch { return out; }
  for (const env of envs) {
    let files = [];
    try { files = readdirSync(join(b, env)).filter((f) => f.endsWith('.json') && !f.endsWith('.hist.json')); } catch { continue; }
    for (const f of files) {
      const res = readJson(join(b, env, f));
      if (res?.total) out.push({ env, profile: f.slice(0, -5), run: res.run?.id ?? '?', rps: res.total.rps, p95: res.total.p95_ms, errors: res.total.error_rate });
    }
  }
  return out;
}

// The brief, as sections in order of importance. `step` keeps the lessons to that step's.
export function brief(root, slug, { step } = {}) {
  const dir = projectDir(root, slug);
  const ctx = readJson(join(dir, 'context.json'));
  const assumptions = readJson(join(dir, 'assumptions.json')) ?? [];
  const w = readJson(join(dir, 'workload.json'));
  const slo = readJson(join(dir, 'slo.json'));
  const envs = readJson(join(dir, 'env.json'))?.environments ?? {};
  const lessons = readJson(join(dir, 'lessons.json'))?.lessons ?? [];
  const learned = readJson(join(dir, 'learned.json'));
  const recalled = readJson(join(dir, 'recalled.json'))?.entries ?? [];
  const last = lastJudged(root, slug);
  const sections = [];
  const section = (title, lines) => { if (lines.length) sections.push({ title, lines }); };

  const f = ctx?.facts ?? {};
  section('System', [
    ...(ctx ? [`${ctx.system_kind ?? 'kind unknown'}; stack ${listOf(f.stack ?? []) || '?'}; services ${listOf(f.compose_services ?? []) || '?'}; datastores ${listOf(f.datastores ?? []) || 'none found'}${f.realtime?.length ? `; realtime ${listOf(f.realtime)}` : ''}`] : ['not discovered yet: /perf-discover']),
    ...(f.operations?.length ? [`${f.operations.length} operation(s) in ${listOf(f.openapi ?? [], 2)}`] : []),
    ...(f.existing_suites?.length ? [`existing suites: ${listOf(f.existing_suites.map((s) => `${s.tool} ${s.path}`))}`] : []),
  ]);
  const open = assumptions.filter((a) => a.status !== 'confirmed');
  section('Decided', [
    ...(w ? [`workload: ${w.model ?? '?'} model, ${w.target?.arrival_rps ? `${w.target.arrival_rps} rps` : `${w.target?.users ?? '?'} users`} (${w.target?.source ?? '?'}), ${(w.journeys ?? []).length} journey(s)`] : []),
    ...(slo ? [`SLOs: ${(slo.transactions ?? []).length} transaction(s), p95 ${[...new Set((slo.transactions ?? []).map((t) => t.slo?.p95_ms).filter(Boolean))].join('/') || '?'} ms, ${(slo.transactions ?? []).filter((t) => t.source === 'confirmed').length} confirmed; profiles ${listOf(slo.profiles ?? [])}`] : []),
    ...Object.entries(envs).map(([n, e]) => `env ${n}: ${e.production ? 'PRODUCTION (refused)' : e.parity ?? 'parity ?'}; owner ${e.owner ?? 'none'}${e.monitor ? `; monitor ${e.monitor.metrics}` : ''}`),
    ...(open.length ? [`${open.length} open assumption(s): ${listOf(open.map((a) => `${a.key}=${a.value}`), 3)}`] : []),
    ...((ctx?.questions ?? []).length ? [`${ctx.questions.length} question(s) waiting: ${listOf(ctx.questions.map((q) => q.key), 3)}`] : []),
  ]);
  section('Measured', [
    ...baselines(dir).map((b) => `baseline ${b.env}/${b.profile}: ${b.rps} rps, p95 ${b.p95} ms, errors ${b.errors} (run ${b.run})`),
    ...(last ? [`last verdict: ${last.v.outcome} (run ${last.id})${last.v.summary ? `: ${last.v.summary}` : ''}`] : ['no judged run yet']),
    ...(last?.v.capacity ? [`capacity: ${last.v.capacity.value} ${last.v.capacity.unit}${last.v.capacity.headroom ? `, headroom ×${last.v.capacity.headroom}` : ''}`] : []),
  ]);
  const settings = Object.entries(learned?.profiles ?? {}).flatMap(([p, s]) => Object.entries(s).map(([k, v]) => `${p}: ${k} ${v}`));
  const person = (learned?.fixes ?? []).filter((x) => x.status === 'needs_person');
  section('Learned', [
    ...(settings.length ? [`applied to every run: ${listOf(settings, 6)}`] : []),
    ...(learned?.fixes ?? []).filter((x) => x.status === 'recurred' || x.status === 'applied').slice(-3).map((x) => `fix ${x.status}: ${x.profile} ${x.field} ${x.from} → ${x.to} (${x.lesson})`),
    ...person.slice(-3).map((x) => `needs a person: ${x.lesson}: ${x.why}`),
  ]);
  const mine = lessons.filter((l) => !step || l.step === step);
  section(step ? `Lessons for ${step}` : 'Lessons', mine.slice(0, 5).map((l) => `${l.step ?? '-'}: ${l.text} (${l.runs.length}×)`)
    .concat(mine.length > 5 ? [`… ${mine.length - 5} more: perf lessons --slug ${slug}${step ? ` --step ${step}` : ''}`] : []));
  section('From the team (Recall)', recalled.slice(-4).reverse().map((e) => `${e.kind ?? 'note'}: ${e.title}`)
    .concat(recalled.length > 4 ? [`… ${recalled.length - 4} more in recalled.json`] : []));
  const pending = outbox(root, slug).length;
  if (pending) section('To share', [`${pending} fact(s) not in Recall yet: perf share --slug ${slug}`]);

  // The cap: each section at most SECTION_MAX lines, then sections in order of importance while
  // they fit. What does not fit is named, never silently lost.
  const lines = [clip(`# ${slug}: what ai-perf knows`), ''];
  let chars = lines.join('\n').length;
  const left = [];
  for (const s of sections) {
    const shown = s.lines.length > SECTION_MAX ? [...s.lines.slice(0, SECTION_MAX - 1), `… ${s.lines.length - SECTION_MAX + 1} more in .perf/${slug}/`] : s.lines;
    const block = [`## ${s.title}`, ...shown.map((l) => `- ${clip(mask(l))}`), ''];
    const size = block.join('\n').length + 1;
    if (left.length || lines.length + block.length > BRIEF_MAX_LINES - 2 || chars + size > BRIEF_MAX_CHARS - 160) { left.push(s.title); continue; }
    lines.push(...block);
    chars += size;
  }
  if (left.length) lines.push(clip(`(left out to stay short: ${left.join(', ')}; the files are in .perf/${slug}/)`));
  return lines.join('\n');
}

export function writeBrief(root, slug) {
  const text = brief(root, slug);
  writeFileSync(join(projectDir(root, slug), 'brief.md'), `${text}\n`);
  return text;
}

// ---- Recall ------------------------------------------------------------------------------------

// The label the team's Recall knows this project by: its repository's name (else the folder's).
export function projectLabel(root) {
  const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const url = r.status === 0 ? r.stdout.trim() : '';
  return basename(url ? url.replace(/\.git$/, '').replace(/[:\\]/g, '/') : resolve(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

const hash = (e) => createHash('sha256').update(`${e.kind}\n${e.title}\n${e.body}`).digest('hex').slice(0, 16);
const fact = (key, kind, title, body, tags, project) => ({
  key, kind, title: clip(mask(title), 120), body: clip(mask(body), RECALL_BODY_MAX), tags: ['ai-perf', ...tags], ...(project ? { project } : {}),
});

// Every fact worth sharing, one per entry, in Recall's kinds. Lessons about running ai-perf are
// instance-wide (no project): every team's runs teach them. Everything else carries the project.
export function facts(root, slug) {
  const dir = projectDir(root, slug);
  const project = projectLabel(root);
  const out = [];
  for (const l of readJson(join(dir, 'lessons.json'))?.lessons ?? []) {
    // Only what stays true is in a body: no run counts or project numbers, or every run would push
    // a successor. Tool lessons say whether ai-perf fixes them itself, not how it did here.
    const fix = FIXES[l.id] ? ' ai-perf fixes it itself in the next run of the profile, and checks the fix.' : ' ai-perf does not fix it itself: a person does.';
    if (l.kind === 'run') out.push(fact(`lesson:${l.id}`, 'lesson', `ai-perf ${l.step ?? ''}: ${l.text.split('. ')[0]}`, `${l.text}${fix}`, [l.step ?? 'run'], null));
    else out.push(fact(`lesson:${l.id}`, 'defect_pattern', `${slug}: ${l.text.split('. ')[0]}`, `${l.text} First seen in run ${l.first_seen} of ${slug}.`, [slug, l.step ?? 'analyze'], project));
  }
  const w = readJson(join(dir, 'workload.json'));
  if (w?.target?.source === 'confirmed') {
    const journeys = (w.journeys ?? []).map((j) => `${j.name} ${j.weight_pct} %`).join(', ');
    out.push(fact('decision:workload', 'decision', `${slug}: load model`, `${slug} is tested as a ${w.model} model of ${w.target.arrival_rps ? `${w.target.arrival_rps} rps` : `${w.target.users} users`}${w.model_reason ? ` (${w.model_reason})` : ''}; journeys ${journeys || 'none'}. Confirmed by the team.`, [slug], project));
  }
  const confirmed = (readJson(join(dir, 'slo.json'))?.transactions ?? []).filter((t) => t.source === 'confirmed');
  if (confirmed.length) out.push(fact('decision:slo', 'decision', `${slug}: agreed SLOs`, `${slug} SLOs agreed with the owner: ${confirmed.map((t) => `${t.name} p95 ${t.slo?.p95_ms} ms, errors ${t.slo?.error_rate}`).join('; ')}.`, [slug], project));
  for (const [name, e] of Object.entries(readJson(join(dir, 'env.json'))?.environments ?? {})) {
    if (e.production) continue;
    const stubs = (e.third_party ?? []).map((t) => `${t.name} ${t.stubbed ? 'stubbed' : 'NOT stubbed'}`).join(', ');
    out.push(fact(`env_note:env:${name}`, 'env_note', `${slug}: perf environment ${name}`, `${slug} load environment ${name}: ${e.parity ?? 'parity not stated'}; load authorised by ${e.owner ?? 'nobody yet'}${stubs ? `; third parties: ${stubs}` : ''}.`, [slug, name], project));
  }
  for (const b of baselines(dir)) {
    out.push(fact(`env_note:baseline:${b.env}/${b.profile}`, 'env_note', `${slug}: ${b.profile} baseline on ${b.env}`, `${slug} ${b.profile} baseline on ${b.env}: ${b.rps} rps, p95 ${b.p95} ms, error rate ${b.errors} (run ${b.run}). Later runs are compared with it.`, [slug, b.env, b.profile], project));
  }
  const last = lastJudged(root, slug);
  if (last?.v.capacity?.value) {
    const c = last.v.capacity;
    out.push(fact(`env_note:capacity:${last.res?.run?.environment ?? 'env'}`, 'env_note', `${slug}: capacity on ${last.res?.run?.environment ?? 'its environment'}`, `${slug} held ${c.value} ${c.unit}${c.rps ? ` (${c.rps} rps)` : ''} within its SLAs on ${last.res?.run?.environment ?? 'its environment'}${c.headroom ? `, ×${c.headroom} the planned peak` : ''} (run ${last.id}).`, [slug], project));
  }
  return out;
}

const sharedPath = (root, slug) => join(projectDir(root, slug), 'shared.json');

// What Recall does not have yet: new facts, and changed ones as successors of what they replace.
// Instance-wide facts (no project) are shared once for every project on this machine.
const globalShared = () => join(perfHome(), 'shared.json');
function sharedState(root, slug) {
  const mine = readJson(sharedPath(root, slug))?.entries ?? {};
  const all = readJson(globalShared())?.entries ?? {};
  // Lessons pushed before shared.json existed (perf learn --pushed) are in Recall already.
  const before = new Set((readJson(join(projectDir(root, slug), 'lessons.json'))?.lessons ?? []).filter((l) => l.pushed).map((l) => `lesson:${l.id}`));
  return (e) => (e.project ? mine[e.key] : all[e.key] ?? mine[e.key]) ?? (before.has(e.key) ? { hash: hash(e), recall_id: null } : undefined);
}
export function outbox(root, slug) {
  if (!existsSync(projectDir(root, slug))) return [];
  const done = sharedState(root, slug);
  return facts(root, slug).filter((e) => done(e)?.hash !== hash(e))
    .map((e) => ({ ...e, ...(done(e)?.recall_id ? { supersedes_id: done(e).recall_id } : {}) }));
}

// The AI pushed these: `key` or `key=recall id`. Only pending facts are recorded, as they are now.
export function markShared(root, slug, items) {
  const path = sharedPath(root, slug);
  const doc = readJson(path) ?? { entries: {} };
  const pending = new Map(outbox(root, slug).map((e) => [e.key, e]));
  const done = [];
  const wide = [];
  for (const item of items) {
    const i = item.indexOf('=');
    const key = i < 0 ? item : item.slice(0, i);
    const e = pending.get(key);
    if (!e) continue;
    const rec = { hash: hash(e), recall_id: i < 0 ? doc.entries[key]?.recall_id ?? null : item.slice(i + 1), pushed_at: new Date().toISOString() };
    doc.entries[key] = rec;
    if (!e.project) wide.push([key, rec]);
    done.push(key);
  }
  writeJson(path, doc);
  if (wide.length) {
    mkdirSync(perfHome(), { recursive: true });
    const g = readJson(globalShared()) ?? { entries: {} };
    for (const [k, rec] of wide) g.entries[k] = rec;
    writeJson(globalShared(), g);
  }
  // Lessons keep their own flag too: lessons.md says which are in Recall.
  markPushed(root, slug, done.filter((k) => k.startsWith('lesson:')).map((k) => k.slice(7)));
  return done;
}

// What the team already knows, from knowledge_search results the AI saved to a file: kept short
// (the newest RECALLED_KEEP), deduplicated by id, and read through the brief.
export function importRecalled(root, slug, entries) {
  const path = join(projectDir(root, slug), 'recalled.json');
  const doc = readJson(path) ?? { entries: [] };
  const byId = new Map(doc.entries.map((e) => [e.id, e]));
  let added = 0;
  // Taken last to first, so the search's first (most relevant) result is the newest; one seen
  // before moves up to where this search put it.
  for (const e of [].concat(entries ?? []).reverse()) {
    if (!e || typeof e !== 'object' || !e.id || !e.title) continue;
    if (!byId.has(String(e.id))) added++;
    byId.delete(String(e.id));
    byId.set(String(e.id), { id: String(e.id), kind: e.kind ?? null, title: clip(mask(String(e.title)), 120), body: clip(mask(String(e.body ?? '')), 600), project: e.project ?? null });
  }
  const kept = [...byId.values()].slice(-RECALLED_KEEP);
  writeJson(path, { updated_at: new Date().toISOString(), entries: kept });
  return { added, kept: kept.length };
}
