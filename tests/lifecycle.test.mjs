import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECKS } from '../lib/checks.mjs';
import { discover, MAX_QUESTIONS } from '../lib/discover.mjs';
import { categorize } from '../lib/analyze.mjs';
import { hasCommand, nextStep } from '../lib/help.mjs';
import { watch } from '../lib/watch.mjs';
import { emit } from '../controller/events.mjs';
import { PROFILES, ROOT, perf, runDir, spec, tmp, waitFor, writeSpec } from './helpers.mjs';

const T = { timeout: 60000 };
import { ENDPOINTS, OPS, SMOKE, project, runFake } from './project.mjs';

// ---- gates -------------------------------------------------------------------------------

test('every gate passes on a complete project', () => {
  const root = tmp();
  project(root);
  for (const step of ['plan', 'model', 'env', 'data']) assert.deepEqual(CHECKS[step](root, 'demo').errors, [], step);
});

test('plan gate: an SLO looser than its SLA, a missing number, a number without source', () => {
  const root = tmp();
  project(root, { 'slo.json': { profiles: ['load'], transactions: [
    { name: 'a', slo: { p95_ms: 500, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' },
    { name: 'b', slo: { p95_ms: '200', error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' },
    { name: 'c', slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 } },
  ] } });
  const e = CHECKS.plan(root, 'demo').errors.join('\n');
  assert.match(e, /a: slo.p95_ms 500 is looser than sla.p95_ms 400/);
  assert.match(e, /b: slo.p95_ms must be a number/);
  assert.match(e, /c: "source" must be one of/);
});

test('model gate: shares and weights must add up, Little\'s law must hold, personas must exist', () => {
  const root = tmp();
  project(root, { 'workload.json': {
    model: 'closed', model_reason: 'x', target: { users: 20, source: 'assumed' },
    personas: [{ name: 'buyer', share_pct: 90, source: 'assumed' }],
    journeys: [{ name: 'j', persona: 'ghost', weight_pct: 80, steps: ['a'], think_time_s: 1, source: 'assumed' }],
    littles_law: { rps: 100, response_s: 0.2, think_s: 1, users: 20 },
  } });
  const e = CHECKS.model(root, 'demo').errors.join('\n');
  assert.match(e, /shares add up to 90/);
  assert.match(e, /weights add up to 80/);
  assert.match(e, /persona "ghost" is not defined/);
  assert.match(e, /100 × \(0.2 \+ 1\) = 120, not 20/);
});

test('env gate: production, an unstubbed third party, no owner or parity', () => {
  const root = tmp();
  project(root, { 'env.json': { environments: { prod: { production: true, allow_hosts: ['x'], allowed_profiles: ['smoke'], third_party: [{ name: 'sms', stubbed: false }] } } } });
  const e = CHECKS.env(root, 'demo').errors.join('\n');
  for (const re of [/marked production/, /"sms" is not stubbed/, /owner/, /parity/]) assert.match(e, re);
});

test('data gate: fewer accounts than users, no cleanup, no run-id prefix', () => {
  const root = tmp();
  project(root, { 'data/manifest.json': { accounts: { count: 5 }, run_id_prefix: false } });
  const e = CHECKS.data(root, 'demo').errors.join('\n');
  for (const re of [/count 5 < 20 target users/, /cleanup.command/, /run_id_prefix/]) assert.match(e, re);
});

test('an unstubbed third party also blocks perf run itself', () => {
  const root = tmp();
  const p = writeSpec(root, spec(), { third_party: [{ name: 'payments', stubbed: false }] });
  const r = perf(['run', p, '--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /third party "payments" is not stubbed/);
});

test('a profile the environment does not allow is refused (PS-A2)', () => {
  const root = tmp();
  const p = writeSpec(root, spec({ profile: { name: 'stress' } }), { allowed_profiles: ['smoke', 'load'] });
  const r = perf(['run', p, '--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /"stress" is not allowed on "local"/);
});

// ---- run → script gate → analyze → report -----------------------------------------------

test('script gate needs a clean smoke that ran every operation', T, () => {
  const root = tmp();
  project(root);
  assert.match(CHECKS.script(root, 'demo').errors[0], /no smoke run yet/);
  runFake(root, { profile: SMOKE, engine_options: { endpoints: ENDPOINTS.slice(0, 2) } });
  assert.match(CHECKS.script(root, 'demo').errors.join('\n'), /operation createOrder never ran/);
  runFake(root, { profile: SMOKE });
  assert.deepEqual(CHECKS.script(root, 'demo').errors, []);
});

test('report: no baseline is NOT EVALUABLE; bootstrap passes loudly; promote makes the baseline', T, () => {
  const root = tmp();
  project(root);
  assert.equal(runFake(root).code, 0);
  const first = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(first.code, 3, first.out);
  assert.match(first.out, /no baseline/);
  const boot = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  assert.equal(boot.code, 0, boot.out);
  assert.match(boot.out, /VERDICT: PASS/);
  assert.match(boot.out, /BOOTSTRAP/);
  assert.match(boot.out, /baseline promoted/);
  assert.match(boot.out, /environment parity: laptop mock/);
  assert.match(boot.out, /SLOs not agreed with an owner .*: listItems, getItem, createOrder/);
  assert.ok(existsSync(join(root, '.perf', 'demo', 'baselines', 'local', 'load.json')));
});

// Pillar 5: cost is estimated before the run and checked after it; a large gap warns.
test('report: estimated vs actual run time is recorded; a large gap warns', T, () => {
  const root = tmp();
  project(root);
  const r = runFake(root);
  assert.match(r.err, /estimate: about \d+ s of load on 2 worker\(s\)/);
  const ok = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--json']).out);
  assert.ok(ok.cost.actual_s >= ok.cost.estimated_s - 1, JSON.stringify(ok.cost));
  assert.ok(!ok.notes.some((n) => n.startsWith('cost:')), ok.notes.join('\n'));
  // The same run as if it had taken ten minutes (a slow start-up, a long drain).
  const path = join(runDir(root), 'result.json');
  const res = JSON.parse(readFileSync(path, 'utf8'));
  res.run.ended_at = new Date(Date.parse(res.run.started_at) + 600_000).toISOString();
  writeFileSync(path, JSON.stringify(res));
  const notes = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--json']).out).notes;
  assert.ok(notes.some((n) => new RegExp(`^cost: the run took 600 s against an estimate of ${ok.cost.estimated_s} s`).test(n)), notes.join('\n'));
});

// Pillar 2: the second run remembers the first. Its verdict names the baseline run it was judged against.
test('report: the second run cites the first run as its baseline', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  const first = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote', '--json']).out);
  runFake(root);
  const second = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--json']).out);
  assert.notEqual(second.run_id, first.run_id);
  assert.equal(second.baseline?.run_id, first.run_id);
  const md = readFileSync(join(root, '.perf', 'demo', 'verdict.md'), 'utf8');
  assert.ok(md.includes(`Compared with \`${first.run_id}\``), md);
});

test('report: a slower build is a FAIL with a systemic regression; an SLO miss within SLA is a WARN', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  runFake(root, { engine_options: { faults: [{ kind: 'slow', factor: 1.6 }] } });
  const slow = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(slow.code, 1, slow.out);
  assert.match(slow.out, /regression vs .* \(systemic\): listItems p95/);
  // Same slower run judged against SLOs set just under it: WARN, not FAIL, when the SLA holds.
  const tight = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'slo.json'), 'utf8'));
  for (const tx of tight.transactions) { tx.slo.p95_ms = 50; tx.sla.p95_ms = 1000; }
  writeFileSync(join(root, '.perf', 'demo', 'slo.json'), JSON.stringify(tight));
  const v = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--json']).out);
  assert.ok(v.transactions.some((t) => t.outcome === 'WARN'));
});

test('report: an SLA breach is a FAIL; a planned transaction never measured is NOT EVALUABLE', T, () => {
  const root = tmp();
  const slo = { profiles: ['load'], transactions: [
    { name: 'listItems', slo: { p95_ms: 5, error_rate: 0.01 }, sla: { p95_ms: 10, error_rate: 0.02 }, source: 'assumed' },
    { name: 'checkout', slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' },
  ] };
  project(root, { 'slo.json': slo });
  runFake(root);
  const v = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--json']).out);
  assert.equal(v.outcome, 'FAIL');
  assert.equal(v.transactions.find((t) => t.name === 'listItems').outcome, 'FAIL');
  assert.equal(v.transactions.find((t) => t.name === 'checkout').outcome, 'NOT_EVALUABLE');
});

test('report: a degraded run is NOT EVALUABLE; an error-storm auto-stop is a FAIL of the target', T, () => {
  const root = tmp();
  project(root);
  runFake(root, { profile: { steady_s: 6 }, engine_options: { faults: [{ kind: 'crash', worker: 1, at_s: 1.5 }] } });
  assert.equal(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).code, 3);
  // A starved test machine can lose every worker (no heartbeat within 3 s) before the rule fires:
  // that run ends aborted with all_workers_lost, which ai-perf reports truthfully; it is retried,
  // at most twice. Any other outcome is judged as it is.
  for (let i = 0; i < 3; i++) {
    runFake(root, { auto_stop: [{ metric: 'error_rate', above: 0.2, for_s: 0.5, min_requests: 10 }], profile: { steady_s: 6 }, engine_options: { faults: [{ kind: 'errors', from_s: 1.2, rate: 0.6, class: 'HTTP 503' }] } });
    if (JSON.parse(readFileSync(join(runDir(root), 'state.json'), 'utf8')).stop_reason !== 'all_workers_lost') break;
  }
  const r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /target failed under load/);
});

test('report: a baseline from another profile is refused, not compared (PS-F3)', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  const p = join(root, '.perf', 'demo', 'baselines', 'local', 'load.json');
  const b = JSON.parse(readFileSync(p, 'utf8'));
  b.run.profile = 'stress';
  writeFileSync(p, JSON.stringify(b));
  runFake(root);
  const r = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(r.code, 3);
  assert.match(r.out, /baseline is local\/stress, this run is local\/load/);
});

