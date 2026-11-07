#!/usr/bin/env node
// perf — the one entry point skills and people call.
//   perf run <spec.json> [--root dir] [--wait] [--json]   start a detached run (--wait: block, exit = state)
//            [--until-evaluable [--attempts n]]          run, judge, learn, fix, run again (at most n, default 3)
//            [--no-learned]                              without the settings earlier runs taught
//            [--breakpoint [--max-runs n]]                a staircase that climbs on until a step breaks (profile.breakpoint)
//   perf status [--root dir] [--slug s] [--run id] [--json]
//   perf stop   [--root dir] [--slug s] [--run id]
//   perf doctor [--root dir] [--spec file] [--fix] [--json]
//   perf discover --slug s [--answer key=value]…        read the repo, log assumptions, ≤ 3 questions
//   perf check <plan|model|env|data|script|all> --slug s  the gate of a lifecycle step
//   perf watch [--slug s] [--run id] [--since n] [--timeout s]   block until an event worth waking for
//   perf analyze [--slug s] [--run id]                   timeline, failures by cause, bottleneck
//   perf report [--slug s] [--run id] [--bootstrap] [--promote]   verdict (exit 0 PASS/WARN, 1 FAIL, 3 NOT EVALUABLE)
//   perf contract --slug s [--traffic a,b] [--ops x,y]   x-perf budgets in the API contract → slo.json, workload.json drafts
//   perf import --slug s                                 read existing suites → drafts, run specs, old results
//   perf audit --slug s                                  score existing suites against perf-standard, ranked fixes
//   perf ci <spec.json> [--bootstrap] [--junit file] [--until-evaluable]   run → analyze → report; exit = verdict (CI gate)
//   perf compare --slug s --run a --run b                two done runs side by side
//   perf matrix <matrix.json> [--bootstrap]              one spec per setting variant, ranked; ties within noise
//   perf scale <scale.json> [--instances 1,2,4] [--bootstrap]   capacity per instance count; scaling efficiency
//   perf volume --slug s [--seed]                        seed and count the data volume plan (data/manifest.json volume)
//   perf trend --slug s [--env e] [--profile p]          comparable runs over time; steps and slow decay
//   perf learn --slug s [--pushed id,…] [--reset lesson]  lessons from every run → lessons.json, PERF_HOME; --reset: a person looked, fixes start over
//   perf lessons [--slug s] [--step plan|…|analyze] [--global]   what to read before a step
//   perf scorecard [--slug s] [--global]                 runs to an evaluable result, per version and profile
//   perf help --slug s                                   the next step and why
//   perf brief --slug s [--step plan|…|analyze]          what ai-perf knows about the project, on one short page
//   perf share --slug s [--pushed key[=id],…] [--import file]   facts for Recall not shared yet; record a push; take in a search
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CHECKS } from '../lib/checks.mjs';
import { discover } from '../lib/discover.mjs';
import { analyze } from '../lib/analyze.mjs';
import { promote, verdict, writeVerdict } from '../lib/verdict.mjs';
import { nextStep } from '../lib/help.mjs';
import { watch } from '../lib/watch.mjs';
import { importSuites } from '../lib/importer.mjs';
import { audit } from '../lib/audit.mjs';
import { compareRuns, renderCompare, trend } from '../lib/history.mjs';
import { STEPS, globalLessons, learn, lessonsFor, markPushed, perfHome } from '../lib/learn.mjs';
import { globalScorecard, scorecard } from '../lib/scorecard.mjs';
import { applyLearned, resetLesson } from '../lib/remedy.mjs';
import { brief, importRecalled, markShared, outbox, writeBrief } from '../lib/memory.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';
import { fromContract } from '../lib/contract.mjs';
import { junit } from '../lib/ci.mjs';
import { FACTOR, breakpointOf, extendSteps, readStaircase, summarizeBreakpoint, writeBreakpoint } from '../lib/breakpoint.mjs';
import { MATRIX_DEFAULT, checkMatrix, deepMerge, maskDeep, rank, writeMatrix } from '../lib/matrix.mjs';
import { mask } from '../lib/mask.mjs';
import { checkVolume, countVolume, describeVolume, writeVolume } from '../lib/volume.mjs';
import { SCALE_DEFAULT, checkScale, parseInstances, readCount, scaledSteps, scaling, waitReady, writeScale } from '../lib/scale.mjs';
import { runCommand } from '../lib/command.mjs';
import { ENGINES } from '../adapters/index.mjs';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, sleep, writeJson } from '../controller/files.mjs';
import { normalize } from '../controller/spec.mjs';
import { isTerminal } from '../controller/state.mjs';
import { doctor, worst } from '../lib/doctor.mjs';
import { describe, findRun, listRuns, perfRoot } from '../lib/runs.mjs';
import { bounds } from '../controller/profile.mjs';

const CONTROLLER = fileURLToPath(new URL('../controller/controller.mjs', import.meta.url));
const VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
// Exit codes are part of the contract (CONTRACTS §6): CI reads them.
export const EXIT = { done: 0, degraded: 4, not_evaluable: 3, aborted: 5, refused: 2, error: 1 };

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
// Switches never take a value: `perf run --no-learned spec.json` keeps spec.json as the spec.
const SWITCHES = new Set(['wait', 'json', 'bootstrap', 'promote', 'global', 'fix', 'no-learned', 'until-evaluable', 'breakpoint', 'seed']);
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    const v = !SWITCHES.has(k) && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    // --answer always collects, and --run twice is compare's pair; any other flag takes one value.
    if (k === 'answer') (flags.answer ??= []).push(v);
    else if (k === 'run' && k in flags) flags.run = [].concat(flags.run, v);
    else flags[k] = v;
  } else pos.push(rest[i]);
}
const root = resolve(flags.root ?? process.cwd());
const json = Boolean(flags.json);
const print = (obj, text) => console.log(json ? JSON.stringify(obj, null, 2) : text);
const mark = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' };

function usage(text) {
  console.error(text);
  return EXIT.error;
}

function newRunId() {
  // Milliseconds in the id: two runs started in the same second still sort in start order.
  const d = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').slice(0, 18);
  return `${d}-${randomBytes(2).toString('hex')}`;
}

