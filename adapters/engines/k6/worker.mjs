// One k6 worker: a Node sidecar that speaks the worker protocol (CONTRACTS §3) and runs k6 as its
// child. k6 starts paused before the barrier so its start-up never eats into the profile, is
// resumed at go_at through its REST API, and streams one JSON point per request on stdout; the
// sidecar puts each one in its perf-hist window by the request's own time.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { appendLine, readJson, sleep, writeJson } from '../../../controller/files.mjs';
import { create, record } from '../../../controller/hist.mjs';
import { bounds, windowIndex, windowOrigin } from '../../../controller/profile.mjs';
import { toContainerHost } from '../../targets/docker.mjs';
import { arrivalScenario, errorClass, openWrapper, runner, stages } from './adapter.mjs';
import { mask } from '../../../lib/mask.mjs';

const [runDir, indexArg] = process.argv.slice(2);
const index = Number(indexArg);
const spec = readJson(join(runDir, 'run.json'));
const T = spec.timing;
const opts = spec.engine_options ?? {};
const dir = join(runDir, 'raw', `w${index}`);
mkdirSync(dir, { recursive: true });
const SAMPLES_PER_CLASS = 20;

const status = {
  worker: index, pid: process.pid, state: 'starting', reason: null, ts: Date.now(), t: null,
  users: 0, requests: 0, failures: 0, cpu_pct: 0, error_classes: {}, stalls: [], child: null,
};
const windows = new Map();
const dirty = new Set();
const sampled = {};
let control = null;
let offset = -Infinity;
const hostNow = () => Date.now() + (Number.isFinite(offset) ? offset : 0);
const write = () => { status.ts = hostNow(); try { writeJson(join(dir, 'status.json'), status); } catch { /* next tick */ } };

function flush() {
  for (const k of dirty) {
    try { writeJson(join(dir, `hist-${k}.json`), windows.get(k)); dirty.delete(k); } catch { /* next tick */ }
  }
}

let k6 = null;
let container = null;
function killChild() {
  if (container) spawnSync('docker', ['rm', '-f', container], { timeout: 30000 });
  else if (k6 && k6.exitCode === null) { try { k6.kill(); } catch { /* gone */ } }
}

