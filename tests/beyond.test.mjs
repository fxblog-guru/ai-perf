import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { breakpointOf, extendSteps, readStaircase } from '../lib/breakpoint.mjs';
import { brokeClearly, checkMatrix, deepMerge, maskDeep, rank } from '../lib/matrix.mjs';
import { recoveryFrom, withinSlo } from '../lib/verdict.mjs';
import { rulesAt } from '../controller/rules.mjs';
import { normalize } from '../controller/spec.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { create, record } from '../controller/hist.mjs';
import { listRuns } from '../lib/runs.mjs';
import { PROFILES, norm, perf, result, runDir, spec, tmp } from './helpers.mjs';
import { ENDPOINTS, JOURNEYS, OPS, project, runFake } from './project.mjs';

// M14, beyond the peak: the breakpoint found by climbing on, recovery after an overload judged
// against the SLO, and a matrix of settings ranked with ties for what noise cannot tell apart.
const T = { timeout: 300000 };

const slo = (profiles, extra = {}) => ({ profiles, transactions: OPS.map((name) => ({ name, slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' })), ...extra });
const workload = (users) => ({
  model: 'closed', model_reason: 'a fixed pool of signed-in shoppers', target: { users, source: 'assumed' },
  personas: [{ name: 'buyer', share_pct: 100, source: 'assumed' }],
  journeys: JOURNEYS,
  littles_law: { rps: users * 10, response_s: 0, think_s: 0.1, users },
});
const report = (root, ...args) => perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', ...args]);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const verdictJson = (root) => read(join(runDir(root), 'verdict.json'));
// The project's environment, with the ceiling its owner allows a breakpoint search.
const envWith = (extra) => ({ environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: PROFILES, owner: 'test', parity: 'laptop mock', third_party: [{ name: 'payments', stubbed: true }], ...extra } } });
const CEILING = envWith({ max_users: 64 });
const bnorm = (x, extra = { max_users: 64 }) => norm(x, { envExtra: extra });

// ---- breakpoint ------------------------------------------------------------------------------

// Two steps of 2 s; 10 requests per user per second. A target capped at 150 requests/s queues
// past it (fake max_rps): at 32 users createOrder's p95 passes its 400 ms SLA, at 16 it does not.
const STAIRS = { name: 'stress', steps: [4, 8], step_s: 2, warmup_s: 1, ramp_s: 1, rampdown_s: 0.5 };
const res = (steps, extra = {}) => ({ run: { model: 'closed' }, run_state: 'done', problems: [], workers: [], steps, ...extra });
const step = (index, users, p95, complete = true, error_rate = 0) => ({ index, users, complete, endpoints: Object.fromEntries(OPS.map((n) => [n, { requests: 100, p95_ms: p95, p99_ms: p95, error_rate }])) });

test('breakpoint: the next staircase climbs from the last step that held, by the factor, cut at the ceiling', () => {
  assert.deepEqual(extendSteps(8, 2, { factor: 2, max: 64 }), [8, 16]);
  assert.deepEqual(extendSteps(8, 4, { factor: 2, max: 64 }), [8, 16, 32, 64]);
  assert.deepEqual(extendSteps(8, 4, { factor: 2, max: 40 }), [8, 16, 32, 40], 'the last step is the ceiling');
  assert.deepEqual(extendSteps(2, 3, { factor: 1.1, max: 10 }), [2, 3, 4], 'each step at least one above the one before');
  assert.equal(extendSteps(40, 2, { factor: 2, max: 40 }), null, 'at the ceiling: no further run');
  // The spec gate: a ceiling above the top step, a factor above 1, only on a staircase.
  assert.deepEqual(bnorm(spec({ profile: { ...STAIRS, breakpoint: { factor: 2, max: 64 } } })).errors, []);
  assert.match(bnorm(spec({ profile: { ...STAIRS, breakpoint: { factor: 2, max: 7 } } })).errors.join(), /breakpoint.max: a number at or above the top step/);
  assert.deepEqual(bnorm(spec({ profile: { ...STAIRS, breakpoint: { max: 8 } } })).errors, [], 'a climbed staircase ends on the ceiling');
  assert.match(bnorm(spec({ profile: { ...STAIRS, breakpoint: { factor: 1, max: 64 } } })).errors.join(), /breakpoint.factor: a number > 1/);
  assert.match(bnorm(spec({ profile: { ...STAIRS, breakpoint: { max: 64, step: 3 } } })).errors.join(), /profile.breakpoint: \{ factor\?, max \}/);
  assert.match(bnorm(spec({ profile: { name: 'load', users: 4, breakpoint: { max: 64 } } })).errors.join(), /breakpoint: only with steps/);
  // The ceiling is the environment owner's, not the spec's: none set, or a max above it, is refused.
  assert.match(bnorm(spec({ profile: { ...STAIRS, breakpoint: { max: 64 } } }), {}).errors.join(), /environment "local" sets no ceiling \(env.json max_users/);
  assert.match(bnorm(spec({ profile: { ...STAIRS, breakpoint: { max: 65 } } })).errors.join(), /breakpoint.max: 65 is above the 64 the owner of "local" allows/);
  assert.match(bnorm(spec({ profile: { ...STAIRS, model: 'open', breakpoint: { max: 64 } } })).errors.join(), /sets no ceiling \(env.json max_arrival_rps/);
  assert.deepEqual(bnorm(spec({ profile: { ...STAIRS, model: 'open', breakpoint: { max: 64 } } }), { max_arrival_rps: 64 }).errors, []);
});

test('breakpoint: a run reads as broke, held, generator or unjudged, and only what was observed is claimed', () => {
  const s = slo(['stress']);
  assert.deepEqual(readStaircase(res([step(0, 4, 50), step(1, 8, 60)]), s), { kind: 'held', held: 8, unit: 'users' });
  const b = readStaircase(res([step(0, 4, 50), step(1, 8, 500)]), s);
  assert.equal(b.kind, 'broke');
  assert.equal(b.held, 4);
  assert.equal(b.broke, 8);
  assert.match(b.why, /listItems p95 500 > SLA 400 ms/);
  // The target broke under load (auto-stop on errors) during a step it did not finish.
  const stopped = readStaircase(res([step(0, 4, 50), step(1, 8, 60, false)], { run_state: 'aborted' }), s, 'auto_stop:error_rate');
  assert.deepEqual([stopped.kind, stopped.held, stopped.broke], ['broke', 4, 8]);
  assert.match(stopped.why, /auto-stopped \(auto_stop:error_rate\)/);
  // Anything else cut short says nothing: a person's stop, a lost worker.
  assert.equal(readStaircase(res([step(0, 4, 50), step(1, 8, 60, false)], { run_state: 'aborted' }), s, 'manual').kind, 'unjudged');
  assert.equal(readStaircase(res([step(0, 4, 50), step(1, 8, 60)], { run_state: 'degraded' }), s).kind, 'unjudged');
  // A saturated generator measured itself: no step above it is the target's.
  assert.equal(readStaircase(res([step(0, 4, 50), step(1, 8, 500)], { run_state: 'not_evaluable', problems: [{ kind: 'generator_saturated' }] }), s).kind, 'generator');
  // Across runs: the last held step, then the first that broke, each with its run.
  const runs = [{ run_id: 'a', reading: { kind: 'held', held: 8, unit: 'users' } }, { run_id: 'b', reading: { kind: 'broke', held: 12, broke: 16, why: 'x', unit: 'users' } }];
  assert.deepEqual(breakpointOf(runs), { found: true, unit: 'users', held: { value: 12, run: 'b' }, broke: { value: 16, run: 'b', why: 'x' } });
  // The extension's first step (the one that held before) breaking now: the earlier hold is kept,
  // and the result is flagged as the edge, not a clean breakpoint.
  const edge = breakpointOf([runs[0], { run_id: 'b', reading: { kind: 'broke', held: null, broke: 8, why: 'x', unit: 'users' } }]);
  assert.deepEqual([edge.held, edge.broke.value, edge.unstable], [{ value: 8, run: 'a' }, 8, true]);
  // A load lower than one that held, breaking later, is the edge too; a higher one is not.
  assert.equal(breakpointOf([{ run_id: 'a', reading: { kind: 'held', held: 16, unit: 'users' } }, { run_id: 'b', reading: { kind: 'broke', held: null, broke: 12, why: 'x', unit: 'users' } }]).unstable, true);
  assert.equal(breakpointOf([{ run_id: 'a', reading: { kind: 'held', held: 16, unit: 'users' } }, { run_id: 'b', reading: { kind: 'broke', held: null, broke: 17, why: 'x', unit: 'users' } }]).unstable, undefined);
  // Nothing broke: no breakpoint, whatever held.
  assert.deepEqual(breakpointOf([runs[0]]), { found: false, unit: 'users', held: { value: 8, run: 'a' }, broke: null });
  assert.equal(breakpointOf([{ run_id: 'a', reading: { kind: 'generator', why: 'x' } }]).found, false);
});

test('breakpoint: a step that did not measure a planned transaction, a plan that fails its gates, or a stop after the last step is read as nothing', () => {
  const s = slo(['stress']);
  const without = (st, name) => { delete st.endpoints[name]; return st; };
  // createOrder never sent in step 2, the others within the SLA: not a break.
  let r = readStaircase(res([step(0, 4, 50), without(step(1, 8, 60), 'createOrder')]), s);
  assert.equal(r.kind, 'unjudged');
  assert.match(r.why, /step 2 \(8 users\) did not measure createOrder: neither held nor broken/);
  // A transaction missing, but another past its SLA: that is a break.
  r = readStaircase(res([step(0, 4, 50), without(step(1, 8, 900), 'createOrder')]), s);
  assert.deepEqual([r.kind, r.broke], ['broke', 8]);
  // The target broke under load, a transaction missing in the unfinished step: still a break.
  r = readStaircase(res([step(0, 4, 50), without(step(1, 8, 60, false), 'createOrder')], { run_state: 'aborted' }), s, 'auto_stop:error_rate');
  assert.equal(r.kind, 'broke');
  // The plan, model, environment or data gate failing: no step is read either way.
  const gate = { reasons: ['NOT_EVALUABLE: the model gate fails (perf check model): journeys: at least one'] };
  assert.equal(readStaircase(res([step(0, 4, 50), step(1, 8, 900)]), s, '', gate).kind, 'unjudged');
  assert.equal(readStaircase(res([step(0, 4, 50), step(1, 8, 900)]), s, '', { reasons: ['NOT_EVALUABLE: no baseline at baselines/local/stress.json (PS-F4)'] }).kind, 'broke', 'only a gate makes it unreadable');
  // Auto-stopped on errors after every step held: where it broke was not measured.
  r = readStaircase(res([step(0, 4, 50), step(1, 8, 60)], { run_state: 'aborted' }), s, 'auto_stop:error_rate');
  assert.equal(r.kind, 'unjudged');
  assert.match(r.why, /after its last step held/);
});

test('breakpoint: when every step holds, the search climbs on until a step breaks, and says between which', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4), 'env.json': CEILING });
  const r = runFake(root, { profile: { ...STAIRS, breakpoint: { factor: 2, max: 64 } }, engine_options: { max_rps: 150 } }, ['--breakpoint', '--bootstrap']);
  assert.match(r.out, /breakpoint run 1\/3 \(4, 8\): held up to 8/);
  assert.match(r.out, /breakpoint run 2\/3 \(8, 16\): held up to 16/);
  assert.match(r.out, /breakpoint run 3\/3 \(16, 32\): broke at 32/);
  const runs = listRuns(root, 'demo');
  assert.equal(runs.length, 3, 'three ordinary runs, each with its own folder');
  for (const x of runs) assert.ok(read(join(x.dir, 'verdict.json')).outcome, `run ${x.id} has its own verdict`);
  const b = read(join(root, '.perf', 'demo', 'breakpoint.json'));
  assert.equal(b.found, true);
  assert.deepEqual([b.held.value, b.held.run, b.broke.value, b.broke.run], [16, runs[2].id, 32, runs[2].id]);
  assert.match(b.broke.why, /createOrder p95 [\d.]+ > SLA 400 ms/);
  assert.equal(b.limit, 'target');
  assert.match(r.out, new RegExp(`It breaks between 16 and 32 users: 16 held \\(run ${runs[2].id}\\), 32 broke \\(run ${runs[2].id}\\)`));
  const md = readFileSync(join(root, '.perf', 'demo', 'breakpoint.md'), 'utf8');
  assert.match(md, /First step that broke: 32 users/);
  // The last run's verdict carries it.
  const v = verdictJson(root);
  assert.deepEqual([v.breakpoint.found, v.breakpoint.broke.value], [true, 32]);
  assert.ok(v.notes.some((n) => /breakpoint search \(3 run\(s\)\): It breaks between 16 and 32/.test(n)));
  assert.equal(r.code, v.exit);
});

test('breakpoint: a target that never breaks stops at the ceiling or the run budget, and no breakpoint is claimed', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4), 'env.json': CEILING });
  let r = runFake(root, { profile: { ...STAIRS, breakpoint: { factor: 2, max: 12 } } }, ['--breakpoint', '--bootstrap']);
  assert.match(r.out, /breakpoint run 2\/3 \(8, 12\): held up to 12/);
  assert.match(r.out, /No breakpoint found below the ceiling of 12 users: it held 12 users/);
  let b = read(join(root, '.perf', 'demo', 'breakpoint.json'));
  assert.deepEqual([b.found, b.broke, b.limit], [false, null, 'ceiling']);
  assert.equal(b.factor, 2);
  assert.doesNotMatch(r.out, /breaks between/);
  r = runFake(root, { profile: { ...STAIRS, breakpoint: { max: 64 } } }, ['--breakpoint', '--bootstrap', '--max-runs', '1']);
  assert.match(r.out, /No breakpoint found in 1 run\(s\): it held 8 users/);
  b = read(join(root, '.perf', 'demo', 'breakpoint.json'));
  assert.deepEqual([b.found, b.limit, b.factor, b.factor_default], [false, 'runs', 1.5, true]);
  // No ceiling, no search: the load is never unbounded.
  r = runFake(root, { profile: STAIRS }, ['--breakpoint']);
  assert.equal(r.code, 2);
  assert.match(r.out, /profile.steps and profile.breakpoint.max/);
  // --max-runs is 1 to 6, never read as the default.
  for (const bad of ['0', '1.5', '7']) {
    r = runFake(root, { profile: { ...STAIRS, breakpoint: { max: 64 } } }, ['--breakpoint', '--max-runs', bad]);
    assert.equal(r.code, 2, `--max-runs ${bad}`);
    assert.match(r.out, /--max-runs: a whole number from 1 to 6/);
  }
  // The environment's ceiling holds whatever the spec says.
  r = runFake(root, { profile: { ...STAIRS, breakpoint: { max: 100 } } }, ['--breakpoint']);
  assert.equal(r.code, 2);
  assert.match(r.out, /breakpoint.max: 100 is above the 64 the owner of "local" allows/);
});

