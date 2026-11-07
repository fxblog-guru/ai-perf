// A small realtime game backend for ai-perf's WebSocket tests: login, matchmaking, moves with acks,
// and a server tick broadcast to every matched player. A WebSocket server (RFC 6455, text frames,
// close, ping) in plain Node, so the bundle keeps no runtime dependency.
// Usage: node mock/game.mjs [port]. Env:
//   MOCK_HOST (127.0.0.1), MOCK_LATENCY_MS (5) per reply, MOCK_MATCH_MS (200) matchmaking wait,
//   MOCK_TICK_MS (50) tick interval, MOCK_TICK_JITTER_MS (0) random extra delay per tick (lag),
//   MOCK_DROP_RATE (0) chance per second that the server drops a connection,
//   MOCK_ERROR_RATE (0) chance that a move is refused ("busy"),
//   MOCK_MAX_PLAYERS (unlimited) connections beyond this are refused, MOCK_TICK_ANNOUNCE_MS (= tick)
//   the tick interval the welcome message claims.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9991);
const env = (k, d) => Number(process.env[k] ?? d);
const LATENCY = env('MOCK_LATENCY_MS', 5);
const MATCH = env('MOCK_MATCH_MS', 200);
const TICK = env('MOCK_TICK_MS', 50);
const JITTER = env('MOCK_TICK_JITTER_MS', 0);
const DROP = env('MOCK_DROP_RATE', 0);
const ERRORS = env('MOCK_ERROR_RATE', 0);
const MAX_PLAYERS = env('MOCK_MAX_PLAYERS', Infinity);
const ANNOUNCE = env('MOCK_TICK_ANNOUNCE_MS', TICK);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(4), Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])]);
  return Buffer.concat([head, body]);
}

// Parses masked client frames from a growing buffer; returns [frames, rest].
function parse(buf) {
  const out = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const op = buf[at] & 0x0f;
    let len = buf[at + 1] & 0x7f;
    let off = at + 2;
    if (len === 126) { if (buf.length - at < 4) break; len = buf.readUInt16BE(at + 2); off = at + 4; }
    else if (len === 127) { if (buf.length - at < 10) break; len = Number(buf.readBigUInt64BE(at + 2)); off = at + 10; }
    const masked = buf[at + 1] & 0x80;
    const end = off + (masked ? 4 : 0) + len;
    if (buf.length < end) break;
    const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), end));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[off + (i % 4)];
    out.push({ op, payload });
    at = end;
  }
  return [out, buf.subarray(at)];
}

const players = new Set();
const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || players.size >= MAX_PLAYERS) return socket.destroy();
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const p = { socket, matched: false, open: true };
  const send = (obj) => { if (p.open) socket.write(frame(JSON.stringify(obj))); };
  const reply = (obj, ms = LATENCY) => setTimeout(() => send(obj), ms);
  send({ type: 'welcome', tick_ms: ANNOUNCE });
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    let frames;
    [frames, buf] = parse(Buffer.concat([buf, d]));
    for (const f of frames) {
      if (f.op === 8) { p.open = false; socket.end(Buffer.from([0x88, 0])); return; }
      if (f.op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload])); continue; }
      if (f.op !== 1) continue;
      let m;
      try { m = JSON.parse(f.payload.toString()); } catch { continue; }
      if (m.type === 'login') reply({ id: m.id, type: 'ok', user: m.user });
      else if (m.type === 'matchmake') setTimeout(() => { p.matched = true; send({ id: m.id, type: 'matched', room: 1 }); }, MATCH);
      else if (m.type === 'move') reply(Math.random() < ERRORS ? { id: m.id, type: 'error', code: 'busy' } : { id: m.id, type: 'ack' });
      else reply({ id: m.id, type: 'error', code: 'unknown' });
    }
  });
  const gone = () => { p.open = false; players.delete(p); };
  socket.on('close', gone);
  socket.on('error', gone);
  players.add(p);
});

// The tick: every TICK ms each matched player gets the server's state, later by up to JITTER ms.
// A fixed timestep, as a game loop runs: tick n is due at start + n × TICK, so a late tick does
// not push every later one back (setInterval would drift).
let seq = 0;
const start = Date.now();
function tick() {
  seq++;
  const s = seq;
  for (const p of players) {
    if (!p.matched) continue;
    const late = JITTER ? Math.random() * JITTER : 0;
    setTimeout(() => { if (p.open) p.socket.write(frame(JSON.stringify({ type: 'tick', seq: s, server_ms: Date.now() }))); }, late);
  }
  setTimeout(tick, Math.max(0, start + (seq + 1) * TICK - Date.now()));
}
setTimeout(tick, TICK);

// Drops: each second, each player is cut with probability DROP, as a flaky network or a crashed
// game server would; the client must notice and reconnect.
if (DROP > 0) setInterval(() => { for (const p of players) if (Math.random() < DROP) p.socket.destroy(); }, 1000);

server.listen(port, process.env.MOCK_HOST ?? '127.0.0.1', () => console.log(`game mock on ws://${process.env.MOCK_HOST ?? '127.0.0.1'}:${port}`));
