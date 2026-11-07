import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, create, merge, percentile, record, upperOf } from '../controller/hist.mjs';
import { create as createState, finalState, transition } from '../controller/state.mjs';
import { evaluate } from '../controller/rules.mjs';
import { normalize as _normalize } from '../controller/spec.mjs';
import { mergeWindows, readWindows, selectWindows } from '../controller/merge.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phaseAt, usersAt, windowIndex, windowOrigin } from '../controller/profile.mjs';
import { ROOT, norm, spec } from './helpers.mjs';

test('hist: a bucket is about 1 % wide and holds its value', () => {
  for (const ms of [0.15, 1, 7.3, 50, 999, 120000]) {
    const b = bucketOf(ms);
    assert.ok(upperOf(b) >= ms && upperOf(b - 1) < ms, `${ms} in bucket ${b}`);
    assert.ok(upperOf(b) / ms < 1.0101);
  }
});

test('hist: percentiles are within 1 % of the exact value', () => {
  const h = create();
  const xs = Array.from({ length: 10000 }, (_, i) => 1 + i * 0.37);
  for (const x of xs) record(h, x);
  for (const q of [0.5, 0.9, 0.95, 0.99]) {
    const exact = xs[Math.ceil(q * xs.length) - 1];
    assert.ok(Math.abs(percentile(h, q) - exact) / exact < 0.0101, `p${q * 100}`);
  }
  assert.equal(percentile(h, 1), Math.round(xs.at(-1) * 100) / 100);
  assert.equal(percentile(create(), 0.95), null);
});

test('hist: merging equals recording everything in one histogram', () => {
  const a = create();
  const b = create();
  const all = create();
  for (let i = 0; i < 500; i++) { record(a, 10 + i % 7); record(all, 10 + i % 7); }
  // Overlapping buckets too: a merge that overwrote instead of adding would only fail here.
  for (let i = 0; i < 50; i++) { record(b, 900 + i); record(all, 900 + i); record(b, 12); record(all, 12); }
  const m = merge(merge(create(), a), b);
  assert.deepEqual(m, all);
});

test('hist: merged p95 is not the average of per-worker p95s', () => {
  const fast = create();
  const slow = create();
  for (let i = 0; i < 1000; i++) record(fast, 10);
  for (let i = 0; i < 10; i++) record(slow, 1000);
  const merged = merge(merge(create(), fast), slow);
  const averaged = (percentile(fast, 0.95) + percentile(slow, 0.95)) / 2;
  assert.ok(percentile(merged, 0.95) < 11);
  assert.ok(averaged > 400, 'the wrong method would report about 505 ms');
});

test('state: only legal transitions', () => {
  const s = createState({});
  assert.throws(() => transition(s, 'done'), /illegal transition preparing -> done/);
  for (const to of ['warmup', 'ramp', 'steady', 'rampdown', 'collecting', 'done']) transition(s, to);
  assert.throws(() => transition(s, 'warmup'), /illegal/);
  assert.equal(s.history.length, 7);
});

test('state: final state precedence is aborted > not_evaluable > degraded > done', () => {
  assert.equal(finalState({ stopReason: 'manual', saturated: true, measured: true, lostWorkers: 1 }), 'aborted');
  assert.equal(finalState({ stopReason: null, saturated: true, measured: true, lostWorkers: 1 }), 'not_evaluable');
  assert.equal(finalState({ stopReason: null, saturated: false, measured: false, lostWorkers: 0 }), 'not_evaluable');
  assert.equal(finalState({ stopReason: null, saturated: false, measured: true, lostWorkers: 1 }), 'degraded');
  assert.equal(finalState({ stopReason: null, saturated: false, measured: true, lostWorkers: 0 }), 'done');
});

test('rules: error rate over the span fires above the limit, not below', () => {
  const rule = { metric: 'error_rate', above: 0.2, for_s: 1, min_requests: 10 };
  const ok = [{ t: 0.5, requests: 50, failures: 5, cpu_max: 0 }, { t: 1.0, requests: 50, failures: 5, cpu_max: 0 }];
  assert.equal(evaluate([rule], ok, 1.0), null);
  const bad = [{ t: 0.5, requests: 50, failures: 20, cpu_max: 0 }, { t: 1.0, requests: 50, failures: 20, cpu_max: 0 }];
  assert.equal(evaluate([rule], bad, 1.0).value, 0.4);
});

test('rules: too few requests never fire; nothing fires before for_s has passed', () => {
  const rule = { metric: 'error_rate', above: 0.2, for_s: 1, min_requests: 10 };
  assert.equal(evaluate([rule], [{ t: 1, requests: 4, failures: 4, cpu_max: 0 }], 1), null);
  assert.equal(evaluate([rule], [{ t: 0.5, requests: 100, failures: 100, cpu_max: 0 }], 0.5), null);
});

test('rules: CPU must stay above the limit for the whole span', () => {
  const rule = { metric: 'generator_cpu_pct', above: 90, for_s: 1 };
  const spike = [{ t: 0.5, requests: 1, failures: 0, cpu_max: 99 }, { t: 1, requests: 1, failures: 0, cpu_max: 50 }];
  assert.equal(evaluate([rule], spike, 1), null);
  const held = [{ t: 0.5, requests: 1, failures: 0, cpu_max: 99 }, { t: 1, requests: 1, failures: 0, cpu_max: 95 }];
  assert.equal(evaluate([rule], held, 1).value, 95);
});

