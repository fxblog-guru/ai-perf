// The target's own metrics, beside its CPU: a connection pool, locks, GC, an event loop, a queue.
// Each signal in env.json monitor.signals is one number read every interval, either from an
// endpoint in the Prometheus text format (`scrape`: the app's or an exporter's /metrics) or from a
// Prometheus server (`prometheus`: an instant query). The analysis reads them at the knee, so a
// wait can be named with evidence instead of inferred from a quiet CPU.

// What a kind means, its unit, and the default limit above which it is a bottleneck. A kind
// without a default (queue_depth, custom) needs `above` in env.json.
export const KINDS = {
  pool_used_pct: { unit: '%', above: 95, means: 'a connection pool was full: requests waited for a connection' },
  pool_waiting: { unit: 'requests', above: 0, means: 'requests queued for a pool connection' },
  db_locks_waiting: { unit: 'locks', above: 0, means: 'transactions waited on database locks' },
  db_slow_queries: { unit: 'queries', above: 0, means: 'the database ran slow queries' },
  gc_time_pct: { unit: '%', above: 10, means: 'garbage collection took a large share of the time' },
  event_loop_lag_ms: { unit: 'ms', above: 100, means: 'the event loop was late: synchronous work blocked it' },
  thread_pool_queue: { unit: 'tasks', above: 0, means: 'work queued for a thread: the thread pool was exhausted' },
  queue_depth: { unit: 'messages', above: null, means: 'a queue backed up: consumers fell behind' },
  custom: { unit: '', above: null, means: 'a signal crossed its limit' },
};

export const limitOf = (s) => s.above ?? KINDS[s.kind]?.above ?? null;

// A URL as it may be shown: no user, password, query string or fragment.
export function showUrl(u) {
  try { const x = new URL(u); x.username = ''; x.password = ''; x.search = ''; x.hash = ''; return x.toString(); } catch { return '(not a URL)'; }
}

// The same rule as target_url (controller/spec.mjs): a credential never sits in a URL.
const CREDENTIAL = /\/\/[^/@]*@|[?&](access_token|token|api_?key|key|password|sig)=/i;

// env.json monitor.signals, checked before a run. Returns the errors.
export function checkSignals(signals) {
  const errors = [];
  if (signals === undefined) return errors;
  if (!Array.isArray(signals)) return ['monitor.signals: a list of { name, kind, scrape | prometheus, ... }'];
  signals.forEach((s, i) => {
    const at = `monitor.signals[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${at}: an object`); return; }
    if (!s.name || !/^[\w.-]+$/.test(s.name)) errors.push(`${at}.name: a short name (letters, digits, . _ -)`);
    else if (signals.filter((x) => x?.name === s.name).length > 1) errors.push(`monitor.signals: name ${s.name} is used twice`);
    if (!KINDS[s.kind]) errors.push(`${at}.kind: one of ${Object.keys(KINDS).join(', ')}`);
    const from = ['scrape', 'prometheus'].filter((k) => s[k] !== undefined);
    if (from.length !== 1) errors.push(`${at}: exactly one of scrape (a /metrics URL) or prometheus (a Prometheus server URL)`);
    else if (!/^https?:\/\//.test(String(s[from[0]])) || showUrl(s[from[0]]) === '(not a URL)') errors.push(`${at}.${from[0]}: an http(s) URL`);
    else if (CREDENTIAL.test(String(s[from[0]]))) errors.push(`${at}.${from[0]}: carries a credential; put the token in an environment variable named by auth_env`);
    else if (from[0] === 'prometheus' && new URL(s.prometheus).search) errors.push(`${at}.prometheus: the server's URL, without a query string`);
    if (from[0] === 'scrape' && (!s.metric || !/^[a-zA-Z_:][\w:]*$/.test(s.metric))) errors.push(`${at}.metric: the metric name to read from the scrape`);
    if (from[0] === 'prometheus' && (typeof s.query !== 'string' || !s.query.trim())) errors.push(`${at}.query: the PromQL query`);
    if (from[0] === 'prometheus' && s.metric !== undefined) errors.push(`${at}.metric: only for scrape; a Prometheus signal has a query`);
    if (s.match !== undefined && (typeof s.match !== 'object' || Array.isArray(s.match) || Object.values(s.match).some((v) => typeof v !== 'string'))) errors.push(`${at}.match: labels as { name: "value" }`);
    if (s.counter !== undefined && typeof s.counter !== 'boolean') errors.push(`${at}.counter: true or false`);
    if (s.above !== undefined && (typeof s.above !== 'number' || !Number.isFinite(s.above))) errors.push(`${at}.above: a number`);
    if (s.scale !== undefined && (typeof s.scale !== 'number' || !Number.isFinite(s.scale) || s.scale <= 0)) errors.push(`${at}.scale: a number > 0 that turns the reading into the kind's unit (1000 for seconds to ms, 100 for a ratio to %)`);
    // A counter's rate is per second: a share of time in % needs its scale (seconds per second × 100).
    if (s.counter === true && /_pct$/.test(String(s.kind)) && s.scale === undefined) errors.push(`${at}.scale: a counter of kind ${s.kind} is a rate per second; set the scale that makes it % (100 for seconds per second)`);
    if (KINDS[s.kind] && limitOf(s) === null) errors.push(`${at}.above: kind ${s.kind} has no default limit; set one`);
    if (s.auth_env !== undefined && !/^[A-Z_][A-Z0-9_]*$/i.test(String(s.auth_env))) errors.push(`${at}.auth_env: the name of an environment variable holding a bearer token`);
    const known = ['name', 'kind', 'scrape', 'prometheus', 'metric', 'query', 'match', 'counter', 'scale', 'above', 'auth_env'];
    for (const k of Object.keys(s)) if (!known.includes(k)) errors.push(`${at}.${k}: unknown key`);
  });
  return errors;
}

