// perf-hist/v1: log-linear latency buckets about 1 % wide. Counts add, so merging workers or windows
// is exact within a bucket. Percentiles are read only from a merged histogram: averaging per-worker
// percentiles is wrong whenever workers see different latencies.

export const SCHEMA = 'perf-hist/v1';
export const MIN_MS = 0.1;
export const GROWTH = 1.01;
const LOG_GROWTH = Math.log(GROWTH);

// Bucket 0 holds everything below MIN_MS; bucket b > 0 covers (MIN_MS·G^(b-1), MIN_MS·G^b].
export function bucketOf(ms) {
  if (!(ms > MIN_MS)) return 0;
  return Math.ceil(Math.log(ms / MIN_MS) / LOG_GROWTH - 1e-9);
}

export function upperOf(b) {
  return MIN_MS * GROWTH ** b;
}

export function create() {
  return { schema: SCHEMA, count: 0, max_ms: 0, buckets: {} };
}

export function record(h, ms, n = 1) {
  const b = bucketOf(ms);
  h.buckets[b] = (h.buckets[b] ?? 0) + n;
  h.count += n;
  if (ms > h.max_ms) h.max_ms = ms;
  return h;
}

export function merge(into, from) {
  if (!from) return into;
  for (const [b, n] of Object.entries(from.buckets)) into.buckets[b] = (into.buckets[b] ?? 0) + n;
  into.count += from.count;
  if (from.max_ms > into.max_ms) into.max_ms = from.max_ms;
  return into;
}

// The bucket's upper edge, never above the true max, so p100 equals max_ms.
export function percentile(h, q) {
  if (!h?.count) return null;
  const rank = Math.max(1, Math.ceil(q * h.count));
  let seen = 0;
  for (const b of Object.keys(h.buckets).map(Number).sort((x, y) => x - y)) {
    seen += h.buckets[b];
    if (seen >= rank) return round(Math.min(upperOf(b), h.max_ms));
  }
  return round(h.max_ms);
}

export const round = (x) => Math.round(x * 100) / 100;
