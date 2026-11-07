import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeMix, plannedMix } from '../lib/verdict.mjs';
import { spawnSync } from 'node:child_process';
import { ROOT, perf, result, runDir, tmp } from './helpers.mjs';
import { JOURNEYS, project, runFake } from './project.mjs';

// M9: what each run leaves behind (its data, cleaned up), whether it ran the planned workload, and
// what the next run learns from it.
const T = { timeout: 120000 };
const LOAD = { name: 'load', users: 20, warmup_s: 0.5, ramp_s: 0.5, steady_s: 3, rampdown_s: 0.5 };
const report = (root, ...args) => perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', ...args]);
const manifest = (cleanup) => ({ 'data/manifest.json': { accounts: { count: 20, source: 'generated' }, cleanup, run_id_prefix: true } });

// ---- cleanup -------------------------------------------------------------------------------

test('cleanup: the manifest command runs after every run, with the run id', T, () => {
  const root = tmp();
  project(root);
  runFake(root, { profile: LOAD });
  const res = result(runDir(root));
  assert.equal(res.cleanup.exit_code, 0);
  assert.equal(res.cleanup.command, `node cleanup.mjs --prefix ${res.run.id}`);
  assert.equal(readFileSync(join(root, 'cleaned.txt'), 'utf8').trim(), res.run.id);
  assert.ok(readFileSync(join(runDir(root), 'events.ndjson'), 'utf8').includes('"type":"cleanup"'));
  assert.doesNotMatch(report(root).out, /cleanup failed/);
});

test('cleanup: after the result is written and its time is not the run\'s; credentials are masked; a process it leaves is not waited for', T, () => {
  const root = tmp();
  writeFileSync(join(root, 'dsn.mjs'), "setTimeout(() => { console.log('connecting to postgres://u:' + 'hunter2@db/x'); process.exit(1); }, 1500);\n");
  project(root, manifest({ command: 'node dsn.mjs --password=hunter2' }));
  runFake(root, { profile: LOAD });
  const res = result(runDir(root));
  assert.ok(res.cleanup.duration_s >= 1.4, JSON.stringify(res.cleanup));
  const cleanedAt = JSON.parse(readFileSync(join(runDir(root), 'events.ndjson'), 'utf8').trim().split('\n').find((l) => l.includes('"type":"cleanup"'))).ts;
  assert.ok(Date.parse(cleanedAt) - Date.parse(res.run.ended_at) >= 1400, 'ended_at is when load stopped, before the cleanup');
  report(root);
  for (const f of ['result.json', 'events.ndjson', 'verdict.md']) assert.doesNotMatch(readFileSync(join(runDir(root), f), 'utf8'), /hunter2/, f);
  assert.match(res.cleanup.command, /--password=\*\*\*/);
  // It exits at once and leaves a child holding its output: done, not timed out.
  project(root, manifest({ command: 'node -e "require(\'child_process\').spawn(process.execPath, [\'-e\', \'setTimeout(() => {}, 8000)\'], { stdio: \'inherit\', detached: true }).unref()"', timeout_s: 6 }));
  runFake(root, { profile: LOAD });
  const bg = result(runDir(root)).cleanup;
  assert.equal(bg.exit_code, 0, JSON.stringify(bg));
  assert.ok(bg.duration_s < 4, JSON.stringify(bg));
  project(root, manifest({ command: 'node cleanup.mjs', timeout_s: 'soon' }));
  assert.match(perf(['check', 'data', '--root', root, '--slug', 'demo']).out, /cleanup.timeout_s: .* a number > 0/);
});