function stop(reason) {
  killChild();
  flush();
  status.state = 'stopped';
  status.reason = reason;
  write();
  process.exit(0);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Start k6 paused, with the run's profile as stages and the target and worker as env variables.
const run = runner();
if (!run) stop('spawn_failed: no k6 and no k6 image');
const port = await freePort();
const docker = run.mode === 'docker';
const target = docker ? toContainerHost(spec.target_url) : spec.target_url;
const env = { BASE_URL: target, TARGET_URL: target, AI_PERF_WORKER: String(index), AI_PERF_WORKERS: String(spec.workers), ...opts.env };
// Open model: k6 runs a wrapper module with an arrival-rate scenario; closed: the script itself,
// with the profile as --stage (VUs).
const open = Boolean(spec.profile.arrival_rps);
let scriptArg = docker ? `/perf/script/${basename(spec.script_path)}` : spec.script_path;
if (open) {
  const wrapper = join(dir, 'k6-open.js');
  const url = docker ? scriptArg : pathToFileURL(spec.script_path).href;
  writeFileSync(wrapper, openWrapper(url, readFileSync(spec.script_path, 'utf8'), arrivalScenario(spec.profile, index, spec.workers)));
  scriptArg = docker ? `/perf/run/raw/w${index}/k6-open.js` : wrapper;
}
const k6Args = [
  'run', '--paused', '--address', docker ? '0.0.0.0:6565' : `127.0.0.1:${port}`,
  '--quiet', '--no-summary', '--no-usage-report', '--out', 'json=-',
  ...(open ? [] : stages(spec.profile, index, spec.workers).flatMap((s) => ['--stage', s])),
  ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
];
if (docker) {
  container = `aiperf-k6-${spec.run_id}-w${index}`;
  k6 = spawn('docker', ['run', '--rm', '-i', '--name', container, '--add-host', 'host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${port}:6565`, '-v', `${dirname(spec.script_path)}:/perf/script:ro`, '-v', `${runDir}:/perf/run:ro`, run.image,
    ...k6Args, scriptArg], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  status.child = { container };
} else {
  k6 = spawn(run.bin, [...k6Args, scriptArg], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: dirname(spec.script_path) });
  status.child = { pid: k6.pid };
}
let stderr = '';
k6.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
let k6Exit = null;
k6.on('exit', (code) => { k6Exit = code ?? -1; });
k6.on('error', (e) => { k6Exit = -1; stderr += e.message; });

// One point per finished request: http_req_duration carries its name, status and outcome. The
// request's own time places it in its window, never the time the line arrived.
//
// k6 starts its stages only once resumed and after setup() has run: seconds after go_at, longer
// with a slow setup(). Its first default-scenario request marks where its profile really began,
// and every point is placed on that clock, so ramp load never lands in a steady window. The lag is
// reported (start_lag_s); the controller degrades the run when it was too long to absorb.
const origin = windowOrigin(spec.profile, T.window_s);
const SETUP = /^::(setup|teardown)$/;
let started = null;
const windowOf = (k) => {
  if (!windows.has(k)) windows.set(k, { schema: 'perf-hist-window/v1', worker: index, window: k, window_s: T.window_s, origin_s: origin, endpoints: {}, checks: { passed: 0, failed: 0 } });
  return windows.get(k);
};
// A request without a name is keyed by its URL: drop the query (ids, tokens) and mask the rest.
const keyOf = (tags) => mask(String(tags.name ?? tags.url ?? 'unnamed').split('?')[0]);
function onPoint(p) {
  if (p.type !== 'Point' || !control?.go_at) return;
  const tags = p.data.tags ?? {};
  if (p.metric === 'vus') { status.users = p.data.value; return; }
  if (p.metric === 'dropped_iterations') {
    status.dropped_iterations = (status.dropped_iterations ?? 0) + p.data.value;
    const tt = control?.go_at ? (Date.parse(p.data.time) + (Number.isFinite(offset) ? offset : 0) - Math.max(started ?? control.go_at, control.go_at)) / 1000 : -1;
    const b = bounds(spec.profile);
    if (tt >= b.steady.from && tt < b.steady.to) status.dropped_steady = (status.dropped_steady ?? 0) + p.data.value;
    return;
  }
  if (SETUP.test(tags.group ?? '')) return;
  // k6 stamps points with its own clock (the host's, or the container's, which Docker keeps in
  // step with it); the offset puts them on the controller's.
  const at = Date.parse(p.data.time) + (Number.isFinite(offset) ? offset : 0);
  if (started === null) {
    if (p.metric !== 'http_req_duration') return;
    // The point is stamped at the request's end; its start is the duration earlier.
    started = Math.min(at - p.data.value, Date.now() + (Number.isFinite(offset) ? offset : 0));
    status.start_lag_s = Math.round(Math.max(0, started - control.go_at) / 100) / 10;
  }
  const t = (at - Math.max(started, control.go_at)) / 1000;
  if (t < 0) return;
  if (p.metric === 'checks') {
    const w = windowOf(windowIndex(t, spec.profile, T.window_s));
    w.checks[p.data.value ? 'passed' : 'failed']++;
    dirty.add(w.window);
    if (!p.data.value) {
      const cls = `check failed: ${tags.check ?? 'unnamed'}`;
      status.error_classes[cls] = (status.error_classes[cls] ?? 0) + 1;
    }
    return;
  }
  if (p.metric !== 'http_req_duration') return;
  const k = windowIndex(t, spec.profile, T.window_s);
  windowOf(k);
  const name = keyOf(tags);
  const ep = (windows.get(k).endpoints[name] ??= { requests: 0, failures: 0, hist: create() });
  ep.requests++;
  record(ep.hist, p.data.value);
  status.requests++;
  if (tags.expected_response === 'false') {
    const cls = errorClass(tags);
    ep.failures++;
    status.failures++;
    status.error_classes[cls] = (status.error_classes[cls] ?? 0) + 1;
    sampled[cls] = (sampled[cls] ?? 0) + 1;
    if (sampled[cls] <= SAMPLES_PER_CLASS) {
      try { appendLine(join(dir, 'errors.ndjson'), { t: Math.round(t * 1000) / 1000, name, class: cls, error: mask(`${tags.method ?? ''} ${tags.url ?? name} -> ${tags.status ?? '0'} ${tags.error_code ? `error_code ${tags.error_code}` : ''}`.trim()), correlation_id: null }); } catch { /* sample lost, count kept */ }
    }
  }
  dirty.add(k);
}
createInterface({ input: k6.stdout }).on('line', (line) => {
  if (!line.startsWith('{')) return;
  try { onPoint(JSON.parse(line)); } catch { /* a partial line */ }
});

const api = (method, body) => fetch(`http://127.0.0.1:${port}/v1/status`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(2000),
});

