import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { create, merge, percentile, round } from './hist.mjs';
import { readJson } from './files.mjs';

const EPS = 1e-6;

// onFile runs every 50 files: a long soak has thousands, and the caller must keep its heartbeat
// going while they are read, or a busy controller looks dead.
export function readWindows(runDir, onFile = () => {}) {
  const out = [];
  let n = 0;
  let workers = [];
  try { workers = readdirSync(join(runDir, 'raw')); } catch { return out; }
  for (const w of workers) {
    let files = [];
    try { files = readdirSync(join(runDir, 'raw', w)); } catch { continue; }
    for (const f of files) if (/^hist-\d+\.json$/.test(f)) {
      const win = readJson(join(runDir, 'raw', w, f));
      if (win) out.push(win);
      if (++n % 50 === 0) onFile(n);
    }
  }
  return out;
}

// Only whole windows inside [from, to) count, so ramps never leak into the measured numbers (PS-D1).
export function selectWindows(windows, windowS, from, to) {
  const start = (w) => (w.origin_s ?? 0) + w.window * windowS;
  return windows.filter((w) => start(w) >= from - EPS && start(w) + windowS <= to + EPS);
}

export function stats(acc, durationS) {
  const h = acc.hist;
  return {
    requests: acc.requests,
    failures: acc.failures,
    error_rate: acc.requests ? round((acc.failures / acc.requests) * 10000) / 10000 : 0,
    rps: durationS > 0 ? round(acc.requests / durationS) : 0,
    p50_ms: percentile(h, 0.5),
    p90_ms: percentile(h, 0.9),
    p95_ms: percentile(h, 0.95),
    p99_ms: percentile(h, 0.99),
    max_ms: h.count ? round(h.max_ms) : null,
    apdex: null,
  };
}

// durationS is the span the samples cover. Whole windows cover slots × window_s; a whole-run
// result passes the time load actually ran, because its last window is partial.
export function mergeWindows(windows, windowS, durationS = null) {
  const total = { requests: 0, failures: 0, hist: create() };
  const endpoints = {};
  const slots = new Set();
  let checks = null;
  // Realtime (perf-standard v1.1 draft, L): players online per window are summed over workers,
  // drops and reconnects add up, tick lag merges like any histogram.
  let rt = null;
  const ccu = new Map();
  const ccuLow = new Map();
  for (const w of windows) {
    slots.add(w.window);
    if (w.realtime) {
      rt ??= { drops: 0, reconnects: 0, tick_lag: create(), period: null };
      if (w.realtime.tick_period) rt.period = w.realtime.tick_period;
      rt.drops += w.realtime.drops;
      rt.reconnects += w.realtime.reconnects;
      merge(rt.tick_lag, w.realtime.tick_lag);
      ccu.set(w.window, (ccu.get(w.window) ?? 0) + w.realtime.ccu_max);
      // The lowest count each worker saw in the window: a dip between samples still shows.
      ccuLow.set(w.window, (ccuLow.get(w.window) ?? 0) + (w.realtime.ccu_min ?? w.realtime.ccu_max));
    }
    if (w.checks) {
      checks ??= { passed: 0, failed: 0 };
      checks.passed += w.checks.passed;
      checks.failed += w.checks.failed;
    }
    for (const [name, e] of Object.entries(w.endpoints)) {
      const acc = (endpoints[name] ??= { requests: 0, failures: 0, hist: create() });
      for (const a of [acc, total]) {
        a.requests += e.requests;
        a.failures += e.failures;
        merge(a.hist, e.hist);
      }
    }
  }
  durationS ??= slots.size * windowS;
  const realtime = rt && {
    ccu_max: Math.max(...ccu.values()), ccu_min: Math.min(...ccuLow.values()),
    drops: rt.drops, reconnects: rt.reconnects,
    drops_per_min: durationS > 0 ? round((rt.drops / durationS) * 60) : 0,
    tick_period_ms: rt.period,
    tick_lag_ms: rt.tick_lag.count ? { count: rt.tick_lag.count, p50: percentile(rt.tick_lag, 0.5), p95: percentile(rt.tick_lag, 0.95), p99: percentile(rt.tick_lag, 0.99), max: round(rt.tick_lag.max_ms) } : null,
  };
  return {
    durationS,
    checks,
    realtime,
    total: stats(total, durationS),
    endpoints: Object.fromEntries(Object.entries(endpoints).map(([k, v]) => [k, stats(v, durationS)])),
    hist: { total: total.hist, endpoints: Object.fromEntries(Object.entries(endpoints).map(([k, v]) => [k, v.hist])) },
  };
}

// One point per window over [from, to): every worker's window summed, its p95 read from the sum.
// With perEndpoint, each point also carries each operation's numbers (a recovery is judged per
// transaction against its SLO).
const point = (a) => ({ requests: a.requests, p95_ms: percentile(a.hist, 0.95), error_rate: a.requests ? round((a.failures / a.requests) * 10000) / 10000 : 0 });
export function windowSeries(windows, windowS, from, to, { perEndpoint = false } = {}) {
  const byIndex = new Map();
  for (const w of selectWindows(windows, windowS, from, to)) {
    const start = (w.origin_s ?? 0) + w.window * windowS;
    const acc = byIndex.get(w.window) ?? { start, requests: 0, failures: 0, hist: create(), endpoints: {} };
    for (const [name, e] of Object.entries(w.endpoints)) {
      const own = (acc.endpoints[name] ??= { requests: 0, failures: 0, hist: create() });
      for (const x of [acc, own]) { x.requests += e.requests; x.failures += e.failures; merge(x.hist, e.hist); }
    }
    byIndex.set(w.window, acc);
  }
  return [...byIndex.values()].sort((a, b) => a.start - b.start).map((a) => ({
    start: round(a.start), ...point(a),
    ...(perEndpoint ? { endpoints: Object.fromEntries(Object.entries(a.endpoints).map(([k, e]) => [k, point(e)])) } : {}),
  }));
}

// Recovery after a spike (CONTRACTS §6). A window is back near the base when its p95 is within
// 20 % + 5 ms of the base's, its errors within 0.5 pp, and it served at least 70 % of the base's
// requests per window. `back` is the first window of two such in a row; `steady_pct` is how
// many of the base's own windows pass the same test.
export function recoveryOf(baseTotal, baseSeries, after) {
  const perWindow = baseTotal.requests / Math.max(1, baseSeries.length);
  const near = (w) => Boolean(w) && w.p95_ms !== null && w.p95_ms <= baseTotal.p95_ms * 1.2 + 5 && w.error_rate <= baseTotal.error_rate + 0.005 && w.requests >= 0.7 * perWindow;
  return {
    back: after.find((w, i) => near(w) && near(after[i + 1])) ?? null,
    steady_pct: baseSeries.length ? Math.round((baseSeries.filter(near).length / baseSeries.length) * 100) : null,
  };
}