function summary(d) {
  const lines = [`${d.slug}/${d.run_id}: ${d.state}${d.t !== null && d.t !== undefined ? ` at t=${d.t}s` : ''} · controller ${d.controller}`];
  if (d.stop_reason && d.stop_reason !== 'complete') lines.push(`  stop reason: ${d.stop_reason}`);
  for (const w of d.workers) lines.push(`  ${w.id} pid ${w.pid}: ${w.state}${w.reason ? ` (${w.reason})` : ''}`);
  for (const p of d.problems) lines.push(`  problem: ${p.kind}: ${p.detail}`);
  for (const e of d.last_events) lines.push(`  event ${e.type}: ${e.summary}`);
  return lines.join('\n');
}

// The run dir `perf run` started, so `perf ci` judges its own run and never another one.
let started = null;

// override: the spec to run instead of the file's (a breakpoint's next staircase, a matrix
// variant); it is checked exactly as the file would be.
// instances: the count a perf scale step deployed, recorded with the run.
async function runOnce(override = null, { instances = null } = {}) {
  const specPath = pos[0];
  if (!specPath) { console.error('usage: perf run <spec.json>'); return EXIT.error; }
  const raw = override ? structuredClone(override) : readJson(resolve(specPath));
  if (!raw) { console.error(`${specPath}: not readable JSON`); return EXIT.error; }
  // What earlier runs of this profile taught (lib/remedy.mjs), before the spec is checked: a fix
  // is held to the same rules as the spec it changes.
  const learned = flags['no-learned'] ? [] : applyLearned(root, raw);
  for (const l of learned) console.error(`learned: ${l.field} ${l.from} → ${l.to} (${l.lesson ?? 'an earlier run'}, run ${l.run ?? '?'})`);
  const { spec, errors, warnings } = normalize(raw, { root });
  if (learned.length) spec.learned = learned;
  // The doctor checks the spec as it will run, learned settings included (ports and files per user,
  // hosts): a fix is held to the same rules as the spec it changes.
  let checked = resolve(specPath);
  const scratch = learned.length || override ? mkdtempSync(join(tmpdir(), 'ai-perf-spec-')) : null;
  if (scratch) { checked = join(scratch, 'spec.json'); writeFileSync(checked, JSON.stringify(raw)); }
  let checks;
  try { checks = errors.length ? [] : await doctor({ root, specPath: checked, quick: true }); } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  const blocking = [...errors, ...checks.filter((c) => c.status === 'fail').map((c) => c.detail)];
  // The data plan's volume: counted before every run but a smoke, so the run keeps the sizes it
  // was measured on. A volume run without a valid plan has nothing to stand on.
  const volumePlan = errors.length ? undefined : readJson(join(perfRoot(root), spec.slug, 'data', 'manifest.json'))?.volume;
  const volumeErrors = checkVolume(volumePlan);
  if (!errors.length && spec.profile?.name === 'volume') {
    if (!volumePlan) blocking.push('profile volume: data/manifest.json has no volume plan (a target size, a seed and a count command per entity); /perf-data writes it');
    else blocking.push(...volumeErrors);
  }
  for (const w of warnings) console.error(`[warn] ${w}`);
  // A signal that does not answer does not block the run, but its warning is not lost either.
  for (const c of checks.filter((x) => x.id === 'signals' && x.status === 'warn')) console.error(`[warn] signals: ${c.detail}`);
  if (blocking.length) {
    print({ refused: blocking }, ['run refused:', ...blocking.map((e) => `  ${e}`)].join('\n'));
    return EXIT.refused;
  }
  spec.run_id = newRunId();
  spec.root = root;
  if (instances) spec.instances = instances;
  if (volumePlan && !volumeErrors.length && spec.profile.name !== 'smoke') {
    spec.volume = countVolume(root, volumePlan);
    console.error(`volume: ${spec.volume.at_volume ? 'at volume' : 'NOT at volume'}: ${describeVolume(spec.volume)}`);
  }
  // What this run is measured under, taken now: editing the plan later cannot rewrite it.
  spec.fingerprint = fingerprint(root, spec);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  spec.git_sha = git.status === 0 ? git.stdout.trim() : 'unknown';
  // Uncommitted changes make another build at the same sha: never "the same build".
  const dirty = git.status === 0 ? spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }) : null;
  spec.git_dirty = dirty ? dirty.status !== 0 || dirty.stdout.trim() !== '' : null;
  // Engine detection can spawn an interpreter for seconds; done here, never inside the controller,
  // where a blocked event loop stops the heartbeat.
  const eng = await ENGINES[spec.engine]();
  spec.tool_version = `${eng.name} ${eng.detect().version ?? 'unknown'}`;
  // Cost before running (pillar 5): the verdict compares it with what the run really took.
  for (const l of [...lessonsFor(root, spec.slug, 'env'), ...lessonsFor(root, spec.slug, 'run')]) console.error(`lesson (${l.from}): ${l.text}`);
  spec.ai_perf_version = VERSION;
  const planned = Math.round(bounds(spec.profile).end);
  spec.estimate = { duration_s: planned, worker_s: planned * spec.workers };
  console.error(`estimate: about ${planned} s of load on ${spec.workers} worker(s) (${spec.estimate.worker_s} worker-seconds) on ${spec.target}`);
  const dir = join(perfRoot(root), spec.slug, 'runs', spec.run_id);
  started = dir;
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'run.json'), spec);
  // The controller's own output goes to controller.log: a crash must leave its reason behind.
  const log = openSync(join(dir, 'controller.log'), 'a');
  const child = spawn(process.execPath, [CONTROLLER, dir], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  writeFileSync(join(dir, 'controller.pid'), `${child.pid}\n`);
  if (!flags.wait) {
    print({ run_id: spec.run_id, dir, pid: child.pid }, `started ${spec.slug}/${spec.run_id} (controller pid ${child.pid})\nnext: perf status --slug ${spec.slug}`);
    return EXIT.done;
  }
  // Never wait forever, but never give up on a healthy run either: the controller's own hard
  // deadline counts from after its workers started (docker can take minutes per container). Until
  // it is known, a generous bound covers the start.
  const T = spec.timing;
  const starting = Date.now() + (T.barrier_timeout_s + bounds(spec.profile).end + T.worker_timeout_s + 60 + 120 * spec.workers) * 1000;
  for (;;) {
    await sleep(250);
    const d = describe(dir);
    const hard = readJson(join(dir, 'state.json'))?.hard_deadline;
    const deadline = hard ? hard + 30_000 : starting;
    if (isTerminal({ state: d.state })) { print(d, summary(d)); return EXIT[d.state]; }
    if (d.controller === 'lost') { print(d, summary(d)); return EXIT.error; }
    if (Date.now() > deadline) { print(d, `${summary(d)}\n  --wait gave up; the run may still be going: perf status --slug ${spec.slug}`); return EXIT.error; }
  }
}