test('breakpoint: a load generator that saturates ends the search: the generator, not the target, is the limit', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['stress']), 'workload.json': workload(4), 'env.json': CEILING });
  // 2 workers, 15 % CPU per user each: 8 users is 60 %, 16 users is 120 %.
  const r = runFake(root, { profile: { ...STAIRS, breakpoint: { factor: 2, max: 64 } }, engine_options: { cpu_pct_per_user: 15 } }, ['--breakpoint', '--bootstrap']);
  assert.match(r.out, /breakpoint run 1\/3 \(4, 8\): held up to 8/);
  assert.match(r.out, /breakpoint run 2\/3 \(8, 16\): generator/);
  assert.match(r.out, /No breakpoint found: the load generator, not the target, was the limit; it held 8 users/);
  const b = read(join(root, '.perf', 'demo', 'breakpoint.json'));
  assert.deepEqual([b.found, b.limit, b.broke], [false, 'generator', null]);
  assert.equal(listRuns(root, 'demo').length, 2, 'no third run');
});

// ---- recovery --------------------------------------------------------------------------------

// Normal load 4 users (40 requests/s) against a target that serves 60/s and queues the rest
// (fake max_rps + backlog). The overload, 12 users for 2 s from steady + 2 s, queues about 120
// requests; the 20/s left over drains them in about 6 s.
const RECOVERY = { name: 'recovery', users: 4, spike: { users: 12, at_s: 2, for_s: 2 }, warmup_s: 1, ramp_s: 1, steady_s: 14, rampdown_s: 0.5 };
const QUEUE = (max_rps) => ({ max_rps, backlog: true });

