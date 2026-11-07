// Bundled mock target (PS-A4): the default every quick start and test loads, never a public service.
// Usage: node mock/server.mjs [port] — env MOCK_LATENCY_MS (base), MOCK_ERROR_RATE (0..1 on /orders),
// MOCK_SLOW_AFTER_S + MOCK_SLOW_FACTOR (latency step after N seconds, to make a regression visible),
// MOCK_STALL_EVERY_S + MOCK_STALL_S (the server freezes for STALL_S out of every EVERY_S: a GC pause,
// a lock convoy; what a closed-loop generator under-reports, coordinated omission).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? 9990);
// MOCK_HOST=0.0.0.0 only inside a container; on a machine it stays on loopback.
const host = process.env.MOCK_HOST ?? '127.0.0.1';
const base = Number(process.env.MOCK_LATENCY_MS ?? 5);
const errorRate = Number(process.env.MOCK_ERROR_RATE ?? 0);
const slowAfter = Number(process.env.MOCK_SLOW_AFTER_S ?? Infinity);
const slowFactor = Number(process.env.MOCK_SLOW_FACTOR ?? 1);
const stallEvery = Number(process.env.MOCK_STALL_EVERY_S ?? 0);
const stallFor = Number(process.env.MOCK_STALL_S ?? 0);
const started = Date.now();
const items = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `item ${i + 1}`, price: 10 + i }));
let orders = 0;

const delay = () => {
  const f = (Date.now() - started) / 1000 > slowAfter ? slowFactor : 1;
  // In a stall, a request waits until the stall ends, then is served normally.
  const inCycle = stallEvery ? ((Date.now() - started) / 1000) % stallEvery : Infinity;
  const wait = inCycle < stallFor ? (stallFor - inCycle) * 1000 : 0;
  return new Promise((r) => setTimeout(r, wait + base * f * (0.5 + Math.random())));
};

function send(res, status, body, rid) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': rid });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const rid = req.headers['x-request-id'] ?? randomUUID();
  let body = '';
  for await (const chunk of req) body += chunk;
  await delay();
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true }, rid);
  if (req.method === 'POST' && url.pathname === '/login') {
    const { username } = JSON.parse(body || '{}');
    return username ? send(res, 200, { token: `t-${username}` }, rid) : send(res, 400, { error: 'username required' }, rid);
  }
  if (!String(req.headers.authorization ?? '').startsWith('Bearer t-')) return send(res, 401, { error: 'login first' }, rid);
  if (req.method === 'GET' && url.pathname === '/items') return send(res, 200, { items: items.slice(0, 20) }, rid);
  const m = url.pathname.match(/^\/items\/(\d+)$/);
  if (req.method === 'GET' && m) {
    const it = items.find((x) => x.id === Number(m[1]));
    return it ? send(res, 200, it, rid) : send(res, 404, { error: 'no such item' }, rid);
  }
  if (req.method === 'POST' && url.pathname === '/orders') {
    if (Math.random() < errorRate) return send(res, 500, { error: 'injected' }, rid);
    return send(res, 201, { id: ++orders, status: 'created' }, rid);
  }
  send(res, 404, { error: 'not found' }, rid);
}).listen(port, host, () => console.log(`mock on http://${host}:${port}`));