test('report: a baseline measured with another load tool is refused, not compared', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  const p = join(root, '.perf', 'demo', 'baselines', 'local', 'load.json');
  const b = JSON.parse(readFileSync(p, 'utf8'));
  b.run.tool = 'locust';
  b.run.tool_version = 'locust 2.47.0';
  writeFileSync(p, JSON.stringify(b));
  runFake(root);
  const r = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /baseline was measured with locust, this run with fake/);
});

test('report: a baseline at another load level or against another target is refused', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  const p = join(root, '.perf', 'demo', 'baselines', 'local', 'load.json');
  const good = readFileSync(p, 'utf8');
  for (const [change, why] of [[(b) => { b.run.users = 200; }, /baseline was taken at 200 users, this run at 20/], [(b) => { b.run.target = 'http://127.0.0.1:9999'; }, /baseline was taken against http:\/\/127\.0\.0\.1:9999/]]) {
    const b = JSON.parse(good);
    change(b);
    writeFileSync(p, JSON.stringify(b));
    const r = perf(['report', '--root', root, '--slug', 'demo']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, why);
  }
});

test('report: failed business checks count against the error rate (PS-D3): over the SLA is a FAIL, over the SLO a WARN', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  const path = join(runDir(root), 'result.json');
  const res = JSON.parse(readFileSync(path, 'utf8'));
  for (const [checks, outcome, why] of [[{ passed: 900, failed: 100 }, 'FAIL', /business checks failed 100 of 1000 \(0\.1\) > SLA error rate 0\.02/], [{ passed: 985, failed: 15 }, 'WARN', /> SLO error rate 0\.01 \(SLA met\)/], [{ passed: 1000, failed: 0 }, 'PASS', null]]) {
    writeFileSync(path, JSON.stringify({ ...res, checks }));
    const v = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--json']).out);
    assert.equal(v.outcome, outcome, v.reasons.join('\n'));
    if (why) assert.match(v.reasons.join('\n'), why);
  }
});

