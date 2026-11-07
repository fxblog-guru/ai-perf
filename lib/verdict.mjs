import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson, writeJson } from '../controller/files.mjs';
import { CHECKS, projectDir } from './checks.mjs';
import { seenBefore } from './learn.mjs';
import { changed } from './fingerprint.mjs';
import { p95ChangeBound } from './stats.mjs';
import { OVERLOAD_SAFETY } from '../controller/rules.mjs';
import { describeVolume, volumeDiff } from './volume.mjs';

// The verdict (design §5.1 step 9, perf-standard E and F). Four outcomes:
//   PASS · WARN (an SLO missed, its SLA met) · FAIL (an SLA breached, a regression, or the target
//   failing under load) · NOT_EVALUABLE (nothing trustworthy to judge). Never a silent pass.
export const EXIT = { PASS: 0, WARN: 0, FAIL: 1, NOT_EVALUABLE: 3 };
const RANK = { PASS: 0, WARN: 1, NOT_EVALUABLE: 2, FAIL: 3 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
// PS-F2 regression thresholds.
export const REGRESSION = { p95_pct: 10, p95_floor_ms: 5, error_pp: 0.5, rps_pct: 10, min_requests: 100 };

export const baselinePath = (root, slug, env, profile) => join(projectDir(root, slug), 'baselines', env, `${profile}.json`);

function judge(name, stats, slo, sla) {
  if (!stats) return { name, outcome: 'NOT_EVALUABLE', why: `${name} is in the plan but was not measured (PS-E3)` };
  const breach = [];
  const miss = [];
  // p95 and the error rate always; p99 when the plan sets it (the tail users meet on a bad day).
  for (const [k, label] of [['p95_ms', 'p95'], ['p99_ms', 'p99'], ['error_rate', 'error rate']]) {
    const v = stats[k];
    if (v === null || v === undefined) continue;
    if (sla?.[k] !== undefined && v > sla[k]) breach.push(`${label} ${v} > SLA ${sla[k]}`);
    else if (slo?.[k] !== undefined && v > slo[k]) miss.push(`${label} ${v} > SLO ${slo[k]}`);
  }
  if (breach.length) return { name, outcome: 'FAIL', why: breach.join('; ') };
  if (miss.length) return { name, outcome: 'WARN', why: `${miss.join('; ')} (SLA met)` };
  return { name, outcome: 'PASS', why: `p95 ${stats.p95_ms} ms, error rate ${stats.error_rate}` };
}

// The same build (a known git sha) measured under the same fingerprint: a difference between the
// two runs is the environment's noise, not the build's.
export const sameBuild = (a, b) => Boolean(a.run.git_sha && a.run.git_sha !== 'unknown' && a.run.git_sha === b.run.git_sha && a.run.git_dirty === false && b.run.git_dirty === false && a.run.fingerprint && changed(a.run.fingerprint, b.run.fingerprint)?.length === 0);

// hists: { cur, base } merged histograms per endpoint (`hist/merged.json`), when both are kept.
export function compareBaseline(res, base, hists = null) {
  const out = { regressions: [], not_compared: [], refused: null };
  if (base.run.environment !== res.run.environment || base.run.profile !== res.run.profile) {
    out.refused = `baseline is ${base.run.environment}/${base.run.profile}, this run is ${res.run.environment}/${res.run.profile} (PS-F3)`;
    return out;
  }
  // Two load tools measure differently (client overhead, connection reuse, the fake engine's
  // numbers are simulated): a difference between them is not a regression or an improvement.
  // tool_version is "<engine> <version>"; a new version of the same engine still compares.
  const tool = (r) => String(r.run.tool_version ?? r.run.tool).split(' ')[0];
  if (tool(base) !== tool(res)) {
    out.refused = `baseline was measured with ${tool(base)}, this run with ${tool(res)}; promote a run of this tool first`;
    return out;
  }
  // Another target or another load level is another experiment (a baseline from before run.users
  // was recorded is compared on target only).
  if (base.run.target !== res.run.target) {
    out.refused = `baseline was taken against ${base.run.target}, this run against ${res.run.target}`;
    return out;
  }
  // Runs of perf scale at another instance count measured another deployment.
  if ((base.run.instances ?? null) !== (res.run.instances ?? null)) {
    out.refused = `baseline ran on ${base.run.instances ?? 'an unrecorded number of'} instance(s), this run on ${res.run.instances ?? 'an unrecorded number of'}; another deployment is another experiment`;
    return out;
  }
  // An open run is defined by its rate (users is only its VU cap); open and closed measure
  // differently. A baseline from before the model was recorded is closed.
  const model = (r) => r.run.model ?? 'closed';
  if (model(base) !== model(res)) {
    out.refused = `baseline is a ${model(base)} model, this run ${model(res)}; they measure differently`;
    return out;
  }
  if (model(res) === 'open' && base.run.arrival_rps !== res.run.arrival_rps) {
    out.refused = `baseline was taken at ${base.run.arrival_rps} arrivals per second, this run at ${res.run.arrival_rps}`;
    return out;
  }
  if (model(res) === 'closed' && base.run.users !== undefined && base.run.users !== res.run.users) {
    out.refused = `baseline was taken at ${base.run.users} users, this run at ${res.run.users}; compare like with like or promote a new baseline`;
    return out;
  }
  // What each run was measured under (lib/fingerprint.mjs): a changed workload, architecture,
  // environment, script or data set makes the earlier run STALE for this one. Nothing is
  // compared, so a refused baseline never adds a regression.
  const diff = changed(base.run.fingerprint, res.run.fingerprint);
  if (diff?.length) {
    out.stale = diff;
    out.refused = `baseline ${base.run.id} is STALE: the ${diff.join(', ')} changed since it was measured; review the change, then promote a new baseline (--bootstrap --promote)`;
    return out;
  }
  // The data each run counted before it started (data/manifest.json volume): the same plan seeded
  // to another size is another data set, as a changed plan is.
  const vol = volumeDiff(base.run.volume, res.run.volume);
  if (vol) {
    out.stale = ['data'];
    out.refused = `baseline ${base.run.id} is STALE: the data volume differs (${vol.join('; ')}); compare runs at the same volume, or promote a new baseline (--bootstrap --promote)`;
    return out;
  }
  if (diff === null) out.unchecked = true;
  for (const [name, cur] of Object.entries(res.endpoints)) {
    const old = base.endpoints?.[name];
    if (!old || old.requests < REGRESSION.min_requests || cur.requests < REGRESSION.min_requests) { out.not_compared.push(name); continue; }
    const dp = cur.p95_ms - old.p95_ms;
    if (dp > REGRESSION.p95_floor_ms && dp / old.p95_ms * 100 > REGRESSION.p95_pct) {
      // With both histograms, the change must hold at the 95 % lower bound of its bootstrap, not
      // only at the point: a few hundred requests move a p95 by 10 % on their own.
      const bound = hists?.cur?.endpoints?.[name] && hists?.base?.endpoints?.[name] ? p95ChangeBound(hists.base.endpoints[name], hists.cur.endpoints[name]) : null;
      // PS-F2 sets the size (10 %, 5 ms); the bootstrap tests that the change is real: its 95 %
      // lower bound must be above zero. A change past PS-F2 that is not significant at this n is
      // said, not called a regression, and not called "noise" either.
      if (!bound) out.regressions.push({ name, what: `p95 ${old.p95_ms} -> ${cur.p95_ms} ms (+${Math.round(dp / old.p95_ms * 100)} %)` });
      else if (bound.rel_pct > 0 && bound.abs_ms > 0) out.regressions.push({ name, what: `p95 ${old.p95_ms} -> ${cur.p95_ms} ms (+${Math.round(dp / old.p95_ms * 100)} %, significant: at least +${bound.rel_pct} % at 95 % confidence)` });
      else (out.within_noise ??= []).push(`${name} p95 +${Math.round(dp / old.p95_ms * 100)} % is not significant at ${cur.requests} and ${old.requests} requests (95 % lower bound ${bound.rel_pct} %)`);
    }
    const de = (cur.error_rate - old.error_rate) * 100;
    if (de > REGRESSION.error_pp) out.regressions.push({ name, what: `error rate +${Math.round(de * 100) / 100} pp` });
  }
  if (base.total?.rps && res.total.rps < base.total.rps * (1 - REGRESSION.rps_pct / 100)) out.regressions.push({ name: 'total', what: `throughput ${base.total.rps} -> ${res.total.rps} rps` });
  const hit = new Set(out.regressions.map((r) => r.name).filter((n) => n !== 'total'));
  const compared = Object.keys(res.endpoints).length - out.not_compared.length;
  // Most compared endpoints worse → systemic (infrastructure, a shared dependency); a few → localized.
  out.scope = !hit.size ? null : hit.size >= Math.max(2, compared / 2) ? 'systemic' : 'localized';
  return out;
}

export function verdict({ root, slug, runDir, bootstrap = false }) {
  const res = readJson(join(runDir, 'result.json'));
  const spec = readJson(join(runDir, 'run.json'));
  // A run still going, or one whose controller died, has no result: that is NOT EVALUABLE (exit 3),
  // never a crash that CI would read as FAIL.
  if (!res) {
    const why = 'NOT_EVALUABLE: no result.json: the run is still going or its controller died (perf status)';
    return { run_id: spec?.run_id ?? basename(runDir), profile: spec?.profile?.name ?? null, environment: spec?.environment ?? null, outcome: 'NOT_EVALUABLE', reasons: [why], transactions: [], baseline: null, notes: [], exit: EXIT.NOT_EVALUABLE };
  }
  const slo = readJson(join(projectDir(root, slug), 'slo.json'));
  const assumptions = readJson(join(projectDir(root, slug), 'assumptions.json')) ?? [];
  const env = readJson(join(projectDir(root, slug), 'env.json'))?.environments?.[spec.environment] ?? {};
  const v = { run_id: res.run.id, profile: res.run.profile, environment: res.run.environment, outcome: 'PASS', reasons: [], transactions: [], baseline: null, notes: [] };
  const add = (outcome, why) => { v.outcome = worse(v.outcome, outcome); v.reasons.push(`${outcome}: ${why}`); };

  const stopReason = readJson(join(runDir, 'state.json'))?.stop_reason ?? '';
  const stepped = Array.isArray(res.steps) && res.steps.length > 0;
  const targetBroke = res.run_state === 'aborted' && /^auto_stop:(error_rate|target_cpu_pct|target_gone)$/.test(stopReason);
  // An auto-stop on errors or target CPU is a finding about the target, not a broken run. On a
  // staircase it is where the target broke: expected, and the capacity is read from the steps.
  if (stepped && targetBroke && stopReason !== 'auto_stop:target_gone') {
    v.notes.push(`the staircase broke: auto-stop (${stopReason}) during step ${(res.steps.find((s) => !s.complete) ?? res.steps.at(-1)).index + 1}; capacity is read from the steps that completed`);
  } else if (targetBroke) {
    // A target that died (even on a staircase) failed: that is a crash, not a capacity.
    const gone = (res.problems ?? []).find((p) => p.kind === 'target_gone');
    add('FAIL', `the target failed under load: run auto-stopped (${stopReason})${gone ? `: ${gone.detail}` : ''}`);
  } else if (res.run_state !== 'done') {
    add('NOT_EVALUABLE', `run ended ${res.run_state}: ${(res.problems ?? []).map((p) => p.kind).join(', ') || 'see problems'}`);
  }

  if (res.run.profile === 'smoke') {
    // Smoke proves wiring only: zero errors, no latency or throughput gate (PS-C3).
    if (res.total.failures > 0) add('FAIL', `smoke had ${res.total.failures} failures`);
    if (res.checks?.failed > 0) add('FAIL', `smoke had ${res.checks.failed} failed business checks`);
  } else if (!slo) {
    add('NOT_EVALUABLE', 'no slo.json: nothing to judge against');
  } else {
    // The run is judged against a plan that passes its own gates (P4): a load run on an unfinished
    // plan, model, environment or data set cannot pass, whatever its numbers.
    for (const step of ['plan', 'model', 'env', 'data']) {
      const g = step === 'env' ? CHECKS.env(root, slug, spec.environment) : CHECKS[step](root, slug);
      if (!g.ok) add('NOT_EVALUABLE', `the ${step} gate fails (perf check ${step}): ${g.errors[0]}`);
    }
    const cut = stepped && judgeCapacity(v, add, res, slo, readJson(join(projectDir(root, slug), 'workload.json')), targetBroke, stopReason);
    // What the transactions are judged on: a staircase's capacity step (or its first when none
    // held), a spike's base (the steady before it: the spike is judged by how the target comes
    // back, not by the SLA it was meant to strain), otherwise the run's window.
    const endpoints = stepped ? (capacityOf(res.steps, slo).cap ?? res.steps[0]).endpoints ?? {} : res.spike ? res.spike.base?.endpoints ?? {} : res.endpoints;
    const judgedRps = stepped ? v.capacity.rps ?? 0 : res.spike ? res.spike.base?.total?.rps ?? 0 : res.total.rps;
    if (res.run.profile === 'recovery') judgeRecovery(v, add, res, slo, stopReason);
    else if (res.spike) judgeSpike(v, add, res, slo);
    judgeMix(v, add, endpoints, readJson(join(projectDir(root, slug), 'workload.json')));
    judgeVolume(v, add, res);
    if (res.run.profile === 'soak') judgeSoak(v, add, res, slo, spec);
    for (const tx of slo.transactions) {
      if (!stepped) {
        const j = judge(tx.name, endpoints[tx.name], tx.slo, tx.sla);
        v.transactions.push(j);
        if (j.outcome !== 'PASS') add(j.outcome, `${j.name}: ${j.why}`);
      }
      // A closed loop waits with the server: during a stall it sends nothing, so the stall is in a
      // few samples only and p95 looks fine (coordinated omission). A p99 ten times the p95 is that
      // signature: the run cannot pass on p95 alone.
      const st = endpoints[tx.name];
      if (!spec.profile?.arrival_rps && tx.sla?.p99_ms === undefined && st?.requests >= 200 && st.p95_ms > 0 && st.p99_ms > 10 * st.p95_ms) {
        add('WARN', `${tx.name}: heavy tail, p99 ${st.p99_ms} ms is ${Math.round(st.p99_ms / st.p95_ms)}× p95 ${st.p95_ms} ms. A closed loop under-samples server stalls (coordinated omission), so p95 understates them: judge p99, or run an open model (profile.arrival_rps)`);
      }
    }
    // Realtime (perf-standard v1.1 draft, L): tick lag and drops against the plan's realtime SLO
    // and SLA, and players held online. Measured but unplanned realtime is said, not judged.
    const rt = res.realtime;
    if (rt && slo.realtime && stepped) {
      v.notes.push(`realtime measured over the whole staircase, not per step, so not judged here (CCU ${rt.ccu_min}-${rt.ccu_max}, tick lag p95 ${rt.tick_lag_ms?.p95 ?? '-'} ms); judge realtime in a load run at the capacity`);
    } else if (rt && slo.realtime) {
      for (const [k, label, value] of [['tick_lag_p95_ms', 'tick lag p95', rt.tick_lag_ms?.p95], ['drops_per_min', 'drops per minute', rt.drops_per_min]]) {
        const sla = slo.realtime.sla?.[k];
        const sl = slo.realtime.slo?.[k];
        // A planned limit with nothing measured is never a pass, SLO or SLA (PS-E3).
        if (value === null || value === undefined) { if (sla !== undefined || sl !== undefined) add('NOT_EVALUABLE', `${label} is in the plan but was not measured`); continue; }
        if (sla !== undefined && value > sla) add('FAIL', `realtime: ${label} ${value} > SLA ${sla}`);
        else if (sl !== undefined && value > sl) add('WARN', `realtime: ${label} ${value} > SLO ${sl} (SLA met)`);
      }
      const hold = slo.realtime.ccu_hold_pct ?? 95;
      const users = res.run.users;
      if (users && rt.ccu_min < (users * hold) / 100) add('FAIL', `realtime: players online fell to ${rt.ccu_min} of ${users} planned (below ${hold} %)`);
      const p = rt.tick_period_ms;
      if (p && Math.abs(p.measured - p.announced) / p.announced > 0.05) v.notes.push(`realtime: the server ticks every ${p.measured} ms, not the ${p.announced} ms it announces; tick lag is measured against the real period`);
    } else if (slo.realtime) {
      add('NOT_EVALUABLE', 'realtime is in the plan but this run measured none (engine ws, or an in-house engine on the kit, records it)');
    } else if (rt) v.notes.push(`realtime measured but not judged: slo.json has no realtime block (CCU ${rt.ccu_min}-${rt.ccu_max}, ${rt.drops} drops, tick lag p95 ${rt.tick_lag_ms?.p95 ?? '-'} ms)`);
    // Business checks an engine evaluates beside the request (k6 check()) count as failures
    // (PS-B8, PS-D3): judged against the strictest error rate the plan allows.
    const checked = (res.checks?.passed ?? 0) + (res.checks?.failed ?? 0);
    if (checked) {
      const rate = res.checks.failed / checked;
      const sla = Math.min(...slo.transactions.map((t) => t.sla?.error_rate ?? Infinity));
      const sloRate = Math.min(...slo.transactions.map((t) => t.slo?.error_rate ?? Infinity));
      const shown = Math.round(rate * 10000) / 10000;
      if (stepped) v.notes.push(`business checks failed ${res.checks.failed} of ${checked} (${shown}) over the whole staircase, steps past its break included; not judged per step`);
      else if (rate > sla && res.spike) add('WARN', `spike: business checks failed ${res.checks.failed} of ${checked} (${shown}) over the run, above the SLA error rate ${sla}; users saw them`);
      else if (rate > sla) add('FAIL', `business checks failed ${res.checks.failed} of ${checked} (${shown}) > SLA error rate ${sla}`);
      else if (rate > sloRate) add('WARN', `business checks failed ${res.checks.failed} of ${checked} (${shown}) > SLO error rate ${sloRate} (SLA met)`);
    }
    if (slo.min_rps && judgedRps < slo.min_rps) add('FAIL', `throughput ${judgedRps} rps${stepped ? ' at the capacity step' : res.spike ? ' in the base' : ''} < minimum ${slo.min_rps}`);
    const basePath = baselinePath(root, slug, res.run.environment, res.run.profile);
    const base = readJson(basePath);
    if (!base) {
      if (bootstrap) v.notes.push('BOOTSTRAP: no baseline exists; judged on SLOs only. Promote this run to start regression checks.');
      else add('NOT_EVALUABLE', `no baseline at baselines/${res.run.environment}/${res.run.profile}.json (PS-F4); rerun with --bootstrap for the first run`);
    } else {
      const hists = stepped ? null : { cur: readJson(join(runDir, res.hist ?? 'hist/merged.json')), base: readJson(basePath.replace(/\.json$/, '.hist.json')) };
      const c = compareBaseline(res, base, hists);
      // A staircase's whole-run numbers mix every step: only its capacity is compared.
      if (stepped) { c.regressions = []; c.within_noise = []; c.scope = null; }
      if (c.within_noise?.length) v.notes.push(`past PS-F2 but not significant, not called a regression; rerun with more requests to decide: ${c.within_noise.join('; ')}`);
      v.baseline = { run_id: base.run.id, ...c };
      // A stale baseline with --bootstrap: judged on SLOs only, so a new baseline can be promoted.
      if (c.stale && bootstrap) v.notes.push(`BOOTSTRAP: ${c.refused}; judged on SLOs only`);
      else if (c.refused) add('NOT_EVALUABLE', c.refused);
      if (c.unchecked) v.notes.push(`baseline ${base.run.id} has no fingerprint (measured before ai-perf 0.3.0): whether the workload, architecture or environment changed since is not checked`);
      // A regression of the same build cannot be the build: say so, and still fail (PS-F2 is the gate).
      if (c.regressions.length && sameBuild(res, base)) v.notes.push(`the baseline is the same build (${res.run.git_sha.slice(0, 8)}) under the same fingerprint: this difference is the environment's noise. Measure it (two runs of one build) before trusting a ${REGRESSION.p95_pct} % gate here`);
      for (const r of c.regressions) add('FAIL', `regression vs ${base.run.id} (${c.scope ?? 'total'}): ${r.name} ${r.what}`);
      if (stepped && !c.refused && !cut) compareCapacity(v, add, res, base, slo);
    }
  }

  // Estimated vs actual cost (pillar 5): a large gap means the next estimate cannot be trusted.
  const actual = (Date.parse(res.run.ended_at) - Date.parse(res.run.started_at)) / 1000;
  if (spec.estimate && Number.isFinite(actual)) {
    v.cost = { estimated_s: spec.estimate.duration_s, actual_s: Math.round(actual) };
    if (actual > spec.estimate.duration_s * 1.5 + 30) v.notes.push(`cost: the run took ${Math.round(actual)} s against an estimate of ${spec.estimate.duration_s} s; find what was slow (start-up, barrier, drain) before estimating the next one`);
  }
  // Cleanup (PS-B6): a run whose cleanup failed may have left its data behind.
  const cl = res.cleanup;
  if (cl && !cl.skipped && cl.exit_code !== 0) add('WARN', `cleanup failed (${cl.exit_code === null ? (/killed after/.test(cl.output ?? '') ? 'timed out' : 'did not start') : `exit ${cl.exit_code}`}): data of run ${res.run.id} may be left behind; run \`${cl.command}\` by hand${cl.output ? ` (${cl.output.split('\n').pop().slice(0, 160)})` : ''}`);
  if (spec.auto_stop_default) v.notes.push('auto-stop: none was planned, so the default applied (error rate above 50 % for 30 s); plan rules from the SLA in the run spec');
  if (res.generator.cpu_max_pct === null) v.notes.push('generator CPU not measured in the window');
  if ((spec.monitor?.metrics ?? 'none') === 'none') v.notes.push('target not monitored: a bottleneck can be located only from response times');
  if (env.parity && env.parity !== 'production-like') v.notes.push(`environment parity: ${env.parity}; numbers are indicative for production`);
  // Once the plan has written SLOs, discover's SLO defaults no longer apply: the plan's own sources do.
  const open = assumptions.filter((a) => a.status !== 'confirmed' && !(slo && a.key.startsWith('slo_')));
  if (open.length) v.notes.push(`rests on ${open.length} unconfirmed assumption(s): ${open.map((a) => `${a.key}=${a.value} (${a.source})`).join('; ')}`);
  const unagreed = (slo?.transactions ?? []).filter((t) => ['imported', 'assumed', 'default'].includes(t.source));
  const defaultErrors = (slo?.transactions ?? []).filter((t) => t.source === 'contract' && ['default', 'assumed'].includes(t.error_rate_source));
  if (defaultErrors.length) v.notes.push(`error-rate limits are defaults, not from the contract: ${defaultErrors.map((t) => t.name).join(', ')}`);
  if (unagreed.length) v.notes.push(`SLOs not agreed with an owner (source imported/assumed/default): ${unagreed.map((t) => t.name).join(', ')}`);
  // P2: what this run repeats from earlier runs (lessons.json, written by perf learn).
  for (const l of seenBefore(root, slug, runDir, res.run.id, v)) v.notes.push(`seen before in ${l.earlier.join(', ')}: ${l.text}`);
  v.summary = summarize(v, res);
  if (v.volume && v.outcome !== 'NOT_EVALUABLE') v.summary += v.volume.at_volume ? ` Measured at the planned data volume: ${describeVolume(v.volume)}.` : ` Measured on less data than planned: ${describeVolume(v.volume)}.`;
  v.exit = EXIT[v.outcome];
  return v;
}

// Stress and capacity: the capacity is the highest step of the unbroken run of steps, from the
// bottom, where every planned transaction met its SLA; it is judged against the planned peak
// (workload.json), and against the baseline's capacity when one was promoted.
const UNIT = { users: 'users', arrival_rps: 'arrivals/s' };
export function capacityOf(steps, slo) {
  const ok = (s) => s.complete && slo.transactions.every((tx) => {
    const e = s.endpoints?.[tx.name];
    return e && tx.sla && e.p95_ms <= tx.sla.p95_ms && e.error_rate <= tx.sla.error_rate && (tx.sla.p99_ms === undefined || e.p99_ms <= tx.sla.p99_ms);
  });
  let cap = null;
  for (const s of steps) { if (ok(s)) cap = s; else break; }
  return { cap, ok };
}
// Returns true when the staircase was cut short by something other than the target breaking.
function judgeCapacity(v, add, res, slo, workload, targetBroke, stopReason) {
  const unit = res.run.model === 'open' ? 'arrival_rps' : 'users';
  const { cap, ok } = capacityOf(res.steps, slo);
  const firstBad = res.steps.find((s) => !ok(s));
  const peak = unit === 'users' ? workload?.target?.users : workload?.target?.arrival_rps;
  v.capacity = {
    unit, value: cap?.[unit] ?? 0, rps: cap?.total?.rps ?? null, peak: peak ?? null,
    headroom: cap && peak ? Math.round((cap[unit] / peak) * 100) / 100 : null,
    steps: res.steps.map((s) => ({ [unit]: s[unit], complete: s.complete, within_sla: ok(s), rps: s.total?.rps ?? null, p95_ms: s.total?.p95_ms ?? null, error_rate: s.total?.error_rate ?? null })),
  };
  // The table of transactions is the capacity step's (or the first step's when none held).
  const at = cap ?? res.steps[0];
  for (const tx of slo.transactions) v.transactions.push(judge(tx.name, at.endpoints?.[tx.name], tx.slo, tx.sla));
  // A step the run did not finish, for a reason other than the target breaking (a stop, a lost
  // worker, the hard deadline), says nothing about the target: neither capacity nor its absence.
  if (firstBad && !firstBad.complete && !targetBroke) {
    add('NOT_EVALUABLE', `capacity: the run ended (${stopReason || res.run_state}) during step ${firstBad.index + 1} (${firstBad[unit]} ${UNIT[unit]}) before it completed${cap ? `; it held ${cap[unit]} ${UNIT[unit]} until then` : ''}`);
    return true;
  }
  if (!cap) add('FAIL', `capacity: no step met the SLA; the first, ${res.steps[0][unit]} ${UNIT[unit]}, already broke it`);
  else if (!peak) v.notes.push(`capacity ${cap[unit]} ${UNIT[unit]}, but workload.json gives no peak to judge it against`);
  else if (cap[unit] < peak) add('FAIL', `capacity ${cap[unit]} ${UNIT[unit]} is below the planned peak of ${peak}`);
  else if (cap[unit] < 1.2 * peak) add('WARN', `capacity ${cap[unit]} ${UNIT[unit]} leaves only ${Math.round((cap[unit] / peak - 1) * 100)} % headroom over the planned peak of ${peak}`);
  if (cap && cap === res.steps.at(-1)) v.notes.push(`every step held: the capacity is at least ${cap[unit]} ${UNIT[unit]}; add a higher step to find where it breaks, or let \`perf run --breakpoint\` climb until it does`);
  return false;
}

// Against a promoted staircase of the same steps: capacity that fell is a regression. Other steps
// are another experiment; a baseline that is not a staircase cannot be compared.
function compareCapacity(v, add, res, base, slo) {
  const unit = res.run.model === 'open' ? 'arrival_rps' : 'users';
  const grid = (steps) => (steps ?? []).map((s) => s[unit]).join(',');
  if (!base.steps?.length) { v.notes.push(`baseline ${base.run.id} is not a staircase: capacity not compared; promote a staircase run`); return; }
  if (grid(base.steps) !== grid(res.steps)) { v.notes.push(`baseline ${base.run.id} climbed other steps (${grid(base.steps)}, this run ${grid(res.steps)}): capacity not compared`); return; }
  const before = capacityOf(base.steps, slo).cap?.[unit] ?? 0;
  const now = capacityOf(res.steps, slo).cap?.[unit] ?? 0;
  v.baseline.capacity_before = before;
  if (now < before) { add('FAIL', `capacity regression vs ${base.run.id}: ${before} -> ${now} ${UNIT[unit]}`); v.baseline.regressions.push({ name: 'capacity', what: `${before} -> ${now}` }); }
}

// Volume: a run is at volume only when the counts taken just before it reach the plan (each
// entity at least min_pct of its target). A volume run on short or uncounted data answers nothing
// about production-sized data: NOT EVALUABLE. Any other run on a project with a volume plan still
// measured something, but on less data than production holds: a WARN, so nobody reads it as more.
export function judgeVolume(v, add, res) {
  const vol = res.run.volume;
  const volumeRun = res.run.profile === 'volume';
  if (!vol) {
    if (volumeRun) add('NOT_EVALUABLE', 'volume: nothing was counted before this run; a volume run needs the volume plan in data/manifest.json (/perf-data)');
    return;
  }
  v.volume = { at_volume: vol.at_volume, min_pct: vol.min_pct, counted_at: vol.counted_at, entities: vol.entities };
  if (vol.at_volume) { v.notes.push(`at volume: ${describeVolume(vol)}, counted before the run`); return; }
  const why = [vol.failed.length && `not counted: ${vol.failed.join(', ')}`, vol.short.length && `under ${vol.min_pct} % of the plan: ${vol.short.join(', ')}`].filter(Boolean).join('; ');
  const text = `the data was short of the volume plan (${why}): ${describeVolume(vol)}; seed it (perf volume --seed) and run again`;
  if (volumeRun) add('NOT_EVALUABLE', `volume: ${text}. This run says nothing about production-sized data`);
  else add('WARN', `volume: ${text}. Numbers on a smaller data set flatter the target`);
}

// Spike: the target must come back to its base within the recovery budget (slo.json spike.recovery_s,
// default 30 s); errors during the spike beyond the SLA are said, since users saw them.
export const SPIKE_DEFAULT = { recovery_s: 30 };
function judgeSpike(v, add, res, slo) {
  const s = res.spike;
  const budget = slo.spike?.recovery_s ?? SPIKE_DEFAULT.recovery_s;
  if (slo.spike?.recovery_s === undefined) v.notes.push(`spike: no recovery budget was planned (slo.json spike.recovery_s), so the default ${budget} s applied`);
  v.spike = { recovered: s.recovered, recovery_s: s.recovery_s, budget_s: budget, peak_p95_ms: s.peak_p95_ms, peak_error_rate: s.peak_error_rate };
  if (!s.base) add('NOT_EVALUABLE', 'spike: no whole window of steady before the spike to compare with; start the spike later (spike.at_s)');
  else if (s.base_steady_pct !== null && s.base_steady_pct < 50) add('NOT_EVALUABLE', `spike: the base is too noisy to measure recovery against: only ${s.base_steady_pct} % of its own windows pass the recovery test; lengthen the windows or the base`);
  else if (!s.recovered && s.observed_after_s < budget) add('NOT_EVALUABLE', `spike: the load ended ${s.observed_after_s} s after the spike, before the ${budget} s recovery budget ran out; recovery cannot be told (lengthen steady after the spike)`);
  else if (!s.recovered) add('FAIL', `spike: the target did not come back to its base (p95 ${s.base.total.p95_ms} ms, errors ${s.base.total.error_rate}) within ${s.observed_after_s} s, more than the ${budget} s budget`);
  else if (s.recovery_s > budget) add('FAIL', `spike: recovery took ${s.recovery_s} s, over the budget of ${budget} s`);
  const sla = Math.min(...slo.transactions.map((t) => t.sla?.error_rate ?? Infinity));
  if (s.peak_error_rate > sla) add('WARN', `spike: errors reached ${s.peak_error_rate} during the spike, above the SLA error rate ${sla}; users saw them`);
}

// Recovery: an overload (the spike shape, held long enough to hurt), then the normal load again.
// It is judged against the plan, not against the base: a window is back when every planned
// transaction measured in it is within its SLO (p95 and error rate), every transaction the normal
// load sent in each of its windows is there again (one that vanished has not recovered), and it
// served at least 70 % of the base's requests per window (a target answering a few requests fast
// has not recovered). A window with no requests at all is not back either. Recovery is the end of
// the first of two such windows in a row in time after the overload, within slo.json
// recovery.recovery_s (else spike.recovery_s, else 30 s). An overload that never took a
// transaction past its SLO proves nothing about recovery: not evaluable, never a pass.
export function withinSlo(w, slo, perWindow, required = []) {
  if (!w) return false;
  const measured = slo.transactions.filter((tx) => w.endpoints?.[tx.name]?.requests > 0);
  return measured.length > 0 && required.every((n) => w.endpoints?.[n]?.requests > 0) && w.requests >= 0.7 * perWindow && measured.every((tx) => {
    const e = w.endpoints[tx.name];
    return e.p95_ms <= tx.slo.p95_ms && e.error_rate <= tx.slo.error_rate;
  });
}
// The transactions a window took past their SLO.
const overSlo = (w, slo) => slo.transactions.filter((tx) => {
  const e = w.endpoints?.[tx.name];
  return e?.requests > 0 && (e.p95_ms > tx.slo.p95_ms || e.error_rate > tx.slo.error_rate);
});
const EPS_S = 1e-6;
// The recovery read from a run's spike block (CONTRACTS §6): the windows on their time grid, a
// missing one counted as not back, the watch measured to where load stopped.
export function recoveryFrom(s, slo) {
  const ws = s.window_s;
  const at = new Map(s.windows.map((w) => [Math.round(w.start / ws), w]));
  const grid = (from, to) => { const out = []; for (let t = from; t + ws <= to + EPS_S; t += ws) out.push({ start: t, w: at.get(Math.round(t / ws)) ?? null }); return out; };
  const steadyFrom = s.windows.length ? Math.min(s.from_s, ...s.windows.map((w) => w.start)) : s.from_s;
  const end = s.end_s ?? (s.windows.length ? s.windows.at(-1).start + ws : s.to_s);
  const ranTo = s.ran_to_s ?? s.to_s;
  const base = s.windows.filter((w) => w.start < s.from_s - EPS_S);
  const during = s.windows.filter((w) => w.start >= s.from_s - EPS_S && w.start < ranTo - EPS_S);
  const after = grid(s.to_s, end);
  const perWindow = base.length ? base.reduce((a, w) => a + w.requests, 0) / base.length : 0;
  // What the normal load sent in every one of its windows must come back; a rare operation that
  // some base windows missed by chance is not required.
  const required = slo.transactions.map((tx) => tx.name).filter((n) => base.length && base.every((w) => w.endpoints?.[n]?.requests > 0));
  const ok = (w) => withinSlo(w, slo, perWindow, required);
  const hurt = [...new Set(during.flatMap((w) => overSlo(w, slo).map((tx) => tx.name)))];
  const i = after.findIndex((g, k) => ok(g.w) && after[k + 1] && ok(after[k + 1].w));
  const back = i >= 0 ? after[i] : null;
  const baseGrid = grid(steadyFrom, s.from_s);
  return {
    overloaded: hurt.length > 0, hurt, recovered: Boolean(back), recovery_s: back ? Math.round((back.start + ws - s.to_s) * 10) / 10 : null,
    observed_after_s: Math.round(Math.max(0, after.length * ws) * 10) / 10,
    base_windows: base.length, base_within_slo_pct: baseGrid.length ? Math.round((baseGrid.filter((g) => ok(g.w)).length / baseGrid.length) * 100) : null,
    overload_s: Math.round(Math.max(0, ranTo - s.from_s) * 10) / 10, planned_overload_s: Math.round((s.to_s - s.from_s) * 10) / 10,
    required,
  };
}
function judgeRecovery(v, add, res, slo, stopReason) {
  const s = res.spike;
  const budget = slo.recovery?.recovery_s ?? slo.spike?.recovery_s ?? SPIKE_DEFAULT.recovery_s;
  if (slo.recovery?.recovery_s === undefined) v.notes.push(slo.spike?.recovery_s !== undefined ? `recovery: no recovery.recovery_s was planned; the spike budget ${budget} s applied` : `recovery: no recovery budget was planned (slo.json recovery.recovery_s), so the default ${budget} s applied`);
  if (!s?.windows) { add('NOT_EVALUABLE', 'recovery: this run has no overload measured window by window (profile.spike on a recovery profile, ai-perf 0.13.0 or later)'); return; }
  const r = recoveryFrom(s, slo);
  v.recovery = { ...r, budget_s: budget, peak_p95_ms: s.peak_p95_ms, peak_error_rate: s.peak_error_rate };
  delete v.recovery.required;
  // The overload safety bound stopped the run: the target was shedding nearly everything for long.
  if (stopReason === 'auto_stop:overload_safety') add('NOT_EVALUABLE', `recovery: the run was stopped by the overload safety bound (errors above ${OVERLOAD_SAFETY.error_rate * 100} %) ${r.overload_s} s into the overload, so its recovery could not be watched; lower or shorten the overload`);
  else if (!r.base_windows) add('NOT_EVALUABLE', 'recovery: no whole window of normal load before the overload to compare with; start the overload later (spike.at_s)');
  else if (r.base_within_slo_pct < 50) add('NOT_EVALUABLE', `recovery: the normal load is not within its SLO in most windows (${r.base_within_slo_pct} %), so "back within SLO" cannot be told; lower the normal load`);
  else if (!r.overloaded) add('NOT_EVALUABLE', `recovery: the overload never took a transaction past its SLO (p95 peaked at ${s.peak_p95_ms} ms): there was nothing to recover from; raise the overload (spike.users or spike.arrival_rps) or hold it longer`);
  else if (r.overload_s < r.planned_overload_s) add('NOT_EVALUABLE', `recovery: the load stopped ${r.overload_s} s into the planned ${r.planned_overload_s} s overload; nothing after it was watched`);
  else if (!r.recovered && r.observed_after_s < budget) add('NOT_EVALUABLE', `recovery: the load ended ${r.observed_after_s} s after the overload, before the ${budget} s budget ran out; whether it comes back cannot be told (lengthen steady after the overload)`);
  else if (!r.recovered) add('FAIL', `recovery: after ${r.overload_s} s of overload (${r.hurt.join(', ')} past the SLO), the target was not back within its SLO in the ${r.observed_after_s} s observed, more than the ${budget} s budget`);
  else if (r.recovery_s > budget) add('FAIL', `recovery: back within its SLO ${r.recovery_s} s after the overload, over the budget of ${budget} s`);
}

// Soak: at constant load nothing may grow. p95 and each container's memory are fitted with a
// robust line over steady; the fitted growth must stay under slo.json soak limits (defaults 20 %
// and 10 %). A soak with too few windows, or no memory, cannot rule out a leak.
export const SOAK_DEFAULT = { max_p95_drift_pct: 20, max_memory_growth_pct: 10 };
export const SOAK_MIN_WINDOWS = 30;
function judgeSoak(v, add, res, slo, spec) {
  const lim = { ...SOAK_DEFAULT, ...slo.soak };
  const defaulted = Object.keys(SOAK_DEFAULT).filter((k) => slo.soak?.[k] === undefined);
  if (defaulted.length) v.notes.push(`soak: no ${defaulted.join(', ')} was planned (slo.json soak), so the default applied (${defaulted.map((k) => `${SOAK_DEFAULT[k]} %`).join(', ')})`);
  const d = res.drift;
  v.drift = d ? { p95_pct: d.p95_pct, memory_pct: d.memory_pct, limits: lim } : null;
  if (res.steps || res.spike) { add('NOT_EVALUABLE', 'soak: a soak holds one constant load; this profile has steps or a spike'); return; }
  if (!d || d.p95_pct === null || d.windows < SOAK_MIN_WINDOWS) { add('NOT_EVALUABLE', `soak: ${d?.windows ?? 'fewer than 4'} steady windows with requests; drift needs at least ${SOAK_MIN_WINDOWS} to be told from noise (lengthen steady or shorten timing.window_s)`); return; }
  if (d.p95_pct > lim.max_p95_drift_pct) add('FAIL', `soak: p95 drifted +${d.p95_pct} % over steady at constant load (limit ${lim.max_p95_drift_pct} %)`);
  for (const [c, pct] of Object.entries(d.memory_pct)) if (pct > lim.max_memory_growth_pct) add('FAIL', `soak: memory of ${c} grew +${pct} % over steady (limit ${lim.max_memory_growth_pct} %): a leak until shown otherwise`);
  if (!Object.keys(d.memory_pct).length) add('WARN', `soak: target memory not measured${(spec.monitor?.metrics ?? 'none') === 'none' ? ' (monitor.metrics is none)' : ' (fewer than 4 samples)'}; a leak cannot be ruled out`);
}

// The mix (PS-B2): what the run sent against what workload.json plans. A journey's weight is its
// share of arrivals in an open model, and its share of virtual users in a closed one; a closed
// user repeats its journey once per cycle (each step's response, here its measured p50, plus the
// think time), so a journey with long think time sends fewer requests per user. An operation is
// off when its share differs by more than 5 pp, or by more than half of its planned share (a rare
// operation never sent fails too), beyond 3 σ of sampling. Requests to operations the plan does
// not have are said too. Under 200 requests the mix is not judged.
export function plannedMix(workload, endpoints = {}) {
  const n = {};
  let total = 0;
  for (const j of workload?.journeys ?? []) {
    const steps = j.steps ?? [];
    const cycle = steps.reduce((a, op) => a + (endpoints[op]?.p50_ms ?? 0) / 1000 + (j.think_time_s ?? 0), 0);
    // Iterations per unit of time: the weight itself (open), or users over their cycle (closed).
    const rate = workload.model === 'closed' && cycle > 0 ? (j.weight_pct ?? 0) / cycle : (j.weight_pct ?? 0);
    for (const op of steps) { n[op] = (n[op] ?? 0) + rate; total += rate; }
  }
  return total ? Object.fromEntries(Object.entries(n).map(([op, x]) => [op, x / total])) : null;
}
export function judgeMix(v, add, endpoints, workload) {
  const plan = plannedMix(workload, endpoints);
  const total = Object.values(endpoints ?? {}).reduce((a, e) => a + (e.requests ?? 0), 0);
  if (!plan || total < 200) return;
  const pct = (x) => Math.round(x * 1000) / 10;
  const off = [];
  for (const [op, p] of Object.entries(plan)) {
    const m = (endpoints[op]?.requests ?? 0) / total;
    const noise = 3 * Math.sqrt((p * (1 - p)) / total);
    if (Math.abs(m - p) > 0.05 + noise || Math.abs(m - p) > 0.5 * p + noise || (m === 0 && p * total >= 5)) off.push(`${op} planned ${pct(p)} %, sent ${pct(m)} %`);
  }
  const extra = Object.entries(endpoints).filter(([op]) => !(op in plan));
  const extraShare = extra.reduce((a, [, e]) => a + e.requests, 0) / total;
  v.mix = { planned: Object.fromEntries(Object.entries(plan).map(([op, p]) => [op, pct(p)])), sent: Object.fromEntries(Object.entries(endpoints).map(([op, e]) => [op, pct(e.requests / total)])) };
  if (off.length) add('WARN', `the mix is not the plan's (workload.json): ${off.join('; ')}. The numbers describe another workload; fix the script's weights`);
  if (extraShare > 0.05) add('WARN', `${pct(extraShare)} % of requests went to operations workload.json does not plan: ${extra.map(([op]) => op).join(', ')}`);
}

// One sentence a business owner can read before anything else.
export function summarize(v, res) {
  if (v.outcome === 'NOT_EVALUABLE') return `The run cannot be judged: ${v.reasons.find((r) => r.startsWith('NOT_EVALUABLE'))?.replace(/^NOT_EVALUABLE: /, '')}.`;
  if (v.capacity) {
    const c = v.capacity;
    const u = UNIT[c.unit];
    if (!c.value) return `It does not hold even the first step (${c.steps[0]?.[c.unit]} ${u}) within the SLA.`;
    return `It holds ${c.value} ${u}${c.rps ? ` (${c.rps} requests/s)` : ''} within the SLA${c.peak ? `; the planned peak is ${c.peak}, so the headroom is ${c.headroom}×` : ''}.`;
  }
  if (v.recovery) {
    const r = v.recovery;
    const at = `${r.overload_s} s of overload at ${res.spike.users ?? res.spike.arrival_rps} ${res.spike.users ? 'users' : 'arrivals/s'}`;
    return r.recovered ? `After ${at}, it was back within its SLO in ${r.recovery_s} s (budget ${r.budget_s} s); p95 peaked at ${r.peak_p95_ms} ms.` : `After ${at}, it was not back within its SLO in the ${r.observed_after_s} s observed; p95 peaked at ${r.peak_p95_ms} ms.`;
  }
  if (v.spike) {
    const s = v.spike;
    const at = `a spike to ${res.spike.users ?? res.spike.arrival_rps} ${res.spike.users ? 'users' : 'arrivals/s'}`;
    if (!res.spike.base) return `After ${at}, recovery cannot be judged: no steady before the spike.`;
    return s.recovered ? `After ${at}, it came back in ${s.recovery_s} s (budget ${s.budget_s} s); p95 peaked at ${s.peak_p95_ms} ms.` : `After ${at}, it did not come back before the load ended; p95 peaked at ${s.peak_p95_ms} ms.`;
  }
  if (v.drift?.p95_pct !== undefined && v.drift.p95_pct !== null) {
    const mem = Object.entries(v.drift.memory_pct);
    return `At constant load, p95 moved ${v.drift.p95_pct >= 0 ? '+' : ''}${v.drift.p95_pct} % over steady${mem.length ? `, memory ${mem.map(([c, p]) => `${c} ${p >= 0 ? '+' : ''}${p} %`).join(', ')}` : ' (memory not measured)'}.`;
  }
  if (v.profile === 'smoke') return v.outcome === 'FAIL' ? `The smoke run failed: ${v.reasons[0]?.replace(/^FAIL: /, '') ?? 'see below'}.` : `The wiring works: ${res?.total?.requests ?? 0} requests, no failure.`;
  const missed = v.transactions.filter((t) => t.outcome !== 'PASS');
  const load = `At ${res?.run?.model === 'open' ? `${res.run.arrival_rps} arrivals/s` : `${res?.run?.users} users`} (${res?.total?.rps} requests/s)`;
  if (!missed.length && v.outcome === 'PASS') return `${load}, every planned transaction met its SLO.`;
  return `${load}: ${missed.length ? missed.map((t) => `${t.name} ${t.outcome === 'FAIL' ? 'broke its SLA' : t.outcome === 'WARN' ? 'missed its SLO' : 'was not measured'}`).join(', ') : v.reasons[0]}.`;
}

export function render(v) {
  const lines = [`# Verdict: ${v.outcome}`, '', v.summary ?? '', '', `Run \`${v.run_id}\` · profile ${v.profile} · environment ${v.environment}`, ''];
  if (v.capacity) lines.push('## Capacity', '', `| ${v.capacity.unit} | rps | p95 ms | error rate | within SLA |`, '|---|---|---|---|---|', ...v.capacity.steps.map((s) => `| ${s[v.capacity.unit]} | ${s.rps ?? '—'} | ${s.p95_ms ?? '—'} | ${s.error_rate ?? '—'} | ${!s.complete ? 'not completed' : s.within_sla ? 'yes' : 'no'} |`), '');
  if (v.reasons.length) lines.push('## Why', '', ...v.reasons.map((r) => `- ${r}`), '');
  if (v.transactions.length) lines.push('## Transactions', '', '| Transaction | Outcome | Detail |', '|---|---|---|', ...v.transactions.map((t) => `| ${t.name} | ${t.outcome} | ${t.why} |`), '');
  if (v.baseline) lines.push('## Baseline', '', `Compared with \`${v.baseline.run_id}\`${v.baseline.scope ? `: ${v.baseline.scope} regression` : ''}.`, v.baseline.not_compared.length ? `Not compared (too few requests): ${v.baseline.not_compared.join(', ')}.` : '', '');
  if (v.notes.length) lines.push('## Read with care', '', ...v.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}

export function writeVerdict(root, slug, runDir, v) {
  writeJson(join(runDir, 'verdict.json'), v);
  writeFileSync(join(runDir, 'verdict.md'), render(v));
  writeFileSync(join(projectDir(root, slug), 'verdict.md'), render(v));
}

// PS-F1: only a signed-off run becomes the baseline: done, and PASS or WARN.
export function promote(root, slug, runDir) {
  const v = readJson(join(runDir, 'verdict.json'));
  const res = readJson(join(runDir, 'result.json'));
  if (!v || !['PASS', 'WARN'].includes(v.outcome) || res.run_state !== 'done') {
    return { ok: false, why: `only a done run with a PASS or WARN verdict is promoted (this one: ${res?.run_state}, ${v?.outcome ?? 'no verdict'})` };
  }
  const to = baselinePath(root, slug, res.run.environment, res.run.profile);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(runDir, 'result.json'), to);
  // Its histograms too, so a later comparison can tell a change from sampling noise.
  try { copyFileSync(join(runDir, res.hist ?? 'hist/merged.json'), to.replace(/\.json$/, '.hist.json')); } catch { /* an old run without them: compared on points */ }
  return { ok: true, path: to };
}