test('rules: a target CPU span with a sampling gap is not judged on the samples it has', () => {
  const rule = { metric: 'target_cpu_pct', above: 90, for_s: 1 };
  const gap = [{ t: 0.5, requests: 1, failures: 0, cpu_max: 0, target_cpu: null }, { t: 1, requests: 1, failures: 0, cpu_max: 0, target_cpu: 97 }];
  assert.equal(evaluate([rule], gap, 1), null);
  const full = [{ t: 0.5, requests: 1, failures: 0, cpu_max: 0, target_cpu: 95 }, { t: 1, requests: 1, failures: 0, cpu_max: 0, target_cpu: 97 }];
  assert.equal(evaluate([rule], full, 1).value, 95);
});

test('spec: a valid spec has no errors', () => {
  const { errors, warnings } = norm(spec(), { platform: 'linux' });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('spec: a host outside allow_hosts is refused (PS-A1)', () => {
  const { errors } = norm(spec({ target_url: 'https://api.example.com' }));
  assert.ok(errors.some((e) => /not in allow_hosts/.test(e)));
});

test('spec: production is refused, by flag or by name', () => {
  assert.ok(norm(spec({ production: true })).errors.some((e) => /never loads production/.test(e)));
  assert.ok(norm(spec({ environment: 'Production-EU' })).errors.some((e) => /never loads production/.test(e)));
});

test('spec: unknown auto-stop metric and bad values are refused', () => {
  const { errors } = norm(spec({ auto_stop: [{ metric: 'p95', above: 'x', for_s: 0 }] }));
  assert.equal(errors.length, 3);
});

test('spec: "smoke" is a shape, not just a name: a large or long run cannot pass as one', () => {
  const smoke = (p) => norm(spec({ profile: { name: 'smoke', warmup_s: 0, ramp_s: 0, rampdown_s: 0, ...p } })).errors;
  assert.deepEqual(smoke({ users: 10, steady_s: 300 }), []);
  assert.ok(smoke({ users: 5000, steady_s: 60 }).some((e) => /a smoke is at most 10 users and 300 s/.test(e)));
  assert.ok(smoke({ users: 2, steady_s: 7200 }).some((e) => /a smoke is at most 10 users and 300 s/.test(e)));
});

test('spec: the docker target with short timeouts warns', () => {
  assert.ok(norm(spec({ target: 'docker' }), { platform: 'linux' }).warnings.some((w) => /docker target keep .* 10 s/.test(w)));
  const ok = spec({ target: 'docker', timing: { heartbeat_timeout_s: 10, worker_timeout_s: 10 } });
  assert.deepEqual(norm(ok, { platform: 'linux' }).warnings, []);
});

test('spec: localhost on Windows warns', () => {
  const s = spec({ target_url: 'http://localhost:8080', allow_hosts: ['localhost'] });
  assert.ok(norm(s, { platform: 'win32' }).warnings.some((w) => /127\.0\.0\.1/.test(w)));
  assert.deepEqual(norm(s, { platform: 'linux' }).warnings, []);
});

test('spec: numbers given as strings are refused, not concatenated', () => {
  const { errors } = norm(spec({ profile: { warmup_s: '5' }, timing: { worker_timeout_s: '10' } }));
  assert.ok(errors.includes('profile.warmup_s: a number >= 0'), errors.join('; '));
  assert.ok(errors.includes('timing.worker_timeout_s: a number > 0'));
  assert.ok(norm(spec({ profile: { users: '20' } })).errors.includes('profile.users: a number > 0'));
  assert.ok(norm(spec({ auto_stop: [{ metric: 'error_rate', above: 0.1, for_s: '5' }] })).errors.length);
});

test('spec: timings must agree with each other', () => {
  const errs = (timing) => norm(spec({ timing })).errors.join('; ');
  assert.match(errs({ heartbeat_timeout_s: 0.2 }), /heartbeat_timeout_s: must cover at least 3 ticks/);
  assert.match(errs({ worker_timeout_s: 0.2 }), /worker_timeout_s: must cover at least 3 ticks/);
  assert.match(errs({ window_s: 0.05 }), /window_s: must be at least one tick/);
  assert.match(errs({ window_s: 5 }), /steady_s: 2 s holds no whole 5 s window/);
});

test('spec: the allowlist lives in env.json; a spec that carries its own is refused', () => {
  const s = { ...spec(), allow_hosts: ['127.0.0.1'] };
  const { errors } = _normalize(s, { env: { environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['load'] } } } });
  assert.ok(errors.some((e) => /allow_hosts: moved to the environment file/.test(e)));
  assert.ok(_normalize(spec(), { env: null }).errors.some((e) => /no \.perf\/demo\/env\.json/.test(e)));
});