// Generator CPU (PS-A5) is k6's own: its container's from `docker stats` (sampled in the
// background, as a fraction of the CPUs Docker has), or its process's from /proc on Linux. Only a
// k6 binary on another OS falls back to the host's CPU, which also counts every other program.
let k6Cpu = null;
let sampling = false;
const ncpu = docker ? Number(spawnSync('docker', ['info', '--format', '{{.NCPU}}'], { encoding: 'utf8', timeout: 30000 }).stdout) || 1 : 1;
function sampleK6Cpu() {
  if (sampling || !container) return;
  sampling = true;
  const c = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', container], { windowsHide: true });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', () => {
    const v = Number(out.trim().replace('%', ''));
    if (Number.isFinite(v) && out.trim()) k6Cpu = Math.round((v / ncpu) * 10) / 10;
    sampling = false;
  });
  c.on('error', () => { sampling = false; });
}
let procPrev = null;
function procCpu() {
  try {
    const f = readFileSync(`/proc/${k6.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(f[11]) + Number(f[12]);
    const at = Date.now();
    const r = procPrev ? ((ticks - procPrev.ticks) / 100) / ((at - procPrev.at) / 1000) * 100 : null;
    procPrev = { ticks, at };
    // /proc counts one core as 100 %; as a share of the machine, like docker stats / NCPU.
    return r === null ? null : Math.round((r / cpus().length) * 10) / 10;
  } catch { return null; }
}
function generatorCpu() {
  if (docker) { sampleK6Cpu(); return k6Cpu ?? 0; }
  if (process.platform === 'linux') return procCpu() ?? 0;
  return hostCpu();
}

let prev = cpus().map((c) => c.times);
function hostCpu() {
  const now = cpus().map((c) => c.times);
  let busy = 0;
  let all = 0;
  now.forEach((c, i) => {
    const p = prev[i];
    const total = Object.values(c).reduce((a, v) => a + v, 0) - Object.values(p).reduce((a, v) => a + v, 0);
    busy += total - (c.idle - p.idle);
    all += total;
  });
  prev = now;
  return all > 0 ? Math.round((busy / all) * 1000) / 10 : 0;
}

const hardEnd = Date.now() + T.barrier_timeout_s * 1000 + (bounds(spec.profile).end + 30) * 1000;
const STALL_S = Math.max(1, (5 * T.tick_ms) / 1000);
let resumed = false;
let last = hostNow();
for (;;) {
  const read = readJson(join(runDir, 'control.json'));
  if (read) { control = read; offset = Math.max(offset, read.heartbeat_at - Date.now()); }
  const now = hostNow();
  if (Date.now() > hardEnd) stop('hard_end');
  if (control && now - control.heartbeat_at > T.heartbeat_timeout_s * 1000) stop('heartbeat_lost');
  if (control?.stop) stop(control.stop_reason ?? 'stop');
  // k6 ends by itself after its last stage; then the sidecar keeps beating until the controller
  // says stop. Ending before the profile's end is a failure, reported as such.
  if (k6Exit !== null && !(control?.go_at && (now - control.go_at) / 1000 >= bounds(spec.profile).end - 1)) {
    stop(`engine_exited: k6 exit ${k6Exit}: ${stderr.trim().split('\n').pop() ?? ''}`.slice(0, 300));
  }
  if (status.state === 'starting') {
    try { if ((await api('GET')).ok) status.state = 'ready'; } catch { /* not up yet */ }
  }
  if (status.state !== 'starting' && control?.go_at && !resumed) {
    resumed = true;
    // Resume at go_at exactly, not at the next tick.
    setTimeout(() => api('PATCH', { data: { type: 'status', id: 'default', attributes: { paused: false } } }).catch(() => { stderr += 'resume failed'; }), Math.max(0, control.go_at - hostNow()));
  }
  if (resumed && now >= control.go_at) {
    if (status.state !== 'running') status.state = 'running';
    const t = (now - control.go_at) / 1000;
    if ((now - last) / 1000 > STALL_S && status.t !== null) status.stalls.push({ from: Math.round(status.t * 1000) / 1000, to: Math.round(t * 1000) / 1000 });
    status.t = t;
    status.cpu_pct = generatorCpu();
  }
  last = now;
  flush();
  write();
  await sleep(T.tick_ms);
}