// Judging a run is learning from it (design §13, P2): its verdict, then the lessons of every judged
// run, the fixes they teach and the scorecard. Nobody has to remember /perf-learn.
function judge(dir, slug) {
  analyze(dir);
  const v = verdict({ root, slug, runDir: dir, bootstrap: Boolean(flags.bootstrap) });
  writeVerdict(root, slug, dir, v);
  const l = learn(root, slug);
  scorecard(root, slug);
  writeBrief(root, slug);
  return { v, l };
}
const learnedLines = (l) => [
  ...l.next.map((f) => `  learned: next ${f.profile} run: ${f.field} ${f.from} → ${f.to} (${f.lesson})`),
  ...l.fixes.filter((f) => f.checked_by && f.checked_by === l.seen.at(-1)).map((f) => `  fix ${f.status}: ${f.field} ${f.from} → ${f.to} (${f.lesson})`),
  ...l.fixes.filter((f) => f.status === 'needs_person' && f.run === l.seen.at(-1)).map((f) => `  needs a person: ${f.lesson}: ${f.why}`),
];

// --until-evaluable: run, judge, learn; while a run taught a fix ai-perf may make itself, run
// again with it, at most --attempts runs. A lesson only a person can act on ends the loop.
// A run that was stopped (by a person, an auto-stop, the target dying, the deadline) ends the loop:
// a stop is never answered with another run.
async function attempts() {
  flags.wait = true;
  const max = Math.min(5, Math.max(1, Math.floor(Number(flags.attempts ?? 3)) || 3));
  // With --json, stdout is the verdict alone; the progress goes to stderr.
  const say = (text) => (json ? console.error(text) : console.log(text));
  for (let i = 1; ; i++) {
    const code = await runOnce();
    if (code === EXIT.refused || code === EXIT.error) return { code };
    const slug = readJson(join(started, 'run.json')).slug;
    const { v, l } = judge(started, slug);
    say([`attempt ${i}/${max}: VERDICT ${v.outcome}`, ...learnedLines(l)].join('\n'));
    const res = readJson(join(started, 'result.json'));
    if (res?.run_state === 'aborted') return { code, v, l, why: `the run was stopped (${readJson(join(started, 'state.json'))?.stop_reason ?? 'stop'}): no new attempt` };
    if (!l.next.length) return { code, v, l, why: v.outcome === 'NOT_EVALUABLE' ? 'no fix ai-perf may make itself: see lessons.md' : null };
    if (i >= max) return { code, v, l, why: `stopped after ${max} attempt(s); the next run would apply the fix above` };
  }
}

// With --until-evaluable the exit is the last verdict's, as perf report's (0 PASS/WARN, 1 FAIL,
// 3 NOT EVALUABLE); 2 refused, 1 error before any verdict.
async function run() {
  if (flags.breakpoint) return breakpointSearch();
  if (!flags['until-evaluable']) return runOnce();
  if (flags['no-learned']) return usage('--until-evaluable applies what each run teaches; it cannot run with --no-learned');
  const a = await attempts();
  if (a.why) (json ? console.error : console.log)(a.why);
  return a.v ? a.v.exit : a.code;
}

