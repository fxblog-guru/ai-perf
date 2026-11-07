import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { shareOf } from '../adapters/engines/kit.mjs';
import { readWindows } from '../controller/merge.mjs';
import { CHECKS } from '../lib/checks.mjs';
import { ROOT, perf, result, runDir, spec, state, tmp, waitFor, writeSpec } from './helpers.mjs';

// M5 exit check (design §15): a WebSocket run against the game mock with CCU and reconnect metrics.
const T = { timeout: 120000 };
const OPS = ['connect', 'login', 'matchmaking', 'move'];

async function startGame(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(ROOT, 'mock', 'game.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, ...env } });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 10000, 'game mock');
  return { url: `ws://127.0.0.1:${port}`, stop: () => child.kill() };
}

function wsRun(root, url, over = {}) {
  copyFileSync(join(ROOT, 'mock', 'game-player.mjs'), join(root, 'game-player.mjs'));
  const s = spec({ engine: 'ws', script: 'game-player.mjs', target_url: url, ...over,
    profile: { name: 'load', users: 20, warmup_s: 1, ramp_s: 1, steady_s: 4, rampdown_s: 0.5, ...over.profile },
    timing: { window_s: 1, ...over.timing }, engine_options: { ...over.engine_options } });
  // A starved test machine (the full suite runs files in parallel) can saturate the ws worker's
  // event loop: the run is then not evaluable or degraded, which is ai-perf telling the truth about
  // the machine, not the engine failing. Such a run is retried, twice at most; any other outcome
  // is returned as it is.
  let r;
  for (let i = 0; i < 3; i++) {
    r = perf(['run', writeSpec(root, s), '--root', root, '--wait'], 90000);
    if (r.code !== 3 && r.code !== 4) return r;
    const problems = state(runDir(root))?.problems ?? [];
    if (!problems.length || !problems.every((p) => ['generator_saturated', 'worker_stalled'].includes(p.kind))) return r;
  }
  return r;
}

function plan(root, realtime) {
  const dir = join(root, '.perf', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'slo.json'), JSON.stringify({ profiles: ['load'], realtime: { ...realtime, source: 'assumed' },
    transactions: ['login', 'move'].map((name) => ({ name, slo: { p95_ms: 500, error_rate: 0.05 }, sla: { p95_ms: 1000, error_rate: 0.5 }, source: 'assumed' })) }));
}

test('kit: whole players split exactly over workers', () => {
  for (const total of [1, 7, 20, 33]) assert.equal([0, 1, 2].reduce((a, i) => a + shareOf(total, i, 3), 0), total);
});

test('ws: players online, every operation timed by its reply, tick lag recorded; CCU holds the plan', T, async () => {
  const game = await startGame();
  try {
    const root = tmp();
    const r = wsRun(root, game.url);
    assert.equal(r.code, 0, r.out);
    const res = result(runDir(root));
    assert.equal(res.run_state, 'done');
    // Players connect, log in and are matched during the ramp; steady holds the moves.
    const seen = new Set(readWindows(runDir(root)).flatMap((w) => Object.keys(w.endpoints)));
    for (const op of OPS) assert.ok(seen.has(op), `${op} measured: ${[...seen]}`);
    assert.ok(res.endpoints.move.requests > 100, `moves in steady: ${res.endpoints.move.requests}`);
    assert.equal(res.total.failures, 0);
    // Matchmaking waits 200 ms on the server; a move is answered in about 5.
    assert.ok(res.endpoints.move.p50_ms < 100, `move p50 ${res.endpoints.move.p50_ms}`);
    assert.deepEqual([res.realtime.ccu_max, res.realtime.ccu_min, res.realtime.drops], [20, 20, 0]);
    assert.ok(res.realtime.tick_lag_ms.count > 100 && res.realtime.tick_lag_ms.p95 < 50, JSON.stringify(res.realtime.tick_lag_ms));
  } finally { game.stop(); }
});

test('ws: the server dropping players shows as drops and reconnects; a drop SLA fails the run', T, async () => {
  const game = await startGame({ MOCK_DROP_RATE: '0.1' });
  try {
    const root = tmp();
    plan(root, { slo: { drops_per_min: 0.5 }, sla: { drops_per_min: 1 } });
    assert.equal(wsRun(root, game.url, { profile: { steady_s: 6 } }).code, 0);
    const res = result(runDir(root));
    assert.ok(res.realtime.drops >= 3, `drops ${res.realtime.drops}`);
    assert.ok(res.realtime.reconnects >= res.realtime.drops - 4, `reconnects ${res.realtime.reconnects} for ${res.realtime.drops} drops`);
    // Players cut and back within a window: the dip shows in the lowest count, not the highest.
    assert.ok(res.realtime.ccu_max === 20 && res.realtime.ccu_min < 20, JSON.stringify(res.realtime));
    const v = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /FAIL: realtime: drops per minute [\d.]+ > SLA 1/);
  } finally { game.stop(); }
});

