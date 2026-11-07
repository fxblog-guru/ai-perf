import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../adapters/metrics/docker-stats.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { fromContract, readContract } from '../lib/contract.mjs';
import { discover } from '../lib/discover.mjs';
import { audit } from '../lib/audit.mjs';
import { importSuites } from '../lib/importer.mjs';
import { perf, tmp } from './helpers.mjs';
import { project, runFake } from './project.mjs';

// What dogfooding fx-blog (M6) taught: a project's contract already holds its budgets and traffic,
// its own load scripts must be seen, and a database on one core of sixteen is not saturated.

const CONTRACT = `openapi: 3.1.0
info:
  title: shop
  x-traffic-classes:
    read:
      rps: 5
      peak_factor: 4
      concurrency: 10
      rate_limit: "none: public pages"
    write:
      rps: 0.5
      peak_factor: 2
      concurrency: 2
paths:
  /api/items:
    get:
      operationId: listItems
      x-traffic: read
      x-perf: { p95_ms: 300, max_queries: 3 }
    post:
      operationId: createItem
      x-traffic: write
      x-perf: { p95_ms: 800 }
  /api/items/{id}:
    get:
      operationId: getItem
      x-traffic: read
      x-perf: { p95_ms: 250, max_payload_kb: 64 }
  /health:
    get:
      operationId: health
`;

function repo(contract = CONTRACT) {
  const root = tmp();
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', 'openapi.yaml'), contract);
  return root;
}

test('contract: operations, methods, traffic classes and x-perf budgets are read from YAML without a parser', () => {
  const c = readContract(join(repo(), 'api', 'openapi.yaml'));
  assert.deepEqual(c.classes.read, { rps: 5, peak_factor: 4, concurrency: 10, rate_limit: 'none: public pages' });
  assert.deepEqual(c.operations.map((o) => [o.method, o.path, o.id, o.traffic, o.perf?.p95_ms ?? null]), [
    ['GET', '/api/items', 'listItems', 'read', 300], ['POST', '/api/items', 'createItem', 'write', 800],
    ['GET', '/api/items/{id}', 'getItem', 'read', 250], ['GET', '/health', 'health', null, null]]);
});

test('perf contract: SLA = the budget, SLO 20 % stricter, a closed workload at the class concurrency; both gates pass', () => {
  const root = repo();
  discover(root, 'demo');
  const c = fromContract(root, 'demo');
  assert.deepEqual(c.wrote, ['slo.json', 'workload.json']);
  assert.deepEqual(c.operations.map((o) => o.id), ['listItems', 'getItem'], 'GETs of the classes, not the POST');
  const slo = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'slo.json'), 'utf8'));
  assert.deepEqual(slo.transactions.map((t) => [t.name, t.sla.p95_ms, t.slo.p95_ms, t.source, t.error_rate_source]), [['listItems', 300, 240, 'contract', 'default'], ['getItem', 250, 200, 'contract', 'default']]);
  const wl = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'workload.json'), 'utf8'));
  // At the 275 ms median budget, 10 clients with no think time drive 36 rps; the contract's peak is 20.
  assert.deepEqual([wl.model, wl.target.users, wl.littles_law.rps, wl.littles_law.peak_rps], ['closed', 10, 36.36, 20]);
  assert.ok(CHECKS.plan(root, 'demo').ok, JSON.stringify(CHECKS.plan(root, 'demo').errors));
  assert.ok(CHECKS.model(root, 'demo').ok, JSON.stringify(CHECKS.model(root, 'demo').errors));
  assert.deepEqual(fromContract(root, 'demo').wrote, [], 'files the project has are kept');
});

test('discover: the contract says how the system is used, so the system kind is not asked', () => {
  const read = repo();
  const d = discover(read, 'demo');
  assert.ok(!d.questions.some((q) => q.key === 'system_kind'));
  assert.equal(JSON.parse(readFileSync(join(read, '.perf', 'demo', 'assumptions.json'), 'utf8')).find((a) => a.key === 'system_kind').source, 'contract');
  assert.equal(d.system_kind, 'read-heavy');
  // Writes carrying most of the rate: a transactional system.
  const write = repo(CONTRACT.replace('rps: 0.5\n      peak_factor: 2', 'rps: 50\n      peak_factor: 2'));
  assert.equal(discover(write, 'demo').system_kind, 'transactional');
});

