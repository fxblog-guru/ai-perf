// A stand-in for a scaled deployment: a load balancer in front of N backend instances, each with a
// capacity, and optionally a part they all share (a database) with its own capacity.
//   node mock/scale-lb.mjs <port> [--capacity 100] [--shared 250] [--start-ms 3000]
//       the balancer, with no instance until it is scaled
//   node mock/scale-lb.mjs scale <n> --port <port>
//       deploy n instances, as `docker compose up -d --scale api=n` does: it returns at once, and
//       the new instances answer only after --start-ms
// The balancer forwards any request round-robin to a ready instance and answers 503 while one is
// still starting. Its own paths:
//   /lb/capacity?worker=i&offered=r  what the deployment serves in requests/s: the sum of the
//       capacities its ready instances report, capped by --shared. The fake engine asks it
//       (engine_options.capacity_url) and tells it the rate each worker offers.
//   /metrics  db_pool_used_pct: the share of the shared part in use (served / shared, at most 100),
//       and lb_instances_ready.
import { createServer, request } from 'node:http';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };

if (args[0] === 'scale') {
  const n = Number(args[1]);
  const r = await fetch(`http://127.0.0.1:${opt('port')}/lb/scale?n=${n}`).catch((e) => ({ ok: false, status: e.message }));
  if (!r.ok) { console.error(`scale to ${n} refused: ${r.status}`); process.exit(1); }
  console.log(`scaling to ${n}`);
  process.exit(0);
}

const port = Number(args[0] ?? 9995);
const capacity = opt('capacity', 100);
const shared = opt('shared', Infinity);
const startMs = opt('start-ms', 3000);
const backends = [];
const offered = new Map();
let next = 0;

function backend(i) {
  const b = { ready: false, port: null, server: null, timer: null };
  b.server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/capacity') ? { capacity_rps: capacity } : { instance: i }));
  }).listen(0, '127.0.0.1', () => { b.port = b.server.address().port; b.timer = setTimeout(() => { b.ready = true; }, startMs); });
  return b;
}

function scaleTo(n) {
  while (backends.length > n) { const b = backends.pop(); clearTimeout(b.timer); b.server.close(); }
  while (backends.length < n) backends.push(backend(backends.length));
  offered.clear();
}

const ready = () => backends.filter((b) => b.ready);
// Each ready instance is asked what it serves: the deployment's capacity is what its parts report.
async function deployed() {
  const each = await Promise.all(ready().map((b) => fetch(`http://127.0.0.1:${b.port}/capacity`).then((r) => r.json()).then((j) => j.capacity_rps).catch(() => 0)));
  return Math.min(each.reduce((a, c) => a + c, 0), shared);
}
const offeredNow = () => [...offered.values()].filter((o) => Date.now() - o.at < 2000).reduce((a, o) => a + o.rps, 0);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://lb');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/lb/scale') {
    const n = Number(url.searchParams.get('n'));
    if (!(Number.isInteger(n) && n >= 0 && n <= 64)) return json(400, { error: 'n: 0 to 64' });
    scaleTo(n);
    return json(200, { instances: n });
  }
  if (url.pathname === '/lb/capacity') {
    const w = url.searchParams.get('worker');
    if (w !== null) offered.set(w, { rps: Number(url.searchParams.get('offered')) || 0, at: Date.now() });
    return json(200, { capacity_rps: await deployed(), instances: ready().length });
  }
  if (url.pathname === '/metrics') {
    const served = Math.min(offeredNow(), await deployed());
    const pool = Number.isFinite(shared) ? Math.min(100, Math.round((served / shared) * 100)) : 0;
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(`# TYPE db_pool_used_pct gauge\ndb_pool_used_pct ${pool}\n# TYPE lb_instances_ready gauge\nlb_instances_ready ${ready().length}\n`);
    return;
  }
  // Not ready while any instance is still starting, or none is deployed: a rolling restart.
  const up = ready();
  if (!up.length || up.length < backends.length) return json(503, { error: 'starting', ready: up.length, instances: backends.length });
  const b = up[next++ % up.length];
  const p = request({ host: '127.0.0.1', port: b.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => json(502, { error: 'instance gone' }));
  req.pipe(p);
}).listen(port, '127.0.0.1', () => console.log(`scale-lb ${port}`));
