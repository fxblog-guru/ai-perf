import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { ENGINES } from '../adapters/index.mjs';
import { normalize } from '../controller/spec.mjs';
import { readJson, writeJson } from '../controller/files.mjs';
import { emit } from '../controller/events.mjs';
import { create, transition } from '../controller/state.mjs';
import { describe, listRuns, perfRoot } from './runs.mjs';
import { CHECKS, projectDir } from './checks.mjs';
import { changed, fingerprint } from './fingerprint.mjs';
import { ContractError, findContract, readContract } from './contract.mjs';
import { childAlive, killChild, killWorker } from './workers.mjs';

// Each check returns { id, group, status: ok|warn|fail, detail, fix? }. Every check has a
// fault-injection test that makes it fail; a check no test can fail is not a check.

const SECRET_PATTERNS = [
  [/\b(?:Bearer|Token)\s+(?!\$\{)[A-Za-z0-9._~+/-]{20,}=*/, 'bearer token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(?:password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'](?!\$\{|<)[^"'\s]{6,}["']/i, 'literal credential'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i, 'credential in a URL'],
  [/[?&](?:access_token|token|api_?key|key|password|sig)=(?!\$\{)[^&\s"']{6,}/i, 'token in a query string'],
  [/\bAuthorization["'\]]*\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/]{8,}=*/i, 'basic auth header'],
  [/\bCookie["'\]]*\s*[:=]\s*["']?[^\s=;"']+=(?!\$\{)[^\s;"']{8,}/i, 'cookie value'],
];

// Run folders are scanned too (no credential in run evidence), except the bulky numeric ones. In
// raw/ only the sampled errors are text a credential can leak into.
const SKIP_DIRS = new Set(['node_modules', 'hist', 'monitor']);

function* walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'raw') yield* rawErrors(p); else if (!SKIP_DIRS.has(e.name)) yield* walk(p); } else yield p;
  }
}

function* rawErrors(dir) {
  let workers = [];
  try { workers = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const w of workers) if (w.isDirectory()) yield join(dir, w.name, 'errors.ndjson');
}

export function scanSecrets(files) {
  const hits = [];
  for (const f of files) {
    let text;
    try { if (statSync(f).size > 1_000_000) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${f}: ${what}`);
  }
  return hits;
}

const check = (id, group, status, detail, fix) => ({ id, group, status, detail, ...(fix ? { fix } : {}) });

// What the machine is, measured, unless a test says what it is (fault injection, design §11).
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true }); return r.status === 0 ? (r.stdout ?? '').trim() : null; };
const nodeScript = (p) => /\.[cm]?js$/.test(p);
const MACHINE = {
  docker: () => { const d = process.env.PERF_DOCKER || 'docker'; return nodeScript(d) ? run(process.execPath, [d, 'version', '--format', '{{.Server.Version}}']) : run(d, ['version', '--format', '{{.Server.Version}}']); },
  python: () => run(process.env.PERF_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['--version']),
  // CPU busy over 300 ms, from the kernel's per-core counters.
  cpu_busy_pct: async () => {
    const snap = () => cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return { busy: a.busy + t - c.times.idle, total: a.total + t }; }, { busy: 0, total: 0 });
    const a = snap();
    await new Promise((r) => setTimeout(r, 300));
    const b = snap();
    return b.total > a.total ? Math.round(((b.busy - a.busy) / (b.total - a.total)) * 100) : 0;
  },
  // Ephemeral ports a client can open: each connection holds one, and keeps it in TIME_WAIT.
  ports: () => {
    if (process.platform === 'win32') {
      const m = (run('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp']) ?? '').match(/Number of Ports\s*:\s*(\d+)/i);
      return m ? Number(m[1]) : null;
    }
    try { const [lo, hi] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number); return hi - lo + 1; } catch { return null; }
  },
  // Open files per process (posix); Windows has no such small default.
  fd_limit: () => (process.platform === 'win32' ? null : Number(run('sh', ['-c', 'ulimit -n'])) || null),
  platform: () => process.platform,
};

export async function doctor({ root, specPath, fix = false, now = Date.now(), quick = false, probes = {} } = {}) {
  const out = [];
  const probe = async (k) => (k in probes ? probes[k] : MACHINE[k]());
  const major = Number(process.versions.node.split('.')[0]);
  out.push(check('node', 'machine', major >= 20 ? 'ok' : 'fail', `Node ${process.versions.node}`, major >= 20 ? null : 'install Node 20 or later'));

  // A missing engine is only a warning, unless the spec being checked needs it.
  const wanted = specPath ? readJson(specPath)?.engine ?? 'fake' : null;
  for (const [name, load] of Object.entries(ENGINES)) {
    const d = (await load()).detect();
    const status = d.ok ? 'ok' : name === wanted ? 'fail' : 'warn';
    out.push(check(`engine.${name}`, 'machine', status, d.ok ? `${name} ${d.version}` : `${name} not installed`, d.ok ? null : d.install));
  }

  let scriptPath = null;
  let spec = null;
  let specErrors = [];
  if (specPath) {
    const raw = readJson(specPath);
    if (!raw) out.push(check('spec', 'safety', 'fail', `${specPath}: not readable JSON`));
    else {
      const n = normalize(raw, { root });
      const { errors, warnings } = n;
      specErrors = errors;
      spec = n.spec;
      scriptPath = spec.script_path ?? null;
      for (const e of errors) out.push(check('spec', 'safety', 'fail', e));
      for (const w of warnings) out.push(check('spec', 'network', 'warn', w));
      if (!errors.length && !warnings.length) out.push(check('spec', 'safety', 'ok', `${specPath} valid; target ${spec.target_url} allowlisted`));
      const live = listRuns(root, spec.slug).map((r) => describe(r.dir, now)).filter((d) => d.controller === 'alive');
      if (live.length) out.push(check('concurrent', 'safety', 'warn', `run ${live[0].run_id} is already live for ${spec.slug}; two runs on one target distort both`));
    }
  }

  const secretFiles = [...walk(perfRoot(root))];
  // The load script may live anywhere in the repo; it is scanned wherever it is.
  for (const f of [specPath, scriptPath]) if (f) secretFiles.push(f);
  const hits = scanSecrets(secretFiles);
  out.push(hits.length
    ? check('secrets', 'safety', 'fail', hits.join('; '), 'move the value to an environment variable and reference it as ${NAME}')
    : check('secrets', 'safety', 'ok', `${secretFiles.length} files scanned`));

  // Docker is checked before a run only when the run needs it (monitoring by docker stats, a
  // docker target); the full doctor always says whether it is there.
  const needsDocker = spec && (spec.monitor?.metrics === 'docker-stats' || spec.target === 'docker');
  if (!quick || needsDocker) {
    const v = await probe('docker');
    out.push(check('docker', 'machine', v ? 'ok' : needsDocker ? 'fail' : 'warn', v ? `Docker ${v}` : 'Docker not reachable (docker version failed)', v ? null : 'start Docker, or set PERF_DOCKER'));
  }
  // A host process to monitor must be running before the run, or the run starts unmonitored.
  if (spec?.monitor?.metrics === 'host-process' && spec.monitor.processes?.length) {
    const found = 'processes' in probes ? probes.processes : await (await import('../adapters/metrics/host-process.mjs')).find(spec.monitor.processes);
    const lost = found.filter((f) => !f.pids.length);
    out.push(check('processes', 'machine', lost.length ? 'fail' : 'ok', lost.length ? `target process not running: ${lost.map((f) => { const p = spec.monitor.processes.find((x) => x.name === f.name); return `${f.name} (${p.pid ? `pid ${p.pid}` : p.port ? `port ${p.port}` : `match /${p.match}/`})`; }).join(', ')}` : `monitoring ${found.map((f) => `${f.name} (pid ${f.pids.join(',')})`).join(', ')}`, lost.length ? 'start the target, or fix env.json monitor.processes (a process of another user may need ai-perf to run with the rights to see its sockets)' : null));
  }
  // The target's own signals answer before the run. One that does not is a warning: the load is
  // still measured, but the analysis cannot use that signal.
  if (spec?.monitor?.signals?.length && !specErrors.length) {
    const { read, showUrl } = await import('../adapters/metrics/signals.mjs');
    const got = 'signals' in probes ? probes.signals : await Promise.all(spec.monitor.signals.map((s) => read(s)));
    const bad = spec.monitor.signals.map((s, i) => ({ s, g: got[i] })).filter(({ g }) => g?.error !== undefined);
    const noToken = spec.monitor.signals.filter((s) => s.auth_env && !process.env[s.auth_env]);
    out.push(check('signals', 'network', bad.length || noToken.length ? 'warn' : 'ok',
      bad.length || noToken.length
        ? [...bad.map(({ s, g }) => `${s.name}: ${g.error} (${showUrl(s.scrape ?? s.prometheus)})`), ...noToken.map((s) => `${s.name}: ${s.auth_env} is not set`)].join('; ')
        : `${spec.monitor.signals.length} signal(s) read: ${spec.monitor.signals.map((s, i) => `${s.name} ${got[i].value}`).join(', ')}`,
      bad.length || noToken.length ? 'fix env.json monitor.signals (URL, metric or query, match), or start the exporter; the run goes on without the signal' : null));
  }
  // Remote workers (§11 Clock, and whether the machines can run the run at all).
  if (spec?.target === 'ssh' && spec.ssh?.hosts?.length && !specErrors.length) {
    const ssh = await import('../adapters/targets/ssh.mjs');
    const mine = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
    // The way back: a channel opened here for the probe's length, on the run's port when it is
    // fixed; each host is asked whether it reaches it (any HTTP answer, a 401, is yes).
    const { openChannel, advertisedPort } = await import('../controller/channel.mjs');
    let back = null;
    try { back = await openChannel({ runDir: perfRoot(root), spec: { workers: 0 }, bind: spec.channel?.bind, port: spec.channel?.port ?? advertisedPort(spec.channel?.advertise), advertise: spec.channel?.advertise }); } catch (e) { out.push(check('channel', 'network', 'fail', `cannot listen for workers: ${e.code ?? e.message}`, 'free the port in channel.port, or choose another')); }
    const answers = await Promise.all(spec.ssh.hosts.map((host) => ('ssh' in probes ? probes.ssh(host) : ssh.probe(spec.ssh, host, back?.url))));
    await back?.close();
    for (const [i, host] of spec.ssh.hosts.entries()) {
      const p = answers[i];
      if (!p.ok) { out.push(check(`ssh.${host}`, 'machine', 'fail', `${host}: cannot run perf-agent: ${p.why}`, `check ssh access (key login), Node, and ai-perf at ${spec.ssh.ai_perf} on ${host}`)); continue; }
      const engineOk = p.engines?.[spec.engine] === true;
      out.push(check(`ssh.${host}`, 'machine', !engineOk ? 'fail' : p.version !== mine ? 'warn' : 'ok', `${host}: ai-perf ${p.version}${p.version !== mine ? ` (here ${mine})` : ''}, engine ${spec.engine} ${engineOk ? 'installed' : 'not installed'}`, !engineOk ? `install ${spec.engine} on ${host}` : p.version !== mine ? 'run the same ai-perf version on every machine' : null));
      if (p.reaches === false) out.push(check(`reach.${host}`, 'network', 'fail', `${host} cannot reach this controller at ${back?.url}: its workers could not report`, 'set channel.advertise to this machine\'s address on their network, give channel.port and open it in the firewall'));
      const off = Math.abs(p.skew_ms) - p.rtt_ms / 2;
      out.push(check(`clock.${host}`, 'clock', off > 1000 ? 'warn' : 'ok', `${host}: clock ${p.skew_ms >= 0 ? '+' : ''}${p.skew_ms} ms from this one (± ${Math.round(p.rtt_ms / 2)} ms)`, off > 1000 ? `fix NTP on ${host}; workers align to the controller, but logs and traces there will not match` : null));
    }
  }
  if (spec?.target === 'k8s' && spec.k8s?.namespace && !specErrors.length) {
    const p = 'k8s' in probes ? probes.k8s : (await import('../adapters/targets/k8s.mjs')).probe(spec.k8s);
    out.push(check('k8s', 'machine', p.ok ? 'ok' : 'fail', p.ok ? `kubectl may create the worker Job in ${spec.k8s.namespace}` : p.why, p.ok ? null : 'install kubectl, select the cluster context, and get create rights on jobs and secrets'));
  }
  if (quick) return out;

  const py = await probe('python');
  out.push(check('python', 'machine', py ? 'ok' : 'warn', py ?? 'no python: Locust and its suites cannot run', py ? null : 'install Python 3, or set PERF_PYTHON'));

  // Generator: a machine already busy, or short of ports or file descriptors, measures itself.
  const users = spec?.profile?.users ?? 0;
  const busy = await probe('cpu_busy_pct');
  out.push(check('cpu', 'generator', busy > 80 ? 'warn' : 'ok', `CPU ${busy} % busy before any load`, busy > 80 ? 'stop what is using the CPU, or generate from another machine: a busy generator under-sends and its numbers describe itself' : null));
  const ports = await probe('ports');
  const needPorts = Math.max(users * 4, (spec?.profile?.arrival_rps ?? 0) * 60);
  if (ports !== null) out.push(check('ports', 'generator', needPorts && ports < needPorts ? 'warn' : 'ok', `${ports} ephemeral ports${needPorts ? `; this run may hold about ${needPorts} (connections and TIME_WAIT)` : ''}`, needPorts && ports < needPorts ? 'widen the ephemeral port range, keep connections alive, or spread the load over more machines' : null));
  const fd = await probe('fd_limit');
  const needFd = users * 4 + 256;
  if (fd !== null) out.push(check('fd', 'generator', fd < needFd ? 'warn' : 'ok', `open files limit ${fd}${users ? ` for ${users} users` : ''}`, fd < needFd ? `raise it (ulimit -n ${needFd * 2}) before the run` : null));

  // Network: the target answers, how fast, and by which name.
  if (spec?.target_url) {
    const url = new URL(spec.target_url);
    if (url.hostname === 'localhost' && (await probe('platform')) === 'win32') out.push(check('localhost', 'network', 'warn', `${spec.target_url}: on Windows "localhost" tries IPv6 first and can cost about 2 s per new connection`, `use 127.0.0.1`));
    // A host the spec refuses (production, not allowlisted, no approval) is never sent anything.
    if (spec.engine !== 'fake' && !specErrors.length) {
      const t0 = Date.now();
      let status = null;
      let why = null;
      try { status = (await fetch(spec.target_url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })).status; } catch (e) { why = e.cause?.code ?? e.name; }
      const ms = Date.now() - t0;
      // No connection fails; anything else (TLS, a proxy) is said: the engines may still get through.
      const down = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'TimeoutError', 'AbortError'].includes(why);
      if (status === null) out.push(check('target', 'network', down ? 'fail' : 'warn', down ? `${spec.target_url} does not answer (${why === 'ENOTFOUND' || why === 'EAI_AGAIN' ? `DNS: ${url.hostname} not found` : why})` : `${spec.target_url}: no HTTP answer (${why}): TLS or a proxy between here and the target?`, down ? 'start the target, or fix target_url' : 'check the certificate and proxy settings the engines will use'));
      else out.push(check('target', 'network', ms > 1000 ? 'warn' : 'ok', `${spec.target_url} answered HTTP ${status} in ${ms} ms`, ms > 1000 ? 'a slow first answer: check DNS and the network path before loading it' : null));
    }
    // Safety: a third party the target calls for real takes this load too.
    const env = readJson(join(projectDir(root, spec.slug), 'env.json'))?.environments?.[spec.environment];
    const live = (env?.third_party ?? []).filter((t) => t.stubbed !== true);
    if (live.length) out.push(check('third_party', 'safety', 'warn', `third parties called for real under load: ${live.map((t) => t.name).join(', ')}`, 'stub them, or get their owners\' approval and record it'));
  }

  // Project: per .perf/<slug>, its files, its baselines, the contract it follows, what is assumed.
  let slugs = [];
  try { slugs = readdirSync(perfRoot(root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  for (const slug of slugs) out.push(...projectChecks(root, slug));

  for (const r of listRuns(root)) {
    const d = describe(r.dir, now);
    if (d.controller !== 'lost') continue;
    const orphans = d.workers.filter((w) => w.reporting && w.alive);
    // An engine a sidecar started (k6) outlives a sidecar that died: it is an orphan whether or not
    // its sidecar is still there. A container name is unique to the run; a pid is only killed
    // while this run is the one that is lost.
    const children = d.workers.map((w) => ({ w, child: readJson(join(r.dir, 'raw', w.id, 'status.json'))?.child })).filter((x) => childAlive(x.child));
    const what = d.state === 'unknown' ? 'never started' : `is gone while the run is ${d.state}`;
    out.push(check(`run.${d.run_id}`, 'controller', 'fail', `controller of ${d.slug}/${d.run_id} ${what}`, 'perf doctor --fix marks it aborted'));
    if (orphans.length || children.length) {
      const names = [...orphans.map((w) => `${w.id} (${w.container ?? `pid ${w.pid}`})`), ...children.map(({ w, child }) => `${w.id} engine (${child.container ?? `pid ${child.pid}`})`)];
      out.push(check(`orphans.${d.run_id}`, 'controller', 'fail', `orphan workers still loading the target: ${names.join(', ')}`, 'perf doctor --fix stops them'));
    }
    if (fix) {
      for (const w of orphans) killWorker(w);
      for (const { child } of children) killChild(child);
      // A stalled controller (a laptop resumed from sleep) reads this and ends aborted too. Its pid
      // is not killed: by now it may belong to an unrelated process.
      writeFileSync(join(r.dir, 'stop.request'), `${new Date().toISOString()} perf doctor --fix\n`);
      // Workers on a cluster outlive a lost controller: their Job and Secret go now.
      const runSpec = readJson(join(r.dir, 'run.json'));
      if (runSpec?.target === 'k8s' && runSpec.k8s?.namespace) (await import('../adapters/targets/k8s.mjs')).cleanup(runSpec);
      const state = readJson(join(r.dir, 'state.json')) ?? create({ run_id: d.run_id, slug: d.slug, pid: d.pid, workers: [], problems: [], stop_reason: null });
      if (state.state !== 'collecting') transition(state, 'collecting');
      transition(state, 'aborted');
      state.stop_reason = 'controller_lost';
      state.problems.push({ kind: 'controller_lost', detail: 'marked aborted by perf doctor --fix', t: null });
      writeJson(join(r.dir, 'state.json'), state);
      emit(r.dir, { type: 'run_finished', severity: 'warn', summary: 'run aborted (controller_lost)', data: { state: 'aborted', stop_reason: 'controller_lost' } });
    }
  }
  if (!out.some((c) => c.group === 'controller')) out.push(check('controller', 'controller', 'ok', 'no lost controller, no orphan worker'));
  return out;
}

function projectChecks(root, slug) {
  const dir = projectDir(root, slug);
  const out = [];
  const unreadable = ['slo.json', 'workload.json', 'env.json', 'data/manifest.json', 'context.json', 'assumptions.json']
    .filter((f) => existsSync(join(dir, f)) && readJson(join(dir, f)) === null);
  if (unreadable.length) out.push(check(`${slug}.files`, 'project', 'fail', `${slug}: not valid JSON: ${unreadable.join(', ')}`, 'fix the file, or write it again with its step'));
  const gates = [['plan', 'slo.json'], ['model', 'workload.json'], ['env', 'env.json'], ['data', 'data/manifest.json']]
    .filter(([, f]) => existsSync(join(dir, f)) && !unreadable.includes(f))
    .map(([step]) => [step, CHECKS[step](root, slug)]).filter(([, g]) => !g.ok);
  if (gates.length) out.push(check(`${slug}.gates`, 'project', 'warn', `${slug}: ${gates.map(([s, g]) => `${s}: ${g.errors[0]}`).join('; ')}`, `perf check <step> --slug ${slug}`));
  else if (!unreadable.length) out.push(check(`${slug}.files`, 'project', 'ok', `${slug}: files valid`));
  // A baseline taken under another workload, architecture or environment than today's is stale.
  const stale = [];
  const bdir = join(dir, 'baselines');
  let envs = [];
  try { envs = readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  for (const e of envs) for (const f of readdirSync(join(bdir, e)).filter((x) => /^[^.]+\.json$/.test(x))) {
    const b = readJson(join(bdir, e, f));
    const spec = readJson(join(dir, 'runs', b?.run?.id ?? '-', 'run.json'));
    const diff = spec?.fingerprint && changed(b.run.fingerprint ?? spec.fingerprint, fingerprint(root, spec))?.filter((k) => k !== 'script');
    if (diff?.length) stale.push(`${e}/${f.replace(/\.json$/, '')} (${diff.join(', ')} changed)`);
  }
  if (stale.length) out.push(check(`${slug}.baselines`, 'project', 'warn', `${slug}: stale baselines: ${stale.join('; ')}`, 'run the profile again and promote it (perf report --promote)'));
  // The plan follows the contract it was drafted from: a budget changed or an x-perf operation added since.
  const path = findContract(root, slug);
  if (path && existsSync(path)) {
    let c = null;
    try { c = readContract(path); } catch (e) { if (!(e instanceof ContractError)) throw e; out.push(check(`${slug}.contract`, 'project', 'warn', `${slug}: ${e.message}`)); }
    if (c) {
      const budgets = new Map(c.operations.filter((o) => o.id && o.perf?.p95_ms).map((o) => [o.id, o.perf.p95_ms]));
      const byId = new Map(c.operations.filter((o) => o.id).map((o) => [o.id, o]));
      const slo = readJson(join(dir, 'slo.json'));
      const planned = new Set((readJson(join(dir, 'workload.json'))?.journeys ?? []).flatMap((j) => j.steps ?? []));
      const drift = [];
      for (const t of slo?.transactions ?? []) if (t.source === 'contract' && budgets.has(t.name) && budgets.get(t.name) !== t.sla?.p95_ms) drift.push(`${t.name} budget is ${budgets.get(t.name)} ms in the contract, ${t.sla?.p95_ms} ms in slo.json`);
      // What perf contract would draft today and the workload lacks: a GET with a budget in a
      // traffic class the plan already covers (a class or a POST left out on purpose is not drift).
      const classes = new Set([...planned].map((id) => byId.get(id)?.traffic ?? null));
      if (planned.size) for (const id of budgets.keys()) if (!planned.has(id) && byId.get(id).method === 'GET' && classes.has(byId.get(id).traffic ?? null)) drift.push(`${id} has an x-perf budget but no journey runs it`);
      if (drift.length) out.push(check(`${slug}.contract`, 'project', 'warn', `${slug}: out of step with ${path.slice(root.length + 1)}: ${drift.join('; ')}`, '/perf-plan and /perf-model again (perf contract drafts only what is missing)'));
    }
  }
  const open = (readJson(join(dir, 'assumptions.json')) ?? []).filter((a) => a.status !== 'confirmed');
  const loaded = listRuns(root, slug).some((r) => (readJson(join(r.dir, 'run.json'))?.profile?.name ?? 'smoke') !== 'smoke');
  if (open.length && loaded) out.push(check(`${slug}.assumptions`, 'project', 'warn', `${slug}: load runs rest on ${open.length} open assumption(s): ${open.map((a) => a.key).join(', ')}`, 'confirm them with the owner (perf discover --answer key=value)'));
  return out;
}

export const worst = (checks) => (checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok');