// --breakpoint: run the staircase; while every step held, run again from the last step that held,
// climbing by profile.breakpoint.factor up to profile.breakpoint.max, at most --max-runs runs. It
// stops at the first step that breaks, at a load generator that saturates (then the generator, not
// the target, is the limit), at the ceiling, or at a run that cannot be read. Each run is an
// ordinary run with its own folder and verdict; the search is written to breakpoint.md.
async function breakpointSearch() {
  if (flags['until-evaluable']) return usage('--breakpoint and --until-evaluable are two loops; run one');
  flags.wait = true;
  const first = readJson(resolve(pos[0] ?? ''));
  if (!first) return usage('usage: perf run <spec.json> --breakpoint [--max-runs n]');
  const p = first.profile ?? {};
  if (!Array.isArray(p.steps) || !(p.breakpoint?.max > 0)) {
    const why = "--breakpoint climbs a staircase up to a ceiling: profile.steps and profile.breakpoint.max (the highest load the environment's owner allows) are required";
    print({ refused: [why] }, `run refused:\n  ${why}`);
    return EXIT.refused;
  }
  // 0, a fraction or a missing value is refused, never read as the default.
  const maxRuns = flags['max-runs'] === undefined ? 3 : typeof flags['max-runs'] === 'string' ? Number(flags['max-runs']) : NaN;
  if (!(Number.isInteger(maxRuns) && maxRuns >= 1 && maxRuns <= 6)) {
    print({ refused: ['--max-runs: a whole number from 1 to 6'] }, 'run refused:\n  --max-runs: a whole number from 1 to 6');
    return EXIT.refused;
  }
  const { factor = FACTOR, max } = p.breakpoint;
  const say = (text) => (json ? console.error(text) : console.log(text));
  const runs = [];
  let raw = first;
  let last = null;
  let stopped = null;
  let limit = null;
  for (let i = 1; ; i++) {
    const code = await runOnce(raw);
    if (code === EXIT.refused || code === EXIT.error) { if (!runs.length) return code; stopped = `run ${i} was ${code === EXIT.refused ? 'refused' : 'not started'}`; limit = 'unjudged'; break; }
    const spec = readJson(join(started, 'run.json'));
    const { v, l } = judge(started, spec.slug);
    last = { dir: started, v, slug: spec.slug };
    const res = readJson(join(started, 'result.json'));
    const slo = readJson(join(perfRoot(root), spec.slug, 'slo.json'));
    const reading = res && slo ? readStaircase(res, slo, readJson(join(started, 'state.json'))?.stop_reason ?? '', v) : { kind: 'unjudged', why: res ? 'no slo.json to judge the steps against' : 'no result' };
    runs.push({ run_id: spec.run_id, steps: spec.profile.steps, reading, outcome: v.outcome });
    say([`breakpoint run ${i}/${maxRuns} (${spec.profile.steps.join(', ')}): ${reading.kind}${reading.kind === 'broke' ? ` at ${reading.broke}` : reading.kind === 'held' ? ` up to ${reading.held}` : `: ${reading.why}`}; VERDICT ${v.outcome}`, ...learnedLines(l)].join('\n'));
    if (reading.kind === 'broke') { stopped = `step ${reading.broke} broke`; limit = 'target'; break; }
    if (reading.kind === 'generator') { stopped = `run ${i}: ${reading.why}`; limit = 'generator'; break; }
    if (reading.kind !== 'held') { stopped = `run ${i} cannot be read: ${reading.why}`; limit = 'unjudged'; break; }
    const next = extendSteps(reading.held, p.steps.length, { factor, max });
    if (!next) { stopped = `every step held up to the ceiling (profile.breakpoint.max ${max})`; limit = 'ceiling'; break; }
    if (i >= maxRuns) { stopped = `every step held in ${i} run(s); --max-runs ${maxRuns} reached`; limit = 'runs'; break; }
    raw = structuredClone(raw);
    raw.profile.steps = next;
  }
  const b = { ...breakpointOf(runs), limit, stopped, max, factor, ...(p.breakpoint.factor === undefined ? { factor_default: true } : {}), runs };
  b.summary = summarizeBreakpoint(b);
  if (last) {
    // The last run's verdict carries the search: what was observed, from which runs.
    last.v.breakpoint = { found: b.found, held: b.held, broke: b.broke, limit, unstable: b.unstable ?? false };
    last.v.notes.push(`breakpoint search (${runs.length} run(s)): ${b.summary}`);
    writeVerdict(root, last.slug, last.dir, last.v);
    writeBreakpoint(root, last.slug, b);
  }
  print(b, [b.summary, `stopped: ${stopped}`, last ? `report: .perf/${last.slug}/breakpoint.md` : ''].filter(Boolean).join('\n'));
  return last ? last.v.exit : EXIT.error;
}

// perf matrix: every variant of a setting runs the same spec, then the ranking (lib/matrix.mjs).
// A variant's apply command runs first, from the project root, with its env and PERF_VARIANT; one
// that fails is not run. The control (the first variant) runs again at the end unless recheck is
// false, so a drift of the environment during the matrix is seen, not ranked.
async function matrix() {
  const file = pos[0];
  const m = file ? readJson(resolve(file)) : null;
  if (!m) return usage('usage: perf matrix <matrix.json> [--root dir] [--bootstrap]');
  const errors = checkMatrix(m, root);
  if (errors.length) { print({ refused: errors }, ['matrix refused:', ...errors.map((e) => `  ${e}`)].join('\n')); return EXIT.refused; }
  flags.wait = true;
  const base = readJson(resolve(root, m.spec));
  if (!base) return usage(`${m.spec}: not readable JSON`);
  pos[0] = resolve(root, m.spec);
  const say = (text) => (json ? console.error(text) : console.log(text));
  const recheck = m.recheck ?? MATRIX_DEFAULT.recheck;
  const order = [...m.variants, ...(recheck ? [{ ...m.variants[0], recheck: true }] : [])];
  // Every variant runs the same spec: what earlier runs taught is applied once, now, and frozen.
  // A run inside the matrix teaches the next one nothing (a learned worker count would change the
  // generator between variants).
  const learnedNow = flags['no-learned'] ? [] : applyLearned(root, base);
  for (const l of learnedNow) say(`learned, for every variant: ${l.field} ${l.from} → ${l.to}`);
  flags['no-learned'] = true;
  // Without a baseline, each variant is judged on its SLOs (as --bootstrap): a matrix compares its
  // variants with each other, and a verdict that only lacks a baseline must not drop a variant.
  flags.bootstrap = true;
  const entries = [];
  let stopped = null;
  for (const v of order) {
    const e = { name: v.name, changes: v.changes ?? [], recheck: Boolean(v.recheck) };
    entries.push(e);
    if (stopped) { e.why = stopped; continue; }
    const env = { ...v.env, PERF_VARIANT: v.name };
    if (v.apply) {
      const a = spawnSync(v.apply, { cwd: root, shell: true, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 600000, windowsHide: true });
      if (a.status !== 0) {
        e.status = 'apply_failed';
        e.why = a.error ? a.error.message : `exit ${a.status}${(a.stderr || a.stdout || '').trim() ? `: ${mask((a.stderr || a.stdout).trim().split('\n').pop()).slice(0, 160)}` : ''}`;
        say(`variant ${v.name}${e.recheck ? ' (recheck)' : ''}: apply failed (${e.why}); not run`);
        continue;
      }
    }
    // The variant's env is set for its run too: engines and scripts read it.
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    let code;
    started = null;
    try { code = await runOnce(deepMerge(base, v.spec ?? {})); } finally {
      for (const [k, x] of Object.entries(saved)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; }
    }
    // A run that started and was not seen to finish (--wait gave up, its controller was lost) may
    // still be loading the target: the next variant must not start on top of it.
    if (code === EXIT.error && started) {
      e.why = `run ${basename(started)} was not seen to finish (perf status); the matrix stopped so no two runs overlap`;
      stopped = `not run: the matrix stopped at ${v.name}`;
      say(`variant ${v.name}${e.recheck ? ' (recheck)' : ''}: ${e.why}`);
      continue;
    }
    if (code === EXIT.refused || code === EXIT.error) { e.why = code === EXIT.refused ? 'refused' : 'not started'; say(`variant ${v.name}${e.recheck ? ' (recheck)' : ''}: ${e.why}`); continue; }
    const spec = readJson(join(started, 'run.json'));
    const { v: verdictOf } = judge(started, spec.slug);
    e.outcome = verdictOf.outcome;
    e.outcome_why = verdictOf.reasons.find((x) => x.startsWith(`${verdictOf.outcome}:`))?.slice(verdictOf.outcome.length + 2, verdictOf.outcome.length + 162) ?? null;
    e.run_id = spec.run_id;
    e.res = readJson(join(started, 'result.json'));
    e.hist = readJson(join(started, e.res?.hist ?? 'hist/merged.json'));
    say(`variant ${v.name}${e.recheck ? ' (recheck)' : ''}: run ${spec.run_id} ${e.res?.run_state ?? 'no result'}, VERDICT ${verdictOf.outcome}`);
  }
  const slug = base.slug;
  const slo = readJson(join(perfRoot(root), slug, 'slo.json'));
  const r = rank(entries, { measure: m.measure ?? 'p95', transaction: m.transaction ?? null, slo, recheck, min_diff_pct: m.min_diff_pct ?? MATRIX_DEFAULT.min_diff_pct, min_diff_ms: m.min_diff_ms ?? MATRIX_DEFAULT.min_diff_ms });
  const name = m.name ?? basename(file).replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  // The report is evidence: no credential a setting carries is written into it.
  const out = { name, spec: m.spec, ...r, learned: learnedNow, variants: m.variants.map((v) => ({ name: v.name, apply: v.apply ? mask(v.apply) : null, env: Object.keys(v.env ?? {}), spec: v.spec ? maskDeep(v.spec) : null, changes: v.changes ?? [] })) };
  const path = writeMatrix(root, slug, out);
  print(out, [`MATRIX ${name}: ${out.verdict}`, ...out.rows.map((x) => `  ${x.rank ?? '-'} ${x.name}: ${x.value ?? '—'}${x.flag ? ` (${x.flag})` : x.tie ? ` (tie with ${x.tie.with})` : ''}`), `report: ${path}`].join('\n'));
  // A matrix cut short by a run still going exits 1: perf status says what that run is doing.
  return stopped ? EXIT.error : out.ranked >= 2 ? EXIT.done : EXIT.not_evaluable;
}

