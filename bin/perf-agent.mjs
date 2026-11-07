#!/usr/bin/env node
// perf-agent — one ai-perf worker on another machine (CONTRACTS §3b). Started by the ssh or k8s
// target, never by hand:
//   node bin/perf-agent.mjs --controller <url> --worker <index> [--token-stdin]
//   node bin/perf-agent.mjs --probe        prints { version, now, engines } for the doctor
// The token comes on stdin (ssh) or in AI_PERF_TOKEN (k8s, from a Secret), never on the command
// line. The worker index comes from --worker or JOB_COMPLETION_INDEX (a k8s Indexed Job).
//
// It fetches the run spec and the script, writes them into a local run folder, starts the engine's
// worker there exactly as the local target does, and mirrors files: control.json down every tick;
// status.json, histogram windows and sampled errors up whenever they change. When the controller
// cannot be reached, control.json stops changing, so the worker's own heartbeat check stops it.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ENGINES } from '../adapters/index.mjs';
import { readJson, writeJson } from '../controller/files.mjs';

const VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };

// --probe: say "ready" once started, then answer one line on stdin with the clock. The caller
// times only that exchange, so start-up time (seconds for ssh and Node) is not read as skew.
if (flag('probe')) {
  const engines = {};
  for (const [name, load] of Object.entries(ENGINES)) { try { engines[name] = (await load()).detect().ok; } catch { engines[name] = false; } }
  // With --controller: can this machine reach the controller there? Any HTTP answer (401) is yes.
  let reaches = null;
  if (typeof flag('controller') === 'string') { try { await fetch(`${flag('controller')}/v1/run`, { signal: AbortSignal.timeout(5000) }); reaches = true; } catch { reaches = false; } }
  process.stdout.write('ready\n');
  await new Promise((resolve) => { process.stdin.once('data', resolve); process.stdin.once('end', resolve); setTimeout(resolve, 10000); });
  process.stdout.write(`${JSON.stringify({ version: VERSION, now: Date.now(), host: hostname(), engines, reaches })}\n`);
  process.exit(0);
}

const controller = String(flag('controller') ?? process.env.AI_PERF_CONTROLLER ?? '');
const index = Number(flag('worker') ?? process.env.JOB_COMPLETION_INDEX);
let token = process.env.AI_PERF_TOKEN ?? '';
if (flag('token-stdin')) token = await new Promise((resolve) => { let s = ''; process.stdin.on('data', (d) => { s += d; if (s.includes('\n')) { process.stdin.pause(); resolve(s.split('\n')[0].trim()); } }); process.stdin.on('end', () => resolve(s.trim())); });
if (!controller || !Number.isInteger(index) || index < 0 || !token) {
  console.error('perf-agent: needs --controller <url>, a worker index (--worker or JOB_COMPLETION_INDEX) and a token (--token-stdin or AI_PERF_TOKEN)');
  process.exit(2);
}
const auth = { authorization: `Bearer ${token}` };
const id = `w${index}`;

// Clock: the controller stamps each answer; the midpoint of a GET (small both ways) is our best
// guess of when it was stamped. clock_skew_ms is this machine's clock minus the controller's, as
// the doctor reports it. The worker aligns its own clock from control.json anyway; this number is
// reported so a machine far off (NTP broken) is seen.
let skew = null;
async function call(method, path, body, raw = false) {
  const t0 = Date.now();
  const r = await fetch(`${controller}${path}`, { method, headers: { ...auth, ...(body ? { 'content-type': 'application/octet-stream' } : {}) }, body, signal: AbortSignal.timeout(10000) });
  const t1 = Date.now();
  const at = Number(r.headers.get('x-perf-time'));
  if (at && method === 'GET') { const s = (t0 + t1) / 2 - at; skew = skew === null ? Math.round(s) : Math.round(0.8 * skew + 0.2 * s); }
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
  return raw ? Buffer.from(await r.arrayBuffer()) : r.status === 204 ? null : r.json();
}

const spec = await call('GET', '/v1/run');
const runDir = mkdtempSync(join(tmpdir(), `ai-perf-agent-${id}-`));
process.on('exit', () => { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* a file still held */ } });
const out = join(runDir, 'raw', id);
mkdirSync(out, { recursive: true });
// The script travels with the run; a script that imports other files needs them beside it here.
if (spec.script_path) {
  const local = join(runDir, 'script', basename(spec.script_path.replace(/\\/g, '/')));
  mkdirSync(join(runDir, 'script'), { recursive: true });
  writeFileSync(local, await call('GET', '/v1/script', null, true));
  spec.script_path = local;
}
writeJson(join(runDir, 'run.json'), spec);
writeJson(join(runDir, 'control.json'), await call('GET', '/v1/control'));

// The engine's worker, started as the local target starts it.
const engine = await ENGINES[spec.engine]();
const pushStatus = async (status) => { await call('PUT', `/v1/workers/${id}/status.json`, JSON.stringify({ ...status, host: hostname(), clock_skew_ms: skew })); };
if (!engine.detect().ok) {
  await pushStatus({ worker: index, pid: null, state: 'stopped', reason: `spawn_failed: ${engine.name} is not installed on ${hostname()}`, ts: Date.now() - (skew ?? 0) });
  process.exit(1);
}
const { cmd, args: wargs, env } = engine.workerCommand({ runDir, index, count: spec.workers, options: spec.engine_options ?? {}, spec });
const child = spawn(cmd, wargs, { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
let exited = false;
child.on('exit', () => { exited = true; });
child.on('error', async (e) => { exited = true; await pushStatus({ worker: index, pid: null, state: 'stopped', reason: `spawn_failed: ${e.code ?? e.message}`, ts: Date.now() - (skew ?? 0) }).catch(() => {}); });

// Up: the status is read first, then every changed window and error file goes up, and only when
// all of them did does that status follow. So the controller never sees "stopped" before the
// windows it covers, even if the worker writes its last window between our reads.
const sent = new Map();
async function pushChanged() {
  const status = readJson(join(out, 'status.json'));
  let names = [];
  try { names = readdirSync(out); } catch { return null; }
  let complete = true;
  for (const name of names.filter((n) => /^(?:hist-\d+\.json|errors\.ndjson)$/.test(n))) {
    let st;
    try { st = statSync(join(out, name)); } catch { continue; }
    const key = `${st.mtimeMs}:${st.size}`;
    if (sent.get(name) === key) continue;
    try { await call('PUT', `/v1/workers/${id}/${name}`, readFileSync(join(out, name))); sent.set(name, key); } catch { complete = false; }
  }
  if (status && complete) await pushStatus(status).catch(() => { complete = false; });
  return complete ? status : null;
}

const tick = spec.timing?.tick_ms ?? 1000;
for (;;) {
  try { writeJson(join(runDir, 'control.json'), await call('GET', '/v1/control')); } catch { /* unreachable: control goes stale, the worker stops itself */ }
  const status = await pushChanged();
  // Stopped and everything sent: done. A worker that exited without a final status is left to
  // go stale at the controller (lost), after one last try to send what it wrote.
  if (status?.state === 'stopped') break;
  if (exited) { await new Promise((r) => setTimeout(r, 300)); await pushChanged(); break; }
  await new Promise((r) => setTimeout(r, tick));
}
process.exit(0);
