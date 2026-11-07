import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { normalize } from '../controller/spec.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, sleep } from '../controller/files.mjs';
import { listRuns } from '../lib/runs.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PERF = join(ROOT, 'bin', 'perf.mjs');

// Test roots are removed when the test file's process exits; PERF_KEEP_TMP=1 keeps them to debug.
const made = [];
export const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ai-perf-')); made.push(d); return d; };
// Cross-project lessons and scorecards live under PERF_HOME: a test never writes the user's.
process.env.PERF_HOME = tmp();
process.on('exit', () => {
  if (process.env.PERF_KEEP_TMP) return;
  for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a run may still hold a file */ } }
});

// Short timings so a full run takes about 4 s; the logic is the same at production timings.
// Timeouts stay at 3 s: under a parallel test run Windows can take over a second to spawn a
// process, and a 1 s timeout then reads a busy controller as a dead one.
export const HB_S = 3;
export function spec(over = {}) {
  const base = {
    slug: 'demo', workers: 2, target_url: 'http://127.0.0.1:8080',
    profile: { name: 'load', users: 20, warmup_s: 0.5, ramp_s: 0.5, steady_s: 2, rampdown_s: 0.5 },
    timing: { tick_ms: 100, window_s: 0.5, heartbeat_timeout_s: HB_S, worker_timeout_s: HB_S, barrier_timeout_s: 5 },
    // ideal: controller logic must not depend on how busy the test machine is; stall and docker
    // tests turn it off to see real starvation.
    engine_options: { rps_per_user: 10, ideal: true },
  };
  return {
    ...base, ...over,
    profile: { ...base.profile, ...over.profile },
    timing: { ...base.timing, ...over.timing },
    engine_options: { ...base.engine_options, ...over.engine_options },
  };
}

export const PROFILES = ['smoke', 'baseline', 'load', 'stress', 'spike', 'soak', 'capacity', 'recovery', 'volume'];

// The project environment file (CONTRACTS §1a). Tests describe the hosts a spec may load with
// `allow_hosts` on the spec for brevity; these helpers move it into env.json where it belongs.
export function env(hosts = ['127.0.0.1'], name = 'local', extra = {}) {
  return { environments: { [name]: { allow_hosts: hosts, allowed_profiles: PROFILES, production: false, owner: 'test', ...extra } } };
}

export function norm(s, { platform, envExtra } = {}) {
  const { allow_hosts: hosts, ...rest } = s;
  return normalize(rest, { platform, env: env(hosts ?? ['127.0.0.1'], rest.environment ?? 'local', envExtra) });
}

export function writeSpec(root, s, envExtra) {
  const { allow_hosts: hosts, ...rest } = s;
  mkdirSync(join(root, '.perf', rest.slug), { recursive: true });
  writeFileSync(join(root, '.perf', rest.slug, 'env.json'), JSON.stringify(env(hosts ?? ['127.0.0.1'], rest.environment ?? 'local', envExtra), null, 2));
  const p = join(root, 'spec.json');
  writeFileSync(p, JSON.stringify(rest, null, 2));
  return p;
}

export function perf(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [PERF, ...args], { encoding: 'utf8', timeout });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Async variant, so a test can act on a run while `perf run --wait` is still blocking.
export function perfAsync(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [PERF, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

export function runDir(root, slug = 'demo') {
  const runs = listRuns(root, slug);
  return runs[runs.length - 1]?.dir;
}

export const state = (dir) => readJson(join(dir, 'state.json'));
export const result = (dir) => readJson(join(dir, 'result.json'));
export const events = (dir) => {
  try { return readFileSync(join(dir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

export async function waitFor(fn, ms, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
}

// Just enough JSON Schema for perf-result/v1: type, required, properties, enum, const, ranges, $ref.
export function validate(schema, value, root = schema, path = '$') {
  const errs = [];
  if (schema.$ref) return validate(root.$defs[schema.$ref.split('/').pop()], value, root, path);
  const types = [].concat(schema.type ?? []);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types.length && !types.some((t) => t === typeOf(value) || (t === 'number' && typeOf(value) === 'integer'))) {
    return [`${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && value !== schema.const) errs.push(`${path}: must be ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: < minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: > maximum`);
  }
  if (typeof value === 'string' && schema.minLength && value.length < schema.minLength) errs.push(`${path}: too short`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...validate(s, value[k], root, `${path}.${k}`));
    if (typeof schema.additionalProperties === 'object') {
      for (const [k, v] of Object.entries(value)) if (!(k in (schema.properties ?? {}))) errs.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  return errs;
}
