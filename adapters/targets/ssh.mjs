import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../../controller/files.mjs';

// Workers on other machines over ssh (CONTRACTS §3b): one perf-agent per worker, spread over
// spec.ssh.hosts in turn. Each host needs Node, ai-perf at spec.ssh.ai_perf and the engine; the
// run's script is sent by the controller. Key-based login only (BatchMode): a password prompt
// would hang a detached run. The token goes to the agent on stdin, never on a command line.
export const name = 'ssh';
export const remote = true;
export const ssh = () => process.env.PERF_SSH || 'ssh';
const nodeScript = (p) => /\.[cm]?js$/.test(p);
const command = (args) => (nodeScript(ssh()) ? [process.execPath, [ssh(), ...args]] : [ssh(), args]);
const OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5'];

// One word for the remote shell: plain words as they are, anything else in double quotes.
// A leading ~/ stays outside quotes, so the remote shell expands it to the home folder.
export const quote = (s) => (/^(~\/)?[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`);
export const remoteCommand = (cfg, extra) => [cfg.node ?? 'node', `${cfg.ai_perf.replace(/\/$/, '')}/bin/perf-agent.mjs`, ...extra].map(quote).join(' ');

export function startWorkers({ runDir, spec, channel }) {
  const cfg = spec.ssh;
  const workers = [];
  for (let index = 0; index < spec.workers; index++) {
    const host = cfg.hosts[index % cfg.hosts.length];
    const id = `w${index}`;
    const dir = join(runDir, 'raw', id);
    mkdirSync(dir, { recursive: true });
    // "--" ends ssh's options: the host is never read as one.
    const [cmd, args] = command([...OPTS, '--', host, remoteCommand(cfg, ['--controller', channel.url, '--worker', String(index), '--token-stdin'])]);
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    // What ssh and the remote side say goes to agent.log. If ssh ends before the agent reported
    // (a refused key, no node, no ai-perf), the worker stops with that reason now, not at the
    // barrier's timeout.
    let said = '';
    child.stderr.on('data', (d) => { said = (said + d).slice(-2000); try { appendFileSync(join(dir, 'agent.log'), d); } catch { /* evidence only */ } });
    const failed = (why) => { if (!existsSync(join(dir, 'status.json'))) writeJson(join(dir, 'status.json'), { worker: index, pid: null, state: 'stopped', reason: `spawn_failed: ${why}`.slice(0, 300), ts: Date.now() }); };
    child.on('error', (e) => failed(`ssh: ${e.code ?? e.message}`));
    child.on('exit', (code) => { if (code !== 0) failed(`ssh to ${host} ended (exit ${code}): ${said.trim().split('\n').pop() ?? ''}`); });
    child.stdin.on('error', () => { /* ssh ended before reading the token: its exit says why */ });
    child.stdin.end(`${channel.token}\n`);
    child.unref();
    workers.push({ id: `w${index}`, index, pid: child.pid ?? null, host, remote: true });
  }
  return workers;
}

// Killing the ssh client would not stop the far side (no tty, no hang-up): the agent stops on
// control.stop or a stale heartbeat, never by a signal from here.
export function stopWorker() { return false; }

// For the doctor: can each host be reached, does it run this ai-perf, how far is its clock off.
// controllerUrl: also say whether that machine reaches the controller there (expects a 401).
export function probe(cfg, host, controllerUrl = null) {
  const [cmd, args] = command([...OPTS, '--', host, remoteCommand(cfg, ['--probe', ...(controllerUrl ? ['--controller', controllerUrl] : [])])]);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let t0 = null;
    let t1 = null;
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, why: 'no answer in 30 s' }); }, 30000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      // Started: now ask for the clock, and time only that exchange.
      if (t0 === null && out.includes('ready\n')) { t0 = Date.now(); child.stdin.write('now\n'); }
      if (t0 !== null && t1 === null && /\{.*\}\s*$/.test(out.split('ready\n').pop())) t1 = Date.now();
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, why: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || t1 === null) { resolve({ ok: false, why: (err || out || `exit ${code}`).trim().split('\n').pop().slice(0, 200) }); return; }
      try {
        const p = JSON.parse(out.trim().split('\n').pop());
        // The remote clock was read inside the exchange: its midpoint is the best guess, half its
        // round trip the uncertainty.
        resolve({ ok: true, version: p.version, engines: p.engines, reaches: p.reaches ?? null, skew_ms: Math.round(p.now - (t0 + t1) / 2), rtt_ms: t1 - t0 });
      } catch { resolve({ ok: false, why: `not a perf-agent answer: ${out.slice(0, 120)}` }); }
    });
  });
}
