// A stand-in for kubectl in tests (PERF_KUBECTL): `apply -f -` reads the List ai-perf writes and
// runs each pod of an Indexed Job as a local process (its command, its env, the Secret's token,
// JOB_COMPLETION_INDEX); `delete -l ai-perf.run=<name>` kills them and forgets the run. State lives
// in FAKE_KUBECTL_STATE (a JSON file). FAKE_KUBECTL_AI_PERF is replaced by this checkout in the
// command, as the image's /ai-perf would be. `auth can-i` answers FAKE_KUBECTL_CAN_I (default yes).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_KUBECTL_STATE;
const load = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return { runs: {} }; } };
const save = (s) => writeFileSync(statePath, JSON.stringify(s));
const here = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

if (args[0] === 'version') { console.log('{"clientVersion":{"gitVersion":"v1.31.0-fake"}}'); process.exit(0); }
// FAKE_KUBECTL_DENY: a verb (create, delete) answered no.
if (args[0] === 'auth') { console.log(args[2] === process.env.FAKE_KUBECTL_DENY ? 'no' : process.env.FAKE_KUBECTL_CAN_I ?? 'yes'); process.exit(0); }
if (args[0] === 'apply') {
  const list = JSON.parse(readFileSync(0, 'utf8'));
  const secrets = Object.fromEntries(list.items.filter((x) => x.kind === 'Secret').map((x) => [x.metadata.name, x.stringData]));
  const state = load();
  for (const job of list.items.filter((x) => x.kind === 'Job')) {
    if (job.spec.completionMode !== 'Indexed') { console.error('only Indexed Jobs are faked'); process.exit(1); }
    const c = job.spec.template.spec.containers[0];
    const env = Object.fromEntries(c.env.map((e) => [e.name, e.value ?? secrets[e.valueFrom.secretKeyRef.name][e.valueFrom.secretKeyRef.key]]));
    const cmd = c.command.map((x) => (process.env.FAKE_KUBECTL_AI_PERF ? x.split(process.env.FAKE_KUBECTL_AI_PERF).join(here) : x));
    const pids = [];
    for (let i = 0; i < job.spec.parallelism; i++) {
      const p = spawn(cmd[0] === 'node' ? process.execPath : cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env, JOB_COMPLETION_INDEX: String(i) } });
      p.unref();
      pids.push(p.pid);
    }
    state.runs[job.metadata.labels['ai-perf.run']] = { pids, namespace: job.metadata.namespace, image: c.image };
    console.log(`job.batch/${job.metadata.name} created`);
  }
  save(state);
  process.exit(0);
}
if (args[0] === 'delete') {
  const label = args[args.indexOf('-l') + 1]?.replace(/^ai-perf\.run=/, '');
  const state = load();
  for (const pid of state.runs[label]?.pids ?? []) { try { process.kill(pid); } catch { /* gone */ } }
  if (state.runs[label]) state.runs[label].deleted = true;
  save(state);
  console.log(`job.batch/${label} deleted`);
  process.exit(0);
}
console.error(`fake kubectl: unsupported ${args.join(' ')}`);
process.exit(1);
