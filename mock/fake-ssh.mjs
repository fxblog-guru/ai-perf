// A stand-in for ssh in tests (PERF_SSH): the "remote" command runs on this machine. Options are
// skipped, the first word after them is the host, the rest is the remote command line, which is
// run through the shell as sshd would.
// - a host named "down…" fails like an unreachable one;
// - a host named "flaky…" loses its agent (killed with its children) after FAKE_SSH_KILL_AFTER_S;
// - FAKE_SSH_AI_PERF is replaced by this checkout, as the remote ai-perf path would be;
// - FAKE_SSH_SKEW_MS shifts the clock --probe reports;
// - FAKE_SSH_LOG gets one JSON line per call: { host, line, args };
// - a host named "noagent…" answers --probe but has no node for anything else.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i].startsWith('-')) i += ['-o', '-p', '-i', '-l', '-F', '-J'].includes(args[i]) ? 2 : 1;
const host = args[i];
let line = args.slice(i + 1).join(' ');
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ host, line, args })}\n`);
if (!host || /(^|@)down/.test(host)) { console.error(`ssh: connect to host ${host} port 22: Connection refused`); process.exit(255); }
if (/(^|@)noagent/.test(host) && !line.includes('--probe')) { console.error('bash: node: command not found'); process.exit(127); }
const here = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
if (process.env.FAKE_SSH_AI_PERF) line = line.split(process.env.FAKE_SSH_AI_PERF).join(here);
line = line.replace(/^node\b/, `"${process.execPath}"`);
const skew = Number(process.env.FAKE_SSH_SKEW_MS ?? 0);
const child = spawn(line, { shell: true, stdio: [process.stdin, skew ? 'pipe' : 'inherit', 'inherit'], env: { ...process.env, AI_PERF_FAKE_HOST: host }, detached: process.platform !== 'win32' });
if (skew) child.stdout.on('data', (d) => process.stdout.write(String(d).replace(/"now":(\d+)/, (_, n) => `"now":${Number(n) + skew}`)));
if (/(^|@)flaky/.test(host)) {
  setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
    process.exit(255);
  }, Number(process.env.FAKE_SSH_KILL_AFTER_S ?? 3) * 1000);
}
child.on('exit', (code) => process.exit(code ?? 1));
