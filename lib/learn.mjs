import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { listRuns } from './runs.mjs';
import { FIXES, draftPatch, selfCorrect } from './remedy.mjs';

// /perf-learn, deterministic part (design §13, P2): what each run taught, kept per project in
// lessons.json and read at the start of each step. A lesson has a stable id, so the same lesson
// from a later run adds to its count instead of repeating it, and the verdict of a later run can
// say "seen before". The skill pushes new lessons to Recall, where a lesson seen in two projects
// is proposed back to the bundle.

// Each lesson belongs to the lifecycle step that can act on it, and is read at the start of that
// step (perf lessons --step, perf help, perf run). Lessons about running ai-perf (kind "run") hold
// in any project; lessons about the system under test (kind "system") stay with their project.
export const STEPS = ['plan', 'model', 'env', 'data', 'script', 'run', 'analyze'];
const PROBLEM_LESSONS = {
  generator_saturated: ['run', 'The load generator saturated: its numbers described the tool. Add workers or a larger machine before trusting a run at this load.'],
  worker_stalled: ['run', 'A load generator froze for part of the run (a starved host or container). Run on a quieter machine, or with more workers, and check the host first.'],
  worker_lost: ['run', 'A load generator was lost during the run. Check the worker log and the host before rerunning; its share of the load was missing.'],
  engine_start_lag: ['script', 'The engine started its load late (a slow setup()). Keep more rampdown than the start-up lag, or move the slow work out of setup().'],
  monitoring_failed: ['env', 'The target was not monitored (no metrics arrived). Check the container names in env.json before a long run.'],
  signal_missing: ['env', 'A signal in env.json gave no sample (a wrong URL, metric or query, the exporter down, or a counter read once). Run perf doctor with the spec before a long run.'],
  no_measured_window: ['run', 'Nothing completed in the measured window: the target hung or the steady phase was too short.'],
  arrival_shortfall: ['run', 'An open-model run dropped arrivals: every virtual user was busy. Raise profile.users (the VU cap) to cover the rate times the slowest response.'],
};

