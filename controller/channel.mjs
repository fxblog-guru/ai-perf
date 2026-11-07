import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './files.mjs';

// The network control channel (CONTRACTS §3b): workers on other machines run the worker protocol
// against files on their own disk, and an agent (bin/perf-agent.mjs) mirrors those files to and
// from the controller's run folder over HTTP. The engines and the controller logic do not change:
// control.json comes down, status.json, histogram windows and sampled errors go up.
//
// Every request carries the run's token (random per run). The channel serves one run and closes
// with it. Requests are small JSON files; anything else is refused.
const FILE = /^(?:status\.json|hist-\d+\.json|errors\.ndjson)$/;
const MAX_BODY = 32 * 1024 * 1024;

// The port written in an advertise URL, even the default one (URL drops ":80").
export const advertisedPort = (advertise) => Number(String(advertise ?? '').match(/^https?:\/\/[^/:]+:(\d+)/)?.[1] ?? 0);

export async function openChannel({ runDir, spec, bind = '0.0.0.0', port = 0, advertise }) {
  const token = randomBytes(32).toString('hex');
  const want = Buffer.from(`Bearer ${token}`);
  const authorised = (req) => { const got = Buffer.from(String(req.headers.authorization ?? '')); return got.length === want.length && timingSafeEqual(got, want); };
  const workers = new Set(Array.from({ length: spec.workers }, (_, i) => `w${i}`));
  const seen = new Map(); // worker -> { at, skew_ms }

  const server = createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'x-perf-time': String(Date.now()) });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (!authorised(req)) return send(401, { error: 'bad token' });
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/v1/run') return send(200, readJson(join(runDir, 'run.json')));
      if (req.method === 'GET' && url.pathname === '/v1/control') return send(200, readJson(join(runDir, 'control.json')) ?? {});
      if (req.method === 'GET' && url.pathname === '/v1/script') {
        if (!spec.script_path) return send(404, { error: 'no script' });
        return send(200, readFileSync(spec.script_path), 'application/octet-stream');
      }
      // PUT /v1/workers/<id>/<file>
      if (req.method === 'PUT' && parts[0] === 'v1' && parts[1] === 'workers' && workers.has(parts[2]) && FILE.test(parts[3] ?? '') && parts.length === 4) {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
        // Whatever a body holds, the controller lives on: a bad one is refused, a failed write is a 500.
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks);
            const dir = join(runDir, 'raw', parts[2]);
            let value = null;
            if (parts[3].endsWith('.json')) {
              try { value = JSON.parse(body.toString('utf8')); } catch { return send(400, { error: 'not JSON' }); }
              if (!value || typeof value !== 'object' || Array.isArray(value)) return send(400, { error: 'not a JSON object' });
              if (parts[3] === 'status.json') {
                if (!Number.isFinite(value.ts) || typeof value.state !== 'string') return send(400, { error: 'a status needs ts and state' });
                // A child process or container named by a remote worker lives on its machine.
                delete value.child;
              }
            }
            mkdirSync(dir, { recursive: true });
            if (value) writeJson(join(dir, parts[3]), value);
            else writeFileSync(join(dir, parts[3]), body);
            if (parts[3] === 'status.json') seen.set(parts[2], { at: Date.now(), skew_ms: Number.isFinite(value.clock_skew_ms) ? value.clock_skew_ms : null, host: typeof value.host === 'string' ? value.host.slice(0, 100) : null });
            return send(204, '');
          } catch (e) { return send(500, { error: String(e.message).slice(0, 200) }); }
        });
        return undefined;
      }
      return send(404, { error: 'unknown' });
    } catch (e) {
      return send(500, { error: String(e.message).slice(0, 200) });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  const actual = server.address().port;
  const base = new URL(advertise ?? `http://127.0.0.1`);
  if (!advertisedPort(advertise)) base.port = String(actual);
  return {
    url: base.origin, token, port: actual, seen,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
