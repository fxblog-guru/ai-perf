import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRIEF_MAX_CHARS, BRIEF_MAX_LINES } from '../lib/memory.mjs';
import { perf, tmp } from './helpers.mjs';
import { ENDPOINTS, project, runFake } from './project.mjs';

// M12: what ai-perf knows about a project, read cheaply (the brief) and shared with the team
// (Recall). The brief is short whatever the project's history; the outbox holds each fact once.
const T = { timeout: 120000 };
const LOAD = { name: 'load', users: 20, warmup_s: 0.5, ramp_s: 0.5, steady_s: 2, rampdown_s: 0.5 };
const P = (root) => join(root, '.perf', 'demo');
const share = (root, ...args) => perf(['share', '--root', root, '--slug', 'demo', ...args]);
const pending = (root) => JSON.parse(share(root).out);

function judgedProject() {
  const root = tmp();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/team/Shop-API.git'], { cwd: root });
  project(root);
  perf(['discover', '--root', root, '--slug', 'demo']);
  runFake(root, { profile: LOAD, engine_options: { endpoints: ENDPOINTS.map((e) => (e.name === 'listItems' ? { ...e, error_rate: 0.05, error_class: 'HTTP 503' } : e)) } });
  perf(['analyze', '--root', root, '--slug', 'demo']);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  return root;
}

test('brief: one short page of what is known, refreshed by every judged run', T, () => {
  const root = judgedProject();
  const b = perf(['brief', '--root', root, '--slug', 'demo']).out;
  for (const s of ['## System', '## Decided', '## Measured', '## Lessons', '## To share']) assert.ok(b.includes(s), s);
  assert.match(b, /workload: closed model, 20 users \(assumed\), 3 journey\(s\)/);
  assert.match(b, /env local: laptop mock; owner test/);
  assert.match(b, /last verdict: (FAIL|WARN|PASS) \(run /);
  assert.match(b, /analyze: Under load, HTTP 503/);
  // perf report wrote it to brief.md, for a skill or a person to open without running anything.
  assert.match(readFileSync(join(P(root), 'brief.md'), 'utf8'), /## Measured/);
  // --step keeps the lessons to that step's.
  assert.doesNotMatch(perf(['brief', '--root', root, '--slug', 'demo', '--step', 'plan']).out, /HTTP 503/);
});

test('brief: a long history costs no more than a short one, and says what it left out', T, () => {
  const root = judgedProject();
  const lp = join(P(root), 'lessons.json');
  const doc = JSON.parse(readFileSync(lp, 'utf8'));
  for (let i = 0; i < 200; i++) doc.lessons.push({ id: `failure:c${i}`, kind: 'system', step: 'analyze', text: `Under load, class ${i} appeared on ${'x'.repeat(300)}.`, runs: ['r'], first_seen: 'r' });
  writeFileSync(lp, JSON.stringify(doc));
  const envs = JSON.parse(readFileSync(join(P(root), 'env.json'), 'utf8'));
  for (let i = 0; i < 40; i++) envs.environments[`stage${i}`] = { allow_hosts: ['127.0.0.1'], owner: 'ops', parity: `rack ${i} ${'y'.repeat(150)}` };
  writeFileSync(join(P(root), 'env.json'), JSON.stringify(envs));
  writeFileSync(join(root, 'found.json'), JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ id: i, kind: 'lesson', title: `team fact ${i}`, body: 'b' }))));
  share(root, '--import', join(root, 'found.json'));
  const b = perf(['brief', '--root', root, '--slug', 'demo']).out.trimEnd();
  assert.ok(b.split('\n').length <= BRIEF_MAX_LINES, `${b.split('\n').length} lines`);
  assert.ok(b.length <= BRIEF_MAX_CHARS, `${b.length} chars`);
  assert.ok(b.split('\n').every((l) => l.length <= 162), 'every line clipped (160 and its "- ")');
  // Every section is still there, each saying what it did not show.
  for (const s of ['## System', '## Decided', '## Measured', '## Lessons', '## From the team']) assert.ok(b.includes(s), s);
  assert.match(b, /… \d+ more in \.perf\/demo\//);
  assert.match(b, /… \d+ more: perf lessons --slug demo/);
  // Only the newest 50 facts from the team are kept.
  assert.equal(JSON.parse(readFileSync(join(P(root), 'recalled.json'), 'utf8')).entries.length, 50);
});

test('share: every fact once, in Recall kinds; tool lessons for everyone, the rest for the project', T, () => {
  const root = judgedProject();
  const out = pending(root);
  const byKey = Object.fromEntries(out.map((e) => [e.key, e]));
  const failure = byKey['lesson:failure:HTTP 503'];
  assert.equal(failure.kind, 'defect_pattern');
  assert.equal(failure.project, 'shop-api');
  assert.deepEqual(failure.tags.slice(0, 2), ['ai-perf', 'demo']);
  const env = byKey['env_note:env:local'];
  assert.match(env.body, /laptop mock; load authorised by test; third parties: payments stubbed/);
  // Assumed numbers are not team knowledge: only what the team confirmed is a decision.
  assert.equal(byKey['decision:workload'], undefined);
  assert.equal(byKey['decision:slo'], undefined);
  for (const e of out) {
    assert.ok(e.body.length <= 2000 && e.title.length <= 120, e.key);
    assert.ok(e.tags[0] === 'ai-perf', e.key);
  }
  // A cleanup that failed is a lesson about running ai-perf: shared with every project, no label.
  writeFileSync(join(P(root), 'data', 'manifest.json'), JSON.stringify({ accounts: { count: 20, source: 'generated' }, cleanup: { command: 'node missing.mjs' }, run_id_prefix: true }));
  runFake(root, { profile: LOAD });
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  const tool = pending(root).find((e) => e.key === 'lesson:cleanup:failed');
  assert.equal(tool.kind, 'lesson');
  assert.equal(tool.project, undefined);
  assert.match(tool.body, /does not fix it itself: a person does/);
  // Shared once for every project on this machine: another project does not push it again.
  perf(['share', '--root', root, '--slug', 'demo', '--pushed', 'lesson:cleanup:failed=rc-1']);
  const other = judgedProject();
  writeFileSync(join(P(other), 'data', 'manifest.json'), JSON.stringify({ accounts: { count: 20, source: 'generated' }, cleanup: { command: 'node missing.mjs' }, run_id_prefix: true }));
  runFake(other, { profile: LOAD });
  perf(['report', '--root', other, '--slug', 'demo', '--bootstrap']);
  assert.equal(pending(other).find((e) => e.key === 'lesson:cleanup:failed'), undefined);
});

