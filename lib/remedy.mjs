import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../controller/files.mjs';
import { SMOKE_MAX } from '../controller/spec.mjs';
import { projectDir } from './checks.mjs';

// Self-correction (design §13, P2): run, learn, fix, run again, check the fix. A lesson about
// running the tool whose cure is known, and which touches only how the load is generated, is
// fixed by ai-perf itself in the next run of the same profile. The system under test, the load it
// is asked to carry, the SLOs and the environment are never changed here: those lessons go to a
// person. Every fix is checked by the next run that used it: verified when the lesson did not
// come back, recurred when it did. A fix that recurred twice is rolled back and goes to a person.

// A worker's CPU after the fix: well under the saturation line (timing.saturation_pct, 80).
const BUSY_PCT = 60;
// Recurrences of one lesson's fixes, in one profile, before ai-perf stops trying.
export const MAX_RECURRED = 2;
const VU_CAP = 10000;
// Workers per ssh host at most: their cores are not known from here.
const PER_HOST = 8;
const CLUSTER_CAP = 64;

// The fields a fix may move, read and written on a run spec (raw or normalised).
const DEFAULTS = { workers: 1, 'profile.rampdown_s': 0, 'profile.users': 0 };
export const getField = (spec, field) => {
  const v = field.startsWith('profile.') ? spec.profile?.[field.slice(8)] : spec[field];
  return v ?? DEFAULTS[field];
};
export function setField(spec, field, value) {
  if (field.startsWith('profile.')) spec.profile[field.slice(8)] = value;
  else spec[field] = value;
}

// What a learned setting is for: one profile, run as one model, on one kind of target. A setting
// learned on a cluster never reaches a laptop, and a VU cap learned by an open run never becomes
// the users of a closed one.
export const modelOf = (spec) => (spec.profile?.arrival_rps !== undefined || spec.profile?.model === 'open' ? 'open' : 'closed');
export const keyOf = (spec) => `${spec.profile?.name ?? 'unknown'}/${modelOf(spec)}/${spec.target ?? 'local'}`;

function workerCap(run) {
  let cap = run.target === 'ssh' ? PER_HOST * (run.ssh?.hosts?.length ?? 1) : run.target === 'k8s' ? CLUSTER_CAP : cpus().length;
  // A closed loop gives each worker whole users: a worker with none sends nothing.
  if (modelOf(run) === 'closed' && run.profile?.users) cap = Math.min(cap, Math.floor(run.profile.users));
  return cap;
}

// Each fix reads the run that taught the lesson (its run.json and result.json) and returns the
// change for the next run, `{ cannot }` when none fits, or null when the run cannot tell.
export const FIXES = {
  // More workers carry the same users: each generator does less, the target gets the same load.
  'problem:generator_saturated': (run, res) => {
    const from = run.workers;
    const hot = Math.max(0, ...(res?.workers ?? []).map((w) => w.cpu_max_pct ?? 0));
    let to = Math.max(from + 1, Math.ceil((from * hot) / BUSY_PCT));
    // Pegged at 100 %: the real demand is above what shows, so at least double.
    if (hot >= 99) to = Math.max(to, 2 * from);
    const cap = workerCap(run);
    if (from >= cap) return { cannot: `already ${from} worker(s), the most this ${run.target ?? 'local'} run can use: more need other or larger machines, a person's choice` };
    return { field: 'workers', from, to: Math.min(to, cap) };
  },
  // A sidecar engine that started late is stopped before its steady state ended: rampdown longer
  // than the lag gives it the time. Rampdown is after the measured window, so nothing measured moves.
  'problem:engine_start_lag': (run, res) => {
    const lag = Math.max(0, ...(res?.problems ?? []).filter((p) => p.kind === 'engine_start_lag').map((p) => p.data?.lag_s ?? 0));
    // A run from before the lag was recorded teaches nothing here.
    if (!lag) return null;
    const from = getField(run, 'profile.rampdown_s');
    return { field: 'profile.rampdown_s', from, to: Math.max(from + 1, Math.ceil(lag + 1)) };
  },
  // Open model: users is only the cap on virtual users. A higher cap lets the engine start the
  // arrivals the plan asked for; the rate itself does not change.
  'problem:arrival_shortfall': (run) => {
    if (modelOf(run) !== 'open') return null;
    const from = getField(run, 'profile.users');
    const cap = run.profile?.name === 'smoke' ? SMOKE_MAX.users : VU_CAP;
    if (from >= cap) return { cannot: `already ${from} virtual users, the most a ${run.profile?.name} run may have: the target is too slow to hold the rate, which is a finding` };
    return { field: 'profile.users', from, to: Math.min(cap, Math.max(from + 1, 2 * from)) };
  },
};

