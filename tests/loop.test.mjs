import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXES, applyLearned, draftPatch, getField, selfCorrect } from '../lib/remedy.mjs';
import { compareBaseline } from '../lib/verdict.mjs';
import { ROOT, perf, result, tmp } from './helpers.mjs';
import { project, runFake } from './project.mjs';
import { listRuns } from '../lib/runs.mjs';

// M12: run, learn, fix, run again, check the fix. Nobody calls /perf-learn; a fix that touches only
// the load generator is made by ai-perf, one that touches the system or the plan goes to a person.
const T = { timeout: 180000 };
const LOAD = { name: 'load', users: 20, warmup_s: 0.5, ramp_s: 0.5, steady_s: 2, rampdown_s: 0.5 };
const lessons = (root) => JSON.parse(readFileSync(join(root, '.perf', 'demo', 'lessons.json'), 'utf8')).lessons;
const learned = (root) => JSON.parse(readFileSync(join(root, '.perf', 'demo', 'learned.json'), 'utf8'));
const runs = (root) => listRuns(root, 'demo').map((r) => JSON.parse(readFileSync(join(r.dir, 'run.json'), 'utf8')));
// A generator whose CPU grows with the users it carries: 20 users on one worker is 100 %.
const HOT = { cpu_pct_per_user: 5 };
const SAT = { faults: [{ kind: 'saturate', pct: 95 }] };

test('loop: a saturated generator is fixed by the next run, and the fix is checked', { ...T, skip: cpus().length < 2 && 'one CPU: no room for a second local worker' }, () => {
  const root = tmp();
  project(root);
  const r = runFake(root, { workers: 1, profile: LOAD, engine_options: HOT }, ['--until-evaluable', '--bootstrap']);
  assert.match(r.out, /attempt 1\/3: VERDICT NOT_EVALUABLE/);
  assert.match(r.out, /learned: next load run: workers 1 → 2 \(problem:generator_saturated\)/);
  assert.match(r.out, /attempt 2\/3: VERDICT (PASS|WARN)/);
  assert.match(r.out, /fix verified: workers 1 → 2/);
  assert.equal(r.code, 0);
  assert.deepEqual(runs(root).map((s) => s.workers), [1, 2]);
  assert.deepEqual(runs(root)[1].learned, [{ field: 'workers', from: 1, to: 2, lesson: 'problem:generator_saturated', run: runs(root)[0].run_id }]);
  const fix = learned(root).fixes[0];
  assert.equal(fix.status, 'verified');
  assert.equal(fix.checked_by, runs(root)[1].run_id);
  assert.deepEqual(learned(root).profiles, { 'load/closed/local': { workers: 2 } });
  assert.match(readFileSync(join(root, '.perf', 'demo', 'lessons.md'), 'utf8'), /fix verified: workers 1 → 2/);
  // The spec file is the team's: what was learned is applied to each run, never written into it.
  assert.equal(JSON.parse(readFileSync(join(root, 'spec.json'), 'utf8')).workers, 1);
  // A later plain run of the profile starts from what was learned.
  assert.match(runFake(root, { workers: 1, profile: LOAD, engine_options: HOT }).err, /learned: workers 1 → 2 \(problem:generator_saturated/);
  assert.equal(runs(root)[2].workers, 2);
});

test('loop: a fix that keeps failing goes to a person, and the loop stops', T, () => {
  const root = tmp();
  project(root);
  // Saturated whatever the worker count: more workers cannot help.
  const r = runFake(root, { workers: 1, profile: LOAD, engine_options: SAT }, ['--until-evaluable', '--attempts', '5', '--bootstrap']);
  assert.equal(r.code, 3, r.out);
  const fixes = learned(root).fixes;
  assert.ok(fixes.some((f) => f.status === 'recurred'), JSON.stringify(fixes));
  assert.equal(fixes.at(-1).status, 'needs_person', JSON.stringify(fixes));
  assert.match(r.out, /needs a person: problem:generator_saturated: /);
  assert.match(r.out, /no fix ai-perf may make itself/);
  // Never more runs than the recurrences allow (or this machine's CPUs), and fewer than --attempts.
  assert.ok(runs(root).length <= 3, `${runs(root).length} runs`);
  assert.equal(lessons(root).find((l) => l.id === 'problem:generator_saturated').remedy.status, 'needs_person');
  // A fix shown not to help is rolled back: later runs go back to the spec.
  if (fixes.at(-1).terminal) {
    assert.deepEqual(learned(root).profiles, {});
    assert.equal(runFake(root, { workers: 1, profile: LOAD, engine_options: SAT }).err.includes('learned:'), false);
    // A person looked: the lesson's fixes start over.
    assert.match(perf(['learn', '--root', root, '--slug', 'demo', '--reset', 'problem:generator_saturated']).out, /start over from the next run/);
    perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
    runFake(root, { workers: 1, profile: LOAD, engine_options: SAT });
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /learned: next load run: workers 1 → 2/);
  }
});

