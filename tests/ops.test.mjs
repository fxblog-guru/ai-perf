import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discover } from '../lib/discover.mjs';
import { nextStep } from '../lib/help.mjs';
import { judgeSeries } from '../lib/history.mjs';
import { changed, fingerprint } from '../lib/fingerprint.mjs';
import { perf, perfAsync, spec, tmp, waitFor } from './helpers.mjs';
import { ENDPOINTS, SMOKE, project, runFake } from './project.mjs';

// M4 operations (design §12): the CI gate, compare, trend, stale baselines and lessons.
const T = { timeout: 120000 };
const SLOW = (factor) => ({ engine_options: { faults: [{ kind: 'slow', factor }] } });
const ids = (root) => readdirSync(join(root, '.perf', 'demo', 'runs')).sort();

test('ci: one command, exit = verdict, JUnit for the pipeline; a refused spec keeps exit 2', T, () => {
  const root = tmp();
  project(root);
  const smoke = (over) => {
    const p = join(root, 'ci.json');
    writeFileSync(p, JSON.stringify(spec({ engine_options: { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true, ...over }, profile: SMOKE })));
    return p;
  };
  const ok = perf(['ci', smoke(), '--root', root, '--junit', join(root, 'j.xml')]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(readFileSync(join(root, 'j.xml'), 'utf8'), /<testsuite name="ai-perf [\w-]+ \(local\/smoke\): PASS" tests="1" failures="0" errors="0">/);
  const bad = perf(['ci', smoke({ faults: [{ kind: 'errors', rate: 0.5, class: 'HTTP 500' }] }), '--root', root, '--junit', join(root, 'j.xml')]);
  assert.equal(bad.code, 1, bad.out);
  assert.match(readFileSync(join(root, 'j.xml'), 'utf8'), /<testcase classname="ai-perf.smoke" name="run"><failure message="FAIL: smoke had \d+ failures"\/>/);
  const p = join(root, 'prod.json');
  writeFileSync(p, JSON.stringify(spec({ environment: 'prod', profile: SMOKE })));
  assert.equal(perf(['ci', p, '--root', root]).code, 2);
});

test('compare: two runs side by side; a slower build is a regression; another load level is refused', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  runFake(root, SLOW(1.6));
  const [a, b] = ids(root);
  const c = perf(['compare', '--root', root, '--slug', 'demo', '--run', a, '--run', b, '--json']);
  assert.equal(c.code, 1, c.out);
  const out = JSON.parse(c.out);
  assert.ok(out.rows.find((r) => r.name === 'listItems').p95_change_pct > 40, JSON.stringify(out.rows));
  assert.equal(out.scope, 'systemic');
  assert.ok(existsSync(join(root, '.perf', 'demo', 'runs', b, `compare-${a}.md`)));
  runFake(root, { profile: { users: 10 } });
  const r = perf(['compare', '--root', root, '--slug', 'demo', '--run', a, '--run', ids(root)[2]]);
  assert.equal(r.code, 3);
  assert.match(r.out, /baseline was taken at 20 users, this run at 10/);
});

// M4 exit check (design §15): the trend flags a planted slow decay that no single step shows.
test('trend: a planted slow decay is flagged though every step is under 10 %; a flat series is not', { timeout: 240000 }, () => {
  const root = tmp();
  project(root);
  for (const f of [1, 1.06, 1.12, 1.18, 1.25]) runFake(root, SLOW(f));
  const t = perf(['trend', '--root', root, '--slug', 'demo', '--json']);
  assert.equal(t.code, 1, t.out);
  const out = JSON.parse(t.out);
  assert.equal(out.runs.length, 5);
  const decay = out.flags.filter((f) => f.kind === 'slow_decay').map((f) => f.series);
  assert.ok(['listItems p95_ms', 'getItem p95_ms'].every((s) => decay.includes(s)), JSON.stringify(out.flags));
  assert.ok(!out.flags.some((f) => f.kind === 'step'), JSON.stringify(out.flags));
  assert.match(readFileSync(join(root, '.perf', 'demo', 'trend.md'), 'utf8'), /\*\*slow decay\*\* in listItems p95_ms: \+2\d(\.\d)? % over 5 runs/);
  const flat = tmp();
  project(flat);
  for (let i = 0; i < 4; i++) runFake(flat);
  const f = perf(['trend', '--root', flat, '--slug', 'demo', '--json']);
  assert.equal(f.code, 0, f.out);
  assert.deepEqual(JSON.parse(f.out).flags, []);
});