test('ws: a lagging tick fails the tick-lag SLA; without a realtime plan it is said, not judged', T, async () => {
  const game = await startGame({ MOCK_TICK_JITTER_MS: '150' });
  try {
    const root = tmp();
    plan(root, { slo: { tick_lag_p95_ms: 30 }, sla: { tick_lag_p95_ms: 50 } });
    wsRun(root, game.url);
    const v = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /FAIL: realtime: tick lag p95 [\d.]+ > SLA 50/);
    const slo = JSON.parse(readFileSync(join(root, '.perf', 'demo', 'slo.json'), 'utf8'));
    delete slo.realtime;
    writeFileSync(join(root, '.perf', 'demo', 'slo.json'), JSON.stringify(slo));
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /realtime measured but not judged/);
  } finally { game.stop(); }
});

test('ws: players the server keeps cutting fall below the planned CCU; the verdict says so', T, async () => {
  const game = await startGame({ MOCK_DROP_RATE: '0.5' });
  try {
    const root = tmp();
    plan(root, { ccu_hold_pct: 95 });
    wsRun(root, game.url, { engine_options: { reconnect_ms: 3000 } });
    const res = result(runDir(root));
    assert.ok(res.realtime.ccu_min < 19, JSON.stringify(res.realtime));
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /FAIL: realtime: players online fell to \d+ of 20 planned \(below 95 %\)/);
  } finally { game.stop(); }
});

test('ws: a lost controller stops the kit workers, and their players with them', T, async () => {
  const game = await startGame();
  try {
    const root = tmp();
    copyFileSync(join(ROOT, 'mock', 'game-player.mjs'), join(root, 'game-player.mjs'));
    const s = spec({ engine: 'ws', script: 'game-player.mjs', target_url: game.url, profile: { steady_s: 60 }, engine_options: {} });
    assert.equal(perf(['run', writeSpec(root, s), '--root', root]).code, 0);
    const dir = await waitFor(() => { const d = runDir(root); return d && state(d)?.state === 'steady' && d; }, 30000, 'steady');
    process.kill(state(dir).pid);
    await waitFor(() => state(dir).workers.every((w) => JSON.parse(readFileSync(join(dir, 'raw', w.id, 'status.json'), 'utf8')).reason === 'heartbeat_lost'), 20000, 'workers stopped on heartbeat_lost');
  } finally { game.stop(); }
});

test('ws: a worker whose own event loop is blocked measures itself: the run is NOT EVALUABLE, not a slow server', T, async () => {
  const game = await startGame();
  try {
    const root = tmp();
    // A player script that blocks its worker for 150 ms per move: everything it receives is late.
    writeFileSync(join(root, 'busy-player.mjs'), `export default async function player(vu) {
  await vu.request('login', { user: vu.user });
  await vu.request('matchmake', {});
  while (vu.running) { const end = Date.now() + 150; while (Date.now() < end); await vu.request('move', {}); await vu.think(0.1); }
}
`);
    const s = spec({ engine: 'ws', script: 'busy-player.mjs', target_url: game.url, profile: { users: 2, steady_s: 4 }, timing: { window_s: 1 }, engine_options: {} });
    const r = perf(['run', writeSpec(root, s), '--root', root, '--wait'], 90000);
    assert.equal(r.code, 3, r.out);
    const res = result(runDir(root));
    assert.match(res.problems.find((p) => p.kind === 'generator_saturated')?.detail ?? '', /event loop [\d.]+ ms late \(> 100 ms\)/);
  } finally { game.stop(); }
});

test('plan gate: realtime limits are numbers, SLO never looser than SLA, with a source', () => {
  const root = tmp();
  plan(root, { slo: { tick_lag_p95_ms: 80 }, sla: { tick_lag_p95_ms: 50, drops_per_min: 'x' } });
  const g = CHECKS.plan(root, 'demo');
  assert.equal(g.ok, false);
  assert.match(g.errors.join('\n'), /realtime.sla.drops_per_min must be a number/);
  assert.match(g.errors.join('\n'), /realtime.slo.tick_lag_p95_ms 80 is looser than realtime.sla.tick_lag_p95_ms 50/);
  plan(root, { slo: { tick_lag_ms: 30 }, ccu_hold_pct: 0 });
  const h = CHECKS.plan(root, 'demo').errors.join('\n');
  assert.match(h, /realtime.slo.tick_lag_ms: not a judged limit/);
  assert.match(h, /realtime.ccu_hold_pct: a number in \(0, 100\]/);
});

// ---- from the independent review of M5 ----------------------------------------------------

function script(root, name, body) {
  writeFileSync(join(root, name), body);
  return name;
}

