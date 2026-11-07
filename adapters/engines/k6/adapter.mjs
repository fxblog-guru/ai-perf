import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// k6 as an ai-perf engine. A k6 script cannot write files, so each worker is a Node sidecar
// (worker.mjs) that speaks the worker protocol and runs k6 as its child: started paused before the
// barrier, resumed at go_at through k6's REST API, its per-request points read from `--out json`.
// k6 comes from PERF_K6 or `k6` on PATH; without one, the pinned image runs it under Docker.
export const name = 'k6';
export const tool = 'k6';
export const IMAGE = 'grafana/k6:1.0.0';
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

// How the sidecar runs k6: { mode: 'binary', bin } or { mode: 'docker', image }, or null.
export function runner() {
  const bin = process.env.PERF_K6 || 'k6';
  if (spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 30000 }).status === 0) return { mode: 'binary', bin };
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { timeout: 30000 }).status === 0) return { mode: 'docker', image: IMAGE };
  return null;
}

let cached;
export function detect() {
  if (cached) return cached;
  const r = runner();
  if (!r) return (cached = { ok: false, install: `install k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/) or run: docker pull ${IMAGE}` });
  const v = r.mode === 'binary'
    ? spawnSync(r.bin, ['version'], { encoding: 'utf8' }).stdout
    : spawnSync('docker', ['run', '--rm', IMAGE, 'version'], { encoding: 'utf8', timeout: 60000 }).stdout;
  const version = String(v).match(/v(\d+\.\d+\.\d+)/)?.[1] ?? 'unknown';
  return (cached = { ok: true, version: r.mode === 'docker' ? `${version} (docker)` : version, runner: r });
}

// No containerCommand: the sidecar needs Node and k6 together, and k6 already runs in its own
// container when it is not installed. Use target local.
export function workerCommand({ runDir, index, spec }) {
  return {
    cmd: process.execPath,
    args: [WORKER, runDir, String(index)],
    env: { AI_PERF_WORKER: String(index), AI_PERF_WORKERS: String(spec.workers) },
  };
}

// Whole users split exactly, as the Locust shim does: the first (total mod workers) workers take
// one extra, so the sum over workers is the profile's count.
export const shareOf = (total, index, workers) => Math.floor(total / workers) + (index < total % workers ? 1 : 0);

// The run's profile as k6 stages for one worker: each stage ends at its target VUs.
export function stages(p, index, workers) {
  const low = p.warmup_users ?? Math.max(1, Math.ceil(p.users * 0.1));
  // A stepped profile's steady is its staircase: a jump to each step, then its hold.
  // A spike: base until at_s, a jump to the spike for for_s, a jump back, base to the end.
  const base = shareOf(p.users, index, workers);
  const steady = p.steps?.length
    ? p.steps.flatMap((u, i) => [...(i ? [[0, shareOf(u, index, workers)]] : []), [p.step_s, shareOf(u, index, workers)]])
    : p.spike?.users
      ? [[p.spike.at_s, base], [0, shareOf(p.spike.users, index, workers)], [p.spike.for_s, shareOf(p.spike.users, index, workers)], [0, base], [p.steady_s - p.spike.at_s - p.spike.for_s, base]]
      : [[p.steady_s ?? 0, base]];
  const all = [
    [0, shareOf(low, index, workers)],
    [p.warmup_s ?? 0, shareOf(low, index, workers)],
    [p.ramp_s ?? 0, shareOf(p.steps?.[0] ?? p.users, index, workers)],
    ...steady,
    [p.rampdown_s ?? 0, 0],
  ];
  // k6 ramps linearly from one stage's target to the next. A zero-length warmup or rampdown is
  // dropped; a zero-length ramp is kept as a jump (0 ms), or steady would ramp from the warmup
  // level instead of holding the full load.
  return all.filter(([d], i) => i === 0 || i === 2 || d > 0 || ((p.steps?.length || p.spike) && i > 2 && i < all.length - 1)).map(([d, vus]) => `${Math.round(d * 1000)}ms:${vus}`);
}