test('cleanup: a failing or hanging cleanup is a warning that names the command; "none:" is a declared no-op', T, () => {
  const root = tmp();
  project(root, manifest({ command: 'node -e "process.exit(3)"' }));
  runFake(root, { profile: LOAD });
  assert.match(report(root).out, /WARN: cleanup failed \(exit 3\): data of run .* may be left behind; run `node -e "process.exit\(3\)"` by hand/);
  project(root, manifest({ command: 'node -e "setTimeout(() => {}, 60000)"', timeout_s: 1 }));
  runFake(root, { profile: LOAD });
  const res = result(runDir(root));
  assert.equal(res.cleanup.exit_code, null);
  assert.match(res.cleanup.output, /killed after 1 s/);
  assert.match(report(root).out, /WARN: cleanup failed \(timed out\)/);
  project(root, manifest({ command: 'none: the mock keeps no state' }));
  runFake(root, { profile: LOAD });
  assert.deepEqual(result(runDir(root)).cleanup, { skipped: 'none: the mock keeps no state' });
  assert.match(report(root).out, /VERDICT: PASS/);
});

// ---- the measured mix ----------------------------------------------------------------------

test('mix: the planned share of each operation follows journey weights and steps', () => {
  assert.deepEqual(plannedMix({ journeys: JOURNEYS }), { listItems: 0.6, getItem: 0.3, createOrder: 0.1 });
  // A journey of three steps puts a third of its weight on each; a repeated step counts twice.
  const mix = plannedMix({ journeys: [{ weight_pct: 50, steps: ['a', 'b', 'a'] }, { weight_pct: 50, steps: ['c'] }] });
  assert.deepEqual(Object.fromEntries(Object.entries(mix).map(([k, x]) => [k, Math.round(x * 1000) / 1000])), { a: 0.5, b: 0.25, c: 0.25 });
});

test('mix: in a closed model a journey weighs by users over their cycle; a rare operation never sent fails', () => {
  // Half the users think 1 s, half 10 s: the first half sends ten times as often.
  const closed = plannedMix({ model: 'closed', journeys: [{ weight_pct: 50, steps: ['a'], think_time_s: 1 }, { weight_pct: 50, steps: ['b'], think_time_s: 10 }] }, { a: { p50_ms: 0 }, b: { p50_ms: 0 } });
  assert.equal(Math.round(closed.a * 1000) / 1000, 0.909);
  // An open plan is shares of arrivals, whatever the think time.
  assert.equal(plannedMix({ model: 'open', journeys: [{ weight_pct: 50, steps: ['a'], think_time_s: 1 }, { weight_pct: 50, steps: ['b'], think_time_s: 10 }] }).a, 0.5);
  const warned = [];
  const plan = { model: 'open', journeys: [{ weight_pct: 97, steps: ['a'] }, { weight_pct: 3, steps: ['rare'] }] };
  judgeMix({}, (o, why) => warned.push(why), { a: { requests: 1000 } }, plan);
  assert.match(warned.join(), /rare planned 3 %, sent 0 %/);
  warned.length = 0;
  judgeMix({}, (o, why) => warned.push(why), { a: { requests: 970 }, rare: { requests: 30 } }, plan);
  assert.deepEqual(warned, []);
});