test('trend: one jump past 10 % is a step, not a slow decay; runs of another kind are left out and named', { timeout: 240000 }, () => {
  const root = tmp();
  project(root);
  runFake(root, { profile: { users: 10 } });
  for (const f of [1, 1, 1, 1.3]) runFake(root, SLOW(f));
  const out = JSON.parse(perf(['trend', '--root', root, '--slug', 'demo', '--json']).out);
  assert.equal(out.runs.length, 4);
  assert.match(out.left_out[0].why, /10 users/);
  assert.ok(out.flags.some((f) => f.kind === 'step' && f.series === 'listItems p95_ms'), JSON.stringify(out.flags));
  assert.ok(!out.flags.some((f) => f.kind === 'slow_decay'));
});

test('baseline STALE: a run under another workload or architecture is not compared; --bootstrap --promote moves on', T, () => {
  const root = tmp();
  project(root);
  discover(root, 'demo');
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  const wl = join(root, '.perf', 'demo', 'workload.json');
  writeFileSync(wl, JSON.stringify({ ...JSON.parse(readFileSync(wl, 'utf8')), model_reason: 'a reworded reason is not a change' }));
  runFake(root);
  assert.equal(perf(['report', '--root', root, '--slug', 'demo']).code, 0, 'prose is not the workload: compared');
  // The workload changes and the new build is much slower: the change, not the build, may be why.
  writeFileSync(wl, JSON.stringify({ ...JSON.parse(readFileSync(wl, 'utf8')), target: { users: 40, source: 'assumed' } }));
  // A consistent plan: the data set grows with the users (the data gate would refuse it otherwise).
  const mf = join(root, '.perf', 'demo', 'data', 'manifest.json');
  writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, 'utf8')), accounts: { count: 40, source: 'generated' } }));
  runFake(root, SLOW(1.6));
  const stale = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(stale.code, 3, stale.out);
  assert.match(stale.out, /is STALE: the workload, data changed since it was measured/);
  assert.doesNotMatch(stale.out, /regression/, 'a refused baseline adds no regression');
  // The way out the message names works: judged on SLOs only, then promoted.
  const boot = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  assert.match(boot.out, /note: BOOTSTRAP: baseline .* is STALE/);
  assert.match(boot.out, /baseline promoted/, boot.out);
  writeFileSync(join(root, 'docker-compose.yml'), 'services:\n  api:\n    image: x\n  cache:\n    image: redis:7\n');
  discover(root, 'demo');
  runFake(root, SLOW(1.6));
  assert.match(perf(['report', '--root', root, '--slug', 'demo']).out, /the architecture changed/);
  // compare and trend apply the same rule.
  const [, , b, c] = ids(root);
  assert.equal(perf(['compare', '--root', root, '--slug', 'demo', '--run', b, '--run', c]).code, 3);
  const t = JSON.parse(perf(['trend', '--root', root, '--slug', 'demo', '--json']).out);
  assert.deepEqual(t.runs, [c]);
  assert.ok(t.left_out.every((x) => /STALE/.test(x.why)), JSON.stringify(t.left_out));
});

