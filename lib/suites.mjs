import { readFileSync } from 'node:fs';

// Reading an existing perf suite (design §4): what it loads, how hard, how users pause, what it
// asserts. Pattern reading, not execution: a suite is never run or changed to be understood.
// Each parser returns { operations: [{ name, weight? }], think_s, peak_users, thresholds, facts }
// where facts are the booleans /perf-audit judges.

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const uniq = (xs) => [...new Map(xs.map((x) => [x.name, x])).values()];
const num = (s) => (s === undefined ? null : Number(s));

// "30s", "2m", "1h30m", "500ms" → seconds.
export function seconds(d) {
  let s = 0;
  for (const [, n, u] of String(d).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) s += Number(n) * { ms: 0.001, s: 1, m: 60, h: 3600 }[u];
  return s;
}

function k6(text) {
  // A request's name is its tags.name: a "name" in a request body is data, not an operation.
  const named = [...text.matchAll(/tags\s*:\s*\{[^}]*?\bname\s*:\s*['"`]([\w.:/-]+)['"`]/g)].map((m) => ({ name: m[1], line: lineOf(text, m.index) }));
  const calls = [...text.matchAll(/http\.(get|post|put|patch|del|request|batch)\s*\(/g)];
  const unnamed = calls.filter((m) => !/tags\s*:\s*\{[^}]*name\s*:/.test(text.slice(m.index, text.indexOf('\n', text.indexOf(')', m.index)) + 1)));
  const sleeps = [...text.matchAll(/sleep\s*\(([^)]*)\)/g)].map((m) => m[1]);
  const think = sleeps.map((a) => Number(a.match(/^\s*(\d+(?:\.\d+)?)/)?.[1])).filter(Number.isFinite);
  const vus = [...text.matchAll(/\b(?:vus|target|preAllocatedVUs|maxVUs)\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const thresholds = [];
  // A threshold scoped to one request ({name:listItems}) is that operation's; an unscoped one is the default.
  for (const m of text.matchAll(/['"]?(http_req_duration|http_req_failed)(\{[^}]*\})?['"]?\s*:\s*\[([^\]]*)\]/g)) {
    const op = m[2]?.match(/name\s*:\s*([\w.:/-]+)/)?.[1] ?? null;
    for (const c of m[3].matchAll(/['"]([^'"]+)['"]/g)) {
      const p = c[1].match(/p\((\d+(?:\.\d+)?)\)\s*<\s*(\d+(?:\.\d+)?)/);
      const r = c[1].match(/rate\s*<\s*(\d*\.?\d+)/);
      if (m[1] === 'http_req_duration' && p) thresholds.push({ metric: `p${p[1]}_ms`, below: Number(p[2]), op });
      if (m[1] === 'http_req_failed' && r) thresholds.push({ metric: 'error_rate', below: Number(r[1]), op });
    }
  }
  return {
    operations: uniq(named),
    think_s: think.length ? Math.min(...think) : null,
    peak_users: vus.length ? Math.max(...vus) : null,
    thresholds,
    facts: {
      ramps: /\bstages\s*:|ramping-vus|ramping-arrival-rate/.test(text),
      think: sleeps.length > 0,
      think_random: sleeps.some((a) => /random/i.test(a)),
      checks: /\bcheck\s*\(/.test(text),
      host_from_env: /__ENV\./.test(text),
      literal_hosts: [...text.matchAll(/['"`](https?:\/\/[^'"`/$]+)/g)].map((m) => ({ host: m[1], line: lineOf(text, m.index) })),
      unnamed: unnamed.map((m) => lineOf(text, m.index)),
      per_user_identity: /__VU|exec\.vu|SharedArray|papaparse|open\(/.test(text),
      login: /login|auth|token/i.test(text),
    },
  };
}

function locust(text) {
  const tasks = [...text.matchAll(/@task(?:\((\d+)\))?\s*\n\s*def\s+(\w+)/g)].map((m) => ({ name: m[2], weight: num(m[1]) ?? 1, line: lineOf(text, m.index) }));
  // A request takes the weight of the @task it is in; one in on_start (a login) is setup, run once
  // per user, and has none.
  const defs = [...text.matchAll(/\bdef\s+(\w+)/g)].map((m) => ({ name: m[1], line: lineOf(text, m.index) }));
  const weightAt = (line) => tasks.find((t) => t.name === defs.filter((d) => d.line <= line).at(-1)?.name)?.weight;
  const named = [...text.matchAll(/\bname\s*=\s*['"]([\w.:/-]+)['"]/g)].map((m) => ({ name: m[1], weight: weightAt(lineOf(text, m.index)), line: lineOf(text, m.index) }));
  const calls = [...text.matchAll(/self\.client\.(get|post|put|patch|delete|request)\s*\(([^\n]*)/g)];
  const wait = text.match(/wait_time\s*=\s*(between|constant|constant_pacing|constant_throughput)\s*\(\s*([\d.]+)/);
  // Locust keys an unnamed request by its URL path: a plain path without ids is a usable name.
  const byPath = calls.filter((m) => !/\bname\s*=/.test(m[2])).map((m) => ({ m, path: m[2].match(/^\s*['"](\/[^'"]*)['"]/)?.[1] }))
    .filter((x) => x.path && !/\/\d/.test(x.path)).map((x) => ({ name: x.path, weight: weightAt(lineOf(text, x.m.index)), line: lineOf(text, x.m.index) }));
  return {
    // The request names are what results are keyed by; task names stand in when requests are unnamed.
    operations: uniq(named.length || byPath.length ? [...named, ...byPath] : tasks),
    think_s: wait ? Number(wait[2]) : null,
    peak_users: null,
    thresholds: [],
    facts: {
      ramps: true, // Locust ramps by spawn rate or a LoadTestShape; ai-perf drives it anyway.
      think: Boolean(wait),
      think_random: wait?.[1] === 'between',
      checks: /catch_response\s*=\s*True|\.failure\(/.test(text),
      host_from_env: true,
      literal_hosts: [...text.matchAll(/self\.client\.\w+\(\s*['"](https?:\/\/[^'"/]+)/g)].map((m) => ({ host: m[1], line: lineOf(text, m.index) })),
      // Only the URL argument decides: an id in the path, an f-string, or concatenation.
      unnamed: calls.filter((m) => !/\bname\s*=/.test(m[2]) && /^\s*(?:f['"]|['"][^'"]*\/\d|['"][^'"]*['"]\s*[%+])/.test(m[2])).map((m) => lineOf(text, m.index)),
      per_user_identity: /itertools\.count|uuid|AI_PERF_WORKER|random|csv|queue|feeder/i.test(text),
      login: /login|auth|token/i.test(text),
    },
  };
}

function gatling(text) {
  const named = [...text.matchAll(/http\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => ({ name: m[1], line: lineOf(text, m.index) }));
  const pauses = [...text.matchAll(/pause\s*\(([^)]*)\)/g)].map((m) => m[1]);
  const users = [...text.matchAll(/(?:atOnceUsers|rampUsers|constantConcurrentUsers|rampConcurrentUsers)\s*\(\s*(\d+)/g)].map((m) => Number(m[1]));
  const thresholds = [];
  for (const m of text.matchAll(/percentile(\d)?\s*\.\s*(?:lt|lte)\s*\(\s*(\d+)/g)) thresholds.push({ metric: `p${{ 1: 50, 2: 75, 3: 95, 4: 99 }[m[1] ?? '3'] ?? 95}_ms`, below: Number(m[2]) });
  for (const m of text.matchAll(/failedRequests\s*\.\s*percent\s*\.\s*(?:lt|lte)\s*\(\s*(\d*\.?\d+)/g)) thresholds.push({ metric: 'error_rate', below: Number(m[1]) / 100 });
  return {
    operations: uniq(named),
    think_s: pauses.length ? Math.min(...pauses.map((p) => Number(p.match(/[\d.]+/)?.[0])).filter(Number.isFinite)) : null,
    peak_users: users.length ? Math.max(...users) : null,
    thresholds,
    facts: {
      ramps: /rampUsers|rampConcurrentUsers|rampUsersPerSec|nothingFor/.test(text),
      think: pauses.length > 0,
      think_random: pauses.some((p) => p.includes(',')),
      checks: /\.check\s*\(/.test(text),
      host_from_env: /System\.getProperty|sys\.env|getenv/.test(text),
      literal_hosts: [...text.matchAll(/baseUrl\s*\(\s*"(https?:\/\/[^"/]+)/g)].map((m) => ({ host: m[1], line: lineOf(text, m.index) })),
      unnamed: [],
      per_user_identity: /feed\s*\(|csv\s*\(|Feeders/.test(text),
      login: /login|auth|token/i.test(text),
    },
  };
}

function jmeter(text) {
  const named = [...text.matchAll(/<HTTPSamplerProxy[^>]*testname="([^"]+)"/g)].map((m) => ({ name: m[1], line: lineOf(text, m.index) }));
  const threads = [...text.matchAll(/ThreadGroup\.num_threads">(\d+)</g)].map((m) => Number(m[1]));
  const timers = [...text.matchAll(/(ConstantTimer|UniformRandomTimer|GaussianRandomTimer)[\s\S]*?\.delay">(\d+)</g)];
  return {
    operations: uniq(named),
    think_s: timers.length ? Math.min(...timers.map((m) => Number(m[2]) / 1000)) : null,
    peak_users: threads.length ? Math.max(...threads) : null,
    thresholds: [],
    facts: {
      ramps: /ThreadGroup\.ramp_time">[1-9]/.test(text),
      think: timers.length > 0,
      think_random: timers.some((m) => m[1] !== 'ConstantTimer'),
      checks: /ResponseAssertion|JSONPathAssertion/.test(text),
      host_from_env: /\$\{__P\(|\$\{__env/.test(text),
      literal_hosts: [...text.matchAll(/HTTPSampler\.domain">([^<$]+)</g)].map((m) => ({ host: m[1], line: lineOf(text, m.index) })),
      unnamed: [],
      per_user_identity: /CSVDataSet|__threadNum|__UUID/.test(text),
      login: /login|auth|token/i.test(text),
    },
  };
}

export const PARSERS = { k6, locust, gatling, jmeter };

export function readSuite(path, tool) {
  const text = readFileSync(path, 'utf8');
  return { text, ...PARSERS[tool](text) };
}