test('report: a run without result.json is NOT EVALUABLE (exit 3), not a crash', () => {
  const root = tmp();
  project(root);
  const dir = join(root, '.perf', 'demo', 'runs', '20261030-000000-abcd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: '20261030-000000-abcd', slug: 'demo', environment: 'local', profile: { name: 'load' } }));
  const r = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /VERDICT: NOT_EVALUABLE\n {2}NOT_EVALUABLE: no result\.json/);
});

test('promote refuses a run that did not pass (PS-F1)', T, () => {
  const root = tmp();
  project(root);
  runFake(root, { profile: { steady_s: 6 }, engine_options: { faults: [{ kind: 'crash', worker: 1, at_s: 1.5 }] } });
  const r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  assert.match(r.out, /not promoted: only a done run/);
  assert.ok(!existsSync(join(root, '.perf', 'demo', 'baselines', 'local', 'load.json')));
});

test('analyze: failures by category with sampled correlation ids; a knee with the target CPU', T, () => {
  const root = tmp();
  project(root);
  const fake = join(root, 'fake-docker.mjs');
  writeFileSync(fake, `console.log(JSON.stringify({ Name: 'shop-api', CPUPerc: '20%', MemPerc: '10%', MemUsage: '100MiB / 1GiB' }));`);
  const env = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'env.json'), 'utf8'));
  env.environments.local.monitor = { metrics: 'docker-stats', containers: ['shop-api'], interval_s: 0.2 };
  writeFileSync(join(root, '.perf', 'demo', 'env.json'), JSON.stringify(env));
  const s = spec({ profile: { steady_s: 4 }, engine_options: { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true, faults: [{ kind: 'errors', from_s: 1.5, rate: 0.05, class: 'HTTP 500' }, { kind: 'slow', from_s: 1.5, factor: 4 }] } });
  writeFileSync(join(root, 'spec.json'), JSON.stringify(s));
  const run = spawnSync(process.execPath, [join(ROOT, 'bin', 'perf.mjs'), 'run', join(root, 'spec.json'), '--root', root, '--wait'], { encoding: 'utf8', env: { ...process.env, PERF_DOCKER: fake } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const a = JSON.parse(perf(['analyze', '--root', root, '--slug', 'demo', '--json']).out);
  const f = a.failures.find((x) => x.class === 'HTTP 500');
  assert.equal(f.category, 'app: server error');
  assert.ok(f.samples[0].correlation_id && f.first_t >= 1.5);
  assert.ok(a.bottleneck, 'knee found');
  assert.match(a.bottleneck.hint, /^not CPU in shop-api: .*pool/);
  assert.ok(existsSync(join(runDir(root), 'analysis.md')));
});