// The Prometheus text format: `name{label="value",...} value [timestamp]`. Comments and blank
// lines are skipped; label values may hold escaped quotes, commas and braces.
export function parseExposition(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{(?:[^"}]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    if (m[2]) for (const l of m[2].slice(1, -1).matchAll(/([a-zA-Z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2].replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
    // +Inf and -Inf are kept (a histogram's last bucket); a signal refuses them, NaN is no value.
    const value = Number(m[3].replace(/^\+?Inf$/i, 'Infinity').replace(/^-Inf$/i, '-Infinity'));
    if (!Number.isNaN(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

const matches = (labels, match) => Object.entries(match ?? {}).every(([k, v]) => labels[k] === v);

// The signal's value from one scrape: the sum of the series of that metric whose labels match.
// null when no series matches: the metric is absent, never zero.
export function fromScrape(text, s) {
  const series = parseExposition(text).filter((x) => x.name === s.metric && matches(x.labels, s.match));
  return series.length ? series.reduce((a, x) => a + x.value, 0) : null;
}

// The signal's value from a Prometheus instant query: a scalar, or the sum of a vector.
export function fromQuery(body) {
  if (body?.status !== 'success') return null;
  const { resultType, result } = body.data ?? {};
  if (resultType === 'scalar') { const v = Number(result?.[1]); return Number.isFinite(v) ? v : null; }
  if (resultType !== 'vector' || !Array.isArray(result) || !result.length) return null;
  const vs = result.map((r) => Number(r.value?.[1])).filter(Number.isFinite);
  return vs.length ? vs.reduce((a, v) => a + v, 0) : null;
}

async function get(url, s, timeoutMs) {
  const headers = { accept: 'text/plain, application/json' };
  if (s.auth_env && process.env[s.auth_env]) headers.authorization = `Bearer ${process.env[s.auth_env]}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// One reading of one signal: { value } or { error }. Never throws.
export async function read(s, timeoutMs = 4000) {
  try {
    if (s.scrape) {
      const v = fromScrape(await get(s.scrape, s, timeoutMs), s);
      return v === null ? { error: `no series ${s.metric}${s.match ? ` matching ${JSON.stringify(s.match)}` : ''}` } : { value: v };
    }
    // The API sits under the server's path (a Prometheus behind a proxy at /prom/).
    const u = new URL(s.prometheus);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/v1/query`;
    u.search = `?query=${encodeURIComponent(s.query)}`;
    const v = fromQuery(JSON.parse(await get(u.toString(), s, timeoutMs)));
    return v === null ? { error: 'the query returned no number' } : { value: v };
  } catch (e) {
    // An error may quote the URL: whatever reached it, no credential leaves in the text.
    return { error: String(e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.code ?? e?.message ?? e).replace(/\/\/[^/@\s]*@/g, '//') };
  }
}

// Reads every signal once. A counter (`counter: true`) is turned into a rate per second over the
// time since its last reading; its first reading, and one after a reset (the counter went down),
// give no sample. `scale` turns the value into the kind's unit. `prev` keeps the last readings
// between calls. `answered` lists the signals that gave a number, sampled or not.
export async function sample(signals, t, prev = new Map(), now = Date.now) {
  const got = await Promise.all(signals.map((s) => read(s)));
  const samples = [];
  const errors = [];
  const answered = [];
  signals.forEach((s, i) => {
    const g = got[i];
    if (g.error === undefined && !Number.isFinite(g.value)) g.error = `not a finite number (${g.value})`;
    if (g.error !== undefined) { errors.push({ signal: s.name, error: g.error }); return; }
    answered.push(s.name);
    let value = g.value;
    if (s.counter) {
      const p = prev.get(s.name);
      const at = now();
      prev.set(s.name, { value, at });
      if (!p || value < p.value || at <= p.at) return;
      value = (value - p.value) / ((at - p.at) / 1000);
    }
    value *= s.scale ?? 1;
    const unit = KINDS[s.kind].unit + (s.counter && s.scale === undefined ? '/s' : '');
    samples.push({ t, name: 'signal', unit, value: Math.round(value * 1000) / 1000, labels: { signal: s.name, kind: s.kind } });
  });
  return { samples, errors, answered };
}
