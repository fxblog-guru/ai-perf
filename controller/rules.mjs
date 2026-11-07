// Hard auto-stop rules. They run in the controller every tick, never in the AI: a runaway test must
// stop in seconds, whatever the session is doing.

export const RULE_METRICS = ['error_rate', 'generator_cpu_pct', 'target_cpu_pct'];

export function checkRule(r) {
  const errs = [];
  if (!RULE_METRICS.includes(r?.metric)) errs.push(`auto_stop: unknown metric ${r?.metric} (known: ${RULE_METRICS.join(', ')})`);
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!num(r?.above)) errs.push(`auto_stop ${r?.metric}: "above" must be a number`);
  if (!(num(r?.for_s) && r.for_s > 0)) errs.push(`auto_stop ${r?.metric}: "for_s" must be a number > 0`);
  if (r?.min_requests !== undefined && !(num(r.min_requests) && r.min_requests >= 0)) errs.push(`auto_stop ${r?.metric}: "min_requests" must be a number >= 0`);
  return errs;
}

// series: one entry per tick, { t, requests, failures, cpu_max } where requests/failures are deltas.
// A rule fires when its metric over the last for_s seconds is above the limit. Error rate is not
// judged on fewer than min_requests; CPU must stay above the limit for the whole span.
export function evaluate(rules, series, t) {
  for (const rule of rules) {
    if (t < rule.for_s) continue;
    const span = series.filter((s) => s.t > t - rule.for_s);
    if (!span.length) continue;
    let value;
    if (rule.metric === 'error_rate') {
      const req = span.reduce((a, s) => a + s.requests, 0);
      if (req < (rule.min_requests ?? 1)) continue;
      value = span.reduce((a, s) => a + s.failures, 0) / req;
    } else if (rule.metric === 'generator_cpu_pct') {
      value = Math.min(...span.map((s) => s.cpu_max));
    } else {
      // Target samples arrive every few seconds; a span with a gap is not judged.
      if (span.some((s) => s.target_cpu === null || s.target_cpu === undefined)) continue;
      value = Math.min(...span.map((s) => s.target_cpu));
    }
    if (value > rule.above) return { rule, value };
  }
  return null;
}

// A recovery test overloads the target on purpose: errors and a pegged CPU during the overload,
// and while it comes back, are what it measures, not a runaway. In that grace the error-rate and
// target-CPU rules give way to one safety bound (almost every request failing for a long while),
// so a target that sheds load is watched coming back instead of being stopped and failed.
export const OVERLOAD_SAFETY = { error_rate: 0.95, min_for_s: 30 };
export function rulesAt(rules, t, grace) {
  if (!grace || t < grace.from_s || t >= grace.to_s) return { rules, eased: false };
  const out = rules.filter((r) => r.metric === 'generator_cpu_pct');
  const errs = rules.filter((r) => r.metric === 'error_rate');
  if (errs.length) out.push({ metric: 'error_rate', above: OVERLOAD_SAFETY.error_rate, for_s: Math.max(OVERLOAD_SAFETY.min_for_s, ...errs.map((r) => r.for_s)), min_requests: Math.max(...errs.map((r) => r.min_requests ?? 1)) });
  return { rules: out, eased: true };
}