test('recovery: a recovery profile needs its overload, and its budget is a judged limit', () => {
  assert.match(norm(spec({ profile: { name: 'recovery', users: 4, steady_s: 4 } })).errors.join(), /profile recovery: needs its overload, profile.spike/);
  assert.deepEqual(norm(spec({ profile: RECOVERY })).errors, []);
  const root = tmp();
  project(root, { 'slo.json': slo(['recovery'], { recovery: { recovery_s: 0, within: 3 } }) });
  const errs = CHECKS.plan(root, 'demo').errors.join('\n');
  assert.match(errs, /recovery.recovery_s must be a number above 0/);
  assert.match(errs, /recovery.within: not a judged limit/);
  // The breakpoint ceilings in env.json are checked by the env gate.
  project(root, { 'env.json': envWith({ max_users: -1, max_arrival_rps: '9' }) });
  const envErrs = CHECKS.env(root, 'demo').errors.join('\n');
  assert.match(envErrs, /local: max_users must be a number above 0/);
  assert.match(envErrs, /local: max_arrival_rps must be a number above 0/);
  project(root, { 'env.json': CEILING });
  assert.deepEqual(CHECKS.env(root, 'demo').errors, []);
});

test('recovery: back means two windows in a row within every transaction\'s SLO, serving near the normal load', () => {
  const s = slo(['recovery']);
  const w = (p95, requests = 100, error_rate = 0, ops = OPS) => ({ requests, endpoints: Object.fromEntries(ops.map((n) => [n, { requests: 10, p95_ms: p95, error_rate }])) });
  assert.equal(withinSlo(w(200), s, 100), true, 'at the SLO is within it');
  assert.equal(withinSlo(w(201), s, 100), false);
  assert.equal(withinSlo(w(50, 100, 0.011), s, 100), false, 'errors past the SLO');
  assert.equal(withinSlo(w(50, 69), s, 100), false, 'fast, but serving under 70 % of the normal load');
  assert.equal(withinSlo(w(50, 100, 0, ['getItem']), s, 100), true, 'a transaction not sent in a window does not block it');
  assert.equal(withinSlo(w(50, 100, 0, ['other']), s, 100), false, 'no planned transaction measured is not within');
});

