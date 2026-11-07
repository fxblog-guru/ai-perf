import { execFile } from 'node:child_process';

// Target CPU and memory from `docker stats` for the containers named in env.json monitor.containers.
// Async on purpose: one sample takes a second or two, and the controller's tick must not wait.
export const name = 'docker-stats';

function command(args) {
  const d = process.env.PERF_DOCKER || 'docker';
  return /\.[cm]?js$/.test(d) ? [process.execPath, [d, ...args]] : [d, args];
}

const pct = (s) => Number(String(s).replace('%', '')) || 0;
const UNITS = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3 };
export function bytes(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([a-z]+)$/i);
  return m ? Number(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1) : 0;
}

// `docker stats` gives CPU as a percentage of one core (a container on a 16-core host can show
// 1600 %). target_cpu_pct is the share of the CPUs the container may use: its CPU limit, else the
// Docker host's CPUs. Without this, a database using one core of sixteen read as saturated and
// auto-stopped a healthy run (found dogfooding fx-blog).
export function parse(stdout, t, cpusOf = () => 1) {
  const out = [];
  for (const line of stdout.split('\n').filter((l) => l.trim().startsWith('{'))) {
    const s = JSON.parse(line);
    const labels = { container: s.Name };
    const cpus = cpusOf(s.Name) || 1;
    out.push({ t, name: 'target_cpu_pct', unit: '%', value: Math.round((pct(s.CPUPerc) / cpus) * 100) / 100, labels: { ...labels, cpus } });
    // Cores busy, as docker reports it: a single-threaded target pegged at one core of sixteen is
    // 6 % of the machine and 1.0 core here.
    out.push({ t, name: 'target_cpu_cores', unit: 'cores', value: Math.round(pct(s.CPUPerc) * 10) / 1000, labels: { ...labels, cpus } });
    out.push({ t, name: 'target_mem_pct', unit: '%', value: pct(s.MemPerc), labels });
    out.push({ t, name: 'target_mem_bytes', unit: 'B', value: bytes(String(s.MemUsage).split('/')[0]), labels });
  }
  return out;
}

const run = (args) => new Promise((resolve) => {
  const [cmd, a] = command(args);
  // A command that cannot even start (not executable, EFTYPE) throws here, not in the callback: it
  // is no sample, as a missing docker is, never a dead controller.
  try { execFile(cmd, a, { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim())); } catch { resolve(null); }
});

// CPUs per container, asked once: the container's limit (NanoCpus) or the Docker host's CPUs.
const cpusCache = new Map();
let hostCpus = null;
// "0-3,8" → 5
export const cpusetSize = (s) => String(s ?? '').split(',').filter(Boolean).reduce((a, r) => { const [x, y] = r.split('-').map(Number); return a + (Number.isFinite(y) ? y - x + 1 : 1); }, 0);
export function cpusOfInspect(line, host) {
  const [nano, quota, period, cpuset] = String(line).split('|');
  if (Number(nano) > 0) return Number(nano) / 1e9;
  if (Number(quota) > 0 && Number(period) > 0) return Number(quota) / Number(period);
  return cpusetSize(cpuset) || host;
}
async function cpusOfAll(containers) {
  if (!hostCpus) { const n = Number(await run(['info', '--format', '{{.NCPU}}'])); if (n > 0) hostCpus = n; }
  for (const c of containers) {
    if (cpusCache.has(c)) continue;
    const line = await run(['inspect', '-f', '{{.HostConfig.NanoCpus}}|{{.HostConfig.CpuQuota}}|{{.HostConfig.CpuPeriod}}|{{.HostConfig.CpusetCpus}}', c]);
    // A container not up yet answers nothing: asked again at the next sample, never cached.
    if (line && hostCpus) cpusCache.set(c, cpusOfInspect(line, hostCpus));
  }
  return (name) => cpusCache.get(name) ?? hostCpus ?? 1;
}

export async function sample({ containers, t }) {
  const cpusOf = await cpusOfAll(containers);
  const out = await run(['stats', '--no-stream', '--format', '{{json .}}', ...containers]);
  return out === null ? [] : parse(out, t, cpusOf);
}