test('mix: a run that sends another mix than workload.json is a warning; so are unplanned operations', T, () => {
  const root = tmp();
  // The plan says a third each; the fake engine sends 60 / 30 / 10.
  const even = JOURNEYS.map((j, i) => ({ ...j, weight_pct: [34, 33, 33][i] }));
  project(root, { 'workload.json': { ...JSON.parse(readFileSync(join(projectFile(root), 'workload.json'), 'utf8')), journeys: even } });
  runFake(root, { profile: LOAD });
  const r = report(root);
  assert.match(r.out, /WARN: the mix is not the plan's \(workload.json\): listItems planned [\d.]+ %, sent [\d.]+ %; createOrder planned [\d.]+ %, sent [\d.]+ %/);
  // An operation the plan does not have, sent 10 % of the time.
  project(root, { 'workload.json': { ...JSON.parse(readFileSync(join(projectFile(root), 'workload.json'), 'utf8')), journeys: JOURNEYS.slice(0, 2).map((j, i) => ({ ...j, weight_pct: [67, 33][i] })) } });
  runFake(root, { profile: LOAD });
  assert.match(report(root).out, /WARN: \d+(\.\d)? % of requests went to operations workload.json does not plan: createOrder/);
});

function projectFile(root) {
  const dir = join(root, '.perf', 'demo');
  if (!existsSync(join(dir, 'workload.json'))) project(root);
  return dir;
}


// ---- lessons at each step, and across projects --------------------------------------------

const EVEN = JOURNEYS.map((j, i) => ({ ...j, weight_pct: [34, 33, 33][i] }));
// A project whose run teaches two lessons about the way it was run: its script's mix was off
// (step script) and its cleanup failed (step run); and one about the system: an HTTP 503 class.
function badRun(root) {
  project(root, manifest({ command: 'node -e "process.exit(3)"' }));
  const w = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'workload.json'), 'utf8'));
  writeFileSync(join(root, '.perf', 'demo', 'workload.json'), JSON.stringify({ ...w, journeys: EVEN }));
  writeFileSync(join(root, '.perf', 'demo', 'context.json'), JSON.stringify({ facts: { operations: [], realtime: ['ws'], existing_suites: [] }, answers: {} }));
  runFake(root, { profile: LOAD, engine_options: { faults: [{ kind: 'errors', rate: 0.005, class: 'HTTP 503' }] } });
  perf(['analyze', '--root', root, '--slug', 'demo']);
  report(root);
  return perf(['learn', '--root', root, '--slug', 'demo']);
}

test('lessons: each is read at the step that can act on it (perf lessons, perf help, perf run)', T, () => {
  const root = tmp();
  badRun(root);
  assert.match(perf(['lessons', '--root', root, '--slug', 'demo', '--step', 'script']).out, /- script: A script sent another mix of operations than workload.json plans.* \(this project\)/);
  assert.doesNotMatch(perf(['lessons', '--root', root, '--slug', 'demo', '--step', 'script']).out, /cleanup/);
  assert.equal(perf(['lessons', '--root', root, '--slug', 'demo', '--step', 'nonsense']).code, 1);
  // No smoke yet: the next step is the script step, and help puts its lesson in front of it.
  const help = perf(['help', '--root', root, '--slug', 'demo']).out;
  assert.match(help, /next: \/perf-script/);
  assert.match(help, /read: A script sent another mix .*\(this project\)/);
  // perf run says the run step's lessons before it loads anything.
  assert.match(runFake(root, { profile: LOAD }).err, /lesson \(this project\): The data cleanup failed after a run/);
});

// Cross-project files live under PERF_HOME: a test that counts projects has its own.
const ownHome = () => { process.env.PERF_HOME = tmp(); };