const win = (start, p95 = 50, ops = OPS, requests = 30) => ({ start, requests, p95_ms: p95, error_rate: 0, endpoints: Object.fromEntries(ops.map((n) => [n, { requests: 10, p95_ms: p95, error_rate: 0 }])) });
// Base 0-2 s, overload 2-3 s, watched to 6 s, in 0.5 s windows.
const block = (after, extra = {}) => ({ from_s: 2, to_s: 3, window_s: 0.5, end_s: 6, ran_to_s: 3, windows: [0, 0.5, 1, 1.5].map((t) => win(t)).concat([win(2, 900), win(2.5, 900)], after), ...extra });

test('recovery: back is two adjacent windows in time; a missing window is not back; the watch runs to where load stopped', () => {
  const s = slo(['recovery']);
  // Good at 3.5 and 4.5 with no window at all at 4: not two in a row. Back at 4.5-5.
  let r = recoveryFrom(block([win(3, 900), win(3.5), win(4.5), win(5)]), s);
  assert.equal(r.recovery_s, 2, 'back at the window 4.5-5 s, its end 2 s after the overload');
  // Windows stop coming at 4 s, but load ran to 6 s: 3 s were watched, and it was not back.
  r = recoveryFrom(block([win(3, 900), win(3.5, 900)]), s);
  assert.deepEqual([r.recovered, r.observed_after_s], [false, 3]);
  // A transaction the normal load sent in every window, gone after the overload: not back.
  r = recoveryFrom(block([win(3, 900), win(3.5, 50, ['listItems', 'getItem']), win(4, 50, ['listItems', 'getItem']), win(4.5), win(5)]), s);
  assert.equal(r.recovery_s, 2);
  assert.deepEqual(r.required, OPS);
  // One the base missed now and then is not required.
  const sparse = block([win(3), win(3.5)]);
  sparse.windows[1] = win(0.5, 50, ['listItems', 'getItem']);
  assert.equal(recoveryFrom(sparse, s).required.includes('createOrder'), false);
  // What ran, not what was planned: the load stopped 0.5 s into the overload.
  r = recoveryFrom(block([], { ran_to_s: 2.5, end_s: 2.5 }), s);
  assert.deepEqual([r.overload_s, r.planned_overload_s], [0.5, 1]);
});

test('recovery: the overload and its budget run under the safety bound, not the error-rate and target-CPU rules', () => {
  const rules = [{ metric: 'error_rate', above: 0.5, for_s: 10, min_requests: 50 }, { metric: 'target_cpu_pct', above: 90, for_s: 30 }, { metric: 'generator_cpu_pct', above: 90, for_s: 10 }];
  const grace = { from_s: 10, to_s: 50 };
  assert.deepEqual(rulesAt(rules, 9, grace), { rules, eased: false });
  assert.deepEqual(rulesAt(rules, 50, grace), { rules, eased: false });
  assert.deepEqual(rulesAt(rules, 10, grace), { rules: [rules[2], { metric: 'error_rate', above: 0.95, for_s: 30, min_requests: 50 }], eased: true });
  assert.deepEqual(rulesAt(rules, 20, null), { rules, eased: false });
  // perf run sets the grace from the plan: the overload, then the budget or the longest rule.
  const root = tmp();
  project(root, { 'slo.json': slo(['recovery'], { recovery: { recovery_s: 5 } }) });
  // A grace written into the spec is never taken: it is computed from the plan.
  const x = norm({ ...spec({ profile: RECOVERY, auto_stop: [{ metric: 'error_rate', above: 0.5, for_s: 8 }] }), overload_grace: { from_s: 0, to_s: 1e9 } });
  assert.deepEqual(x.spec.overload_grace, { from_s: 4, to_s: 36 }, 'no plan read: the default 30 s budget');
  const withPlan = (forS) => normalize({ ...spec({ profile: RECOVERY, auto_stop: [{ metric: 'error_rate', above: 0.5, for_s: forS }] }) }, { root, env: envWith({}) }).spec.overload_grace;
  assert.deepEqual(withPlan(3), { from_s: 4, to_s: 11 }, 'the planned 5 s budget');
  assert.deepEqual(withPlan(8), { from_s: 4, to_s: 14 }, 'a rule longer than the budget');
  assert.equal(norm({ ...spec({ profile: { ...RECOVERY, name: 'spike' } }), overload_grace: { from_s: 0, to_s: 1e9 } }).spec.overload_grace, undefined, 'only a recovery test, never one the spec asks for');
});

test('recovery: an overload the target comes back from in time passes; slower than the budget fails', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['recovery']) });
  assert.equal(runFake(root, { profile: RECOVERY, engine_options: QUEUE(60) }).code, 0);
  const s = result(runDir(root)).spike;
  assert.ok(s.windows.length >= 27, `every steady window is kept (${s.windows.length})`);
  let r = report(root);
  const v = verdictJson(root);
  assert.equal(v.recovery.overloaded, true);
  assert.equal(v.recovery.recovered, true);
  assert.ok(v.recovery.recovery_s > 2 && v.recovery.recovery_s < 9, `recovery in ${v.recovery.recovery_s} s`);
  assert.match(r.out, /VERDICT: PASS/);
  assert.match(r.out, /no recovery budget was planned \(slo.json recovery.recovery_s\), so the default 30 s applied/);
  assert.match(r.out, new RegExp(`summary: After 2 s of overload at 12 users, it was back within its SLO in ${v.recovery.recovery_s} s \\(budget 30 s\\)`));
  // The transactions are the normal load's, before the overload.
  assert.ok(v.transactions.every((t) => t.outcome === 'PASS'));
  project(root, { 'slo.json': slo(['recovery'], { recovery: { recovery_s: 2 } }) });
  r = report(root);
  assert.match(r.out, new RegExp(`FAIL: recovery: back within its SLO ${v.recovery.recovery_s} s after the overload, over the budget of 2 s`));
  // The spike's budget applies when no recovery budget is planned.
  project(root, { 'slo.json': slo(['recovery'], { spike: { recovery_s: 2 } }) });
  r = report(root);
  assert.match(r.out, /no recovery.recovery_s was planned; the spike budget 2 s applied/);
  assert.match(r.out, /FAIL: recovery: back within its SLO/);
});