test('loop: --attempts bounds the runs, and says the next run would apply the fix', { ...T, skip: cpus().length < 4 && 'fewer than 4 CPUs: no room for a second fix' }, () => {
  const root = tmp();
  project(root);
  const r = runFake(root, { workers: 1, profile: LOAD, engine_options: SAT }, ['--until-evaluable', '--attempts', '2', '--bootstrap']);
  assert.equal(runs(root).length, 2);
  assert.match(r.out, /stopped after 2 attempt\(s\); the next run would apply the fix above/);
});

test('loop: a run that was stopped is never answered with another run, and teaches no fix', T, () => {
  const root = tmp();
  project(root);
  // Saturated in steady, then the target's errors trip the auto-stop.
  const r = runFake(root, {
    workers: 1, profile: { ...LOAD, steady_s: 3 },
    engine_options: { ...HOT, faults: [{ kind: 'errors', rate: 1, from_s: 2.5 }] },
    auto_stop: [{ metric: 'error_rate', above: 0.5, for_s: 0.3, min_requests: 10 }],
  }, ['--until-evaluable', '--bootstrap']);
  assert.match(r.out, /the run was stopped \(auto_stop:error_rate\): no new attempt/, r.out);
  assert.doesNotMatch(r.out, /attempt 2/);
  assert.equal(runs(root).length, 1);
  assert.deepEqual(learned(root).profiles, {});
  assert.equal(result(listRuns(root, 'demo')[0].dir).run_state, 'aborted');
});

test('loop: a lesson about the system or the plan is never fixed by ai-perf', T, () => {
  const root = tmp();
  project(root, { 'data/manifest.json': { accounts: { count: 20, source: 'generated' }, cleanup: { command: 'node missing-cleanup.mjs' }, run_id_prefix: true } });
  const r = runFake(root, { workers: 1, profile: LOAD, engine_options: { endpoints: [{ name: 'listItems', weight: 1, median_ms: 40, error_rate: 0.2, error_class: 'HTTP 503' }] } }, ['--until-evaluable', '--bootstrap']);
  assert.match(r.out, /attempt 1\/3/);
  assert.doesNotMatch(r.out, /attempt 2/);
  assert.equal(runs(root).length, 1);
  assert.deepEqual(learned(root).profiles, {});
  const byId = Object.fromEntries(lessons(root).map((l) => [l.id, l]));
  assert.equal(byId['cleanup:failed'].remedy.status, 'needs_person');
  // A finding about the system under test is the test's result, not something to fix.
  assert.equal(byId['failure:HTTP 503'].remedy, undefined);
});

test('learning is automatic: perf report learns, and the next run uses it unless told not to', T, () => {
  const root = tmp();
  project(root);
  runFake(root, { workers: 1, profile: LOAD, engine_options: HOT });
  const rep = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.match(rep.out, /learned: next load run: workers 1 → 2/);
  assert.ok(lessons(root).some((l) => l.id === 'problem:generator_saturated'));
  runFake(root, { workers: 1, profile: LOAD, engine_options: HOT }, ['--no-learned']);
  assert.equal(runs(root)[1].workers, 1);
  assert.equal(runs(root)[1].learned, undefined);
  // A run made without the fix does not check it.
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.equal(learned(root).fixes[0].status, 'applied');
  // perf ci learns too.
  const ci = perf(['ci', join(root, 'spec.json'), '--root', root, '--bootstrap'], 120000);
  assert.match(ci.err, /fix verified: workers 1 → 2/);
});

