// A stand-in for a target's own metrics: a /metrics endpoint in the Prometheus text format, and a
// Prometheus server's instant query API that answers a bare metric name.
// node mock/metrics-server.mjs <port> '<plan json>'
// plan: { "<metric>": { "labels": {...}, "from": 5, "to": 50, "at_s": 20, "counter_per_s": 0 } }
// A gauge is `from` until `at_s` seconds after start, or until /metrics has answered `after_n`
// times (a reading that rises as a run goes on, whenever it started), then `to`. A counter grows
// by counter_per_s. MOCK_TOKEN set: every request needs `Authorization: Bearer <token>`.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9993);
const plan = JSON.parse(process.argv[3] ?? '{}');
const started = Date.now();
let scrapes = 0;
const value = (p) => {
  const s = (Date.now() - started) / 1000;
  if (p.counter_per_s) return Math.round(p.counter_per_s * s);
  return s >= (p.at_s ?? Infinity) || scrapes > (p.after_n ?? Infinity) ? p.to : p.from;
};
const labels = (l) => (l && Object.keys(l).length ? `{${Object.entries(l).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '');

createServer((req, res) => {
  if (process.env.MOCK_TOKEN && req.headers.authorization !== `Bearer ${process.env.MOCK_TOKEN}`) { res.writeHead(401); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/metrics') {
    scrapes++;
    const lines = ['# HELP mock a stand-in', '# TYPE mock gauge'];
    for (const [name, p] of Object.entries(plan)) lines.push(`${name}${labels(p.labels)} ${value(p)}`);
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(`${lines.join('\n')}\n`);
    return;
  }
  if (url.pathname === '/api/v1/query') {
    const p = plan[url.searchParams.get('query')];
    const body = { status: 'success', data: { resultType: 'vector', result: p ? [{ metric: p.labels ?? {}, value: [Date.now() / 1000, String(value(p))] }] : [] } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`metrics-server ${port}`));
