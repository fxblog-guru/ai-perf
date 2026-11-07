import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bottleneck, categorize } from '../lib/analyze.mjs';

// Pillar 1: an exam of cases with known answers (design §13). Each case is a symptom from
// references/bottlenecks.md; the deterministic analysis must name the cause the table names, or
// say plainly that it cannot. A wrong confident answer fails the exam.

// A ramp to steady: p95 flat at 50 ms while rps and the offered load grow, then `after` from the
// knee on, at the top load.
function series(after) {
  const tl = [10, 20, 30, 40].map((rps, i) => ({ t: i * 10, phase: 'ramp', load: (i + 1) * 5, rps, p95_ms: 50, error_rate: 0 }));
  after.forEach((w, i) => tl.push({ t: 40 + i * 10, phase: 'steady', load: 25, error_rate: 0, ...w }));
  return tl;
}
const KNEE = series([{ rps: 41, p95_ms: 180 }, { rps: 40, p95_ms: 260 }]);
const HEALTHY = series([{ rps: 50, p95_ms: 55 }, { rps: 50, p95_ms: 52 }]);
const cpuAt = (value) => [30, 40, 50].map((t) => ({ t, name: 'target_cpu_pct', value, labels: { container: 'db' } }));

const CASES = [
  ['p95 rises with load, target CPU high → CPU-bound, naming the container', KNEE, [], cpuAt(96), /^CPU-bound: db above 85 %/],
  // It names what was watched, and does not clear what was not: a quiet database is not a quiet app.
  ['p95 rises with load, target CPU low → not CPU there: a pool, locks, a dependency, I/O, or an unmonitored part', KNEE, [], cpuAt(20), /^not CPU in db: .*pool.*not monitored/],
  ['p95 rises with load, target not monitored → resource unknown, not a guess', KNEE, [], [], /resource is unknown/],
  ['the generator saturated → the numbers describe the tool', KNEE, [{ kind: 'generator_saturated' }], cpuAt(20), /load generator/],
  ['the generator saturated even without a knee → still the tool', HEALTHY, [{ kind: 'generator_saturated' }], [], /load generator/],
  ['latency flat while throughput grows → no bottleneck claimed', HEALTHY, [], cpuAt(96), null],
  // Latency that grows at a load that has not changed for windows is drift, not saturation.
  ['p95 doubles long after load stopped growing (soak drift) → not a knee', series([{ rps: 41, p95_ms: 52 }, { rps: 41, p95_ms: 60 }, { rps: 40, p95_ms: 180 }]), [], cpuAt(96), null],
  ['latency doubles but throughput still grows → not a knee yet', series([{ rps: 60, p95_ms: 120 }, { rps: 80, p95_ms: 130 }]), [], cpuAt(96), null],
];

for (const [name, tl, problems, cpu, answer] of CASES) {
  test(`exam: ${name}`, () => {
    const b = bottleneck(tl, problems, cpu);
    if (answer === null) assert.equal(b, null, `claimed a bottleneck: ${b?.hint}`);
    else assert.match(b?.hint ?? 'no answer', answer);
  });
}

test('exam: one core pegged on a big machine is not "not CPU": a single-threaded part may be the bottleneck', () => {
  const cores = [30, 40, 50].map((t) => ({ t, name: 'target_cpu_cores', value: 1, labels: { container: 'db' } }));
  assert.match(bottleneck(KNEE, [], cpuAt(6), cores).hint, /^maybe CPU-bound on one thread: db had about 1 cores busy/);
  // Two cores of sixteen, well spread: still not CPU.
  const spread = [30, 40, 50].map((t) => ({ t, name: 'target_cpu_cores', value: 0.5, labels: { container: 'db' } }));
  assert.match(bottleneck(KNEE, [], cpuAt(6), spread).hint, /^not CPU in db/);
});

test('exam: a knee names its evidence (PS-H2: load, latency before and after, resource)', () => {
  const b = bottleneck(KNEE, [], cpuAt(96));
  assert.equal(b.t, 40);
  assert.match(b.evidence, /p95 50 -> 180 ms at t=40s, rps flat at 41, CPU max 96 % \(db\)/);
});

const FAILURES = [
  ['HTTP 503', /overloaded/], ['HTTP 429', /overloaded/],
  ['HTTP 500', /app: server error/], ['HTTP 502', /app: server error/],
  ['HTTP 404', /the request itself is wrong/], ['HTTP 401', /the request itself is wrong/],
  ['ReadTimeout', /timeout/], ['ConnectionResetError', /network: connection/],
  ['something new', /unknown: read the samples/],
];
for (const [cls, answer] of FAILURES) {
  test(`exam: failure "${cls}" goes to the right owner`, () => assert.match(categorize(cls), answer));
}