test('categories: who acts on each failure class', () => {
  assert.equal(categorize('HTTP 500'), 'app: server error');
  assert.equal(categorize('HTTP 503'), 'app: overloaded (throttling or unavailable)');
  assert.equal(categorize('HTTP 404'), 'data or script: the request itself is wrong');
  assert.equal(categorize('ConnectionRefusedError'), 'network: connection');
  assert.equal(categorize('ReadTimeout'), 'network or app: timeout');
});

// ---- asking policy, help, watch ------------------------------------------------------------

test('discover: an API description means no question about operations; never more than 3 questions', () => {
  const root = tmp();
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ paths: { '/items': { get: { operationId: 'listItems', 'x-perf': { p95_ms: 200 } } } } }));
  const c = discover(root, 'demo');
  assert.ok(c.questions.length <= MAX_QUESTIONS);
  assert.ok(!c.questions.some((q) => q.key === 'operations'));
  assert.ok(!c.questions.some((q) => q.key === 'peak_load'), 'x-perf answers the load question');
  assert.deepEqual(c.facts.operations, ['listItems']);
  for (const q of c.questions) assert.ok(q.proposed && q.choices.length, 'every question has a proposed answer');
});

test('report: once the plan sets SLOs, discover\'s SLO defaults are not quoted as assumptions', T, () => {
  const root = tmp();
  discover(root, 'demo');
  project(root);
  runFake(root);
  const v = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--json']).out);
  const note = v.notes.find((n) => n.startsWith('rests on')) ?? '';
  assert.doesNotMatch(note, /slo_p95_ms/);
  assert.match(note, /peak_load=50 \(default\)/);
});

test('discover: an answer is never asked again and becomes a confirmed assumption', () => {
  const root = tmp();
  const first = discover(root, 'demo');
  assert.equal(first.questions.length, 3, 'an empty repo leaves 5 open questions; only the 3 most decisive are asked');
  assert.ok(first.questions.some((q) => q.key === 'peak_load'));
  const second = discover(root, 'demo', { peak_load: '500 users' });
  const third = discover(root, 'demo');
  for (const c of [second, third]) assert.ok(!c.questions.some((q) => q.key === 'peak_load'));
  const a = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'assumptions.json'), 'utf8')).find((x) => x.key === 'peak_load');
  assert.equal(a.status, 'confirmed');
  assert.equal(a.value, '500 users');
});

test('discover: a value confirmed later (an agreed SLO) is never downgraded by a new scan', () => {
  const root = tmp();
  discover(root, 'demo');
  const path = join(root, '.perf', 'demo', 'assumptions.json');
  const list = JSON.parse(readFileSync(path, 'utf8')).map((a) => (a.key === 'slo_p95_ms' ? { ...a, value: 300, source: 'confirmed', status: 'confirmed' } : a));
  writeFileSync(path, JSON.stringify(list));
  discover(root, 'demo');
  const a = JSON.parse(readFileSync(path, 'utf8')).find((x) => x.key === 'slo_p95_ms');
  assert.deepEqual([a.status, a.value], ['confirmed', 300]);
});

test('discover: an existing suite is found; help routes to /perf-import only once that command exists', () => {
  const root = tmp();
  writeFileSync(join(root, 'load.js'), "import http from 'k6/http';\nexport default function () { http.get('x'); }\n");
  const c = discover(root, 'demo');
  assert.deepEqual(c.facts.existing_suites, [{ tool: 'k6', path: 'load.js' }]);
  assert.equal(nextStep(root, 'demo').command, hasCommand('/perf-import') ? '/perf-import' : '/perf-plan');
});

