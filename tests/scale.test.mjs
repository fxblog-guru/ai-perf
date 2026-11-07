import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fill, runCommand, words } from '../lib/command.mjs';
import { VOLUME_DRIFT_PCT, checkVolume, countVolume, parseCount, volumeDiff } from '../lib/volume.mjs';
import { checkScale, parseInstances, readCount, scaledSteps, scaling, waitReady } from '../lib/scale.mjs';
import { compareBaseline, judgeVolume } from '../lib/verdict.mjs';
import { rank } from '../lib/matrix.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { listRuns } from '../lib/runs.mjs';
import { ROOT, perf, result, runDir, spec, tmp } from './helpers.mjs';
import { ENDPOINTS, JOURNEYS, OPS, project, runFake } from './project.mjs';

// M15, volume and scalability: a run is at volume only on the data it counted just before it, runs
// at other volumes are another experiment, and a deployment scaled to n instances is read for its
// capacity per count and its scaling efficiency, never claiming a capacity no staircase observed.
const T = { timeout: 400000 };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = [];
after(() => { for (const c of children) c.kill(); });

// ---- the command a project gives ---------------------------------------------------------------

// Records the arguments it was started with: what a shell would have done to them shows here.
const RECORD = "import { writeFileSync } from 'node:fs';\nwriteFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n";