export const learnedPath = (root, slug) => join(projectDir(root, slug), 'learned.json');
const resetPath = (root, slug) => join(projectDir(root, slug), 'learn-reset.json');

// A run that was stopped (by a person, an auto-stop, the target dying, the deadline) did not run
// its course: it teaches no fix and checks none. One without a measured window checks none either.
const ranItsCourse = (res) => res && res.run_state !== 'aborted';
const measured = (res) => ranItsCourse(res) && !(res.problems ?? []).some((p) => p.kind === 'no_measured_window');

// Replays every judged run in start order: which fixes were made, which later runs used them, and
// whether their lesson came back. Recomputed from the runs every time, so it never drifts from them.
// `runs` are { id, dir, ids } with `ids` the lesson ids the run taught.
export function selfCorrect(root, slug, runs) {
  const settings = {};
  const fixes = [];
  // `perf learn --reset <lesson>`: a person looked; the runs before that point no longer count.
  const reset = readJson(resetPath(root, slug)) ?? {};
  for (const r of runs) {
    const run = readJson(join(r.dir, 'run.json'));
    const res = readJson(join(r.dir, 'result.json'));
    if (!run) continue;
    const key = keyOf(run);
    // A fix is checked by the first later run of its key that ran with it (or more) to the end.
    if (measured(res)) {
      for (const f of fixes) {
        if (f.key !== key || f.status !== 'applied' || r.id <= f.run) continue;
        if (getField(run, f.field) >= f.to) Object.assign(f, { status: r.ids.has(f.lesson) ? 'recurred' : 'verified', checked_by: r.id });
      }
    }
    if (!ranItsCourse(res)) continue;
    for (const id of r.ids) {
      const fix = FIXES[id];
      if (!fix || (reset[id] && r.id <= reset[id])) continue;
      const mine = fixes.filter((f) => f.key === key && f.lesson === id && !(reset[id] && f.run <= reset[id]));
      if (mine.some((f) => f.terminal)) continue;
      if (mine.filter((f) => f.status === 'recurred').length >= MAX_RECURRED) {
        // Shown not to help: no longer applied. Until a person resets it, nothing more is tried.
        const field = mine.find((f) => f.field)?.field;
        if (field) delete settings[key]?.[field];
        fixes.push({ lesson: id, profile: run.profile?.name, key, field, run: r.id, status: 'needs_person', terminal: true, why: `fixed ${MAX_RECURRED} times and it came back each time; the fix is rolled back` });
        continue;
      }
      const c = fix(run, res);
      if (!c) continue;
      // No fix fits now; a later run (another target, a larger machine) may still get one.
      if (c.cannot) {
        if (mine.at(-1)?.why !== c.cannot) fixes.push({ lesson: id, profile: run.profile?.name, key, run: r.id, status: 'needs_person', why: c.cannot });
        continue;
      }
      const prof = (settings[key] ??= {});
      // Learned settings only grow: a run made without them (--no-learned) teaches nothing new.
      if ((prof[c.field] ?? -Infinity) >= c.to) continue;
      prof[c.field] = c.to;
      fixes.push({ lesson: id, profile: run.profile?.name, key, field: c.field, from: c.from, to: c.to, run: r.id, status: 'applied' });
    }
  }
  for (const k of Object.keys(settings)) if (!Object.keys(settings[k]).length) delete settings[k];
  const doc = { updated_at: new Date().toISOString(), profiles: settings, fixes };
  writeJson(learnedPath(root, slug), doc);
  return doc;
}

