import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENGINES, METRICS, OPEN_MODEL, REMOTE, TARGETS } from '../adapters/index.mjs';
import { readJson } from './files.mjs';
import { checkRule } from './rules.mjs';
import { bounds, spikeBounds } from './profile.mjs';
import { checkSignals } from '../adapters/metrics/signals.mjs';

export const DEFAULT_TIMING = {
  tick_ms: 1000,
  window_s: 10,
  heartbeat_timeout_s: 10,
  worker_timeout_s: 10,
  barrier_timeout_s: 60,
  saturation_pct: 80,
  // A worker whose event loop runs this late timestamps what it receives late: it measures itself.
  loop_lag_ms: 100,
};

// Anything that starts like production is refused (prod1, prodeu, production2, prd), except the
// word "product…". Refusing a harmless "prodigy" is the cheap mistake; loading production is not.
const PROD = /^(prod(?!uct(?!ion))|prd)/i;
const PROD_HOST = /(^|[.-])(prod(?!uct(?!ion))|prd)[a-z0-9]*([.-]|$)/i;
// Smoke proves wiring and skips the SLO and baseline checks (PS-C3), and an environment may allow
// only smoke; so "smoke" is a shape, not just a name, or any load could pass as one.
export const SMOKE_MAX = { users: 10, duration_s: 300 };
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const envPath = (root, slug) => join(root, '.perf', slug, 'env.json');
export const loadEnv = (root, slug) => (slug ? readJson(envPath(root, slug)) : null);

// The environment file is the project's, written by /perf-env: who may be loaded, with which
// profiles, what is stubbed, what is monitored. A run spec only names an environment from it.
// Loading a system is the owner's decision (P4). Loopback is the user's own machine; any other host
// needs a recorded approval: who, when (at most APPROVAL_DAYS ago), and for which hosts.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const APPROVAL_DAYS = 90;
function checkApproval(name, e, host, errors, now = Date.now()) {
  if (!e.owner) errors.push(`environment "${name}": owner (who authorises load on it) required in env.json`);
  if (!host || LOOPBACK.has(host)) return;
  const a = e.approval;
  const at = Date.parse(a?.at ?? '');
  if (!a?.by || !Number.isFinite(at)) { errors.push(`environment "${name}": loading ${host} needs approval { by, at, hosts } in env.json: who allowed it and when`); return; }
  if (at > now + 86400000) errors.push(`environment "${name}": approval.at ${a.at} is in the future`);
  else if (now - at > APPROVAL_DAYS * 86400000) errors.push(`environment "${name}": approval by ${a.by} on ${a.at} is older than ${APPROVAL_DAYS} days; ask again`);
  if (!Array.isArray(a.hosts)) errors.push(`environment "${name}": approval.hosts must be a list of hosts`);
  else if (!a.hosts.includes(host)) errors.push(`environment "${name}": approval by ${a.by} does not cover host ${host} (it covers: ${(a.hosts ?? []).join(', ') || 'none'})`);
}

function checkEnvironment(spec, env, host, errors) {
  if (spec.allow_hosts) errors.push('allow_hosts: moved to the environment file (.perf/<slug>/env.json); the run spec no longer decides it');
  const e = env?.environments?.[spec.environment];
  if (!env) { errors.push(`environment: no .perf/${spec.slug}/env.json; /perf-env writes it`); return null; }
  if (!e) { errors.push(`environment: "${spec.environment}" is not in env.json (known: ${Object.keys(env.environments ?? {}).join(', ')})`); return null; }
  if (e.production === true) errors.push(`environment: "${spec.environment}" is marked production; ai-perf never loads production`);
  checkApproval(spec.environment, e, host, errors);
  if (host && !(e.allow_hosts ?? []).includes(host)) errors.push(`target_url: host "${host}" is not in allow_hosts of environment "${spec.environment}"`);
  if (spec.profile?.name && !(e.allowed_profiles ?? []).includes(spec.profile.name)) {
    errors.push(`profile.name: "${spec.profile.name}" is not allowed on "${spec.environment}" (allowed: ${(e.allowed_profiles ?? []).join(', ') || 'none'}) (PS-A2)`);
  }
  for (const tp of e.third_party ?? []) {
    if (tp.stubbed !== true) errors.push(`third party "${tp.name}" is not stubbed on "${spec.environment}"; loading it costs money or breaks its terms`);
  }
  return e;
}