test('share: a pushed fact is not pending again until it changes, and then supersedes the old entry', T, () => {
  const root = judgedProject();
  const keys = pending(root).map((e) => e.key);
  assert.match(share(root, '--pushed', `env_note:env:local=rc-42,${keys.filter((k) => k !== 'env_note:env:local').join(',')}`).out, /recorded as in Recall: env_note:env:local/);
  assert.deepEqual(pending(root), []);
  assert.doesNotMatch(perf(['brief', '--root', root, '--slug', 'demo']).out, /## To share/);
  // The lesson flag follows: lessons.md says it is in Recall.
  assert.match(readFileSync(join(P(root), 'lessons.md'), 'utf8'), /in Recall/);
  // The owner confirms the plan: two new decisions, and the environment note changes.
  const w = JSON.parse(readFileSync(join(P(root), 'workload.json'), 'utf8'));
  w.target.source = 'confirmed';
  writeFileSync(join(P(root), 'workload.json'), JSON.stringify(w));
  const e = JSON.parse(readFileSync(join(P(root), 'env.json'), 'utf8'));
  e.environments.local.parity = 'staging copy, half size';
  writeFileSync(join(P(root), 'env.json'), JSON.stringify(e));
  const now = Object.fromEntries(pending(root).map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(now).sort(), ['decision:workload', 'env_note:env:local']);
  assert.equal(now['env_note:env:local'].supersedes_id, 'rc-42');
  assert.equal(now['decision:workload'].supersedes_id, undefined);
  assert.match(now['decision:workload'].body, /closed model of 20 users .*browse 60 %, look 30 %, buy 10 %. Confirmed by the team./);
  // A run that repeats a known lesson changes nothing to share: bodies hold no run counts.
  runFake(root, { profile: LOAD, engine_options: { endpoints: ENDPOINTS.map((x) => (x.name === 'listItems' ? { ...x, error_rate: 0.05, error_class: 'HTTP 503' } : x)) } });
  perf(['analyze', '--root', root, '--slug', 'demo']);
  perf(['report', '--root', root, '--slug', 'demo', '--bootstrap']);
  assert.equal(pending(root).find((x) => x.key.startsWith('lesson:failure')), undefined);
  // A key that is not pending is not recorded.
  assert.match(share(root, '--pushed', 'lesson:nothing').out, /none/);
});

test('share: lessons pushed before shared.json existed are not pushed again', T, () => {
  const root = judgedProject();
  perf(['learn', '--root', root, '--slug', 'demo', '--pushed', 'failure:HTTP 503']);
  assert.equal(pending(root).find((e) => e.key === 'lesson:failure:HTTP 503'), undefined);
});

test('share: a search comes back in its order, the most relevant first in the brief', T, () => {
  const root = judgedProject();
  writeFileSync(join(root, 'a.json'), JSON.stringify([{ id: 1, title: 'old one' }]));
  share(root, '--import', join(root, 'a.json'));
  writeFileSync(join(root, 'b.json'), JSON.stringify([{ id: 2, title: 'best match' }, { id: 1, title: 'old one, refreshed' }, { id: 3, title: 'third' }]));
  share(root, '--import', join(root, 'b.json'));
  const b = perf(['brief', '--root', root, '--slug', 'demo']).out;
  assert.match(b, /## From the team \(Recall\)\n- note: best match\n- note: old one, refreshed\n- note: third/);
});

test('share: no secret leaves the machine, in a fact or in what comes back', T, () => {
  const root = judgedProject();
  const e = JSON.parse(readFileSync(join(P(root), 'env.json'), 'utf8'));
  e.environments.local.parity = 'staging, API_KEY=sk-live-123456 and https://admin:hunter22@db.internal';
  writeFileSync(join(P(root), 'env.json'), JSON.stringify(e));
  const out = share(root).out;
  assert.doesNotMatch(out, /sk-live-123456|hunter22/);
  assert.doesNotMatch(perf(['brief', '--root', root, '--slug', 'demo']).out, /sk-live-123456|hunter22/);
  writeFileSync(join(root, 'found.json'), JSON.stringify({ results: [{ id: 'k1', kind: 'env_note', title: 'db', body: 'PGPASSWORD=topsecret1 psql' }, { id: 'k1', title: 'db again' }, { title: 'no id' }] }));
  assert.match(share(root, '--import', join(root, 'found.json')).out, /from Recall: 1 new, 1 kept/);
  const kept = readFileSync(join(P(root), 'recalled.json'), 'utf8');
  assert.doesNotMatch(kept, /topsecret1/);
  // The same id twice in one search: the first (most relevant) one is kept.
  assert.match(perf(['brief', '--root', root, '--slug', 'demo']).out, /## From the team \(Recall\)\n- env_note: db\n/);
});