// perf scale: for each instance count, the project's command deploys that many, ai-perf waits until
// the target answers, runs the staircase and reads its capacity; then the scaling efficiency per
// count (lib/scale.mjs). The command runs without a shell and {n} is only ever a whole number.
async function scale() {
  const file = pos[0];
  const raw = file ? readJson(resolve(file)) : null;
  if (!raw) return usage('usage: perf scale <scale.json> [--instances 1,2,4] | perf scale <spec.json> --instances 1,2,4 --command "..." [--ready-url u]');
  // A run spec with the plan in flags, or a plan file that names its spec.
  const plan = raw.profile
    ? { spec: resolve(file), instances: flags.instances, command: flags.command === true ? undefined : flags.command, ...(flags['ready-url'] ? { ready: { url: flags['ready-url'] } } : {}), ...(flags.name ? { name: flags.name } : {}) }
    : { ...raw, ...(flags.instances ? { instances: flags.instances } : {}) };
  const errors = checkScale(plan, root);
  const base = errors.length ? null : readJson(resolve(root, plan.spec));
  if (base && !(Array.isArray(base.profile?.steps) && base.profile.steps.length >= 2)) errors.push('spec: perf scale reads the capacity from a staircase: profile.steps');
  if (base && errors.length === 0) {
    // The readiness probe goes only to the target's own host: the environment allows it, nothing else.
    const host = (u) => { try { return new URL(u).hostname; } catch { return null; } };
    if (plan.ready?.url && host(plan.ready.url) !== host(base.target_url)) errors.push(`ready.url: on the target's host (${host(base.target_url)}), the one the environment allows`);
  }
  if (errors.length) { print({ refused: errors }, ['scale refused:', ...errors.map((e) => `  ${e}`)].join('\n')); return EXIT.refused; }
  flags.wait = true;
  pos[0] = resolve(root, plan.spec);
  const counts = parseInstances(plan.instances).list;
  const mode = plan.steps ?? SCALE_DEFAULT.steps;
  const readyUrl = plan.ready?.url ?? base.target_url;
  const say = (text) => (json ? console.error(text) : console.log(text));
  const points = [];
  for (const n of counts) {
    const p = { instances: n };
    points.push(p);
    const c = runCommand(plan.command, { n }, { cwd: root, env: { PERF_INSTANCES: String(n) }, timeout_s: plan.timeout_s ?? SCALE_DEFAULT.timeout_s });
    p.scale = { argv: c.argv, exit_code: c.exit_code, duration_s: c.duration_s };
    if (c.exit_code !== 0) { p.why = `the scale command failed (${c.exit_code === null ? 'did not run' : `exit ${c.exit_code}`}${c.output ? `: ${c.output.split('\n').pop().slice(0, 160)}` : ''}); not run`; say(`scale ${n}: ${p.why}`); continue; }
    const r = await waitReady(readyUrl, plan.ready?.timeout_s ?? SCALE_DEFAULT.ready_timeout_s);
    p.ready_s = r.waited_s;
    if (!r.ready) { p.why = `the target was not ready ${r.waited_s} s after scaling (last: ${r.last}); not run`; say(`scale ${n}: ${p.why}`); continue; }
    const spec = structuredClone(base);
    spec.profile.steps = scaledSteps(base.profile.steps, n, counts[0], mode);
    // The search beyond the staircase is perf run --breakpoint's; here every count climbs its own grid.
    delete spec.profile.breakpoint;
    p.steps = spec.profile.steps;
    const code = await runOnce(spec, { instances: n });
    if (code === EXIT.refused || code === EXIT.error) { p.why = `the run was ${code === EXIT.refused ? 'refused' : 'not started'}`; say(`scale ${n}: ${p.why}`); continue; }
    const runSpec = readJson(join(started, 'run.json'));
    const { v } = judge(started, runSpec.slug);
    const res = readJson(join(started, 'result.json'));
    const slo = readJson(join(perfRoot(root), runSpec.slug, 'slo.json'));
    p.run_id = runSpec.run_id;
    p.outcome = v.outcome;
    if (!res || !slo) { p.why = res ? 'no slo.json to read the steps against' : 'no result'; say(`scale ${n}: ${p.why}`); continue; }
    Object.assign(p, readCount(res, slo, readJson(join(started, 'state.json'))?.stop_reason ?? ''));
    p.bottleneck = readJson(join(started, 'analysis.json'))?.bottleneck ?? null;
    say(`scale ${n} instance(s) (${p.steps.join(', ')}), ready in ${p.ready_s} s: ${p.reading.kind}${p.held !== null ? `, held ${p.held}` : ''}; run ${p.run_id}, VERDICT ${v.outcome}`);
  }
  const name = plan.name ?? basename(file).replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const out = { name, spec: plan.spec, command: mask(plan.command), steps: mode, ...scaling(points) };
  const path = writeScale(root, base.slug, out);
  print(out, [`SCALE ${name}: ${out.summary}`, ...out.points.slice(1).map((x) => `  ${x.instances}: ${x.verdict}: ${x.why_verdict}`), `report: ${path}`].join('\n'));
  return out.base_known && out.measured >= 2 ? EXIT.done : EXIT.not_evaluable;
}