// A person looked at a lesson: its fixes start over from the next run.
export function resetLesson(root, slug, lesson, lastRun) {
  const doc = readJson(resetPath(root, slug)) ?? {};
  doc[lesson] = lastRun;
  writeJson(resetPath(root, slug), doc);
}

// What `perf run` takes from earlier runs: the learned settings of this profile, model and target,
// applied to the raw spec before it is checked. A value the spec already sets higher is kept.
export function applyLearned(root, raw) {
  if (!raw?.slug || !raw.profile?.name) return [];
  const doc = readJson(learnedPath(root, raw.slug));
  const key = keyOf(raw);
  const set = doc?.profiles?.[key] ?? {};
  const out = [];
  for (const [field, to] of Object.entries(set)) {
    if (!(field in DEFAULTS)) continue;
    if (field === 'profile.users' && modelOf(raw) !== 'open') continue;
    const from = getField(raw, field);
    if (!(to > from)) continue;
    setField(raw, field, to);
    const why = [...(doc.fixes ?? [])].reverse().find((f) => f.key === key && f.field === field && f.to === to);
    out.push({ field, from, to, lesson: why?.lesson ?? null, run: why?.run ?? null });
  }
  return out;
}

// Tool-level learning: a lesson about running ai-perf that two projects taught becomes a draft
// patch to the skill of the step that acts on it, ready for `git apply` in the bundle. It is a
// proposal: nothing here edits the bundle.
const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_OF = {
  plan: 'planning-perf-tests', model: 'modeling-workload', env: 'checking-perf-environment',
  data: 'preparing-perf-data', script: 'generating-load-script', run: 'executing-load', analyze: 'analyzing-perf-results',
};
export const LESSONS_HEADING = '## Lessons from other projects';
export function draftPatch(lesson, bundle = BUNDLE) {
  const rel = `skills/${SKILL_OF[lesson.step]}/SKILL.md`;
  const path = join(bundle, rel);
  if (!SKILL_OF[lesson.step] || !existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  // The patch keeps the file's line ends, so it applies to a CRLF checkout as well.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const text = raw.replace(/\r\n/g, '\n');
  // Already in the skill: nothing to propose.
  if (text.includes(lesson.text)) return null;
  const newline = text.endsWith('\n');
  const body = (newline ? text.slice(0, -1) : text).split('\n');
  // Under the heading, after the section's last line (before the next heading); the heading is
  // added at the end once.
  const h = body.indexOf(LESSONS_HEADING);
  let at = body.length;
  let add = ['', LESSONS_HEADING, '', `- ${lesson.text}`];
  if (h >= 0) {
    const next = body.findIndex((l, i) => i > h && /^#{1,2} /.test(l));
    at = next < 0 ? body.length : next;
    while (at > h + 1 && body[at - 1] === '') at--;
    add = [...(at === h + 1 ? [''] : []), `- ${lesson.text}`];
  }
  const before = body.slice(Math.max(0, at - 3), at);
  const after = body.slice(at, at + 3);
  const start = at - before.length + 1;
  const old = before.length + after.length;
  const lines = [...before.map((l) => ` ${l}`), ...add.map((l) => `+${l}`), ...after.map((l) => ` ${l}`)];
  // A file without a final newline: its last line is replaced by itself with one.
  if (!newline && at === body.length) {
    lines.splice(before.length - 1, 1, `-${body.at(-1)}`, '\\ No newline at end of file', `+${body.at(-1)}`);
  } else if (!newline && at + after.length === body.length) lines.push('\\ No newline at end of file');
  const header = `@@ -${start},${old} +${start},${old + add.length} @@`;
  // A line the file ends without (the one before the marker) has no line end of its own.
  const content = lines.map((l, i) => `${l}${l.startsWith('\\') || lines[i + 1]?.startsWith('\\') ? '\n' : eol}`);
  return { file: rel, patch: [`--- a/${rel}\n`, `+++ b/${rel}\n`, `${header}\n`, ...content].join('') };
}
