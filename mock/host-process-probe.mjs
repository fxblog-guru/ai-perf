// Runs the host-process adapter against a busy-server it starts, and prints what it measured:
// used to test the Linux (/proc) path inside a container. node mock/host-process-probe.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const hp = await import(new URL('../adapters/metrics/host-process.mjs', import.meta.url));
const child = spawn(process.execPath, [fileURLToPath(new URL('./busy-server.mjs', import.meta.url)), '19991', '0.8', '64'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const procs = [{ name: 'byport', port: 19991 }, { name: 'bypid', pid: child.pid }, { name: 'bymatch', match: 'busy-server\.mjs 19991' }];
const found = await hp.find(procs);
await hp.sample({ processes: procs, t: 0 });
await new Promise((r) => setTimeout(r, 2000));
const live = await hp.sample({ processes: procs, t: 2 });
child.kill();
await new Promise((r) => setTimeout(r, 800));
const gone = await hp.sample({ processes: procs, t: 3 });
console.log(JSON.stringify({ platform: process.platform, child: child.pid, found, live: live.map((x) => [x.labels.container, x.name, x.value]), gone: gone.map((x) => [x.labels.container, x.name, x.value]) }));
