import { spawnSync } from 'node:child_process';

// Workers as pods of one Kubernetes Indexed Job (CONTRACTS §3b): pod i runs perf-agent as worker
// i (JOB_COMPLETION_INDEX). The image must hold Node, ai-perf at spec.k8s.ai_perf (default
// /ai-perf) and the engine (docker/agent.Dockerfile builds one). The token travels in a Secret of
// the run, never in the Job's spec. Both are labelled with the run id and deleted at its end.
export const name = 'k8s';
export const remote = true;
export const kubectl = () => process.env.PERF_KUBECTL || 'kubectl';
const nodeScript = (p) => /\.[cm]?js$/.test(p);
const run = (args, input) => {
  const [cmd, a] = nodeScript(kubectl()) ? [process.execPath, [kubectl(), ...args]] : [kubectl(), args];
  return spawnSync(cmd, a, { encoding: 'utf8', timeout: 60000, windowsHide: true, input });
};
const resName = (runId) => `ai-perf-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 52);

// barrier + profile + drain, as the controller's own hard deadline, plus room to start.
const deadline = (spec) => {
  const p = spec.profile;
  const T = spec.timing;
  return T.barrier_timeout_s + (p.warmup_s ?? 0) + (p.ramp_s ?? 0) + (p.steady_s ?? 0) + (p.rampdown_s ?? 0) + T.worker_timeout_s + 120;
};

export function manifest({ spec, channel }) {
  const cfg = spec.k8s;
  const nm = resName(spec.run_id);
  const labels = { 'app.kubernetes.io/name': 'ai-perf-worker', 'ai-perf.run': nm };
  return {
    apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: nm, namespace: cfg.namespace, labels }, type: 'Opaque', stringData: { token: channel.token } },
      {
        apiVersion: 'batch/v1', kind: 'Job', metadata: { name: nm, namespace: cfg.namespace, labels },
        spec: {
          // A failed pod is one lost worker, never a reason to stop the others; it is not retried (a
          // new pod would rejoin mid-run as the same worker). Needs Kubernetes 1.29 or later.
          completionMode: 'Indexed', completions: spec.workers, parallelism: spec.workers,
          backoffLimitPerIndex: 0, maxFailedIndexes: spec.workers,
          // The Job cannot outlive the run (pods stuck pulling an image included), and is removed
          // an hour after it ends even if ai-perf never deletes it.
          activeDeadlineSeconds: Math.ceil(deadline(spec)), ttlSecondsAfterFinished: 3600,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'Never', automountServiceAccountToken: false,
              containers: [{
                name: 'worker', image: cfg.image,
                command: [cfg.node ?? 'node', `${(cfg.ai_perf ?? '/ai-perf').replace(/\/$/, '')}/bin/perf-agent.mjs`, '--controller', channel.url],
                env: [{ name: 'AI_PERF_TOKEN', valueFrom: { secretKeyRef: { name: nm, key: 'token' } } }],
                ...(cfg.resources ? { resources: cfg.resources } : {}),
              }],
            },
          },
        },
      },
    ],
  };
}

export function startWorkers({ spec, channel }) {
  const r = run(['apply', '-n', spec.k8s.namespace, '-f', '-'], JSON.stringify(manifest({ spec, channel })));
  const workers = Array.from({ length: spec.workers }, (_, index) => ({ id: `w${index}`, index, pid: null, pod: `${resName(spec.run_id)}-${index}`, remote: true }));
  // Same signal as a failed local spawn: the barrier sees stopped workers and ends the run.
  if (r.status !== 0) return workers.map((w) => ({ ...w, spawn_error: `kubectl apply: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}` }));
  return workers;
}

// The Job and its Secret go at the end of every run, whatever happened.
export function finish({ spec }) {
  const r = run(['delete', 'job,secret', '-n', spec.k8s.namespace, '-l', `ai-perf.run=${resName(spec.run_id)}`, '--wait=false', '--ignore-not-found']);
  return r.status === 0;
}

export function stopWorker() { return false; }

// After a lost controller (perf doctor --fix): the run's Job and Secret, by label.
export const cleanup = (spec) => finish({ spec });

// For the doctor: kubectl answers, and may create Jobs and Secrets in the namespace.
export function probe(cfg) {
  const v = run(['version', '--client', '-o', 'json']);
  if (v.status !== 0) return { ok: false, why: 'kubectl not found or not working' };
  const can2 = (verb, what) => run(['auth', 'can-i', verb, what, '-n', cfg.namespace]).stdout?.trim() === 'yes';
  const denied = ['create', 'delete'].flatMap((verb) => ['jobs', 'secrets'].filter((w) => !can2(verb, w)).map((w) => `${verb} ${w}`));
  return denied.length ? { ok: false, why: `kubectl may not ${denied.join(', ')} in namespace ${cfg.namespace}` } : { ok: true };
}