test('ws: refused requests are failures, not drops; players stay online and are not reconnected', T, async () => {
  const game = await startGame({ MOCK_ERROR_RATE: '0.1' });
  try {
    const root = tmp();
    plan(root, { ccu_hold_pct: 95 });
    wsRun(root, game.url);
    const res = result(runDir(root));
    assert.ok(res.endpoints.move.failures > 0, 'refused moves are failures');
    assert.deepEqual([res.realtime.drops, res.realtime.reconnects], [0, 0], JSON.stringify(res.realtime));
    assert.ok(res.realtime.ccu_min >= 19, JSON.stringify(res.realtime));
    assert.doesNotMatch(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /players online fell/);
  } finally { game.stop(); }
});

test('ws: idle players are online: a window with no events still counts them', T, async () => {
  const game = await startGame();
  try {
    const root = tmp();
    plan(root, { ccu_hold_pct: 100 });
    const name = script(root, 'idle-player.mjs', "export default async function player(vu) {\n  await vu.request('login', { user: vu.user });\n  while (vu.running) { await vu.think(3); await vu.request('move', {}); }\n}\n");
    const s = spec({ engine: 'ws', script: name, target_url: game.url, profile: { users: 4, warmup_s: 1, ramp_s: 0, steady_s: 4, rampdown_s: 0.5 }, timing: { window_s: 1 }, engine_options: {} });
    perf(['run', writeSpec(root, s), '--root', root, '--wait'], 90000);
    assert.equal(result(runDir(root)).realtime.ccu_min, 4, JSON.stringify(result(runDir(root)).realtime));
  } finally { game.stop(); }
});

test('ws: a worker that never fills its share is held to the plan from one window into steady', T, async () => {
  const game = await startGame({ MOCK_MAX_PLAYERS: '15', MOCK_DROP_RATE: '0.3' });
  try {
    const root = tmp();
    plan(root, { ccu_hold_pct: 95 });
    wsRun(root, game.url, { profile: { steady_s: 5 } });
    const rt = result(runDir(root)).realtime;
    // The server takes 15 at most, and the dips under that show: the minimum is not a sum of
    // maxima. (ccu_max sums each worker's peak in a window, so it can read a little over 15.)
    assert.ok(rt.ccu_min < 15, JSON.stringify(rt));
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /players online fell to \d+ of 20/);
  } finally { game.stop(); }
});

test('ws: realtime in the plan but not measured is NOT EVALUABLE: no ticks, or an engine without realtime', T, async () => {
  const game = await startGame();
  try {
    const root = tmp();
    plan(root, { slo: { tick_lag_p95_ms: 30 } });
    const name = script(root, 'chat-player.mjs', "export default async function player(vu) {\n  await vu.request('login', { user: vu.user });\n  while (vu.running) { await vu.request('move', {}); await vu.think(0.2); }\n}\n");
    const s = spec({ engine: 'ws', script: name, target_url: game.url, profile: { users: 4, steady_s: 3 }, timing: { window_s: 1 }, engine_options: {} });
    perf(['run', writeSpec(root, s), '--root', root, '--wait'], 90000);
    const r = perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /tick lag p95 is in the plan but was not measured/);
    perf(['run', writeSpec(root, spec({ profile: { steady_s: 1 } })), '--root', root, '--wait']);
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /realtime is in the plan but this run measured none/);
  } finally { game.stop(); }
});

test('ws: a server that announces the wrong tick is measured against its real period, and said so', T, async () => {
  const game = await startGame({ MOCK_TICK_MS: '50', MOCK_TICK_ANNOUNCE_MS: '40' });
  try {
    const root = tmp();
    plan(root, { sla: { tick_lag_p95_ms: 60 } });
    wsRun(root, game.url, { profile: { steady_s: 6 } });
    const rt = result(runDir(root)).realtime;
    // Against the announced 40 ms, lag would grow by 10 ms a tick: seconds by the end.
    assert.ok(rt.tick_lag_ms.p95 < 60, JSON.stringify(rt.tick_lag_ms));
    assert.ok(Math.abs(rt.tick_period_ms.measured - 50) < 2, JSON.stringify(rt.tick_period_ms));
    assert.match(perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']).out, /the server ticks every [\d.]+ ms, not the 40 ms it announces/);
  } finally { game.stop(); }
});

test('ws: a server that accepts TCP but never finishes the handshake fails connect after timeout_ms', T, async () => {
  const { createServer } = await import('node:net');
  const silent = createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    const root = tmp();
    copyFileSync(join(ROOT, 'mock', 'game-player.mjs'), join(root, 'game-player.mjs'));
    const s = spec({ engine: 'ws', script: 'game-player.mjs', target_url: `ws://127.0.0.1:${silent.address().port}`, profile: { users: 2, steady_s: 3 }, timing: { window_s: 1 }, engine_options: { timeout_ms: 800 } });
    perf(['run', writeSpec(root, s), '--root', root, '--wait'], 90000);
    const dir = runDir(root);
    const classes = Object.assign({}, ...state(dir).workers.map((w) => JSON.parse(readFileSync(join(dir, 'raw', w.id, 'status.json'), 'utf8')).error_classes));
    assert.ok(classes.ConnectTimeout > 0, JSON.stringify(classes));
  } finally { silent.close(); }
});
