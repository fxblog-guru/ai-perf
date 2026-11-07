import { create, percentile } from '../controller/hist.mjs';

// How sure a regression is. A p95 from a few hundred requests moves by 10 % from sampling alone
// (a principal engineer's simulation: 26 % false regressions at n = 100 under a point rule). So a
// p95 change is judged on its bootstrap distribution: both histograms are resampled, and the change
// counts only when its lower bound clears the PS-F2 limit. Seeded, so a verdict is reproducible.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Resamples n requests from a perf-hist and returns the p95 of each of B resamples.
// The true n is resampled (up to 100,000, beyond which the bound no longer moves): a smaller cap
// would widen the interval past what the data supports.
export function bootstrapP95(hist, { B = 200, cap = 100000, seed = 1 } = {}) {
  const buckets = Object.entries(hist?.buckets ?? {}).map(([b, c]) => [Number(b), c]).sort((x, y) => x[0] - y[0]);
  const total = buckets.reduce((a, [, c]) => a + c, 0);
  if (!total) return [];
  const cum = [];
  let run = 0;
  for (const [, c] of buckets) { run += c; cum.push(run); }
  const n = Math.min(total, cap);
  const next = rng(seed + total);
  const out = [];
  for (let i = 0; i < B; i++) {
    const h = create();
    for (let j = 0; j < n; j++) {
      const r = next() * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > r) hi = mid; else lo = mid + 1; }
      const b = String(buckets[lo][0]);
      h.buckets[b] = (h.buckets[b] ?? 0) + 1;
      h.count++;
    }
    h.max_ms = hist.max_ms;
    out.push(percentile(h, 0.95));
  }
  return out;
}

// The one-sided 95 % lower bound of the relative and absolute p95 change, new against old.
export function p95ChangeBound(oldHist, newHist, opts = {}) {
  const a = bootstrapP95(oldHist, { ...opts, seed: 7 });
  const b = bootstrapP95(newHist, { ...opts, seed: 11 });
  if (!a.length || !b.length) return null;
  const rel = a.map((x, i) => (b[i] - x) / x).sort((x, y) => x - y);
  const abs = a.map((x, i) => b[i] - x).sort((x, y) => x - y);
  const lo = (xs) => xs[Math.floor(0.05 * (xs.length - 1))];
  return { rel_pct: Math.round(lo(rel) * 1000) / 10, abs_ms: Math.round(lo(abs) * 100) / 100 };
}

// A robust line through a series (the median of the pairwise slopes): one noisy point neither
// makes nor hides a trend. Used by trend (across runs) and drift (across a soak's windows).
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function theilSen(ys) {
  const slopes = [];
  for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) slopes.push((ys[j] - ys[i]) / (j - i));
  const slope = median(slopes);
  return { slope, intercept: median(ys.map((y, i) => y - slope * i)) };
}

// The same line through points (x, y), x being time: a gap in the samples does not bend it. Past
// `bins` points, each of `bins` equal time slices is replaced by its median point first: a day of
// memory samples every 5 s is 17 000 points, and pairwise slopes grow with their square.
export function lineXY(xs, ys, bins = 120) {
  let px = xs;
  let py = ys;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  if (xs.length > bins) {
    const width = (hi - lo) / bins || 1;
    const groups = new Map();
    xs.forEach((x, i) => {
      const k = Math.min(bins - 1, Math.floor((x - lo) / width));
      if (!groups.has(k)) groups.set(k, { x: [], y: [] });
      groups.get(k).x.push(x);
      groups.get(k).y.push(ys[i]);
    });
    const ordered = [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k));
    px = ordered.map((g) => median(g.x));
    py = ordered.map((g) => median(g.y));
  }
  const slopes = [];
  for (let i = 0; i < px.length; i++) for (let j = i + 1; j < px.length; j++) if (px[j] !== px[i]) slopes.push((py[j] - py[i]) / (px[j] - px[i]));
  const slope = slopes.length ? median(slopes) : 0;
  return { slope, intercept: median(py.map((y, i) => y - slope * (px[i] - lo))), x0: lo, x1: hi };
}

// The fitted change over the series, in % of its fitted start; null when it cannot be told.
export function drift(ys, xs = ys.map((_, i) => i)) {
  if (ys.length < 4) return null;
  const { slope, intercept, x0, x1 } = lineXY(xs, ys);
  return intercept > 0 ? Math.round(((slope * (x1 - x0)) / intercept) * 1000) / 10 : null;
}