test('fixes: each touches only the generator, from the run that taught it, within limits', () => {
  const sat = FIXES['problem:generator_saturated'];
  assert.deepEqual(sat({ workers: 2, target: 'ssh' }, { workers: [{ cpu_max_pct: 90 }, { cpu_max_pct: 70 }] }), { field: 'workers', from: 2, to: 3 });
  assert.deepEqual(sat({ workers: 2, target: 'ssh' }, { workers: [{ cpu_max_pct: 100 }] }), { field: 'workers', from: 2, to: 4 });
  // Not above this machine's CPUs for local workers; at the limit, it is a person's choice.
  const n = cpus().length;
  if (n > 1) assert.equal(sat({ workers: 1, target: 'local' }, { workers: [{ cpu_max_pct: 400 }] }).to, Math.min(n, 7));
  assert.match(sat({ workers: n, target: 'local' }, { workers: [{ cpu_max_pct: 100 }] }).cannot, /other or larger machines/);
  // ssh: a few workers per host; a closed loop: never more workers than users.
  assert.equal(sat({ workers: 6, target: 'ssh', ssh: { hosts: ['a'] } }, { workers: [{ cpu_max_pct: 100 }] }).to, 8);
  assert.equal(sat({ workers: 6, target: 'ssh', ssh: { hosts: ['a', 'b'] } }, { workers: [{ cpu_max_pct: 100 }] }).to, 12);
  assert.equal(sat({ workers: 2, target: 'k8s', profile: { users: 3 } }, { workers: [{ cpu_max_pct: 100 }] }).to, 3);
  const lag = FIXES['problem:engine_start_lag'];
  assert.deepEqual(lag({ profile: { rampdown_s: 1 } }, { problems: [{ kind: 'engine_start_lag', data: { lag_s: 3.2 } }] }), { field: 'profile.rampdown_s', from: 1, to: 5 });
  // A run from before the lag was recorded teaches nothing (it must not block a later fix).
  assert.equal(lag({ profile: {} }, { problems: [{ kind: 'engine_start_lag', detail: 'old' }] }), null);
  const vu = FIXES['problem:arrival_shortfall'];
  assert.deepEqual(vu({ profile: { arrival_rps: 50, users: 30 } }), { field: 'profile.users', from: 30, to: 60 });
  assert.equal(vu({ profile: { users: 30 } }), null, 'a closed loop has no VU cap to raise');
  // A smoke stays a smoke.
  assert.equal(vu({ profile: { name: 'smoke', arrival_rps: 5, users: 8 } }).to, 10);
  assert.match(vu({ profile: { name: 'smoke', arrival_rps: 5, users: 10 } }).cannot, /most a smoke run/);
  assert.equal(getField({}, 'workers'), 1);
});

test('fixes: a learned setting never lowers what the spec asks for', () => {
  const root = tmp();
  mkdirSync(join(root, '.perf', 'demo'), { recursive: true });
  writeFileSync(join(root, '.perf', 'demo', 'learned.json'), JSON.stringify({ profiles: {
    'load/closed/local': { workers: 3, 'profile.rampdown_s': 4, 'profile.users': 99, 'profile.steady_s': 99 },
    'load/open/local': { 'profile.users': 60 },
  }, fixes: [] }));
  const raw = { slug: 'demo', workers: 5, profile: { name: 'load', rampdown_s: 1, users: 20 } };
  assert.deepEqual(applyLearned(root, raw).map((c) => [c.field, c.from, c.to]), [['profile.rampdown_s', 1, 4]]);
  // A field no fix moves is never applied, even when the spec sets it lower.
  const timed = { slug: 'demo', workers: 5, profile: { name: 'load', rampdown_s: 9, users: 20, steady_s: 2 } };
  applyLearned(root, timed);
  assert.equal(timed.profile.steady_s, 2);
  assert.equal(raw.workers, 5);
  assert.equal(raw.profile.steady_s, undefined, 'only the fields a fix may move');
  assert.equal(raw.profile.users, 20, 'a VU cap never becomes the users of a closed loop');
  assert.deepEqual(applyLearned(root, { slug: 'demo', profile: { name: 'smoke' } }), []);
  // Another target or model is another key: nothing learned on a laptop reaches a cluster run.
  assert.deepEqual(applyLearned(root, { slug: 'demo', target: 'k8s', profile: { name: 'load' } }), []);
  assert.deepEqual(applyLearned(root, { slug: 'demo', profile: { name: 'load', arrival_rps: 50, users: 30 } }).map((c) => c.to), [60]);
});

// Run folders as perf leaves them, for the replay.
function fakeRun(root, id, run, res, ids) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ slug: 'demo', target: 'local', ...run }));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ run_state: 'done', problems: [], ...res }));
  return { id, dir, ids: new Set(ids) };
}

test('fixes: a fix that cannot be made now does not block one later; a stopped run checks nothing', () => {
  const root = tmp();
  mkdirSync(join(root, '.perf', 'demo'), { recursive: true });
  const n = cpus().length;
  const L = { name: 'load', users: 100 };
  const hot = { workers: [{ cpu_max_pct: 100 }] };
  const doc = selfCorrect(root, 'demo', [
    // At this machine's limit: a person's choice, for now.
    fakeRun(root, 'r1', { workers: n, profile: L }, hot, ['problem:generator_saturated']),
    // The team lowered the workers; the next saturation is fixed again.
    fakeRun(root, 'r2', { workers: 1, profile: L }, hot, ['problem:generator_saturated']),
    // A run stopped by a person used the fix but proves nothing.
    fakeRun(root, 'r3', { workers: 2, profile: L }, { run_state: 'aborted' }, []),
  ]);
  assert.equal(doc.fixes[0].status, 'needs_person');
  if (n > 1) {
    assert.equal(doc.fixes[1].status, 'applied', JSON.stringify(doc.fixes));
    assert.equal(doc.fixes[1].checked_by, undefined);
  }
  // A run with no measured window does not check it either; a full one does.
  const doc2 = selfCorrect(root, 'demo', [
    fakeRun(root, 's1', { workers: 1, profile: L }, hot, ['problem:generator_saturated']),
    fakeRun(root, 's2', { workers: 2, profile: L }, { problems: [{ kind: 'no_measured_window' }] }, []),
    fakeRun(root, 's3', { workers: 2, profile: L }, {}, []),
  ]);
  if (n > 1) assert.deepEqual([doc2.fixes[0].status, doc2.fixes[0].checked_by], ['verified', 's3']);
});