test('lessons: two clones of one repository are one project, and no path or remote is written down', T, () => {
  ownHome();
  const [a, b] = [tmp(), tmp()];
  for (const r of [a, b]) { spawnSync('git', ['init', '-q'], { cwd: r }); spawnSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/team/shop.git'], { cwd: r }); }
  badRun(a);
  assert.doesNotMatch(badRun(b).out, /propose to the bundle/);
  const store = readFileSync(join(process.env.PERF_HOME, 'lessons.json'), 'utf8');
  for (const leak of [a, b, 'gitlab.example.com'].map((x) => x.replace(/\\/g, '\\\\'))) assert.ok(!store.includes(leak), leak);
});

test('lessons: one learned before lessons had steps takes its step on the next learn', T, () => {
  const root = tmp();
  badRun(root);
  const p = join(root, '.perf', 'demo', 'lessons.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  for (const l of doc.lessons) delete l.step;
  writeFileSync(p, JSON.stringify(doc));
  perf(['learn', '--root', root, '--slug', 'demo']);
  assert.ok(JSON.parse(readFileSync(p, 'utf8')).lessons.every((l) => l.step), 'every lesson has its step again');
});

test('lessons: a lesson about running ai-perf that two projects taught is proposed to the bundle, and read by a third', T, () => {
  ownHome();
  const [a, b, c] = [tmp(), tmp(), tmp()];
  assert.doesNotMatch(badRun(a).out, /propose to the bundle/);
  assert.match(badRun(b).out, /seen in two projects or more, propose to the bundle: .*\[cleanup:failed\] \(2 projects\)/);
  const g = perf(['lessons', '--global']).out;
  assert.match(g, /\[propose\] run: The data cleanup failed .* \(2 project\(s\)\)/);
  // Lessons about a system under test stay with it.
  assert.match(readFileSync(join(a, '.perf', 'demo', 'lessons.md'), 'utf8'), /Under load, HTTP 503/);
  assert.doesNotMatch(g, /Under load|HTTP 503/);
  project(c);
  assert.match(perf(['lessons', '--root', c, '--slug', 'demo', '--step', 'run']).out, /- run: The data cleanup failed .* \(2 other project\(s\)\)/);
});

// ---- runs to an evaluable result ----------------------------------------------------------

test('scorecard: runs until one could be judged, and why the ones before could not, per version and profile', T, () => {
  ownHome();
  const root = tmp();
  project(root);
  for (let i = 0; i < 2; i++) { runFake(root, { profile: LOAD }); perf(['report', '--root', root, '--slug', 'demo']); }
  runFake(root, { profile: LOAD });
  report(root);
  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
  const card = perf(['scorecard', '--root', root, '--slug', 'demo']).out;
  assert.match(card, new RegExp(`ai-perf ${version.replace(/\./g, '\\.')} load: 3 run\\(s\\); evaluable at run 3; not evaluable: no baseline at baselines/local/load.json ×2`));
  assert.match(perf(['scorecard', '--global']).out, new RegExp(`ai-perf ${version.replace(/\./g, '\\.')}: median 3 run\\(s\\) to an evaluable result`));
  // A profile first judged under an earlier version is continued here: kept out of this version's median.
  const first = join(runDir(root), '..', readdirSync(join(runDir(root), '..')).sort()[0], 'run.json');
  writeFileSync(first, JSON.stringify({ ...JSON.parse(readFileSync(first, 'utf8')), ai_perf_version: '0.0.1' }));
  assert.match(perf(['scorecard', '--root', root, '--slug', 'demo']).out, new RegExp(`ai-perf ${version.replace(/\./g, '\\.')} load \\(continued from an earlier version\\): 2 run`));
  assert.match(perf(['scorecard', '--global']).out, /ai-perf 0\.0\.1: median - run\(s\) .* 1 never evaluable/);
  assert.doesNotMatch(perf(['scorecard', '--global']).out, new RegExp(`ai-perf ${version.replace(/\./g, '\\.')}:`));
});

// ---- small cases go to stlc ---------------------------------------------------------------

test('routing: a small case is pointed at stlc\'s perf tier; realtime, a big peak or an incident keep it here', T, () => {
  const root = tmp();
  project(root);
  const ctx = (facts = {}, answers = {}) => writeFileSync(join(root, '.perf', 'demo', 'context.json'), JSON.stringify({ facts: { operations: ['listItems', 'getItem', 'createOrder'], realtime: [], existing_suites: [], ...facts }, answers }));
  const help = () => perf(['help', '--root', root, '--slug', 'demo']).out;
  ctx();
  assert.match(help(), /small case: 3 operation\(s\), a peak of 20 users, .*stlc's perf tier/);
  ctx({ realtime: ['socket.io'] });
  assert.doesNotMatch(help(), /small case/);
  ctx({}, { past_incidents: 'yes, checkout timed out on Black Friday' });
  assert.doesNotMatch(help(), /small case/);
  ctx();
  const w = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'workload.json'), 'utf8'));
  writeFileSync(join(root, '.perf', 'demo', 'workload.json'), JSON.stringify({ ...w, target: { ...w.target, users: 500 } }));
  assert.doesNotMatch(help(), /small case/);
  // Before the model, the peak is the answer to discover; a range is as big as its top.
  rmSync(join(root, '.perf', 'demo', 'workload.json'));
  ctx({}, { peak_load: '30 users' });
  assert.match(help(), /small case: 3 operation\(s\), a peak of 30 users/);
  ctx({}, { peak_load: '30-300 users' });
  assert.doesNotMatch(help(), /small case/);
});
