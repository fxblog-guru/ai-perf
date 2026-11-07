// `perf ci` (design §12, the regression gate): the verdict as JUnit XML, so GitLab or any CI shows
// each transaction as a test. FAIL is a failure, NOT EVALUABLE an error (the gate could not
// judge), WARN passes with its reason in system-out.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function junit(v) {
  // The run-level reasons (a regression, failed checks, a broken run) are one more test case.
  const cases = [...v.transactions.map((t) => ({ name: t.name, outcome: t.outcome, why: t.why })),
    { name: 'run', outcome: v.outcome === 'WARN' && !v.reasons.length ? 'PASS' : v.reasons.some((r) => r.startsWith('FAIL')) ? 'FAIL' : v.reasons.some((r) => r.startsWith('NOT_EVALUABLE')) ? 'NOT_EVALUABLE' : 'PASS', why: v.reasons.join('\n') || 'no run-level finding' }];
  const failures = cases.filter((c) => c.outcome === 'FAIL').length;
  const errors = cases.filter((c) => c.outcome === 'NOT_EVALUABLE').length;
  const body = cases.map((c) => {
    const inner = c.outcome === 'FAIL' ? `<failure message="${esc(c.why)}"/>`
      : c.outcome === 'NOT_EVALUABLE' ? `<error message="${esc(`not evaluable: ${c.why}`)}"/>`
        : `<system-out>${esc(c.why)}</system-out>`;
    return `    <testcase classname="ai-perf.${esc(v.profile ?? 'run')}" name="${esc(c.name)}">${inner}</testcase>`;
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ai-perf" tests="${cases.length}" failures="${failures}" errors="${errors}">`,
    `  <testsuite name="ai-perf ${esc(v.run_id)} (${esc(v.environment)}/${esc(v.profile)}): ${v.outcome}" tests="${cases.length}" failures="${failures}" errors="${errors}">`,
    ...body, '  </testsuite>', '</testsuites>', ''].join('\n');
}
