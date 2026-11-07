import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, perf, spec } from './helpers.mjs';

// The project the lifecycle and operations tests share.
export const OPS = ['listItems', 'getItem', 'createOrder'];
// About 80 requests: enough that a 10 % operation runs at least once (0.9^80 ≈ 0.02 %).
export const SMOKE = { name: 'smoke', users: 4, warmup_users: 4, warmup_s: 2, ramp_s: 0, steady_s: 0, rampdown_s: 0 };
export const ENDPOINTS = [
  { name: 'listItems', weight: 6, median_ms: 40, sigma: 0.2 },
  { name: 'getItem', weight: 3, median_ms: 30, sigma: 0.2 },
  { name: 'createOrder', weight: 1, median_ms: 80, sigma: 0.2 },
];

export const JOURNEYS = [
  { name: 'browse', persona: 'buyer', weight_pct: 60, steps: ['listItems'], think_time_s: 0.1, source: 'assumed' },
  { name: 'look', persona: 'buyer', weight_pct: 30, steps: ['getItem'], think_time_s: 0.1, source: 'assumed' },
  { name: 'buy', persona: 'buyer', weight_pct: 10, steps: ['createOrder'], think_time_s: 0.1, source: 'assumed' },
];
// The cleanup the manifest names: it records the run id it was given, so a test can see it ran.
export const CLEANUP = "import { appendFileSync } from 'node:fs';\nappendFileSync('cleaned.txt', process.argv[3] + '\\n');\n";

// A project as the lifecycle skills leave it: every file valid, so each test breaks exactly one.
export function project(root, over = {}) {
  const dir = join(root, '.perf', 'demo');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const files = {
    'slo.json': { profiles: ['smoke', 'load'], transactions: OPS.map((name) => ({ name, slo: { p95_ms: 200, error_rate: 0.01 }, sla: { p95_ms: 400, error_rate: 0.02 }, source: 'assumed' })) },
    'workload.json': {
      model: 'closed', model_reason: 'a fixed pool of signed-in shoppers',
      target: { users: 20, source: 'assumed' },
      personas: [{ name: 'buyer', share_pct: 100, source: 'assumed' }],
      // The fake engine's mix (ENDPOINTS weights 6:3:1), so the measured mix is the planned one.
      journeys: JOURNEYS,
      littles_law: { rps: 200, response_s: 0, think_s: 0.1, users: 20 },
    },
    'env.json': { environments: { local: { allow_hosts: ['127.0.0.1'], allowed_profiles: PROFILES, owner: 'test', parity: 'laptop mock', third_party: [{ name: 'payments', stubbed: true }] } } },
    'data/manifest.json': { accounts: { count: 20, source: 'generated' }, cleanup: { command: 'node cleanup.mjs --prefix $RUN_ID' }, run_id_prefix: true },
    ...over,
  };
  for (const [name, content] of Object.entries(files)) if (content !== null) writeFileSync(join(dir, name), JSON.stringify(content, null, 2));
  writeFileSync(join(root, 'cleanup.mjs'), CLEANUP);
}

export function runFake(root, over = {}, args = []) {
  const s = spec({ engine_options: { endpoints: ENDPOINTS, ...over.engine_options }, ...over, engine_options_: undefined });
  s.engine_options = { endpoints: ENDPOINTS, rps_per_user: 10, ideal: true, ...over.engine_options };
  const p = join(root, 'spec.json');
  writeFileSync(p, JSON.stringify(s));
  return perf(['run', p, '--root', root, '--wait', ...args]);
}