// The lessons one run teaches, each { id, kind, text }.
// The verdict is passed in while it is being made; otherwise the run's verdict.json is read.
export function lessonsOf(runDir, v = readJson(join(runDir, 'verdict.json'))) {
  const res = readJson(join(runDir, 'result.json'));
  const a = readJson(join(runDir, 'analysis.json'));
  const out = [];
  for (const kind of new Set((res?.problems ?? []).map((p) => p.kind))) {
    if (PROBLEM_LESSONS[kind]) out.push({ id: `problem:${kind}`, kind: 'run', step: PROBLEM_LESSONS[kind][0], text: PROBLEM_LESSONS[kind][1] });
  }
  // A saturated generator is already a problem lesson; its bottleneck line says the same.
  if (a?.bottleneck?.hint && a.bottleneck.evidence !== 'generator_saturated') {
    const key = a.bottleneck.hint.split(':')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.push({ id: `bottleneck:${key}`, kind: 'system', step: 'analyze', text: `Under load the target showed: ${a.bottleneck.hint} (${a.bottleneck.evidence}).` });
  }
  for (const f of a?.failures ?? []) {
    out.push({ id: `failure:${f.class}`, kind: 'system', step: 'analyze', text: `Under load, ${f.class} (${f.category}) appeared${f.operations.length ? ` on ${f.operations.join(', ')}` : ''}.` });
  }
  for (const r of v?.baseline?.regressions ?? []) {
    out.push({ id: `regression:${r.name}`, kind: 'system', step: 'analyze', text: `${r.name} regressed against the baseline (${r.what}); look at what changed on that path.` });
  }
  // What the verdict found about the way the run was made.
  if ((v?.reasons ?? []).some((r) => /the mix is not the plan's/.test(r))) out.push({ id: 'mix:off', kind: 'run', step: 'script', text: 'A script sent another mix of operations than workload.json plans. Check the task weights against the journeys before a run; the verdict says which operation was off.' });
  if ((v?.reasons ?? []).some((r) => /^WARN: cleanup failed/.test(r))) out.push({ id: 'cleanup:failed', kind: 'run', step: 'run', text: 'The data cleanup failed after a run: run data may be left behind. Run the cleanup command by hand once before the next run, and fix it.' });
  return out;
}

// Lessons that hold in any project are kept beside the bundle's user data too (PERF_HOME, default
// ~/.ai-perf): a lesson that two projects taught is proposed back to the bundle (design §13, P2).
export const perfHome = () => process.env.PERF_HOME || join(homedir(), '.ai-perf');
// A project is its repository (the origin remote; else this folder) and slug, hashed: two clones
// of one repo are one project, and no path or remote of another project is written down.
export function projectKey(root, slug) {
  const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const repo = r.status === 0 && r.stdout.trim() ? r.stdout.trim().replace(/\/\/[^/@]*@/, '//').replace(/\.git$/, '') : resolve(root);
  return createHash('sha256').update(`${repo}\n${slug}`).digest('hex').slice(0, 16);
}
// Two `perf learn` at once must not lose each other's lessons: a lock directory, taken in turn
// (a lock older than 30 s is from a process that died).
export function withLock(path, fn) {
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (i > 500) throw new Error(`${lock}: held for too long`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
function learnGlobally(root, slug, lessons) {
  const home = perfHome();
  mkdirSync(home, { recursive: true });
  const path = join(home, 'lessons.json');
  return withLock(path, () => mergeGlobal(path, root, slug, lessons));
}
function mergeGlobal(path, root, slug, lessons) {
  const doc = readJson(path) ?? { lessons: [] };
  const byId = new Map(doc.lessons.map((l) => [l.id, l]));
  const key = projectKey(root, slug);
  for (const l of lessons.filter((x) => x.kind === 'run')) {
    const g = byId.get(l.id) ?? { id: l.id, kind: l.kind, step: l.step, text: l.text, projects: [] };
    if (!g.projects.includes(key)) g.projects.push(key);
    g.proposed = g.projects.length >= 2;
    // Proposed: a draft patch to the skill of its step, for a person to apply to the bundle.
    if (g.proposed) {
      const d = draftPatch(g);
      if (d) {
        mkdirSync(join(dirname(path), 'proposals'), { recursive: true });
        g.patch = join('proposals', `${g.id.replace(/[^a-z0-9-]+/gi, '-')}.patch`);
        g.patch_file = d.file;
        writeFileSync(join(dirname(path), g.patch), d.patch);
      } else delete g.patch;
    }
    byId.set(l.id, g);
  }
  writeJson(path, { updated_at: new Date().toISOString(), lessons: [...byId.values()] });
  return [...byId.values()];
}

// The lessons to read before a step: this project's, then those other projects taught.
export function lessonsFor(root, slug, step) {
  const mine = (readJson(join(projectDir(root, slug), 'lessons.json'))?.lessons ?? []).filter((l) => !step || l.step === step);
  const key = projectKey(root, slug);
  const others = (readJson(join(perfHome(), 'lessons.json'))?.lessons ?? [])
    .filter((l) => (!step || l.step === step) && !mine.some((m) => m.id === l.id) && l.projects.some((p) => p !== key));
  return [...mine.map((l) => ({ ...l, from: 'this project' })), ...others.map((l) => ({ ...l, from: `${l.projects.filter((p) => p !== key).length} other project(s)` }))];
}

export function globalLessons() {
  return readJson(join(perfHome(), 'lessons.json'))?.lessons ?? [];
}

export function learn(root, slug) {
  const path = join(projectDir(root, slug), 'lessons.json');
  const known = new Map((readJson(path)?.lessons ?? []).map((l) => [l.id, l]));
  const fresh = [];
  // Every judged run is read, including the ones that taught nothing: `seen` says so.
  const seen = [];
  const judged = [];
  for (const r of listRuns(root, slug)) {
    if (!existsSync(join(r.dir, 'verdict.json'))) continue;
    seen.push(r.id);
    const taught = lessonsOf(r.dir);
    judged.push({ id: r.id, dir: r.dir, ids: new Set(taught.map((l) => l.id)) });
    for (const l of taught) {
      const k = known.get(l.id);
      if (!k) { known.set(l.id, { ...l, runs: [r.id], first_seen: r.id, pushed: false }); fresh.push(l.id); }
      else {
        // A lesson known from before keeps its runs, and takes today's wording, kind and step.
        Object.assign(k, { kind: l.kind, step: l.step, text: l.text });
        if (!k.runs.includes(r.id)) k.runs.push(r.id);
      }
    }
  }
  // Learning fixes things: each lesson about running the tool gets its fix, or goes to a person.
  const corrected = selfCorrect(root, slug, judged);
  for (const l of known.values()) {
    const last = corrected.fixes.filter((f) => f.lesson === l.id).at(-1);
    if (last) l.remedy = last;
    else if (l.kind === 'run' && !FIXES[l.id]) l.remedy = { status: 'needs_person', why: 'no fix ai-perf may make itself: it is in the lesson' };
    else delete l.remedy;
  }
  const lessons = [...known.values()].sort((a, b) => b.runs.length - a.runs.length);
  writeJson(path, { updated_at: new Date().toISOString(), seen, lessons });
  render(root, slug, lessons);
  const proposed = learnGlobally(root, slug, lessons).filter((g) => g.proposed);
  // The fixes the last judged run taught: what the next run of its profile will do differently.
  const lastRun = judged.at(-1)?.id;
  const next = corrected.fixes.filter((f) => f.run === lastRun && f.status === 'applied');
  return { lessons, fresh, seen, proposed, fixes: corrected.fixes, next };
}

const render = (root, slug, lessons) => writeFileSync(join(projectDir(root, slug), 'lessons.md'),
  ['# Lessons', '', ...lessons.map((l) => `- ${l.step ? `**${l.step}**: ` : ''}${l.text} _(${l.runs.length} run(s), first ${l.first_seen}${l.pushed ? ', in Recall' : ''})_${remedyLine(l.remedy)}`), ''].join('\n'));
const remedyLine = (f) => !f ? '' : f.status === 'needs_person' ? `\n  - needs a person: ${f.why}` : `\n  - fix ${f.status}: ${f.field} ${f.from} → ${f.to} (taught by ${f.run}${f.checked_by ? `, checked by ${f.checked_by}` : ''})`;

// The skill records which lessons it pushed to Recall, so they are not pushed twice.
export function markPushed(root, slug, ids) {
  const path = join(projectDir(root, slug), 'lessons.json');
  const doc = readJson(path) ?? { lessons: [] };
  for (const l of doc.lessons) if (ids.includes(l.id)) l.pushed = true;
  writeJson(path, doc);
  render(root, slug, doc.lessons);
  return doc.lessons.filter((l) => ids.includes(l.id)).map((l) => l.id);
}

// For the verdict: the lessons this run repeats from earlier runs (ids sort by start time), never
// from itself or from runs that came after it.
export function seenBefore(root, slug, runDir, runId, v) {
  const known = new Map((readJson(join(projectDir(root, slug), 'lessons.json'))?.lessons ?? []).map((l) => [l.id, l]));
  return lessonsOf(runDir, v).map((l) => known.get(l.id)).filter(Boolean)
    .map((k) => ({ ...k, earlier: k.runs.filter((id) => id < runId) })).filter((k) => k.earlier.length);
}
