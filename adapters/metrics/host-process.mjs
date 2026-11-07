import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

// Target CPU and memory of processes running on this machine, for a target outside Docker
// (env.json monitor: { metrics: "host-process", processes: [{ name, pid | port | match }] }).
// - pid: that process, for as long as it lives;
// - port: the processes listening on that TCP port;
// - match: every process whose command line matches the regular expression (a server that forks
//   workers is one target).
// Each sample reads one snapshot of the machine's processes (pid, parent, start time, command line,
// CPU time, private memory) and listening ports: on Windows one PowerShell call, on Linux /proc,
// elsewhere ps and lsof. port and match targets are looked up again in every snapshot, so workers
// that are recycled are followed; a pid target is followed by pid and start time, so a reused pid
// is not mistaken for it. The load generator itself (this controller, its children, anything
// whose command line holds the run folder) is never part of a target.
//
// Memory is the target's private memory: Windows private bytes, Linux RssAnon (anonymous resident
// memory, so pages shared between forked workers are not counted twice), else RSS.
export const name = 'host-process';

// A tool's output is kept even when it exits non-zero (Get-Process with a dead pid does); null
// means the tool itself could not run, which is "no sample", never "the target is gone".
const run = (cmd, args) => new Promise((resolve) => {
  try { execFile(cmd, args, { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(stdout ? String(stdout) : err ? null : '')); } catch { resolve(null); }
});

// ---- snapshots: Map(pid -> { ppid, start, cmd, cpu_ms, mem }) and Map(port -> Set(pid)) ---------

const WIN = `$ErrorActionPreference='SilentlyContinue'
Get-NetTCPConnection -State Listen | ForEach-Object { "L\`t$($_.LocalPort)\`t$($_.OwningProcess)" }
Get-CimInstance Win32_Process | ForEach-Object { "P\`t$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.CreationDate.Ticks)\`t$([math]::Round(($_.KernelModeTime + $_.UserModeTime) / 10000))\`t$($_.PrivatePageCount)\`t$($_.CommandLine)" }`;

async function windows() {
  const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN]);
  if (text === null || !text.includes('P\t')) return null;
  const procs = new Map();
  const ports = new Map();
  for (const line of text.split(/\r?\n/)) {
    const c = line.split('\t');
    if (c[0] === 'L') { const port = Number(c[1]); if (!ports.has(port)) ports.set(port, new Set()); ports.get(port).add(Number(c[2])); }
    if (c[0] === 'P') procs.set(Number(c[1]), { ppid: Number(c[2]), start: c[3], cpu_ms: Number(c[4]), mem: Number(c[5]), cmd: c.slice(6).join('\t') });
  }
  return { procs, ports };
}

let clk = null;
async function linux() {
  clk ??= Number((await run('getconf', ['CLK_TCK']))?.trim()) || 100;
  const procs = new Map();
  for (const d of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      // Fields after the command (which may hold spaces): state is rest[0], ppid rest[1], utime
      // rest[11], stime rest[12], starttime rest[19].
      const rest = readFileSync(`/proc/${d}/stat`, 'utf8').split(') ').pop().split(' ');
      const status = readFileSync(`/proc/${d}/status`, 'utf8');
      const kb = (k) => Number(status.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN);
      const anon = kb('RssAnon');
      procs.set(Number(d), {
        ppid: Number(rest[1]), start: rest[19], cpu_ms: ((Number(rest[11]) + Number(rest[12])) / clk) * 1000,
        mem: (Number.isFinite(anon) ? anon : kb('VmRSS') || 0) * 1024,
        cmd: readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(),
      });
    } catch { /* gone between listing and reading */ }
  }
  return { procs, ports: null, linuxPort };
}
// Linux: the socket inodes listening on the port, then the processes holding them.
function linuxPort(port, pids) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[3] === '0A' && parseInt(c[1].split(':').pop(), 16) === port) inodes.add(c[9]);
    }
  }
  const out = new Set();
  if (!inodes.size) return out;
  for (const pid of pids) {
    let fds = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); if (m && inodes.has(m[1])) { out.add(pid); break; } } catch { /* gone */ }
    }
  }
  return out;
}

async function posix(ports) {
  const text = await run('ps', ['-axo', 'pid=,ppid=,lstart=,cputime=,rss=,command=']);
  if (text === null) return null;
  const procs = new Map();
  for (const l of text.split('\n')) {
    // pid ppid "Wed Oct 30 10:00:00 2026" cputime rss command
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [d, hms] = m[4].includes('-') ? m[4].split('-') : ['0', m[4]];
    const secs = hms.split(':').map(Number).reduce((a, x) => a * 60 + x, 0) + Number(d) * 86400;
    procs.set(Number(m[1]), { ppid: Number(m[2]), start: m[3], cpu_ms: secs * 1000, mem: Number(m[5]) * 1024, cmd: m[6] });
  }
  const byPort = new Map();
  for (const port of ports) byPort.set(port, new Set(((await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])) ?? '').split(/\s+/).filter(Boolean).map(Number)));
  return { procs, ports: byPort };
}