test('discover: an in-house load script is found; import lists it with what to do; the audit skips it', async () => {
  const root = tmp();
  mkdirSync(join(root, 'tests', 'perf'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'tests', 'perf', 'load.mjs'), "for (let i = 0; i < 10; i++) await fetch('http://127.0.0.1:3000/');\n");
  writeFileSync(join(root, 'scripts', 'perf-check.mjs'), "import http from 'node:http';\nconst concurrency = 10;\nhttp.request('http://x');\n");
  writeFileSync(join(root, 'tests', 'unit.test.mjs'), "await fetch('http://x');\n");
  writeFileSync(join(root, 'scripts', 'build.mjs'), "await fetch('http://x');\n");
  const d = discover(root, 'demo');
  assert.deepEqual(d.facts.existing_suites, [{ tool: 'in-house', path: 'scripts/perf-check.mjs' }, { tool: 'in-house', path: 'tests/perf/load.mjs' }]);
  const imp = await importSuites(root, 'demo');
  assert.ok(imp.suites.every((s) => !s.runnable && /in-house load script/.test(s.reason)));
  assert.ok(CHECKS.import(root, 'demo').ok, 'listed with its reason, the import gate passes');
  assert.deepEqual(audit(root, 'demo').suites, []);
});

test('docker-stats: CPU is the share of the CPUs a container may use, not of one core', () => {
  const line = JSON.stringify({ Name: 'db', CPUPerc: '118.67%', MemPerc: '1%', MemUsage: '100MiB / 8GiB' });
  const [cpu] = parse(`${line}\n`, 0, () => 16);
  assert.equal(cpu.value, 7.42);
  assert.equal(cpu.labels.cpus, 16);
  assert.equal(parse(`${line}\n`, 0, () => 2)[0].value, 59.34, 'a 2-CPU limit');
});

test('verdict: error-rate limits that are defaults beside contract budgets are named', () => {
  const root = tmp();
  project(root, { 'slo.json': { profiles: ['smoke', 'load'], transactions: ['listItems', 'getItem', 'createOrder'].map((name) => ({ name, source: 'contract', error_rate_source: 'default', slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 } })) } });
  runFake(root);
  const v = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.match(v.out, /error-rate limits are defaults, not from the contract: listItems, getItem, createOrder/);
});

// ---- from the independent review of M6 ----------------------------------------------------

const LAYOUTS = `openapi: 3.1.0
info:
  title: shop # the shop
  x-traffic-classes:
    read: { rps: 50, peak_factor: 2, concurrency: 10 }
    write:
      rps: 5 # per second
      peak_factor: 2
paths:
    "/api/users/{id}":
        get:
            operationId: getUser
            x-traffic: read
            x-perf:
                p95_ms: 200
                max_queries: 2
            responses:
                '200':
                    links:
                        posts:
                            operationId: listPostsByUser
            callbacks:
                onChange:
                    '{$request.body#/url}':
                        post:
                            operationId: notifyChange
                            x-perf: { p95_ms: 5000 }
        post:
            operationId: updateUser
            x-traffic: write
            x-perf: { p95_ms: 400 } # writes are slower
webhooks:
  newPost:
    post:
      operationId: newPostHook
      x-perf: { p95_ms: 9000 }
`;

test('contract: only operations under paths, only their own keys; block x-perf, flow classes, comments, quoted paths', () => {
  const root = repo(LAYOUTS);
  const c = readContract(join(root, 'api', 'openapi.yaml'));
  assert.deepEqual(c.operations.map((o) => [o.method, o.path, o.id, o.traffic, o.perf]), [
    ['GET', '/api/users/{id}', 'getUser', 'read', { p95_ms: 200, max_queries: 2 }],
    ['POST', '/api/users/{id}', 'updateUser', 'write', { p95_ms: 400 }]]);
  assert.deepEqual(c.classes, { read: { rps: 50, peak_factor: 2, concurrency: 10 }, write: { rps: 5, peak_factor: 2 } });
});