test('help: every step it can name is a command this bundle has', () => {
  const named = [...readFileSync(join(ROOT, 'lib', 'help.mjs'), 'utf8').matchAll(/\/perf-[a-z]+/g)].map((m) => m[0]);
  const missing = [...new Set(named)].filter((c) => c !== '/perf-import' && !hasCommand(c));
  assert.deepEqual(missing, [], 'help names a command that does not exist');
});

test('help: a NOT EVALUABLE verdict sends you to fix the run, not to the next profile', T, () => {
  const root = tmp();
  project(root);
  discover(root, 'demo');
  runFake(root, { profile: SMOKE });
  runFake(root, { profile: { name: 'load', users: 20, warmup_s: 0.5, ramp_s: 0.5, steady_s: 2, rampdown_s: 0.5 } });
  perf(['analyze', '--root', root, '--slug', 'demo']);
  perf(['report', '--root', root, '--slug', 'demo']);
  const n = nextStep(root, 'demo');
  assert.equal(n.command, '/perf-analyze', JSON.stringify(n));
  assert.match(n.why, /NOT EVALUABLE \(NOT_EVALUABLE: no baseline/);
});

test('help: walks the lifecycle from nothing to a verdict', T, () => {
  const root = tmp();
  assert.equal(nextStep(root, 'demo').command, '/perf-start');
  discover(root, 'demo');
  assert.equal(nextStep(root, 'demo').command, '/perf-plan');
  project(root, { 'workload.json': null, 'env.json': null, 'data/manifest.json': null });
  assert.equal(nextStep(root, 'demo').command, '/perf-model');
  project(root);
  assert.equal(nextStep(root, 'demo').command, '/perf-script');
  runFake(root, { profile: SMOKE });
  assert.equal(nextStep(root, 'demo').command, '/perf-run');
  runFake(root);
  assert.equal(nextStep(root, 'demo').command, '/perf-analyze');
  perf(['analyze', '--root', root, '--slug', 'demo']);
  assert.equal(nextStep(root, 'demo').command, '/perf-report');
});

test('watch: with the wake budget spent, a notable event is batched, not woken for', T, async () => {
  const dir = join(tmp(), 'run');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: 'r', slug: 'demo', watch: { max_wakes_per_hour: 1 } }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ run_id: 'r', slug: 'demo', state: 'steady', pid: process.pid, heartbeat_at: Date.now(), heartbeat_timeout_s: 600 }));
  emit(dir, { t: 1, type: 'new_error_class', severity: 'warn', summary: 'HTTP 500', data: { class: 'HTTP 500' } });
  const first = await watch(dir, { timeoutS: 5 });
  assert.equal(first.reason, 'notable event');
  emit(dir, { t: 2, type: 'new_error_class', severity: 'warn', summary: 'HTTP 503', data: { class: 'HTTP 503' } });
  const second = await watch(dir, { since: first.next, timeoutS: 1, pollMs: 100 });
  assert.equal(second.reason, 'wake budget spent; batched');
  assert.equal(second.events.length, 1, 'the batched event is still handed over');
});

test('watch: wakes on a notable event, not on phase changes; over budget only critical events wake', T, async () => {
  const root = tmp();
  const s = spec({ profile: { steady_s: 4 }, watch: { max_wakes_per_hour: 1 }, engine_options: { faults: [{ kind: 'errors', from_s: 1, rate: 0.1, class: 'HTTP 500' }] } });
  assert.equal(perf(['run', writeSpec(root, s), '--root', root]).code, 0);
  const dir = await waitFor(() => runDir(root), 5000, 'run dir');
  const first = await watch(dir, { timeoutS: 30 });
  assert.equal(first.reason, 'notable event');
  assert.ok(first.events.some((e) => e.type === 'new_error_class'));
  // The budget (1 per hour) is spent: from now on only critical events wake, until run_finished.
  // A busy machine may add a critical worker_lost on the way; a non-critical wake never comes.
  let since = first.next;
  for (let i = 0; i < 5; i++) {
    const w = await watch(dir, { since, timeoutS: 30 });
    assert.ok(['critical event', 'controller lost'].includes(w.reason), `woke for "${w.reason}" with the budget spent`);
    if (w.events.some((e) => e.type === 'run_finished')) return;
    since = w.next;
  }
  assert.fail('run_finished never woke the watcher');
});