test('recovery: a target that sheds the overload with errors is watched coming back, not stopped and failed', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['recovery']) });
  // A strict rule (errors above 30 % for 1 s) and a target that fails 60 % of requests during the
  // overload (t = 4 to 6 s): outside a recovery test that rule would stop the run.
  const shed = { ...QUEUE(60), faults: [{ kind: 'errors', rate: 0.6, from_s: 4, to_s: 6 }] };
  runFake(root, { profile: RECOVERY, auto_stop: [{ metric: 'error_rate', above: 0.3, for_s: 1 }], engine_options: shed });
  const res = result(runDir(root));
  assert.equal(res.run_state, 'done');
  assert.ok(res.spike.peak_error_rate > 0.3, `errors during the overload: ${res.spike.peak_error_rate}`);
  let r = report(root);
  assert.doesNotMatch(r.out, /the target failed under load/);
  assert.match(r.out, /VERDICT: PASS/);
  assert.equal(verdictJson(root).recovery.recovered, true);
  // Stopped by the safety bound itself: not a failure of the target, and not a recovery either.
  const p = join(runDir(root), 'result.json');
  writeFileSync(p, JSON.stringify({ ...res, run_state: 'aborted' }));
  const st = join(runDir(root), 'state.json');
  writeFileSync(st, JSON.stringify({ ...read(st), stop_reason: 'auto_stop:overload_safety' }));
  r = report(root);
  assert.match(r.out, /NOT_EVALUABLE: recovery: the run was stopped by the overload safety bound \(errors above 95 %\)/);
  assert.doesNotMatch(r.out, /FAIL/);
});

test('recovery: a target with nothing left over never comes back and fails; too short a watch is not evaluable', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['recovery'], { recovery: { recovery_s: 5 } }) });
  // Capacity 40/s is exactly the normal load: the queue the overload left never drains.
  runFake(root, { profile: RECOVERY, engine_options: QUEUE(40) });
  let r = report(root);
  assert.match(r.out, /FAIL: recovery: after 2 s of overload \([\w, ]+ past the SLO\), the target was not back within its SLO in the 10 s observed, more than the 5 s budget/);
  assert.match(r.out, /summary: After 2 s of overload at 12 users, it was not back within its SLO in the 10 s observed/);
  project(root, { 'slo.json': slo(['recovery'], { recovery: { recovery_s: 20 } }) });
  r = report(root);
  assert.match(r.out, /NOT_EVALUABLE: recovery: the load ended 10 s after the overload, before the 20 s budget ran out/);
  assert.doesNotMatch(r.out, /FAIL: recovery/);
  // One good window between bad ones is noise, not recovery.
  project(root, { 'slo.json': slo(['recovery'], { recovery: { recovery_s: 5 } }) });
  const p = join(runDir(root), 'result.json');
  const x = read(p);
  const lone = x.spike.windows.find((w) => w.start >= x.spike.to_s + 2);
  for (const e of Object.values(lone.endpoints)) e.p95_ms = 50;
  writeFileSync(p, JSON.stringify(x));
  assert.match(report(root).out, /FAIL: recovery: after 2 s of overload .* not back within its SLO/);
  // Load that stopped during the overload: what ran is said, and nothing after it is judged.
  writeFileSync(p, JSON.stringify({ ...x, spike: { ...x.spike, ran_to_s: x.spike.from_s + 1, end_s: x.spike.from_s + 1 } }));
  const cut = report(root).out;
  assert.match(cut, /NOT_EVALUABLE: recovery: the load stopped 1 s into the planned 2 s overload/);
  assert.doesNotMatch(cut, /FAIL: recovery/);
});

test('recovery: an overload that never took the target past its SLO is not evaluable, never a pass', T, () => {
  const root = tmp();
  project(root, { 'slo.json': slo(['recovery']) });
  // 5 users is 50 requests/s, under the 60 the target serves: nothing queues.
  runFake(root, { profile: { ...RECOVERY, spike: { users: 5, at_s: 2, for_s: 2 } }, engine_options: QUEUE(60) });
  const r = report(root);
  assert.match(r.out, /NOT_EVALUABLE: recovery: the overload never took a transaction past its SLO \(p95 peaked at [\d.]+ ms\): there was nothing to recover from/);
  assert.doesNotMatch(r.out, /VERDICT: PASS/);
  assert.equal(verdictJson(root).recovery.overloaded, false);
  // A normal load already past its SLO cannot say when the target is back within it.
  const p = join(runDir(root), 'result.json');
  const x = read(p);
  for (const w of x.spike.windows) for (const e of Object.values(w.endpoints)) e.p95_ms = 300;
  writeFileSync(p, JSON.stringify(x));
  assert.match(report(root).out, /NOT_EVALUABLE: recovery: the normal load is not within its SLO in most windows \(0 %\)/);
});

// ---- configuration matrix ------------------------------------------------------------------

// The fake engine's latency per operation, scaled: a setting that makes the target faster.
const scaled = (f) => ({ engine_options: { endpoints: ENDPOINTS.map((e) => ({ ...e, median_ms: e.median_ms * f })) } });
const LOAD = { name: 'load', users: 10, warmup_s: 0.5, ramp_s: 0.5, steady_s: 3, rampdown_s: 0.5 };
function matrixProject(root, m, before = () => {}) {
  project(root);
  before(root);
  const s = spec({ profile: LOAD });
  s.engine_options = { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true };
  writeFileSync(join(root, 'spec.json'), JSON.stringify(s));
  writeFileSync(join(root, 'matrix.json'), JSON.stringify({ spec: 'spec.json', ...m }));
  return perf(['matrix', join(root, 'matrix.json'), '--root', root, '--bootstrap'], 300000);
}