test('command: split into words without a shell, so nothing in it or in a value can start a second command', () => {
  assert.deepEqual(words('docker compose up -d --scale api={n}'), ['docker', 'compose', 'up', '-d', '--scale', 'api={n}']);
  assert.deepEqual(words('"C:\\Program Files\\nodejs\\node.exe" \'a b\' c'), ['C:\\Program Files\\nodejs\\node.exe', 'a b', 'c'], 'quotes keep one word; backslashes stay');
  assert.deepEqual(words('psql -c ""'), ['psql', '-c', ''], 'an empty quoted word is a word');
  assert.throws(() => words('echo "open'), /unclosed "/);
  assert.deepEqual(fill(['--scale', 'api={n}', '{other}'], { n: 4 }), ['--scale', 'api=4', '{other}']);
  const root = tmp();
  writeFileSync(join(root, 'rec.mjs'), RECORD);
  const r = runCommand(`"${process.execPath}" rec.mjs {n} ; echo pwned > pwned.txt && $(whoami) | more`, { n: 2 }, { cwd: root });
  assert.equal(r.exit_code, 0, r.output);
  assert.deepEqual(read(join(root, 'argv.json')), ['2', ';', 'echo', 'pwned', '>', 'pwned.txt', '&&', '$(whoami)', '|', 'more']);
  assert.equal(existsSync(join(root, 'pwned.txt')), false, 'no shell ran the rest');
  assert.equal(runCommand('no-such-program-xyz {n}', { n: 1 }, { cwd: root }).exit_code, null);
  assert.equal(runCommand(`"${process.execPath}" -e "process.exit(3)"`, {}, { cwd: root }).exit_code, 3);
});

// ---- volume ----------------------------------------------------------------------------------

const SEED = "import { readFileSync, writeFileSync } from 'node:fs';\nconst [entity, target] = process.argv.slice(2);\nlet c = {};\ntry { c = JSON.parse(readFileSync('counts.json', 'utf8')); } catch { /* none yet */ }\nc[entity] = Number(target);\nwriteFileSync('counts.json', JSON.stringify(c));\n";
// Prints the count with thousands separators, as psql or a report would; `broken` prints a number
// and then fails, which is no count.
const COUNT = "import { appendFileSync, readFileSync } from 'node:fs';\nconst entity = process.argv[2];\nappendFileSync('counted.log', entity + '\\n');\nconst c = JSON.parse(readFileSync('counts.json', 'utf8'));\nif (entity === 'broken') { console.log('12'); process.exit(2); }\nconsole.log(c[entity] === undefined ? 'no such table' : c[entity].toLocaleString('en-US'));\n";
const VOLUME = { entities: {
  orders: { target: 5000000, seed: 'node seed.mjs {entity} {target}', count: 'node count.mjs {entity}', source: 'measured' },
  tenants: { target: 2000, seed: 'node seed.mjs {entity} {target}', count: 'node count.mjs {entity}', source: 'confirmed' },
} };
const MANIFEST = (volume = VOLUME) => ({ accounts: { count: 20, source: 'generated' }, cleanup: { command: 'node cleanup.mjs --prefix $RUN_ID' }, run_id_prefix: true, ...(volume ? { volume } : {}) });
const SLO = { profiles: ['smoke', 'load', 'volume', 'stress'], transactions: OPS.map((name) => ({ name, slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' })) };
const counts = (root, c) => writeFileSync(join(root, 'counts.json'), JSON.stringify(c));
function volumeProject(root, volume = VOLUME) {
  project(root, { 'slo.json': SLO, 'data/manifest.json': MANIFEST(volume) });
  writeFileSync(join(root, 'seed.mjs'), SEED);
  writeFileSync(join(root, 'count.mjs'), COUNT);
  counts(root, { orders: 0, tenants: 0 });
}
const LOAD = { name: 'load', users: 4, warmup_s: 0.5, ramp_s: 0.5, steady_s: 2, rampdown_s: 0.5 };

test('volume: the plan is checked by the data gate: a size per entity with its source, a count command, a share to reach', () => {
  assert.deepEqual(checkVolume(VOLUME), []);
  assert.deepEqual(checkVolume(undefined), [], 'no plan: nothing to check');
  const bad = checkVolume({ entities: { orders: { target: 5.5, count: 'node "count.mjs', seed: '', source: 'guess', rows: 1 } }, min_pct: 120, extra: 1 });
  for (const re of [/volume.extra: unknown key/, /volume.min_pct: a number in \(0, 100\]/, /orders.rows: unknown key/, /orders.target: the row count/, /orders.count: unclosed "/, /orders.seed: a command/, /orders.source: one of/]) assert.match(bad.join('\n'), re);
  assert.match(checkVolume({ entities: {} }).join(), /at least one entity/);
  assert.match(checkVolume({ entities: { orders: { target: 10, source: 'measured' } } }).join(), /orders.count: a command that prints the row count/);
  const root = tmp();
  project(root, { 'data/manifest.json': MANIFEST({ entities: { orders: { target: 10, count: 'x' } } }) });
  assert.match(CHECKS.data(root, 'demo').errors.join(), /orders.source/);
  // A count is the last line a command printed, a whole number with or without separators.
  assert.deepEqual(['5000000', ' count \n-------\n 5,000,000\n', '5_000_000', '5 000 000\n\n', '12.5', 'error', '', '-3'].map(parseCount), [5000000, 5000000, 5000000, 5000000, null, null, null, null]);
});

test('volume: perf volume seeds only when asked, counts every entity, and short or uncounted data is not at volume', T, () => {
  const root = tmp();
  volumeProject(root, { ...VOLUME, entities: { ...VOLUME.entities, broken: { target: 10, count: 'node count.mjs {entity}', source: 'assumed' } } });
  let r = perf(['volume', '--root', root, '--slug', 'demo']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(read(join(root, 'counts.json')).orders, 0, 'counting never seeds');
  assert.match(r.out, /NOT AT VOLUME/);
  r = perf(['volume', '--root', root, '--slug', 'demo', '--seed']);
  let v = read(join(root, '.perf', 'demo', 'data', 'volume.json'));
  assert.deepEqual([v.entities.orders.count, v.entities.orders.pct, v.entities.orders.ok, v.entities.orders.seed.exit_code], [5000000, 100, true, 0]);
  // A count command that printed a number and failed counted nothing.
  assert.equal(v.entities.broken.count, null);
  assert.match(v.entities.broken.error, /the count command failed \(exit 2\)/);
  assert.deepEqual([v.at_volume, v.failed, v.short], [false, ['broken'], []]);
  assert.equal(r.code, 3);
  // Without the broken entity: at volume, then short once a fifth of the orders are gone.
  volumeProject(root);
  counts(root, { orders: 5000000, tenants: 2000 });
  r = perf(['volume', '--root', root, '--slug', 'demo']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /AT VOLUME \(each entity at least 95 % of its target\)\n {2}orders: 5000000 of 5000000 \(100 %\)/);
  counts(root, { orders: 4700000, tenants: 2000 });
  v = countVolume(root, VOLUME);
  assert.deepEqual([v.at_volume, v.entities.orders.pct, v.short], [false, 94, ['orders']]);
  assert.equal(countVolume(root, { ...VOLUME, min_pct: 90 }).at_volume, true, 'min_pct sets the share');
  assert.match(readFileSync(join(root, '.perf', 'demo', 'data', 'volume.md'), 'utf8'), /\| orders \| 5,000,000 \| 5,000,000 \| 100 \|/);
  r = perf(['volume', '--root', tmp(), '--slug', 'demo']);
  assert.equal(r.code, 2, 'no plan: refused');
});

test('volume: a run counts its data just before it starts; a volume run is at volume only on that count', T, () => {
  const root = tmp();
  volumeProject(root);
  counts(root, { orders: 5000000, tenants: 2000 });
  // A smoke counts nothing: it proves the wiring only.
  runFake(root, { profile: { name: 'smoke', users: 2, warmup_s: 0, ramp_s: 0, steady_s: 1, rampdown_s: 0 } });
  assert.equal(existsSync(join(root, 'counted.log')), false);
  let r = runFake(root, { profile: { ...LOAD, name: 'volume' } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /volume: at volume: orders 5,000,000 of 5,000,000 \(100 %\), tenants 2,000 of 2,000 \(100 %\)/);
  const res = result(runDir(root));
  assert.deepEqual([res.run.volume.at_volume, res.run.volume.entities.orders.count], [true, 5000000]);
  assert.ok(res.run.volume.counted_at <= res.run.started_at, 'counted before the run started');
  r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  let v = read(join(runDir(root), 'verdict.json'));
  assert.equal(v.outcome, 'PASS', r.out);
  assert.equal(v.volume.at_volume, true);
  assert.ok(v.notes.some((n) => /^at volume: orders 5,000,000 of 5,000,000/.test(n)));
  assert.match(v.summary, /Measured at the planned data volume: orders 5,000,000/);
  // 90 % of the orders: a volume run says nothing about production-sized data.
  counts(root, { orders: 4500000, tenants: 2000 });
  runFake(root, { profile: { ...LOAD, name: 'volume' } });
  r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  v = read(join(runDir(root), 'verdict.json'));
  assert.equal(v.outcome, 'NOT_EVALUABLE', r.out);
  assert.ok(v.reasons.some((x) => /^NOT_EVALUABLE: volume: the data was short of the volume plan \(under 95 % of the plan: orders\): orders 4,500,000 of 5,000,000 \(90 %\)/.test(x)), v.reasons.join('\n'));
  // A load run on the same short data still measured something: a WARN that says on what.
  runFake(root, { profile: LOAD });
  r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  v = read(join(runDir(root), 'verdict.json'));
  assert.equal(v.outcome, 'WARN', r.out);
  assert.match(v.reasons.join(), /WARN: volume: the data was short .* flatter the target/);
  assert.match(v.summary, /Measured on less data than planned/);
  // A volume run without a plan is refused before it starts.
  writeFileSync(join(root, '.perf', 'demo', 'data', 'manifest.json'), JSON.stringify(MANIFEST(null)));
  r = runFake(root, { profile: { ...LOAD, name: 'volume' } });
  assert.equal(r.code, 2);
  assert.match(r.out, /profile volume: data\/manifest.json has no volume plan/);
});

test('volume: a judged volume run with nothing counted is not evaluable', () => {
  const v = { notes: [], reasons: [] };
  const add = (o, why) => v.reasons.push(`${o}: ${why}`);
  judgeVolume(v, add, { run: { profile: 'volume' } });
  assert.match(v.reasons.join(), /NOT_EVALUABLE: volume: nothing was counted before this run/);
  v.reasons = [];
  judgeVolume(v, add, { run: { profile: 'load' } });
  assert.deepEqual(v.reasons, [], 'no plan, no volume judgment');
});

const counted = (orders, tenants = 2000) => ({ min_pct: 95, at_volume: true, short: [], failed: [], entities: { orders: { target: 5000000, count: orders }, tenants: { target: 2000, count: tenants } } });
const resAt = (volume, extra = {}) => ({ run: { id: 'r', environment: 'local', profile: 'load', tool: 'other', tool_version: 'fake 1', target: 'http://x', users: 4, model: 'closed', ...(volume ? { volume } : {}), ...extra }, endpoints: {}, total: { rps: 10 } });

test('volume: runs at other data volumes are STALE for each other; the plan is in the fingerprint', () => {
  assert.equal(volumeDiff(null, null), null);
  assert.equal(volumeDiff(counted(5000000), counted(5000000 * (1 - (VOLUME_DRIFT_PCT - 1) / 100))), null, 'within the tolerance: the same data size');
  assert.deepEqual(volumeDiff(counted(5000000), counted(4500000)), ['orders 5,000,000 -> 4,500,000 rows']);
  assert.deepEqual(volumeDiff(counted(5000000), counted(null)), ['orders was not counted in the later run']);
  assert.match(volumeDiff(counted(5000000), null).join(), /one run counted its data .* the other did not/);
  const c = compareBaseline(resAt(counted(4500000)), resAt(counted(5000000)));
  assert.deepEqual(c.stale, ['data']);
  assert.match(c.refused, /STALE: the data volume differs \(orders 5,000,000 -> 4,500,000 rows\)/);
  assert.equal(compareBaseline(resAt(counted(5000000)), resAt(counted(4950000))).refused, null);
  // Runs of perf scale at other instance counts are other deployments.
  assert.match(compareBaseline(resAt(null, { instances: 4 }), resAt(null, { instances: 1 })).refused, /baseline ran on 1 instance\(s\), this run on 4/);
  // The plan's sizes are in the data fingerprint; a manifest without a plan keeps its old digest.
  const root = tmp();
  volumeProject(root);
  const fp = (m) => { writeFileSync(join(root, '.perf', 'demo', 'data', 'manifest.json'), JSON.stringify(m)); return fingerprint(root, { slug: 'demo', environment: 'local' }).data; };
  const plain = fp(MANIFEST(null));
  assert.equal(plain, fp({ ...MANIFEST(null) }));
  const planned = fp(MANIFEST());
  assert.notEqual(planned, plain);
  assert.notEqual(fp(MANIFEST({ entities: { ...VOLUME.entities, orders: { ...VOLUME.entities.orders, target: 1000000 } } })), planned, 'another target size is another data set');
  // A matrix variant that declares it changes the data is not STALE for its counts.
  const variant = (name, volume, changes = []) => ({ name, changes, res: { ...resAt(volume), run_state: 'done', total: { rps: 10, requests: 500, p95_ms: 50 } } });
  let m = rank([variant('a', counted(5000000)), variant('b', counted(1000000))]);
  assert.match(m.rows[1].flag, /STALE: the data changed/);
  m = rank([variant('a', counted(5000000)), variant('b', counted(1000000), ['data'])]);
  assert.equal(m.rows[1].flag, undefined);
});

test('volume: a baseline at another volume is STALE, and perf compare refuses the pair', T, () => {
  const root = tmp();
  volumeProject(root);
  counts(root, { orders: 5000000, tenants: 2000 });
  runFake(root, { profile: LOAD });
  let r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap', '--promote']);
  assert.match(r.out, /baseline promoted/);
  counts(root, { orders: 4000000, tenants: 2000 });
  runFake(root, { profile: LOAD });
  r = perf(['report', '--root', root, '--slug', 'demo']);
  const v = read(join(runDir(root), 'verdict.json'));
  assert.equal(v.outcome, 'NOT_EVALUABLE');
  assert.ok(v.reasons.some((x) => /STALE: the data volume differs \(orders 5,000,000 -> 4,000,000 rows\)/.test(x)), v.reasons.join('\n'));
  assert.deepEqual(v.baseline.stale, ['data']);
  const [a, b] = listRuns(root, 'demo').map((x) => x.id);
  r = perf(['compare', '--root', root, '--slug', 'demo', '--run', a, '--run', b]);
  assert.equal(r.code, 3);
  assert.match(r.out, /Not compared: .*the data volume differs/);
});

// ---- scalability -----------------------------------------------------------------------------

test('scale: the plan is checked; instance counts are whole numbers only, ascending', () => {
  assert.deepEqual(parseInstances('1,2,4'), { list: [1, 2, 4] });
  assert.deepEqual(parseInstances([1, 3]), { list: [1, 3] });
  for (const bad of ['1;rm -rf /', '1,2.5', '1,0x10', '1,$(id)', '0,1', '2,1', '2,2', '1', '1,2,3,4,5,6,7,8,9']) assert.ok(parseInstances(bad).error, bad);
  const root = tmp();
  writeFileSync(join(root, 'spec.json'), '{}');
  assert.deepEqual(checkScale({ spec: 'spec.json', instances: '1,2', command: 'docker compose up -d --scale api={n}' }, root), []);
  const errs = checkScale({ spec: 'nope.json', instances: '1', command: 'x "y', steps: 'double', ready: { url: 'ftp://x', wait: 1 }, timeout_s: 0, other: 1 }, root).join('\n');
  for (const re of [/other: unknown key/, /spec: the run spec/, /instances: between 2/, /command: unclosed "/, /steps: "scaled"/, /ready: \{ url\?, timeout_s\? \}/, /timeout_s: seconds/]) assert.match(errs, re);
  assert.match(checkScale({ spec: 'spec.json', instances: '1,2', command: 'x', ready: { url: 'ftp://x' } }, root).join(), /ready.url: an http/);
  // Each count climbs the staircase times n / base, so every count is read on the same grid.
  assert.deepEqual(scaledSteps([4, 8, 16], 2, 1), [8, 16, 32]);
  assert.deepEqual(scaledSteps([4, 8, 16], 3, 2), [6, 12, 24]);
  assert.deepEqual(scaledSteps([1, 2], 1, 4), [1, 2], 'each step above the one before');
  assert.deepEqual(scaledSteps([4, 8], 4, 1, 'same'), [4, 8]);
});

const pt = (instances, kind, held, extra = {}) => ({ instances, unit: 'users', held, reading: { kind, ...(kind === 'unjudged' ? { why: 'stopped' } : {}) }, ...extra });
const POOL = { cause: ['pool_used_pct'], hint: 'waiting on db_pool: a connection pool was full: requests waited for a connection', evidence: 'p95 80 -> 500 ms, db_pool 100 % > 95' };

test('scale: efficiency per count, and its verdict: linear, sublinear, flat with the shared bottleneck named, or no claim', () => {
  let s = scaling([pt(1, 'broke', 16), pt(2, 'broke', 32), pt(4, 'broke', 40, { bottleneck: { hint: 'not CPU in the target' } }), pt(8, 'broke', 40, { bottleneck: POOL })]);
  assert.equal(s.base_known, true);
  assert.deepEqual(s.points.slice(1).map((p) => [p.instances, p.efficiency, p.verdict]), [[2, 1, 'linear'], [4, 0.63, 'sublinear'], [8, 0.31, 'flat']]);
  assert.match(s.points[2].why_verdict, /a shared bottleneck no signal named \(not CPU in the target\): add monitor.signals/);
  assert.match(s.points[3].why_verdict, /40 users at 8 instance\(s\) against 40 at 4: no more than before; a shared bottleneck: waiting on db_pool: a connection pool was full/);
  assert.equal(s.summary, 'From 1 instance(s) at 16 users: 2 linear (1), 4 sublinear (0.63), 8 flat (0.31).');
  // Less than before is flat too (negative); an efficiency at 0.8 is linear.
  s = scaling([pt(1, 'broke', 10), pt(2, 'broke', 16), pt(3, 'broke', 8)]);
  assert.deepEqual(s.points.slice(1).map((p) => [p.efficiency, p.verdict]), [[0.8, 'linear'], [0.27, 'flat']]);
  assert.match(s.points[2].why_verdict, /less than before/);
  // A count whose steps all held: its capacity is a floor. Linear at least, or no claim.
  s = scaling([pt(1, 'broke', 16), pt(2, 'held', 32), pt(4, 'held', 32)]);
  assert.deepEqual(s.points.slice(1).map((p) => [p.verdict, p.capacity.at_least]), [['linear', true], ['unknown', true]]);
  assert.match(s.points[2].why_verdict, /capacity is at least that and the efficiency at least 0.5; add higher steps/);
  assert.match(s.summary, /2 linear \(at least 1\), 4 unknown \(at least 0.5\)/);
  // The generator saturating is the limit, never a sublinear target.
  s = scaling([pt(1, 'broke', 16), pt(4, 'generator', 32)]);
  assert.equal(s.points[1].verdict, 'generator');
  assert.match(s.points[1].why_verdict, /the load generator saturated: it, not the target, is the limit at 4 instance\(s\); the target held at least 32 users/);
  // No base capacity, no efficiency.
  s = scaling([pt(1, 'held', 64), pt(2, 'broke', 32)]);
  assert.deepEqual([s.base_known, s.points[1].verdict, s.points[1].efficiency], [false, 'unknown', undefined]);
  assert.match(s.summary, /^Scaling cannot be read: every step held at 1 instance\(s\), so its capacity is only "at least 64"/);
  assert.equal(scaling([pt(1, 'broke', null), pt(2, 'broke', 8)]).base_known, false, 'a base that broke at its first step has no capacity to divide by');
  s = scaling([{ instances: 1, why: 'the scale command failed' }, pt(2, 'unjudged', null)]);
  assert.match(s.summary, /the base count \(1\) was not measured: the scale command failed/);
  assert.equal(s.points[1].verdict, 'not_measured');
});

test('scale: a count read from its staircase; with a saturated generator, only the steps that ended before it', () => {
  const sl = { transactions: OPS.map((name) => ({ name, sla: { p95_ms: 400, error_rate: 0.02 } })) };
  const st = (index, users, p95, to_s) => ({ index, users, complete: true, to_s, total: { rps: users * 10 }, endpoints: Object.fromEntries(OPS.map((n) => [n, { p95_ms: p95, p99_ms: p95, error_rate: 0 }])) });
  const steps = [st(0, 16, 50, 4), st(1, 32, 60, 6), st(2, 64, 70, 8), st(3, 128, 80, 10)];
  let c = readCount({ run: { model: 'closed' }, run_state: 'done', steps, problems: [] }, sl);
  assert.deepEqual([c.reading.kind, c.held, c.rps], ['held', 128, 1280]);
  c = readCount({ run: { model: 'closed' }, run_state: 'not_evaluable', steps, problems: [{ kind: 'generator_saturated', t: 8.4 }] }, sl);
  assert.deepEqual([c.reading.kind, c.held, c.rps], ['generator', 64, 640]);
});

test('scale: ready means an answer below 500, waited for up to the timeout', T, async () => {
  let status = 503;
  const s = createServer((req, res) => { res.writeHead(status); res.end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/`;
  let r = await waitReady(url, 0.5, { intervalMs: 50 });
  assert.deepEqual([r.ready, r.last], [false, 'HTTP 503']);
  assert.ok(r.waited_s >= 0.5);
  setTimeout(() => { status = 401; }, 300);
  r = await waitReady(url, 5, { intervalMs: 50 });
  assert.deepEqual([r.ready, r.last], [true, 'HTTP 401'], 'any answer of the app counts, a 401 too');
  assert.ok(r.waited_s >= 0.2 && r.waited_s < 5);
  s.close();
  r = await waitReady(url, 0.3, { intervalMs: 50 });
  assert.equal(r.ready, false);
});

// A deployment behind mock/scale-lb.mjs: each instance serves 100 requests/s, and (shared) all of
// them share a database pool that serves 250. Steps of 4, 8, 16 and 32 users at 10 requests/s each
// against one instance: 16 holds, 32 breaks the 400 ms SLA. Each count n climbs n times those.
const STAIRS = { name: 'stress', steps: [4, 8, 16, 32], step_s: 2, warmup_s: 1, ramp_s: 1, rampdown_s: 0.5 };
async function balancer(extra = []) {
  const port = await freePort();
  const c = spawn(process.execPath, [join(ROOT, 'mock', 'scale-lb.mjs'), String(port), '--capacity', '100', '--start-ms', '3000', ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(c);
  await new Promise((resolve) => c.stdout.once('data', resolve));
  return port;
}
function scaleProject(root, port, engine = {}) {
  const url = `http://127.0.0.1:${port}`;
  project(root, {
    'slo.json': SLO,
    'env.json': { environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['smoke', 'load', 'stress'], owner: 'test', parity: 'laptop mock', third_party: [{ name: 'payments', stubbed: true }], monitor: { metrics: 'none', interval_s: 0.3, signals: [{ name: 'db_pool', kind: 'pool_used_pct', scrape: `${url}/metrics`, metric: 'db_pool_used_pct' }] } } } },
  });
  const s = spec({ target_url: url, profile: STAIRS });
  s.engine_options = { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true, capacity_url: `${url}/lb/capacity`, ...engine };
  writeFileSync(join(root, 'spec.json'), JSON.stringify(s));
  return `"${process.execPath}" "${join(ROOT, 'mock', 'scale-lb.mjs')}" scale {n} --port ${port}`;
}

test('scale: linear to 2 instances, flat at 4 against a shared database pool that its signal names', T, async () => {
  const root = tmp();
  const port = await balancer(['--shared', '250']);
  const command = scaleProject(root, port);
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ name: 'api', spec: 'spec.json', instances: [1, 2, 4], command, ready: { timeout_s: 30 } }));
  const r = perf(['scale', join(root, 'plan.json'), '--root', root, '--bootstrap'], 380000);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /scale 1 instance\(s\) \(4, 8, 16, 32\), ready in [\d.]+ s: broke, held 16/);
  assert.match(r.out, /scale 2 instance\(s\) \(8, 16, 32, 64\), ready in [\d.]+ s: broke, held 32/);
  assert.match(r.out, /scale 4 instance\(s\) \(16, 32, 64, 128\), ready in [\d.]+ s: broke, held 32/);
  const s = read(join(root, '.perf', 'demo', 'scale-api.json'));
  assert.deepEqual(s.points.map((p) => [p.instances, p.held, p.efficiency ?? null, p.verdict ?? 'base']), [[1, 16, null, 'base'], [2, 32, 1, 'linear'], [4, 32, 0.5, 'flat']]);
  assert.match(s.points[2].why_verdict, /a shared bottleneck: waiting on db_pool: a connection pool was full/);
  assert.equal(s.summary, 'From 1 instance(s) at 16 users: 2 linear (1), 4 flat (0.5).');
  // Each count waited for its new instances (3 s to start) before its run, and ran on them.
  for (const p of s.points) assert.ok(p.ready_s >= 2.5, `count ${p.instances} ready after ${p.ready_s} s`);
  assert.deepEqual(s.points.map((p) => p.scale.argv.slice(-3)), [['1', '--port', String(port)], ['2', '--port', String(port)], ['4', '--port', String(port)]]);
  const runs = listRuns(root, 'demo');
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((x) => result(x.dir).run.instances), [1, 2, 4]);
  assert.match(readFileSync(join(root, '.perf', 'demo', 'scale-api.md'), 'utf8'), /\| 4 \| 16, 32, 64, 128 \| `[^`]+` \| [\d.]+ s \| 32 users \| [\d.]+ \| 0.5 \| flat: 32 users at 4 instance\(s\) against 32 at 2/);
  // Two counts are two deployments: never compared as one experiment.
  const c = perf(['compare', '--root', root, '--slug', 'demo', '--run', runs[0].id, '--run', runs[1].id]);
  assert.match(c.out, /baseline ran on 1 instance\(s\), this run on 2/);
});

test('scale: a load generator that saturates at a high count is the limit, not the target', T, async () => {
  const root = tmp();
  const port = await balancer();
  // 2 % generator CPU per user on each of 2 workers: 128 users saturate it, 64 do not.
  const command = scaleProject(root, port, { cpu_pct_per_user: 2 });
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ name: 'gen', spec: 'spec.json', instances: [1, 4], command, ready: { timeout_s: 30 } }));
  const r = perf(['scale', join(root, 'plan.json'), '--root', root, '--bootstrap'], 380000);
  const s = read(join(root, '.perf', 'demo', 'scale-gen.json'));
  assert.deepEqual(s.points.map((p) => [p.instances, p.reading.kind, p.held]), [[1, 'broke', 16], [4, 'generator', 64]], r.out);
  assert.equal(s.points[1].verdict, 'generator');
  assert.match(r.out, /4: generator: the load generator saturated: it, not the target, is the limit at 4 instance\(s\); the target held at least 64 users/);
  assert.doesNotMatch(r.out, /sublinear|flat/);
});

test('scale: a failed scale command runs nothing; a probe off the target host and a spec with no staircase are refused', T, async () => {
  const root = tmp();
  const port = await freePort();
  scaleProject(root, port);
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ name: 'bad', spec: 'spec.json', instances: '1,2', command: `"${process.execPath}" -e "process.exit(3)"`, ready: { timeout_s: 1 } }));
  let r = perf(['scale', join(root, 'plan.json'), '--root', root]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /scale 1: the scale command failed \(exit 3\); not run/);
  assert.equal(listRuns(root, 'demo').length, 0);
  assert.match(read(join(root, '.perf', 'demo', 'scale-bad.json')).summary, /the base count \(1\) was not measured: the scale command failed/);
  // The same command from a run spec and flags; a readiness probe elsewhere is refused.
  r = perf(['scale', join(root, 'spec.json'), '--root', root, '--instances', '1,2', '--command', 'node x.mjs {n}', '--ready-url', 'http://10.0.0.9/health']);
  assert.equal(r.code, 2);
  assert.match(r.out, /ready.url: on the target's host \(127.0.0.1\)/);
  r = perf(['scale', join(root, 'spec.json'), '--root', root, '--instances', '1;id', '--command', 'node x.mjs {n}']);
  assert.equal(r.code, 2);
  assert.match(r.out, /instances: whole numbers/);
  const flat = spec({ target_url: `http://127.0.0.1:${port}` });
  writeFileSync(join(root, 'load.json'), JSON.stringify(flat));
  r = perf(['scale', join(root, 'load.json'), '--root', root, '--instances', '1,2', '--command', 'node x.mjs {n}']);
  assert.equal(r.code, 2);
  assert.match(r.out, /perf scale reads the capacity from a staircase/);
});