test('spec: a real engine needs its script, and the script must exist', () => {
  const env = { environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: ['load'] } } };
  assert.ok(_normalize(spec({ engine: 'locust' }), { env }).errors.some((e) => /script: the locust script to run is required/.test(e)));
  assert.ok(_normalize(spec({ engine: 'locust', script: 'nope.py' }), { env, root: ROOT }).errors.some((e) => /script: nope\.py not found/.test(e)));
});

test('spec: a credential in target_url is refused', () => {
  for (const url of ['http://admin:pw@127.0.0.1:8080', 'http://127.0.0.1:8080/?access_token=abcdef123']) {
    assert.ok(norm(spec({ target_url: url })).errors.some((e) => /carries a credential/.test(e)), url);
  }
});

test('spec: a production-looking host is refused even when allowlisted and labelled staging', () => {
  const s = spec({ target_url: 'https://api.prod.example.com', allow_hosts: ['api.prod.example.com'], environment: 'staging' });
  assert.ok(norm(s).errors.some((e) => /looks like production/.test(e)));
  const ok = spec({ target_url: 'https://product.example.com', allow_hosts: ['product.example.com'], environment: 'staging' });
  // A host that is not this machine needs the owner's recorded approval for it.
  const approval = { by: 'owner', at: new Date().toISOString(), hosts: ['product.example.com'] };
  assert.deepEqual(norm(ok, { platform: 'linux', envExtra: { approval } }).errors, []);
});

test('spec: every production-like name is refused, "product" is not', () => {
  for (const env of ['prod', 'Prod EU', 'prod1', 'prodeu', 'production', 'production2', 'prd', 'PRD-eu']) {
    assert.ok(norm(spec({ environment: env })).errors.some((e) => /never loads production/.test(e)), env);
  }
  for (const env of ['product', 'products-staging', 'staging', 'local', 'dev']) {
    assert.deepEqual(norm(spec({ environment: env }), { platform: 'linux' }).errors, [], env);
  }
  for (const host of ['prodapi.example.com', 'api.prd.example.com', 'eu-prod1.example.com']) {
    const s = spec({ target_url: `https://${host}`, allow_hosts: [host] });
    assert.ok(norm(s).errors.some((e) => /looks like production/.test(e)), host);
  }
});

test('merge: reading windows reports progress so the controller can keep beating', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-perf-'));
  mkdirSync(join(root, 'raw', 'w0'), { recursive: true });
  for (let k = 0; k < 120; k++) writeFileSync(join(root, 'raw', 'w0', `hist-${k}.json`), JSON.stringify({ window: k, endpoints: {} }));
  const calls = [];
  assert.equal(readWindows(root, (n) => calls.push(n)).length, 120);
  assert.deepEqual(calls, [50, 100]);
});

test('profile: windows start exactly where steady starts', () => {
  const p = { users: 1, warmup_s: 0.3, ramp_s: 0.4, steady_s: 2 };
  assert.ok(Math.abs(windowOrigin(p, 0.5) - -0.3) < 1e-9);
  assert.equal(windowIndex(0, p, 0.5), 0);
  assert.equal(windowIndex(0.7, p, 0.5), 2);
  assert.equal(windowIndex(0.69, p, 0.5), 1);
  const ws = [1, 2, 3, 4, 5, 6].map((window) => ({ window, origin_s: -0.3, endpoints: {} }));
  assert.deepEqual(selectWindows(ws, 0.5, 0.7, 2.7).map((w) => w.window), [2, 3, 4, 5]);
});

test('profile: phases and users follow the shape', () => {
  const p = spec().profile;
  assert.equal(phaseAt(0.2, p), 'warmup');
  assert.equal(phaseAt(0.7, p), 'ramp');
  assert.equal(phaseAt(1.5, p), 'steady');
  assert.equal(phaseAt(3.2, p), 'rampdown');
  assert.equal(phaseAt(3.6, p), 'end');
  assert.equal(usersAt(0.2, p), 2);
  assert.equal(usersAt(2, p), 20);
  assert.equal(phaseAt(0, { users: 1, steady_s: 1 }), 'steady');
});

test('merge: only whole windows inside the steady span are selected', () => {
  const ws = [0, 1, 2, 3, 4, 5, 6].map((window) => ({ window, endpoints: {} }));
  assert.deepEqual(selectWindows(ws, 0.5, 1.0, 3.0).map((w) => w.window), [2, 3, 4, 5]);
  assert.deepEqual(selectWindows(ws, 0.5, 1.2, 3.0).map((w) => w.window), [3, 4, 5]);
});

test('merge: rps is requests over the selected duration', () => {
  const h = record(create(), 10, 100);
  const w = (window) => ({ window, endpoints: { a: { requests: 100, failures: 5, hist: h } } });
  const m = mergeWindows([w(0), w(1)], 0.5);
  assert.equal(m.total.requests, 200);
  assert.equal(m.total.rps, 200);
  assert.equal(m.total.error_rate, 0.05);
  assert.equal(m.hist.endpoints.a.count, 200, 'endpoint histograms merge across windows too');
  assert.equal(m.hist.total.count, 200);
  assert.equal(mergeWindows([w(0), w(1)], 0.5, 4).total.rps, 50, 'an explicit duration wins');
});