// The open model as a k6 scenario for one worker: `ramping-arrival-rate`, so iterations start on
// schedule whatever the server does (no coordinated omission). The worker takes its share of the
// rate and of the VU cap (profile.users). Rates are per 10 s, so a fractional share keeps its
// precision in k6's integer rates. When every VU is busy, k6 drops iterations and says so
// (`dropped_iterations`): the planned load was not sent.
export function arrivalScenario(p, index, workers) {
  // Arrivals per minute, the whole number split exactly over workers (shareOf), so 0.3 rps on ten
  // workers is 18 a minute, not 0, and the sum over workers is the planned rate.
  const share = (rate) => shareOf(Math.round(rate * 60), index, workers);
  const low = p.warmup_rps ?? Math.max(1, p.arrival_rps * 0.1);
  const vus = Math.max(1, shareOf(p.users, index, workers));
  // Each stage ramps linearly from the previous target. A zero-length ramp is kept as a jump, or
  // steady would ramp from the warmup rate (seen in review: 4 → 18 rps through a "steady" of 20).
  const steady = p.steps?.length
    ? p.steps.flatMap((r, i) => [...(i ? [[0, share(r), true]] : []), [p.step_s, share(r)]])
    : p.spike?.arrival_rps
      ? [[p.spike.at_s, share(p.arrival_rps)], [0, share(p.spike.arrival_rps), true], [p.spike.for_s, share(p.spike.arrival_rps)], [0, share(p.arrival_rps), true], [p.steady_s - p.spike.at_s - p.spike.for_s, share(p.arrival_rps)]]
      : [[p.steady_s ?? 0, share(p.arrival_rps)]];
  const stages = [
    [p.warmup_s ?? 0, share(low)],
    [p.ramp_s ?? 0, share(p.steps?.[0] ?? p.arrival_rps), true],
    ...steady,
    [p.rampdown_s ?? 0, 0],
  ].filter(([d, , jump]) => jump || d > 0).map(([d, target]) => ({ duration: `${Math.round(d * 1000)}ms`, target }));
  return { executor: 'ramping-arrival-rate', startRate: share(low), timeUnit: '1m', preAllocatedVUs: vus, maxVUs: vus, stages };
}

// The module k6 runs for an open model: the product's script, its default function and its setup
// and teardown, with the run's scenario in place of the script's own load options.
export function openWrapper(scriptUrl, scriptText, scenario) {
  const has = (name) => new RegExp(`export\\s+(async\\s+)?(function|const|let)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(scriptText);
  return [
    `import * as product from ${JSON.stringify(scriptUrl)};`,
    `export const options = Object.assign({}, product.options, { scenarios: { aiperf: ${JSON.stringify(scenario)} }, stages: undefined, vus: undefined, duration: undefined, iterations: undefined });`,
    'export default product.default;',
    ...(has('setup') ? ['export const setup = product.setup;'] : []),
    ...(has('teardown') ? ['export const teardown = product.teardown;'] : []),
    '',
  ].join('\n');
}

// A failure that never got a status is classed by k6's error-code range
// (https://grafana.com/docs/k6/latest/javascript-api/error-codes/), keeping the code itself:
// 1050 request timeout, 11xx DNS, 12xx TCP. The class names match categorize() in lib/analyze.mjs.
export function errorClass(tags) {
  const status = Number(tags?.status ?? 0);
  if (status >= 100) return `HTTP ${status}`;
  const code = Number(tags?.error_code ?? 0);
  if (code === 1050) return 'RequestTimeout (k6 1050)';
  if (code >= 1100 && code < 1200) return `DNSError (k6 ${code})`;
  if (code >= 1200 && code < 1300) return `ConnectionError (k6 ${code})`;
  return code ? `k6 error ${code}` : 'k6 error';
}