async function snapshot(processes) {
  if (process.platform === 'win32') return windows();
  if (process.platform === 'linux') return linux();
  return posix(processes.filter((p) => p.port).map((p) => p.port));
}

// The load generator: the controller (exclude.root, the process sampling), everything it started,
// and anything whose command line holds the run folder (exclude.text). Its CPU is never the
// target's. Without exclude (the doctor, a test) only this process is left out.
function generator(procs, exclude) {
  const out = new Set([process.pid, ...(exclude?.root ? [exclude.root] : [])]);
  const descendants = Boolean(exclude?.root);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of procs) if (!out.has(pid) && ((descendants && out.has(p.ppid)) || (exclude?.text && p.cmd.includes(exclude.text)))) { out.add(pid); grew = true; }
  }
  return out;
}

function pidsIn(snap, p, gen) {
  if (p.pid) return snap.procs.has(p.pid) ? [p.pid] : [];
  if (p.port) {
    const holders = snap.linuxPort ? snap.linuxPort(p.port, snap.procs.keys()) : snap.ports?.get(p.port) ?? new Set();
    return [...holders].filter((x) => snap.procs.has(x) && !gen.has(x));
  }
  const re = new RegExp(p.match);
  return [...snap.procs].filter(([pid, x]) => x.cmd && re.test(x.cmd) && !gen.has(pid)).map(([pid]) => pid);
}

// ---- the adapter ------------------------------------------------------------------------------

const followed = new Map(); // name -> { pids: Map(pid -> start), prev: Map(pid -> cpu_ms), at, gone }
export function reset() { followed.clear(); }

// For the doctor: which configured processes are running now.
export async function find(processes, exclude) {
  const snap = await snapshot(processes);
  if (!snap) return processes.map((p) => ({ name: p.name, pids: [], why: 'the process list could not be read' }));
  const gen = generator(snap.procs, exclude);
  return processes.map((p) => ({ name: p.name, pids: pidsIn(snap, p, gen) }));
}

export async function sample({ processes = [], t, exclude }) {
  const snap = await snapshot(processes);
  if (!snap) return []; // the tool failed: no sample this time, nothing concluded
  const gen = generator(snap.procs, exclude);
  const now = Date.now();
  const host = cpus().length;
  const out = [];
  for (const p of processes) {
    let f = followed.get(p.name);
    if (f?.gone) continue;
    // A pid target keeps its pid while it lives (same start time); port and match look again.
    const pids = p.pid
      ? (snap.procs.get(p.pid) && (!f || f.pids.get(p.pid) === snap.procs.get(p.pid).start) ? [p.pid] : [])
      : pidsIn(snap, p, gen);
    if (!f) {
      if (!pids.length) continue; // not found yet: no sample, so the controller says it is not monitored
      f = { pids: new Map(), prev: new Map(), at: null, gone: false };
      followed.set(p.name, f);
    }
    const labels = { container: p.name, pids: pids.join(','), cpus: host };
    // Every process of the target gone: the target died (a pid reused by another program is not it).
    if (!pids.length) {
      f.gone = true;
      out.push({ t, name: 'target_process_up', unit: 'bool', value: 0, labels: { ...labels, pids: [...f.pids.keys()].join(',') } });
      continue;
    }
    // Some of its processes exited (a worker crashed, or was recycled): said, and followed on.
    const exited = [...f.pids.keys()].filter((pid) => !pids.includes(pid) || snap.procs.get(pid)?.start !== f.pids.get(pid));
    if (exited.length && f.at) out.push({ t, name: 'target_process_exited', unit: 'count', value: exited.length, labels: { ...labels, exited: exited.join(',') } });
    out.push({ t, name: 'target_process_up', unit: 'bool', value: 1, labels });
    const mem = pids.reduce((a, pid) => a + (snap.procs.get(pid).mem || 0), 0);
    out.push({ t, name: 'target_mem_bytes', unit: 'B', value: mem, labels });
    out.push({ t, name: 'target_mem_pct', unit: '%', value: Math.round((mem / totalmem()) * 10000) / 100, labels });
    // CPU is a rate: over the pids seen in both snapshots (a new worker counts from its second).
    if (f.at) {
      const used = pids.reduce((a, pid) => a + (f.prev.has(pid) && f.pids.get(pid) === snap.procs.get(pid).start ? Math.max(0, snap.procs.get(pid).cpu_ms - f.prev.get(pid)) : 0), 0);
      const cores = Math.round((used / Math.max(1, now - f.at)) * 1000) / 1000;
      out.push({ t, name: 'target_cpu_cores', unit: 'cores', value: cores, labels });
      out.push({ t, name: 'target_cpu_pct', unit: '%', value: Math.round((cores / host) * 10000) / 100, labels });
    }
    f.pids = new Map(pids.map((pid) => [pid, snap.procs.get(pid).start]));
    f.prev = new Map(pids.map((pid) => [pid, snap.procs.get(pid).cpu_ms]));
    f.at = now;
  }
  return out;
}