// Stop acts on a live run only: a controller that is alive or starting. Without --run it picks the
// latest such run, never a finished one or one whose controller is gone (nobody would read the stop).
const live = (d) => d.controller === 'alive' || d.controller === 'starting';
function stop() {
  const runs = listRuns(root, flags.slug);
  const r = flags.run ? runs.find((x) => x.id === flags.run) : runs.reverse().find((x) => live(describe(x.dir)));
  if (!r) { console.error(flags.run ? `no run ${flags.run}` : 'no live run to stop'); return EXIT.error; }
  const d = describe(r.dir);
  if (isTerminal({ state: d.state })) { console.error(`${r.slug}/${r.id} already finished (${d.state})`); return EXIT.error; }
  if (!live(d)) { console.error(`${r.slug}/${r.id}: its controller is lost, so nothing would act on a stop; run perf doctor --fix`); return EXIT.error; }
  writeFileSync(join(r.dir, 'stop.request'), `${new Date().toISOString()}\n`);
  print({ run_id: r.id, requested: true }, `stop requested for ${r.slug}/${r.id}`);
  return EXIT.done;
}

async function main() {
  if (Array.isArray(flags.run) && cmd !== 'compare') return usage('--run takes one run here (two only for perf compare)');
  switch (cmd) {
    case 'run': return run();
    case 'matrix': return matrix();
    case 'scale': return scale();
    case 'volume': {
      if (!flags.slug) return usage('perf volume --slug <slug> [--seed]');
      const plan = readJson(join(perfRoot(root), flags.slug, 'data', 'manifest.json'))?.volume;
      const errs = plan ? checkVolume(plan) : ['data/manifest.json has no volume plan (a target size, a seed and a count command per entity); /perf-data writes it'];
      if (errs.length) { print({ refused: errs }, ['volume refused:', ...errs.map((e) => `  ${e}`)].join('\n')); return EXIT.refused; }
      const v = countVolume(root, plan, { seed: Boolean(flags.seed) });
      writeVolume(root, flags.slug, v);
      print(v, [`${v.at_volume ? 'AT VOLUME' : 'NOT AT VOLUME'} (each entity at least ${v.min_pct} % of its target)`,
        ...Object.entries(v.entities).map(([k, r]) => `  ${k}: ${r.count === null ? `not counted: ${r.error}` : `${r.count} of ${r.target} (${r.pct} %)`}${r.seed && r.seed.exit_code !== 0 ? `; seed failed (exit ${r.seed.exit_code ?? 'none'}): ${r.seed.output ?? ''}` : ''}`),
        `report: .perf/${flags.slug}/data/volume.md`].join('\n'));
      return v.at_volume ? EXIT.done : EXIT.not_evaluable;
    }
    case 'status': {
      const r = findRun(root, { slug: flags.slug, run: flags.run });
      if (!r) { print({ runs: [] }, 'no runs yet; next: /perf-start'); return EXIT.done; }
      const d = describe(r.dir);
      print(d, summary(d));
      return EXIT.done;
    }
    case 'stop': return stop();
    case 'doctor': {
      const checks = await doctor({ root, specPath: flags.spec ? resolve(flags.spec) : null, fix: Boolean(flags.fix) });
      const overall = worst(checks);
      print({ verdict: overall, checks }, [...checks.map((c) => `${mark[c.status]} ${c.group}/${c.id}: ${c.detail}${c.fix && c.status !== 'ok' ? `\n        fix: ${c.fix}` : ''}`), `doctor: ${overall}`].join('\n'));
      return overall === 'fail' ? EXIT.error : EXIT.done;
    }
    case 'discover': {
      if (!flags.slug) return usage('perf discover --slug <slug>');
      const answers = Object.fromEntries((flags.answer ?? []).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
      const ctx = discover(root, flags.slug, answers);
      print(ctx, [`context: .perf/${flags.slug}/context.md`, ...(ctx.questions.length ? ctx.questions.map((q) => `? ${q.ask}  [proposed: ${q.proposed}]  (--answer ${q.key}=…)`) : ['no questions: everything needed is known'])].join('\n'));
      return EXIT.done;
    }
    case 'ci': {
      // The regression gate (design §12): one command, exit code = verdict. A refused or broken
      // run keeps its own code (2 refused, 1 error); everything else is judged by the verdict.
      flags.wait = true;
      if (flags['until-evaluable'] && flags['no-learned']) return usage('--until-evaluable applies what each run teaches; it cannot run with --no-learned');
      const a = flags['until-evaluable'] ? await attempts() : { code: await runOnce() };
      if (a.code === EXIT.refused || a.code === EXIT.error) return a.code;
      const r = { dir: started, slug: readJson(join(started, 'run.json')).slug };
      // The loop judged its last run already.
      const { v, l } = a.v ? a : judge(r.dir, r.slug);
      if (!a.v) for (const line of learnedLines(l)) console.error(line);
      const xml = junit(v);
      writeFileSync(join(r.dir, 'junit.xml'), xml);
      if (flags.junit) writeFileSync(resolve(flags.junit), xml);
      print(v, [`VERDICT: ${v.outcome}`, ...v.reasons.map((x) => `  ${x}`), ...v.notes.map((n) => `  note: ${n}`), `junit: ${flags.junit ?? join(r.dir, 'junit.xml')}`].join('\n'));
      return v.exit;
    }
    case 'compare': {
      const ids = [].concat(flags.run ?? []);
      if (!flags.slug || ids.length !== 2) return usage('perf compare --slug <slug> --run <a> --run <b>');
      const [a, b] = ids.map((id) => findRun(root, { slug: flags.slug, run: id }));
      if (!a || !b) return usage(`no run ${!a ? ids[0] : ids[1]}`);
      const c = compareRuns(a.dir, b.dir);
      writeFileSync(join(b.dir, `compare-${a.id}.md`), renderCompare(c));
      print(c, renderCompare(c));
      return c.refused ? EXIT.not_evaluable : c.regressions.length ? EXIT.error : EXIT.done;
    }
    case 'trend': {
      if (!flags.slug) return usage('perf trend --slug <slug> [--env e] [--profile p]');
      const t = trend(root, flags.slug, { environment: flags.env, profile: flags.profile });
      print(t, t.refused ?? [`${t.runs.length} comparable run(s) on ${t.environment}/${t.profile}`, ...t.flags.map((f) => `  [${f.kind}] ${f.series}: ${f.change_pct > 0 ? '+' : ''}${f.change_pct} %${f.kind === 'slow_decay' ? ` over ${f.runs} runs` : ` at ${f.at}`}`), `report: .perf/${flags.slug}/trend.md`].join('\n'));
      return t.flags.length ? EXIT.error : EXIT.done;
    }
    case 'learn': {
      if (!flags.slug) return usage('perf learn --slug <slug> [--pushed id,…]');
      if (flags.pushed) { const done = markPushed(root, flags.slug, String(flags.pushed).split(',')); print(done, `marked as in Recall: ${done.join(', ') || 'none'}`); return EXIT.done; }
      if (flags.reset) {
        const last = listRuns(root, flags.slug).map((x) => x.id).at(-1) ?? '';
        resetLesson(root, flags.slug, String(flags.reset), last);
        learn(root, flags.slug);
        print({ reset: flags.reset, after: last }, `${flags.reset}: its fixes start over from the next run (runs up to ${last || 'now'} no longer count)`);
        return EXIT.done;
      }
      const l = learn(root, flags.slug);
      const card = scorecard(root, flags.slug);
      print({ ...l, scorecard: card }, [`${l.lessons.length} lesson(s), ${l.fresh.length} new`, ...l.lessons.filter((x) => !x.pushed).map((x) => `  [${x.id}] ${x.text}`), `not yet in Recall: ${l.lessons.filter((x) => !x.pushed).length}`,
        ...(l.proposed.length ? [`seen in two projects or more, propose to the bundle: ${l.proposed.map((x) => `[${x.id}] (${x.projects.length} projects)`).join(', ')}`, ...l.proposed.filter((x) => x.patch).map((x) => `  patch for ${x.patch_file}: ${join(perfHome(), x.patch)}`)] : [])].join('\n'));
      return EXIT.done;
    }
    case 'lessons': {
      if (flags.step && !STEPS.includes(flags.step)) return usage(`perf lessons --step ${STEPS.join('|')}`);
      if (flags.global) { const g = globalLessons(); print(g, g.length ? g.map((x) => `${x.proposed ? '[propose] ' : ''}${x.step}: ${x.text} (${x.projects.length} project(s))${x.patch ? `\n  patch for ${x.patch_file}: ${join(perfHome(), x.patch)}` : ''}`).join('\n') : 'no lessons yet'); return EXIT.done; }
      if (!flags.slug) return usage('perf lessons --slug <slug> [--step plan|…|analyze] | --global');
      const ls = lessonsFor(root, flags.slug, flags.step);
      print(ls, ls.length ? ls.map((x) => `- ${x.step}: ${x.text} (${x.from})`).join('\n') : `no lessons${flags.step ? ` for ${flags.step}` : ''} yet`);
      return EXIT.done;
    }
    case 'scorecard': {
      if (flags.global) { const g = globalScorecard(); print(g, Object.entries(g).map(([ver, x]) => `ai-perf ${ver}: median ${x.median_runs_to_evaluable ?? '-'} run(s) to an evaluable result over ${x.project_profiles} project profile(s); ${x.never_evaluable} never evaluable`).join('\n') || 'no scorecards yet'); return EXIT.done; }
      if (!flags.slug) return usage('perf scorecard --slug <slug> | --global');
      const c = scorecard(root, flags.slug);
      print(c, Object.entries(c.versions).flatMap(([ver, ps]) => Object.entries(ps).map(([p, x]) => `ai-perf ${ver} ${p}${x.continued ? ' (continued from an earlier version)' : ''}: ${x.runs} run(s); evaluable at run ${x.runs_to_evaluable ?? 'none yet'}${Object.keys(x.not_evaluable).length ? `; not evaluable: ${Object.entries(x.not_evaluable).map(([k, n]) => `${k} ×${n}`).join(', ')}` : ''}`)).join('\n') || 'no judged runs yet');
      return EXIT.done;
    }
    case 'contract': {
      if (!flags.slug) return usage('perf contract --slug <slug> [--traffic read,search] [--ops a,b]');
      const list = (x) => (x ? String(x).split(',').map((v) => v.trim()).filter(Boolean) : undefined);
      const c = fromContract(root, flags.slug, { traffic: list(flags.traffic), ops: list(flags.ops) });
      if (c.refused) { print(c, `not drafted: ${c.refused}`); return EXIT.error; }
      print(c, [`contract: ${c.contract}`, `${c.operations.length} operation(s) with x-perf: ${c.operations.map((o) => `${o.id} ${o.p95_ms} ms`).join(', ')}`,
        c.wrote.length ? `drafts written: ${c.wrote.join(', ')} (source contract; error rates are defaults)` : 'no draft written: slo.json and workload.json already exist',
        `next: perf check plan --slug ${flags.slug}, perf check model --slug ${flags.slug}`].join('\n'));
      return EXIT.done;
    }
    case 'import': {
      if (!flags.slug) return usage('perf import --slug <slug>');
      const imp = await importSuites(root, flags.slug);
      print(imp, [...imp.suites.map((s) => `${s.tool} ${s.path}: ${s.operations.length} operation(s)${s.engine ? `, runs as engine ${s.engine} (${s.run_spec})` : ''}${s.reason ? `; ${s.reason}` : ''}`),
        ...imp.results.map((r) => `old result ${r.path} (${r.kind}): kept as reference, not a baseline`),
        imp.wrote.length ? `drafts written: ${imp.wrote.join(', ')} (source imported)` : 'no draft written: the project already has its files',
        `next: perf check import --slug ${flags.slug}, then /perf-audit`].join('\n'));
      return imp.suites.length ? EXIT.done : EXIT.error;
    }
    case 'audit': {
      if (!flags.slug) return usage('perf audit --slug <slug>');
      const a = audit(root, flags.slug);
      print(a, [...a.suites.map((s) => `${s.path} (${s.tool}): ${s.score}/100`), ...a.ranked.map((f) => `  [${f.severity}] ${f.path}${f.lines.length ? `:${f.lines.join(',')}` : ''} ${f.title} (${f.ps})`), `report: .perf/${flags.slug}/audit.md`].join('\n'));
      return a.suites.length ? EXIT.done : EXIT.error;
    }
    case 'check': {
      if (!flags.slug) return usage('perf check <step|all> --slug <slug>');
      const steps = pos[0] === 'all' || !pos[0] ? Object.keys(CHECKS) : [pos[0]];
      if (steps.some((s) => !CHECKS[s])) return usage(`steps: ${Object.keys(CHECKS).join(', ')}, all`);
      const results = steps.map((s) => CHECKS[s](root, flags.slug));
      print(results, results.map((r) => [`${r.ok ? '[ok]  ' : '[FAIL]'} ${r.step}`, ...r.errors.map((e) => `   - ${e}`), ...r.warnings.map((w) => `   ~ ${w}`)].join('\n')).join('\n'));
      return results.every((r) => r.ok) ? EXIT.done : EXIT.error;
    }
    case 'watch': {
      const r = findRun(root, { slug: flags.slug, run: flags.run });
      if (!r) return usage('no run to watch');
      const w = await watch(r.dir, { since: Number(flags.since ?? 0), timeoutS: Number(flags.timeout ?? 3600) });
      print(w, [...w.events.map((e) => `t=${e.t ?? '-'} ${e.severity} ${e.type}: ${e.summary}`), `woke: ${w.reason}; next: perf watch --run ${r.id} --since ${w.next}`].join('\n'));
      return EXIT.done;
    }
    case 'analyze': {
      const r = findRun(root, { slug: flags.slug, run: flags.run });
      if (!r) return usage('no run to analyze');
      const a = analyze(r.dir);
      print(a, `analysis: ${join(r.dir, 'analysis.md')}\nbottleneck: ${a.bottleneck?.hint ?? 'none found'}\nfailures: ${a.failures.map((f) => `${f.class} ×${f.count} (${f.category})`).join('; ') || 'none'}`);
      return EXIT.done;
    }
    case 'report': {
      const r = findRun(root, { slug: flags.slug, run: flags.run });
      if (!r) return usage('no run to report');
      const v = verdict({ root, slug: r.slug, runDir: r.dir, bootstrap: Boolean(flags.bootstrap) });
      writeVerdict(root, r.slug, r.dir, v);
      const l = learn(root, r.slug);
      scorecard(root, r.slug);
      writeBrief(root, r.slug);
      const lines = [`VERDICT: ${v.outcome}`, ...v.reasons.map((x) => `  ${x}`), ...v.notes.map((n) => `  note: ${n}`), ...(v.summary ? [`  summary: ${v.summary}`] : []), ...learnedLines(l)];
      if (flags.promote) {
        const p = promote(root, r.slug, r.dir);
        lines.push(p.ok ? `baseline promoted: ${p.path}` : `not promoted: ${p.why}`);
      }
      print(v, lines.join('\n'));
      return v.exit;
    }
    case 'brief': {
      if (!flags.slug) return usage('perf brief --slug <slug> [--step plan|…|analyze]');
      if (flags.step && !STEPS.includes(flags.step)) return usage(`perf brief --step ${STEPS.join('|')}`);
      const text = brief(root, flags.slug, { step: flags.step });
      print({ brief: text }, text);
      return EXIT.done;
    }
    case 'share': {
      if (!flags.slug) return usage('perf share --slug <slug> [--pushed key[=recall id],…] [--import file.json]');
      if (flags.import) {
        const entries = readJson(resolve(String(flags.import)));
        if (!entries) return usage(`${flags.import}: not readable JSON (an array of knowledge_search results)`);
        const r = importRecalled(root, flags.slug, Array.isArray(entries) ? entries : entries.results ?? entries.entries ?? []);
        writeBrief(root, flags.slug);
        print(r, `from Recall: ${r.added} new, ${r.kept} kept; read them in perf brief`);
        return EXIT.done;
      }
      if (flags.pushed) {
        const done = markShared(root, flags.slug, String(flags.pushed).split(',').filter(Boolean));
        writeBrief(root, flags.slug);
        print(done, `recorded as in Recall: ${done.join(', ') || 'none (nothing pending by those keys)'}`);
        return EXIT.done;
      }
      // Always JSON: each entry is the arguments of one knowledge_push, plus its key.
      console.log(JSON.stringify(outbox(root, flags.slug), null, 2));
      return EXIT.done;
    }
    case 'help': {
      if (!flags.slug) return usage('perf help --slug <slug>');
      const n = nextStep(root, flags.slug);
      print(n, [`next: ${n.command}`, `why:  ${n.why}`, ...(n.lessons ?? []).map((l) => `read: ${l.text} (${l.from})`), ...(n.alternative ? [`small case: ${n.alternative.why}`] : [])].join('\n'));
      return EXIT.done;
    }
    default:
      console.error('usage: perf run|status|stop|doctor (see bin/perf.mjs header)');
      return EXIT.error;
  }
}

process.exitCode = await main();
