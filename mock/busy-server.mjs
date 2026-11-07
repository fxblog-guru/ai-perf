// A stand-in target for host-process tests: an HTTP server on a port that keeps part of a core
// busy and holds memory, until it is killed; optionally its memory grows (a leak).
// node mock/busy-server.mjs <port> [busy 0..1] [MiB held] [MiB more each second]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9991);
const busy = Number(process.argv[3] ?? 0.8);
const held = [Buffer.alloc(Number(process.argv[4] ?? 64) * 1024 * 1024, 1)];
const leak = Number(process.argv[5] ?? 0);
createServer((req, res) => res.end('ok')).listen(port, '127.0.0.1', () => console.log(`busy-server ${port}`));
// Busy for `busy` of every 100 ms, so CPU use is about `busy` cores.
setInterval(() => { const end = Date.now() + busy * 100; while (Date.now() < end); }, 100);
if (leak > 0) setInterval(() => held.push(Buffer.alloc(leak * 1024 * 1024, 1)), 1000);