test('matrix: the variants run the same spec; a clear winner wins, a difference within noise is a tie', T, () => {
  const root = tmp();
  // Earlier runs taught 3 workers for this profile: every variant gets them, frozen for the matrix.
  const taught = (dir) => writeFileSync(join(dir, '.perf', 'demo', 'learned.json'), JSON.stringify({ profiles: { 'load/closed/local': { workers: 3 } }, fixes: [] }));
  // pool-20's apply stands in for a lesson learned in the middle of the matrix (4 workers): frozen,
  // it changes nothing.
  const midway = `node -e "require('fs').writeFileSync('.perf/demo/learned.json', JSON.stringify({ profiles: { 'load/closed/local': { workers: 4 } }, fixes: [] }))"`;
  const r = matrixProject(root, { name: 'pool', variants: [{ name: 'pool-10' }, { name: 'pool-20', spec: scaled(0.5), apply: midway }, { name: 'pool-15', spec: scaled(0.98) }] }, taught);
  assert.equal(r.code, 0, r.out + r.err);
  const m = read(join(root, '.perf', 'demo', 'matrix-pool.json'));
  assert.equal(m.winner, 'pool-20');
  assert.deepEqual(m.groups, [['pool-20'], ['pool-10', 'pool-15'].sort((a, b) => m.rows.find((x) => x.name === a).value - m.rows.find((x) => x.name === b).value)]);
  const row = (n) => m.rows.find((x) => x.name === n);
  assert.match(row(m.groups[1][0]).behind.why, /^\+[\d.]+ %, at least \+[\d.]+ % \([\d.]+ ms\) at 95 % confidence$/, 'the second group is clearly behind the winner');
  assert.equal(row('pool-15').rank, row('pool-10').rank, 'within noise: the same rank');
  // The control ran again at the end, and held still.
  assert.equal(m.drift.checked, true);
  assert.equal(m.drift.moved, false);
  assert.equal(listRuns(root, 'demo').length, 4, 'three variants and the control again');
  const md = readFileSync(join(root, '.perf', 'demo', 'matrix-pool.md'), 'utf8');
  assert.match(md, /\*\*pool-20 wins on p95 of all requests\.\*\*/);
  assert.match(md, /\| 1 \| pool-20 \|/);
  assert.match(md, /tie with pool-1[05]/);
  assert.match(r.out, /MATRIX pool: pool-20 wins/);
  // Each variant's run carries its own setting.
  const specs = listRuns(root, 'demo').map((x) => read(join(x.dir, 'run.json')).engine_options.endpoints[0].median_ms);
  assert.deepEqual(specs, [40, 20, 39.2, 40]);
  // The same generator for all: the learned workers applied once, and no run learning inside it.
  const runs = listRuns(root, 'demo').map((x) => read(join(x.dir, 'run.json')));
  assert.deepEqual(runs.map((x) => x.workers), [3, 3, 3, 3]);
  assert.ok(runs.every((x) => x.learned === undefined), 'nothing applied per run');
  assert.deepEqual(m.learned.map((l) => [l.field, l.to]), [['workers', 3]]);
  assert.match(md, /a move of [\d.]+ %: not significant; the leader's margin is [\d.]+ %/);
});

test('matrix: a run that was not seen to finish stops the matrix; no variant starts on top of it', T, () => {
  const root = tmp();
  // The second variant's apply leaves a process that kills the next controller to start: its run
  // is lost to perf run --wait, and may still be loading.
  writeFileSync(join(root, 'killer.mjs'), [
    "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
    "const runs = '.perf/demo/runs';",
    'const seen = new Set(existsSync(runs) ? readdirSync(runs) : []);',
    'const end = Date.now() + 60000;',
    'const t = setInterval(() => {',
    '  if (Date.now() > end) process.exit(0);',
    '  for (const d of existsSync(runs) ? readdirSync(runs) : []) {',
    "    if (seen.has(d) || !existsSync(runs + '/' + d + '/controller.pid')) continue;",
    "    try { process.kill(Number(readFileSync(runs + '/' + d + '/controller.pid', 'utf8'))); } catch {}",
    '    clearInterval(t); process.exit(0);',
    '  }',
    '}, 50);',
  ].join('\n'));
  const r = matrixProject(root, { name: 'lost', recheck: false, variants: [
    { name: 'a' },
    { name: 'b', apply: 'node -e "require(\'child_process\').spawn(process.execPath,[\'killer.mjs\'],{detached:true,stdio:\'ignore\'}).unref()"' },
    { name: 'c', spec: scaled(0.5) },
  ] });
  assert.equal(r.code, 1, r.out + r.err);
  const m = read(join(root, '.perf', 'demo', 'matrix-lost.json'));
  const row = (n) => m.rows.find((x) => x.name === n);
  assert.match(row('b').flag, /was not seen to finish \(perf status\); the matrix stopped so no two runs overlap/);
  assert.match(row('c').flag, /not run: the matrix stopped at b/);
  assert.equal(listRuns(root, 'demo').length, 2, 'c never started');
});

test('matrix: a variant measured under another fingerprint than its setting declares is STALE; a failed apply is not run', T, () => {
  const root = tmp();
  // Each apply sets the data set's account count; the test reads it back from the fingerprint.
  // It also records the POOL it was given: a variant's env reaches its apply, and is gone after it.
  const accounts = (n) => `node -e "const f='.perf/demo/data/manifest.json';const fs=require('fs');const m=JSON.parse(fs.readFileSync(f));m.accounts.count=${n};fs.writeFileSync(f,JSON.stringify(m));fs.appendFileSync('env.txt',(process.env.POOL||'-')+'/'+process.env.PERF_VARIANT+',')"`;
  const r = matrixProject(root, { name: 'cache', recheck: false, variants: [
    { name: 'off', apply: accounts(20), env: { POOL: '10' } },
    { name: 'on', apply: accounts(30), spec: scaled(0.98) },
    { name: 'on-declared', apply: accounts(30), changes: ['data'], spec: { engine_options: { ...scaled(0.98).engine_options, token: 'zq9x7' } }, env: { POOL: '30' } },
    { name: 'broken', apply: 'node -e "process.exit(3)"' },
  ] });
  const m = read(join(root, '.perf', 'demo', 'matrix-cache.json'));
  const row = (n) => m.rows.find((x) => x.name === n);
  assert.match(row('on').flag, /^STALE: the data changed beyond the setting; not ranked/);
  assert.equal(row('on').rank, null);
  assert.equal(row('on-declared').flag, undefined, 'a declared change is the setting');
  assert.match(row('broken').flag, /not run: apply failed \(exit 3\)/);
  assert.equal(row('broken').run_id, null);
  assert.equal(listRuns(root, 'demo').length, 3);
  assert.equal(readFileSync(join(root, 'env.txt'), 'utf8'), '10/off,-/on,30/on-declared,');
  assert.deepEqual(m.variants[0].env, ['POOL']);
  // A secret in a setting never reaches the report.
  assert.equal(m.variants[2].spec.engine_options.token, '***');
  assert.doesNotMatch(readFileSync(join(root, '.perf', 'demo', 'matrix-cache.json'), 'utf8'), /zq9x7/);
  assert.equal(m.winner, null, 'off and on-declared are within noise');
  assert.match(m.verdict, /no winner: (off, on-declared|on-declared, off) tie/);
  assert.match(m.drift === null ? 'none' : 'checked', /none/);
  assert.match(readFileSync(join(root, '.perf', 'demo', 'matrix-cache.md'), 'utf8'), /drift of the environment during the matrix is not ruled out/);
  assert.equal(r.code, 0);
  // Fewer than two variants ranked: no ranking, exit 3.
  const lone = matrixProject(tmp(), { recheck: false, variants: [{ name: 'a' }, { name: 'b', apply: 'node -e "process.exit(1)"' }] });
  assert.equal(lone.code, 3);
  assert.match(lone.out, /fewer than two variants could be ranked/);
});

test('matrix: the file is checked; a variant may not change the test itself', () => {
  const root = tmp();
  writeFileSync(join(root, 'spec.json'), '{}');
  const errs = (m) => checkMatrix({ spec: 'spec.json', ...m }, root).join('\n');
  assert.match(errs({ variants: [{ name: 'a' }] }), /variants: at least two/);
  assert.match(errs({ variants: [{ name: 'a' }, { name: 'a' }] }), /a is used twice/);
  assert.match(errs({ variants: [{ name: 'a' }, { name: 'b', spec: { profile: { users: 99 } } }] }), /spec.profile: every variant runs the same profile/);
  assert.match(errs({ variants: [{ name: 'a' }, { name: 'b', spec: { target_url: 'http://x' } }] }), /spec.target_url/);
  assert.match(errs({ variants: [{ name: 'a' }, { name: 'b', changes: ['thresholds'] }] }), /thresholds is not a fingerprint part/);
  assert.match(errs({ measure: 'p50', variants: [{ name: 'a' }, { name: 'b' }] }), /measure: one of p95, capacity/);
  assert.match(errs({ variants: [{ name: 'a' }, { name: 'b', env: { POOL: 20 } }] }), /env: \{ NAME: "value" \}/);
  assert.match(checkMatrix({ spec: 'missing.json', variants: [{ name: 'a' }, { name: 'b' }] }, root).join(), /spec: the run spec/);
  assert.equal(errs({ variants: [{ name: 'a' }, { name: 'b', env: { POOL: '20' }, spec: { engine_options: { pool: 3 } } }] }), '');
  // The generator and the rules are the test's too, not a setting.
  for (const k of ['workers', 'timing', 'auto_stop']) assert.match(errs({ variants: [{ name: 'a' }, { name: 'b', spec: { [k]: 1 } }] }), new RegExp(`spec.${k}: every variant runs the same`));
  // Types: env and changes of the wrong kind are refused, never a crash.
  assert.match(errs({ variants: [{ name: 'a', env: null }, { name: 'b', env: ['X=1'] }] }), /variants\[0\].env: \{ NAME: "value" \}[\s\S]*variants\[1\].env: \{ NAME: "value" \}/);
  assert.match(errs({ variants: [{ name: 'a', changes: 5 }, { name: 'b', changes: {} }] }), /variants\[0\].changes: a list[\s\S]*variants\[1\].changes: a list/);
  assert.match(errs({ variants: [null, { name: 'b' }] }), /variants\[0\]: an object/);
  // A variant may not point a worker at another host, swap the tools ai-perf runs, or Node itself.
  for (const k of ['AI_PERF_TARGET_URL', 'ai_perf_target_url', 'PERF_DOCKER', 'PERF_HOME', 'NODE_OPTIONS', 'Path', 'LD_PRELOAD', 'HOME']) {
    assert.match(errs({ variants: [{ name: 'a' }, { name: 'b', env: { [k]: 'x' } }] }), new RegExp(`env.${k}: a variant may not set this variable`), k);
  }
  assert.deepEqual(maskDeep({ engine_options: { token: 'abc', url: 'http://u:pw@h/x?api_key=k', pool: 3, list: ['Bearer abcdefghijkl'] } }),
    { engine_options: { token: '***', url: 'http://***@h/x?api_key=***', pool: 3, list: ['Bearer ***'] } });
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 }), { a: { b: 1, c: [3] }, d: 1, e: 2 });
});

