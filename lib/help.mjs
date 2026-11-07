import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, projectDir } from './checks.mjs';
import { describe, listRuns } from './runs.mjs';
import { readJson } from '../controller/files.mjs';
import { isTerminal } from '../controller/state.mjs';
import { lessonsFor } from './learn.mjs';

// A small case (design §13, P3): a handful of operations, a known peak of at most 50 users, no
// realtime, no suite to bring in, no peak event or incident to reproduce. stlc's light perf tier
// (a smoke and one load check in the same flow as the rest of testing) covers it; ai-perf's full
// lifecycle is more than it needs. Said, never imposed: the team decides.
export const SMALL = { operations: 5, users: 50 };
export function smallCase(root, slug) {
  const dir = projectDir(root, slug);
  const ctx = readJson(join(dir, 'context.json'));
  if (!ctx) return null;
  const f = ctx.facts ?? {};
  const a = ctx.answers ?? {};
  const w = readJson(join(dir, 'workload.json'));
  if (f.realtime?.length || f.existing_suites?.length) return null;
  const ops = w ? new Set((w.journeys ?? []).flatMap((j) => j.steps ?? [])).size : (f.operations ?? []).length;
  if (!ops || ops > SMALL.operations) return null;
  const said = [...String(a.peak_load ?? '').matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, '')));
  const peak = w?.target?.users ?? (said.length ? Math.max(...said) : NaN);
  if (!(peak > 0) || peak > SMALL.users || w?.model === 'open') return null;
  if ([a.peak_event, a.past_incidents].some((x) => x !== undefined && !/^no\b/i.test(String(x)))) return null;
  return { to: 'stlc', why: `${ops} operation(s), a peak of ${peak} users, no realtime, no existing suite, no peak event or incident: stlc's perf tier (a smoke and one load check) covers it; ai-perf's full lifecycle is more than it needs` };
}

const STEP_OF = { '/perf-plan': 'plan', '/perf-model': 'model', '/perf-env': 'env', '/perf-data': 'data', '/perf-script': 'script', '/perf-run': 'run', '/perf-analyze': 'analyze' };

// A step is only ever a command this bundle has: help must never send anyone to a missing one.
const COMMANDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');
export const hasCommand = (c) => existsSync(join(COMMANDS, `${c.slice(1)}.md`));

// /perf-help: "what now?" from the project's files alone. It never asks and never writes.
export function nextStep(root, slug) {
  const s = next(root, slug);
  const step = STEP_OF[s.command];
  if (!step) return s;
  const lessons = lessonsFor(root, slug, step);
  const small = ['plan', 'model', 'env', 'data', 'script'].includes(step) ? smallCase(root, slug) : null;
  return { ...s, ...(lessons.length ? { lessons: lessons.map((l) => ({ text: l.text, from: l.from })) } : {}), ...(small ? { alternative: small } : {}) };
}

function next(root, slug) {
  const dir = projectDir(root, slug);
  const has = (f) => existsSync(join(dir, f));
  const step = (command, why) => ({ command, why });
  if (!existsSync(dir)) return step('/perf-start', 'no .perf/ for this project yet');
  if (!has('context.json')) return step('/perf-discover', 'the system has not been read yet');
  const ctx = readJson(join(dir, 'context.json'));
  if (ctx?.facts?.existing_suites?.length && !has('import.json') && hasCommand('/perf-import')) return step('/perf-import', `existing ${[...new Set(ctx.facts.existing_suites.map((s) => s.tool))].join(', ')} suite found; bring it in before writing new scripts`);
  if (has('import.json')) {
    const imp = CHECKS.import(root, slug);
    if (!imp.ok) return step('/perf-import', `its gate fails: ${imp.errors[0]}`);
    if (!has('audit.json') && hasCommand('/perf-audit')) return step('/perf-audit', 'the imported suite has not been scored against perf-standard yet');
  }
  for (const [name, command, file] of [['plan', '/perf-plan', 'slo.json'], ['model', '/perf-model', 'workload.json'], ['env', '/perf-env', 'env.json'], ['data', '/perf-data', 'data/manifest.json']]) {
    if (!has(file)) return step(command, `${file} is missing`);
    const c = CHECKS[name](root, slug);
    if (!c.ok) return step(command, `its gate fails: ${c.errors[0]}`);
  }
  const runs = listRuns(root, slug).map((r) => ({ ...r, d: describe(r.dir), spec: readJson(join(r.dir, 'run.json')) }));
  const live = runs.find((r) => !isTerminal({ state: r.d.state }) && r.d.controller !== 'lost');
  if (live) return step('/perf-watch', `run ${live.id} is ${live.d.state}`);
  const lost = runs.find((r) => r.d.controller === 'lost');
  if (lost) return step('/perf-doctor', `run ${lost.id} lost its controller`);
  const script = CHECKS.script(root, slug);
  if (!script.ok) return step('/perf-script', script.errors[0]);
  const last = runs.filter((r) => r.spec?.profile?.name !== 'smoke').at(-1);
  if (!last) return step('/perf-run', 'smoke is clean; run the first load profile');
  if (!existsSync(join(last.dir, 'analysis.json'))) return step('/perf-analyze', `run ${last.id} is not analysed`);
  if (!existsSync(join(last.dir, 'verdict.json'))) return step('/perf-report', `run ${last.id} has no verdict`);
  const v = readJson(join(last.dir, 'verdict.json'));
  if (v.outcome === 'FAIL') return step('/perf-analyze', `run ${last.id} FAILED: fix the cause, then /perf-run again and /perf-compare the two runs`);
  // Nothing trustworthy was measured: the run itself must be fixed before any next profile.
  if (v.outcome === 'NOT_EVALUABLE') return step('/perf-analyze', `run ${last.id} is NOT EVALUABLE (${v.reasons[0] ?? 'see verdict.md'}); fix that and run it again`);
  if (!(readJson(join(dir, 'lessons.json'))?.seen ?? []).includes(last.id)) return step('/perf-learn', `run ${last.id} is judged; collect what it taught before the next run`);
  return step('/perf-run', `run ${last.id} is ${v.outcome}; the next profile in the plan, or the same one after a change (then /perf-compare)`);
}
