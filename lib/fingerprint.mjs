import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';

// What a run was measured under (design §12, baseline upkeep), taken when the run starts and kept
// in run.json and result.run. Two runs whose fingerprints differ are another experiment: the
// baseline is STALE, compare refuses them, trend leaves them out. Only what moves the numbers is
// in it: who is recorded as the source of a number, the SLO thresholds a run is judged against,
// and which hosts are allowed change nothing that was measured.

const digest = (x) => (x === null || x === undefined ? null : createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16));
const fileDigest = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };

export function fingerprint(root, spec) {
  const dir = projectDir(root, spec.slug);
  const w = readJson(join(dir, 'workload.json'));
  const facts = readJson(join(dir, 'context.json'))?.facts;
  const env = readJson(join(dir, 'env.json'))?.environments?.[spec.environment];
  const data = readJson(join(dir, 'data', 'manifest.json'));
  return {
    workload: digest(w && {
      model: w.model, users: w.target?.users, arrival_rps: w.target?.arrival_rps,
      personas: (w.personas ?? []).map((p) => [p.name, p.share_pct]),
      journeys: (w.journeys ?? []).map((j) => [j.name, j.persona, j.weight_pct, j.steps, j.think_time_s]),
    }),
    architecture: digest(facts && { services: facts.compose_services, datastores: facts.datastores, stack: facts.stack, realtime: facts.realtime }),
    environment: digest(env && { parity: env.parity, third_party: (env.third_party ?? []).map((t) => [t.name, t.stubbed === true]) }),
    script: spec.script_path ? fileDigest(spec.script_path) : null,
    // The volume plan's target sizes, when there is one (a manifest without it keeps the digest it
    // always had). The sizes a run counted are compared apart, with a tolerance (lib/volume.mjs).
    data: digest(data && { accounts: data.accounts?.count, shared: data.accounts?.shared_reason ?? null, ...(data.volume?.entities ? { volume: Object.entries(data.volume.entities).map(([k, e]) => [k, e?.target]) } : {}) }),
  };
}

// The parts that differ between two fingerprints; null when either run has none (taken before
// ai-perf recorded them), so the caller can say it could not check.
export function changed(a, b) {
  if (!a || !b) return null;
  return Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
}