test('contract: what cannot be placed exactly is refused, never guessed', () => {
  const twoIds = repo(CONTRACT.replace('operationId: listItems', 'operationId: listItems\n      operationId: listAll'));
  discover(twoIds, 'demo');
  assert.match(fromContract(twoIds, 'demo').refused, /GET \/api\/items has two operationIds/);
  const stray = repo(CONTRACT.replace('      x-perf: { p95_ms: 300, max_queries: 3 }', '      x-perf: { p95_ms: 300, max_queries: 3 }\n      responses:\n        default:\n          x-perf: { p95_ms: 1 }'));
  discover(stray, 'demo');
  assert.match(fromContract(stray, 'demo').refused, /x-perf lines under paths, but only \d+ sit where an operation's own keys are/);
  const units = repo(CONTRACT.replace('x-perf: { p95_ms: 300, max_queries: 3 }', 'x-perf: { p95_ms: 300ms }'));
  discover(units, 'demo');
  assert.match(fromContract(units, 'demo').refused, /x-perf.p95_ms is not a number of milliseconds for listItems \("300ms"\)/);
});

test('discover: writes without an operationId still count when reading the system kind', () => {
  const root = repo(`openapi: 3.1.0
info:
  x-traffic-classes:
    checkout: { rps: 200, peak_factor: 1, concurrency: 50 }
    browse: { rps: 10, peak_factor: 1, concurrency: 5 }
paths:
  /orders:
    get:
      operationId: listOrders
      x-traffic: checkout
    post:
      x-traffic: checkout
  /items:
    get:
      operationId: listItems
      x-traffic: browse
`);
  assert.equal(discover(root, 'demo').system_kind, 'transactional');
});

test('discover: a DataLoader, a loadConfig or a micro-benchmark is not a load suite; a looping perf script is', () => {
  const root = tmp();
  const put = (p, s) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s); };
  put('src/loaders/userLoader.ts', "export const load = (ids) => Promise.all(ids.map((id) => fetch('/u/' + id)));\n");
  put('src/loadConfig.js', "for (const k of keys) await fetch('/cfg/' + k);\n");
  put('scripts/bench-parse.mjs', "for (let i = 0; i < 1e6; i++) parse(await fetch('x'));\n");
  put('perf/read-only.mjs', "export const url = await fetch('http://x');\n");
  put('perf/load.mjs', "for (let i = 0; i < users; i++) workers.push(fetch('http://x'));\n");
  put('load-tests/run.py', "import requests\nwhile True:\n    requests.get('http://x')\n");
  assert.deepEqual(discover(root, 'demo').facts.existing_suites.map((s) => s.path).sort(), ['load-tests/run.py', 'perf/load.mjs']);
});

test('perf contract: an overdriving closed loop is warned; a rate-only class gets the clients and think time its peak needs', () => {
  const root = repo(`openapi: 3.1.0
info:
  x-traffic-classes:
    crowd: { rps: 10, peak_factor: 1, concurrency: 100 }
    feed: { rps: 20, peak_factor: 2 }
paths:
  /a:
    get:
      operationId: getA
      x-traffic: crowd
      x-perf: { p95_ms: 200 }
  /b:
    get:
      operationId: getB
      x-traffic: feed
      x-perf: { p95_ms: 100 }
`);
  discover(root, 'demo');
  const c = fromContract(root, 'demo');
  assert.match(c.warnings.join('\n'), /class crowd: 100 clients with no think time drive about 500 rps at its 200 ms budget, 50× its peak of 10/);
  const wl = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'workload.json'), 'utf8'));
  const feed = wl.journeys.find((j) => j.name === 'feed');
  // 40 rps peak at 0.1 s: Little's law asks for 4 clients, and no think time holds them to 40 rps.
  assert.deepEqual([wl.personas.find((p) => p.name === 'feed') && wl.target.users, feed.think_time_s], [104, 0]);
  assert.ok(CHECKS.model(root, 'demo').ok, JSON.stringify(CHECKS.model(root, 'demo').errors));
});

test('docker-stats: CPUs from a quota or a cpuset as well as --cpus; cores busy kept beside the share', async () => {
  const { cpusOfInspect, cpusetSize } = await import('../adapters/metrics/docker-stats.mjs');
  assert.equal(cpusOfInspect('2000000000|0|0|', 16), 2);
  assert.equal(cpusOfInspect('0|150000|100000|', 16), 1.5);
  assert.equal(cpusOfInspect('0|0|0|0-3,8', 16), 5);
  assert.equal(cpusOfInspect('0|0|0|', 16), 16);
  assert.equal(cpusetSize('0-1,4-5,7'), 5);
  const line = JSON.stringify({ Name: 'redis', CPUPerc: '99.5%', MemPerc: '1%', MemUsage: '10MiB / 8GiB' });
  const out = parse(`${line}\n`, 0, () => 16);
  assert.deepEqual(out.filter((s) => s.name.startsWith('target_cpu')).map((s) => [s.name, s.value]), [['target_cpu_pct', 6.22], ['target_cpu_cores', 0.995]]);
});