test('learn: lessons from runs, "seen before" in a later verdict, pushes are recorded', T, () => {
  const root = tmp();
  project(root);
  discover(root, 'demo');
  runFake(root, { profile: SMOKE });
  const saturated ={ engine_options: { faults: [{ kind: 'saturate', pct: 95 }] } };
  runFake(root, saturated);
  perf(['analyze', '--root', root, '--slug', 'demo']);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  // perf report learned already: nobody has to call perf learn.
  const first = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'lessons.json'), 'utf8'));
  assert.deepEqual(first.lessons.map((l) => l.id), ['problem:generator_saturated']);
  assert.deepEqual(JSON.parse(perf(['learn', '--root', root, '--slug', 'demo', '--json']).out).fresh, []);
  runFake(root, saturated);
  perf(['analyze', '--root', root, '--slug', 'demo']);
  const v = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--json']).out);
  assert.ok(v.notes.some((n) => n.startsWith(`seen before in ${first.seen[0]}: The load generator saturated`)), v.notes.join('\n'));
  assert.equal(nextStep(root, 'demo').command, '/perf-analyze', 'NOT EVALUABLE is fixed first');
  const second = JSON.parse(perf(['learn', '--root', root, '--slug', 'demo', '--json']).out);
  assert.deepEqual(second.fresh, []);
  assert.equal(second.lessons[0].runs.length, 2);
  perf(['learn', '--root', root, '--slug', 'demo', '--pushed', 'problem:generator_saturated']);
  assert.match(readFileSync(join(root, '.perf', 'demo', 'lessons.md'), 'utf8'), /\(2 run\(s\), first [\w-]+, in Recall\)/);
});

test('help: a judged PASS run has taught its lessons already; one judged before that goes to /perf-learn', T, () => {
  const root = tmp();
  project(root);
  discover(root, 'demo');
  runFake(root, { profile: SMOKE });
  runFake(root);
  perf(['analyze', '--root', root, '--slug', 'demo']);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.equal(nextStep(root, 'demo').command, '/perf-run');
  rmSync(join(root, '.perf', 'demo', 'lessons.json'));
  assert.equal(nextStep(root, 'demo').command, '/perf-learn');
  perf(['learn', '--root', root, '--slug', 'demo']);
  assert.equal(nextStep(root, 'demo').command, '/perf-run');
});

test('ci judges its own run, even when another run of the slug starts after it', T, async () => {
  const root = tmp();
  project(root);
  const ciSpec = join(root, 'ci.json');
  writeFileSync(ciSpec, JSON.stringify(spec({ engine_options: { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true }, profile: { ...SMOKE, warmup_s: 4 } })));
  const ci = perfAsync(['ci', ciSpec, '--root', root]);
  await waitFor(() => existsSync(join(root, '.perf', 'demo', 'runs')) && ids(root).length === 1, 10000, 'ci run started');
  const other = join(root, 'other.json');
  writeFileSync(other, JSON.stringify(spec({ profile: { steady_s: 30 } })));
  assert.equal(perf(['run', other, '--root', root]).code, 0);
  const r = await ci;
  try {
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`junit: .*${ids(root)[0]}`));
  } finally { perf(['stop', '--root', root, '--run', ids(root)[1]]); }
});

test('a repeated regression is "seen before" in the next verdict, citing only earlier runs', T, () => {
  const root = tmp();
  project(root);
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  runFake(root, SLOW(1.6));
  perf(['report', '--root', root, '--slug', 'demo']);
  perf(['learn', '--root', root, '--slug', 'demo']);
  runFake(root, SLOW(1.6));
  const v = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--json']).out);
  const [, second, third] = ids(root);
  assert.ok(v.notes.some((n) => n.startsWith(`seen before in ${second}: listItems regressed`)), v.notes.join('\n'));
  assert.ok(!v.notes.some((n) => n.includes(third) && n.startsWith('seen before')));
  // Re-judging the older run after the later one was learned never cites the later one.
  perf(['learn', '--root', root, '--slug', 'demo']);
  const again = JSON.parse(perf(['report', '--root', root, '--slug', 'demo', '--run', second, '--json']).out);
  assert.ok(!again.notes.some((n) => n.startsWith('seen before') && n.includes(third)), again.notes.join('\n'));
});

test('a flag given twice is refused where it takes one value', () => {
  const r = perf(['status', '--root', tmp(), '--run', 'a', '--run', 'b']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--run takes one run here/);
});