// One validation for `perf run` and `/perf-doctor`, so the gate and the health check cannot disagree.
export function normalize(raw, { platform = process.platform, root = process.cwd(), env } = {}) {
  const errors = [];
  const warnings = [];
  const spec = structuredClone(raw ?? {});
  spec.engine ??= 'fake';
  spec.target ??= 'local';
  spec.workers ??= 1;
  spec.environment ??= 'local';
  // No rule given: the run still stops when most requests fail (P4). Explicit rules replace it.
  if (!spec.auto_stop?.length) { spec.auto_stop = [{ metric: 'error_rate', above: 0.5, for_s: 30, min_requests: 50 }]; spec.auto_stop_default = true; }
  spec.timing = { ...DEFAULT_TIMING, ...spec.timing };

  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.slug ?? '')) errors.push('slug: lower-case letters, digits and dashes');
  if (!ENGINES[spec.engine]) errors.push(`engine: unknown "${spec.engine}" (known: ${Object.keys(ENGINES).join(', ')})`);
  if (!TARGETS[spec.target]) errors.push(`target: unknown "${spec.target}" (known: ${Object.keys(TARGETS).join(', ')})`);
  if (!Number.isInteger(spec.workers) || spec.workers < 1) errors.push('workers: an integer >= 1');

  // Numbers must be numbers: "5" would pass ">= 0" and then concatenate durations into days.
  const p = spec.profile;
  let shapeOk = Boolean(p);
  if (!p?.name) errors.push('profile.name: required');
  // A closed stepped profile takes its users from its top step.
  const usersFromSteps = Array.isArray(p?.steps) && p.arrival_rps === undefined && p.model !== 'open';
  if (!usersFromSteps && !(isNum(p?.users) && p.users > 0)) { errors.push('profile.users: a number > 0'); shapeOk = false; }
  // Open model: arrivals per second, with `users` as the cap on concurrent virtual users.
  for (const k of ['arrival_rps', 'warmup_rps']) {
    if (p?.[k] !== undefined && !(isNum(p[k]) && p[k] > 0)) { errors.push(`profile.${k}: a number > 0`); shapeOk = false; }
  }
  // Steps (stress, capacity): an ascending staircase held step_s each; steady is their sum, and the
  // top step is the profile's users (closed) or arrival rate (open).
  if (p?.steps !== undefined) {
    if (!Array.isArray(p.steps) || p.steps.length < 2 || !p.steps.every((x) => isNum(x) && x > 0)) { errors.push('profile.steps: at least two numbers > 0'); shapeOk = false; }
    else if (p.steps.some((x, i) => i && x <= p.steps[i - 1])) { errors.push('profile.steps: ascending, each step above the one before'); shapeOk = false; }
    else if (!(isNum(p.step_s) && p.step_s > 0)) { errors.push('profile.step_s: the seconds each step is held, > 0'); shapeOk = false; }
    else {
      p.steady_s = p.steps.length * p.step_s;
      if (p.arrival_rps !== undefined || p.model === 'open') p.arrival_rps = p.steps.at(-1);
      else p.users = p.steps.at(-1);
    }
  }
  // Checked after the steps, which set arrival_rps on an open staircase.
  if (p?.arrival_rps !== undefined && ENGINES[spec.engine] && !OPEN_MODEL.has(spec.engine)) {
    errors.push(`profile.arrival_rps: engine ${spec.engine} runs a closed loop of users; an open model (arrival rate) needs ${[...OPEN_MODEL].filter((e) => e !== 'fake').join(' or ')}`);
  }
  // A spike: a jump inside steady to a higher load, and back; there must be steady before it to
  // compare with and after it to recover in.
  if (p?.spike !== undefined && p?.steps !== undefined) { errors.push('profile: steps or spike, not both; one shape is judged at a time'); shapeOk = false; }
  else if (p?.spike !== undefined) {
    const sp = p.spike;
    const key = p.arrival_rps !== undefined ? 'arrival_rps' : 'users';
    if (!(isNum(sp?.[key]) && sp[key] > (p[key] ?? 0))) { errors.push(`profile.spike.${key}: a number above the base ${key}`); shapeOk = false; }
    else if (!(isNum(sp.at_s) && sp.at_s > 0 && isNum(sp.for_s) && sp.for_s > 0 && sp.at_s + sp.for_s < (p.steady_s ?? 0))) { errors.push('profile.spike: at_s > 0 and for_s > 0, inside steady with steady before it and after it'); shapeOk = false; }
  }
  // A recovery test overloads the target and drops back to a normal load: without the overload it
  // would be a load test under another name, and could pass as a recovery it never measured.
  if (p?.name === 'recovery' && p.spike === undefined) { errors.push('profile recovery: needs its overload, profile.spike { users | arrival_rps, at_s, for_s }: the normal load before and after it is users (or arrival_rps)'); shapeOk = false; }
  // The ceiling of a breakpoint search (perf run --breakpoint): how far past the staircase it may
  // climb, as the environment's owner allows. Never unbounded.
  if (p?.breakpoint !== undefined) {
    const bp = p.breakpoint;
    if (!Array.isArray(p.steps)) errors.push('profile.breakpoint: only with steps (a staircase to extend)');
    else if (!bp || typeof bp !== 'object' || Object.keys(bp).some((k) => !['factor', 'max'].includes(k))) errors.push('profile.breakpoint: { factor?, max }');
    else {
      if (bp.factor !== undefined && !(isNum(bp.factor) && bp.factor > 1)) errors.push('profile.breakpoint.factor: a number > 1 (each new step is the one before × factor)');
      // At the top step is allowed: a climbed staircase ends on the ceiling itself.
      if (!(isNum(bp.max) && bp.max >= (p.steps.at(-1) ?? 0))) errors.push('profile.breakpoint.max: a number at or above the top step: the highest load the search may reach');
    }
  }
  for (const k of ['warmup_s', 'ramp_s', 'steady_s', 'rampdown_s', 'warmup_users']) {
    if (p?.[k] !== undefined && !(isNum(p[k]) && p[k] >= 0)) { errors.push(`profile.${k}: a number >= 0`); shapeOk = false; }
  }
  const T = spec.timing;
  let timingOk = true;
  for (const [k, v] of Object.entries(T)) if (!(isNum(v) && v > 0)) { errors.push(`timing.${k}: a number > 0`); timingOk = false; }
  if (timingOk) {
    // A beat must arrive several times inside each timeout, or healthy workers look dead.
    if (T.heartbeat_timeout_s * 1000 < 3 * T.tick_ms) errors.push('timing.heartbeat_timeout_s: must cover at least 3 ticks');
    if (T.worker_timeout_s * 1000 < 3 * T.tick_ms) errors.push('timing.worker_timeout_s: must cover at least 3 ticks');
    if (T.window_s * 1000 < T.tick_ms) errors.push('timing.window_s: must be at least one tick');
  }
  if (shapeOk) {
    const b = bounds(p);
    if (!(b.end > 0)) errors.push('profile: total duration must be > 0');
    if (p.name === 'smoke' && (p.users > SMOKE_MAX.users || b.end > SMOKE_MAX.duration_s)) {
      errors.push(`profile: a smoke is at most ${SMOKE_MAX.users} users and ${SMOKE_MAX.duration_s} s (this one: ${p.users} users, ${b.end} s); a bigger run is a load profile and is judged against SLOs`);
    }
    const steady = b.steady.to - b.steady.from;
    // Each step needs a window to settle and one to measure.
    if (timingOk && p.steps?.length && p.step_s < 2 * T.window_s) errors.push(`profile.step_s: ${p.step_s} s holds fewer than two ${T.window_s} s windows; a step needs one to settle and one to measure`);
    // Windows start at steady: a step or a spike that does not fall on window edges shares windows
    // with its neighbours, and its numbers are a mix of two loads.
    const onEdge = (x) => Math.abs(x / T.window_s - Math.round(x / T.window_s)) < 1e-6;
    if (timingOk && p.steps?.length && !onEdge(p.step_s)) errors.push(`profile.step_s: ${p.step_s} s is not a whole number of ${T.window_s} s windows`);
    if (timingOk && p.spike) {
      const { at_s: at, for_s: len } = p.spike;
      if (!onEdge(at) || !onEdge(len)) errors.push(`profile.spike: at_s and for_s must be whole numbers of ${T.window_s} s windows`);
      else if (at < 2 * T.window_s) errors.push(`profile.spike.at_s: ${at} s leaves fewer than two ${T.window_s} s windows of base before the spike`);
      else if (p.steady_s - at - len < 2 * T.window_s) errors.push(`profile.spike: ${p.steady_s - at - len} s of steady after the spike holds fewer than two ${T.window_s} s windows to recover in`);
    }
    if (timingOk && steady > 0 && steady < T.window_s) errors.push(`profile.steady_s: ${steady} s holds no whole ${T.window_s} s window; lengthen steady or shorten timing.window_s`);
  }

  let url = null;
  try { url = new URL(spec.target_url); } catch { errors.push('target_url: not a URL'); }
  const host = url?.hostname ?? null;
  if (url && (url.username || url.password || /[?&](access_token|token|api_?key|key|password|sig)=/i.test(url.search))) {
    errors.push('target_url: carries a credential; pass it through an environment variable, never in the URL');
  }
  const e = checkEnvironment(spec, env === undefined ? loadEnv(root, spec.slug) : env, host, errors);
  spec.monitor = { metrics: 'none', interval_s: 5, containers: [], ...e?.monitor };
  if (!METRICS[spec.monitor.metrics]) errors.push(`monitor.metrics: unknown "${spec.monitor.metrics}" (known: ${Object.keys(METRICS).join(', ')})`);
  if (spec.monitor.metrics === 'docker-stats' && !spec.monitor.containers?.length) errors.push('monitor.containers: docker-stats needs the target container names');
  // host-process: each process named, found by exactly one of pid, port or match (a regex over
  // the command line).
  if (spec.monitor.metrics === 'host-process') {
    const ps = spec.monitor.processes;
    if (!Array.isArray(ps) || !ps.length) errors.push('monitor.processes: host-process needs the target processes, each { name, pid | port | match }');
    else for (const [i, p] of ps.entries()) {
      const ways = ['pid', 'port', 'match'].filter((k) => p?.[k] !== undefined);
      if (!p?.name || !/^[\w.-]+$/.test(p.name)) errors.push(`monitor.processes[${i}].name: a short name (letters, digits, . _ -)`);
      else if (ps.filter((x) => x?.name === p.name).length > 1) errors.push(`monitor.processes: name ${p.name} is used twice`);
      if (ways.length !== 1) errors.push(`monitor.processes[${i}]: exactly one of pid, port, match`);
      else if (ways[0] !== 'match' && !(Number.isInteger(p[ways[0]]) && p[ways[0]] > 0)) errors.push(`monitor.processes[${i}].${ways[0]}: a whole number > 0`);
      else if (ways[0] === 'match') { try { new RegExp(p.match); } catch { errors.push(`monitor.processes[${i}].match: not a regular expression`); } }
    }
  }
  // The target's own metrics (a pool, locks, GC): read beside any metrics source, even none.
  errors.push(...checkSignals(spec.monitor.signals));
  if (spec.auto_stop.some((r) => r?.metric === 'target_cpu_pct') && spec.monitor.metrics === 'none') {
    errors.push('auto_stop target_cpu_pct: needs a metrics source in env.json monitor');
  }
  if (spec.engine !== 'fake') {
    if (!spec.script) errors.push(`script: the ${spec.engine} script to run is required (path from the project root)`);
    else {
      spec.script_path = resolve(root, spec.script);
      if (!existsSync(spec.script_path)) errors.push(`script: ${spec.script} not found`);
    }
  }
  if (spec.production === true || PROD.test(spec.environment)) errors.push('environment: ai-perf never loads production');
  if (host && PROD_HOST.test(host)) errors.push(`target_url: host "${host}" looks like production; ai-perf never loads production`);
  // Files on a Docker Desktop bind mount can lag seconds behind; a short timeout reads a healthy
  // container worker as lost.
  // Remote targets (CONTRACTS §3b): where the workers run, and the address they reach the
  // controller's channel at. Hosts and names are checked as words: nothing in them may be read as
  // an ssh option or a second shell command.
  if (REMOTE.has(spec.target)) {
    const ch = spec.channel ?? {};
    let adv = null;
    try { adv = new URL(ch.advertise); } catch { /* below */ }
    if (!adv || adv.protocol !== 'http:' || adv.pathname !== '/' || adv.search) errors.push(`channel.advertise: the http://host[:port] address the ${spec.target} workers reach this controller at (this machine's address on their network)`);
    if (ch.port !== undefined && !(Number.isInteger(ch.port) && ch.port >= 0 && ch.port < 65536)) errors.push('channel.port: a TCP port (0 picks a free one)');
    if (ch.bind !== undefined && !/^[\w.:-]+$/.test(String(ch.bind))) errors.push('channel.bind: an address to listen on');
    if (timingOk && Math.min(T.heartbeat_timeout_s, T.worker_timeout_s) < 10) warnings.push(`timing: on the ${spec.target} target keep heartbeat_timeout_s and worker_timeout_s at 10 s or more; the network adds latency`);
  }
  if (spec.target === 'ssh') {
    const c = spec.ssh ?? {};
    if (!Array.isArray(c.hosts) || !c.hosts.length || !c.hosts.every((h) => typeof h === 'string' && /^[A-Za-z0-9][\w.-]*(@[A-Za-z0-9][\w.:-]*)?$/.test(h))) errors.push('ssh.hosts: the machines to run workers on, each host or user@host');
    if (typeof c.ai_perf !== 'string' || !/^(~\/)?[\w./-]+$/.test(c.ai_perf)) errors.push('ssh.ai_perf: where ai-perf is on those machines (a path without spaces)');
    if (c.node !== undefined && !/^(~\/)?[\w./-]+$/.test(String(c.node))) errors.push('ssh.node: the node command on those machines');
  }
  if (spec.target === 'k8s') {
    const c = spec.k8s ?? {};
    if (typeof c.namespace !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(c.namespace)) errors.push('k8s.namespace: the namespace to run the worker Job in');
    if (typeof c.image !== 'string' || !/^[\w./:@-]+$/.test(c.image)) errors.push('k8s.image: an image with Node, ai-perf and the engine (docker/agent.Dockerfile)');
    if (timingOk && T.barrier_timeout_s < 180) warnings.push(`timing.barrier_timeout_s: ${T.barrier_timeout_s} s may not cover scheduling pods and pulling ${c.image ?? 'the image'}; give the k8s target 180 s or more`);
  }
  if (spec.target === 'docker' && timingOk && Math.min(T.heartbeat_timeout_s, T.worker_timeout_s) < 10) {
    warnings.push('timing: on the docker target keep heartbeat_timeout_s and worker_timeout_s at 10 s or more; bind-mounted files can lag');
  }
  // k6 starts its stages a second or more after go (longer with a slow setup()); the rampdown
  // absorbs that lag, or the stop cuts the end of steady (CONTRACTS §3).
  if (spec.engine === 'k6' && shapeOk && (p.rampdown_s ?? 0) < 3) {
    warnings.push('profile.rampdown_s: with k6 keep at least 3 s of rampdown; it absorbs k6 start-up lag, which otherwise cuts the steady state short');
  }
  if (host === 'localhost' && platform === 'win32') {
    warnings.push('target_url: "localhost" on Windows adds about 2 s per request; use 127.0.0.1');
  }

  for (const r of spec.auto_stop) errors.push(...checkRule(r));

  // A breakpoint search climbs only as far as the environment's owner allows: the ceiling is in
  // env.json (max_users, or max_arrival_rps for an open model), never only in the spec the agent
  // wrote. An environment without one gets no search.
  const bp = p?.breakpoint;
  if (bp && e && Array.isArray(p.steps) && isNum(bp.max)) {
    const open = p.arrival_rps !== undefined || p.model === 'open';
    const key = open ? 'max_arrival_rps' : 'max_users';
    const ceiling = e[key];
    if (!(isNum(ceiling) && ceiling > 0)) errors.push(`profile.breakpoint: environment "${spec.environment}" sets no ceiling (env.json ${key}: the highest load its owner allows); a breakpoint search needs one`);
    else if (bp.max > ceiling) errors.push(`profile.breakpoint.max: ${bp.max} is above the ${ceiling} the owner of "${spec.environment}" allows (env.json ${key})`);
  }
  // A recovery test's overload, and the time it has to come back, are run under the overload
  // safety bound instead of the error-rate and target-CPU rules (controller/rules.mjs rulesAt): the
  // planned recovery budget, and at least the longest rule's span so the overload's own errors have
  // left the rule's window when it is back in force.
  delete spec.overload_grace;
  if (p?.name === 'recovery' && shapeOk && p.spike) {
    const slo = spec.slug ? readJson(join(root, '.perf', spec.slug, 'slo.json')) : null;
    const budget = slo?.recovery?.recovery_s ?? slo?.spike?.recovery_s ?? 30;
    const sb = spikeBounds(p);
    spec.overload_grace = { from_s: sb.from, to_s: sb.to + Math.max(budget, ...spec.auto_stop.map((r) => r?.for_s ?? 0)) };
  }

  return { spec, errors, warnings };
}