test('baseline: an open run whose VU cap was raised still compares with its baseline', () => {
  const run = (users) => ({ run: { environment: 'local', profile: 'load', tool_version: 'k6 1', target: 'local', model: 'open', arrival_rps: 50, users }, total: { rps: 50, p95_ms: 10, error_rate: 0 }, endpoints: {} });
  assert.equal(compareBaseline(run(60), run(30)).refused, null);
  const closed = (users) => ({ ...run(users), run: { ...run(users).run, model: 'closed' } });
  assert.match(compareBaseline(closed(60), closed(30)).refused, /30 users, this run at 60/);
});

test('cli: switches never swallow the spec; --until-evaluable needs what is learned', T, () => {
  const root = tmp();
  project(root);
  runFake(root, { workers: 1, profile: LOAD });
  const p = join(root, 'spec.json');
  assert.equal(perf(['run', '--no-learned', p, '--root', root, '--wait']).code, 0);
  assert.match(perf(['run', '--until-evaluable', '--no-learned', p, '--root', root]).err, /cannot run with --no-learned/);
  // --json keeps stdout parseable.
  const ci = perf(['ci', p, '--root', root, '--until-evaluable', '--bootstrap', '--json'], 120000);
  assert.doesNotMatch(ci.out, /attempt \d/);
  assert.match(ci.err, /attempt 1\/3/);
});

function patchCase(text, lesson) {
  const bundle = tmp();
  const file = join(bundle, 'skills', 'executing-load', 'SKILL.md');
  mkdirSync(join(bundle, 'skills', 'executing-load'), { recursive: true });
  writeFileSync(file, text);
  const d = draftPatch({ step: 'run', text: lesson }, bundle);
  writeFileSync(join(bundle, 'p.patch'), d.patch);
  // As the bundle's own checkout applies it: no line-end conversion by this machine's git config.
  const a = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', 'p.patch'], { cwd: bundle, encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr + d.patch);
  return readFileSync(file, 'utf8');
}

test('tool learning: the patch goes under its heading wherever it is, and keeps the file as it is', () => {
  // The heading is not the last section: the lesson goes at the end of its section.
  assert.equal(patchCase('# S\n\n## Lessons from other projects\n\n- old\n\n## Troubleshooting\n\nstuff\n', 'new'),
    '# S\n\n## Lessons from other projects\n\n- old\n- new\n\n## Troubleshooting\n\nstuff\n');
  // A CRLF checkout stays CRLF.
  assert.equal(patchCase('# S\r\n\r\nbody\r\n', 'new'), '# S\r\n\r\nbody\r\n\r\n## Lessons from other projects\r\n\r\n- new\r\n');
  // A file without a final newline gets one.
  assert.equal(patchCase('# S\n\nbody', 'new'), '# S\n\nbody\n\n## Lessons from other projects\n\n- new\n');
});

test('tool learning: a lesson two projects taught becomes a patch that applies to the skill', () => {
  const bundle = tmp();
  cpSync(join(ROOT, 'skills', 'executing-load'), join(bundle, 'skills', 'executing-load'), { recursive: true });
  const lesson = { step: 'run', text: 'Start the target before the run; a cold JIT reads as a slow service.' };
  const d = draftPatch(lesson, bundle);
  assert.equal(d.file, 'skills/executing-load/SKILL.md');
  writeFileSync(join(bundle, 'p.patch'), d.patch);
  const apply = spawnSync('git', ['apply', 'p.patch'], { cwd: bundle, encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  const skill = readFileSync(join(bundle, d.file), 'utf8').replace(/\r\n/g, '\n');
  assert.match(skill, /## Lessons from other projects\n\n- Start the target before the run/);
  // Once there, it is not proposed again; a second lesson goes under the same heading.
  assert.equal(draftPatch(lesson, bundle), null);
  const d2 = draftPatch({ step: 'run', text: 'Another lesson.' }, bundle);
  assert.doesNotMatch(d2.patch, /\+## Lessons/);
  writeFileSync(join(bundle, 'p2.patch'), d2.patch);
  assert.equal(spawnSync('git', ['apply', 'p2.patch'], { cwd: bundle }).status, 0);
  assert.ok(existsSync(join(bundle, d.file)));
});