test('trend math: real drift is found through noise and after a long flat history; noise and a fixed step are not findings', () => {
  const kinds = (values, rps = false) => judgeSeries(values.map((value, i) => ({ run_id: `r${String(i).padStart(2, '0')}`, value })), rps ? (x) => -x : (x) => x, 10).map((f) => f.kind);
  assert.deepEqual(kinds([100, 108, 104, 112, 108, 116, 112, 120]), ['slow_decay'], 'noisy but real +20 %');
  assert.deepEqual(kinds([...Array(16).fill(100), 104, 108, 112, 116, 120]), ['slow_decay'], 'late decay after a flat history');
  assert.deepEqual(kinds([100, 115, 118, 122, 126, 130, 135, 140]), ['step', 'slow_decay'], 'an old step does not hide the decay after it');
  assert.deepEqual(kinds([100, 120, 100, 100, 100]), [], 'a fixed regression is not a finding any more');
  assert.deepEqual(kinds([92, 95, 99, 107]), [], 'four noisy runs are too few');
  assert.deepEqual(kinds([100, 92, 107, 95, 103, 98, 106, 94]), [], 'noise of ±8 % around a flat line');
  assert.deepEqual(kinds([90, 99, 100, 101, 99, 100, 101, 108]), [], 'a low first run and a high last run around a flat middle are not a trend');
  assert.deepEqual(kinds([100, 97, 94, 91, 88, 85], true), ['slow_decay'], 'throughput decays downwards');
  assert.deepEqual(kinds([100, 103, 106, 109, 112, 115], true), [], 'throughput rising is not a decay');
});

test('fingerprint: thresholds, sources and allowed hosts do not make a run another experiment; stubs, scripts and data do', () => {
  const root = tmp();
  project(root);
  writeFileSync(join(root, 'load.js'), 'v1');
  const s = { slug: 'demo', environment: 'local', script_path: join(root, 'load.js') };
  const before = fingerprint(root, s);
  const dir = join(root, '.perf', 'demo');
  const edit = (f, fn) => { const p = join(dir, f); const j = JSON.parse(readFileSync(p, 'utf8')); fn(j); writeFileSync(p, JSON.stringify(j)); };
  edit('slo.json', (j) => { j.transactions[0].source = 'confirmed'; j.transactions[0].slo.p95_ms = 150; });
  edit('workload.json', (j) => { j.target.source = 'confirmed'; j.model_reason = 'reworded'; });
  edit('env.json', (j) => { j.environments.local.allow_hosts.push('10.0.0.9'); j.environments.local.owner = 'someone else'; });
  assert.deepEqual(changed(before, fingerprint(root, s)), []);
  edit('env.json', (j) => { j.environments.local.third_party[0].stubbed = false; });
  writeFileSync(join(root, 'load.js'), 'v2');
  edit('data/manifest.json', (j) => { j.accounts.count = 5; });
  edit('workload.json', (j) => { j.journeys[0].think_time_s = 2; });
  assert.deepEqual(changed(before, fingerprint(root, s)).sort(), ['data', 'environment', 'script', 'workload']);
  assert.equal(changed(null, before), null, 'a run from before fingerprints: unknown, not "unchanged"');
});

// Dogfood on fx-blog: the same build, run twice on a shared laptop, moved 22 %.
test('same build, same fingerprint: a regression is still a FAIL, and the verdict says it is the environment', T, () => {
  const root = tmp();
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(root, 'app.txt'), 'v1');
  git('add', '.');
  git('commit', '-qm', 'v1');
  project(root);
  runFake(root);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  runFake(root, SLOW(1.6));
  const r = perf(['report', '--root', root, '--slug', 'demo']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the baseline is the same build \([0-9a-f]{8}\) under the same fingerprint: this difference is the environment's noise/);
  const [a, b] = ids(root);
  assert.equal(JSON.parse(perf(['compare', '--root', root, '--slug', 'demo', '--run', a, '--run', b, '--json']).out).same_build, true);
  // Uncommitted changes at the same sha are another build: no such note.
  writeFileSync(join(root, 'app.txt'), 'v1 edited');
  runFake(root, SLOW(1.6));
  assert.doesNotMatch(perf(['report', '--root', root, '--slug', 'demo']).out, /same build/);
  // Another commit is another build: no such note.
  writeFileSync(join(root, 'app.txt'), 'v2');
  git('commit', '-qam', 'v2');
  runFake(root, SLOW(1.6));
  assert.doesNotMatch(perf(['report', '--root', root, '--slug', 'demo']).out, /same build/);
});