// Synthetic runs for the ranking: n requests spread evenly up to p95 / 0.95, one histogram each.
function fakeRun(id, p95, { n = 2000, steps, fp = { workload: 'w', data: 'd' }, state = 'done' } = {}) {
  const h = create();
  for (let i = 0; i < n; i++) record(h, ((p95 / 0.95) * (i + 0.5)) / n);
  const hist = { total: h, endpoints: {} };
  const pt = { requests: n, p95_ms: p95, error_rate: 0 };
  return { name: id, run_id: id, hist, res: { run: { id, environment: 'local', profile: 'load', target: 'x', users: 10, tool_version: 'fake 1', fingerprint: fp }, run_state: state, total: pt, endpoints: {}, ...(steps ? { steps } : {}) } };
}

test('matrix ranking: ties within noise, a moved control voids the winner, capacity counts only a clear break', () => {
  // 1000 ms against 1040 ms: 4 % apart, under the 5 % that counts.
  let r = rank([fakeRun('a', 1000), fakeRun('b', 1040)]);
  assert.equal(r.winner, null);
  assert.deepEqual(r.groups, [['a', 'b']]);
  r = rank([fakeRun('a', 1000), fakeRun('b', 1040)], { min_diff_pct: 2 });
  assert.equal(r.winner, 'a', 'a smaller floor makes 4 % count');
  // Few requests: a large point difference is not significant.
  r = rank([fakeRun('a', 100, { n: 20 }), fakeRun('b', 110, { n: 20 })]);
  assert.equal(r.winner, null);
  assert.match(r.rows[1].tie.why, /not significant/);
  // The control measured twice and moved by more than the variants are apart: no winner.
  const again = { ...fakeRun('a', 1500), name: 'a', recheck: true, run_id: 'a2' };
  r = rank([fakeRun('a', 1000), fakeRun('b', 1300), again]);
  assert.equal(r.winner, null);
  assert.match(r.verdict, /environment moved during the matrix/);
  r = rank([fakeRun('a', 1000), fakeRun('b', 1300), { ...fakeRun('a', 1001), recheck: true }]);
  assert.equal(r.winner, 'a');
  // The control moved 4.5 %, under what counts, and the leader is 6 % ahead: once the move is taken
  // off, its lead no longer counts.
  r = rank([fakeRun('a', 1000), fakeRun('b', 1060), { ...fakeRun('a', 1045), recheck: true }]);
  assert.equal(r.drift.moved, false);
  assert.equal(r.winner, null);
  assert.match(r.verdict, /no winner: a leads b by 6 %, not enough over the 4.5 % the control moved/);
  // A recheck asked for and not made: no winner.
  r = rank([fakeRun('a', 1000), fakeRun('b', 1300)], { recheck: true });
  assert.equal(r.winner, null);
  assert.match(r.verdict, /a recheck of the control was asked for and could not be made \(the control was not measured twice \(the recheck did not run\)\)/);
  r = rank([fakeRun('a', 1000), fakeRun('b', 1300), { name: 'a', recheck: true, status: 'apply_failed', why: 'exit 1' }]);
  assert.equal(r.winner, null);
  assert.equal(r.drift.checked, false);
  // A control that could not be ranked: no variant silently takes its place.
  r = rank([fakeRun('a', 1000, { state: 'degraded' }), fakeRun('b', 500), fakeRun('c', 1300)]);
  assert.equal(r.winner, null);
  assert.match(r.verdict, /no ranking: the control a could not be ranked \(run ended degraded/);
  assert.match(r.rows[1].flag, /the control a could not be/);
  // Fast because it fails: errors past the SLA, or 0.5 pp over the control's, or a failed verdict.
  const failing = fakeRun('b', 20);
  failing.res.total.error_rate = 0.9;
  r = rank([fakeRun('a', 200), failing, fakeRun('c', 400)], { slo: slo(['load']) });
  assert.match(r.rows[1].flag, /errors 0.9 above the SLA error rate 0.02: not ranked/);
  assert.equal(r.winner, 'a');
  const noisy = fakeRun('b', 20);
  noisy.res.total.error_rate = 0.011;
  r = rank([fakeRun('a', 200), noisy, fakeRun('c', 400)], { slo: slo(['load']) });
  assert.match(r.rows[1].flag, /errors 0.011 against the control's 0 \(more than 0.5 pp\)/);
  r = rank([fakeRun('a', 200), { ...fakeRun('b', 20), outcome: 'FAIL', outcome_why: 'listItems: p95 900 > SLA 400' }, fakeRun('c', 400)]);
  assert.match(r.rows[1].flag, /verdict FAIL: not ranked \(listItems: p95 900 > SLA 400\)/);
  assert.equal(r.winner, 'a');
  // Significant in %, but at 95 % confidence under the 1 ms that counts: a tie.
  r = rank([fakeRun('a', 2), fakeRun('b', 2.4)]);
  assert.equal(r.winner, null);
  assert.match(r.rows[1].tie.why, /under the 1 ms that counts/);
  assert.equal(rank([fakeRun('a', 2), fakeRun('b', 2.4)], { min_diff_ms: 0.1 }).winner, 'a');
  // A run that did not end done is shown, never ranked.
  r = rank([fakeRun('a', 1000), fakeRun('b', 500, { state: 'degraded' }), fakeRun('c', 1300)]);
  assert.match(r.rows[1].flag, /run ended degraded/);
  assert.equal(r.winner, 'a');
  // Capacity: the higher one wins only when the other's broken step broke clearly.
  const s = slo(['stress']);
  const clear = [step(0, 4, 50), step(1, 8, 50), step(2, 16, 900)];
  const marginal = [step(0, 4, 50), step(1, 8, 50), step(2, 16, 410)];
  const held = [step(0, 4, 50), step(1, 8, 50), step(2, 16, 60)];
  assert.equal(brokeClearly(clear[2], s), true);
  assert.equal(brokeClearly(marginal[2], s), false, '410 ms is within 10 % of the 400 ms SLA');
  assert.equal(brokeClearly(step(2, 16, 50, true, 0.03), s), true, 'errors 1 pp past the SLA');
  r = rank([fakeRun('x', 1, { steps: held }), fakeRun('y', 1, { steps: clear })], { measure: 'capacity', slo: s });
  assert.equal(r.winner, 'x');
  r = rank([fakeRun('x', 1, { steps: held }), fakeRun('y', 1, { steps: marginal })], { measure: 'capacity', slo: s });
  assert.equal(r.winner, null);
  assert.match(r.rows[1].tie.why, /less than the noise floor/);
  r = rank([fakeRun('x', 1, { steps: held }), fakeRun('y', 1, { steps: held.slice(0, 2) })], { measure: 'capacity', slo: s });
  assert.match(r.rows[1].flag, /incomparable: other steps/);
});
