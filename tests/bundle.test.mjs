import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT } from './helpers.mjs';
import { CHECKS } from '../lib/checks.mjs';

// The bundle is software too: commands point at real skills, links resolve, frontmatter parses,
// and every `perf <sub>` a skill tells the AI to run exists.
const read = (p) => readFileSync(p, 'utf8');
const skills = readdirSync(join(ROOT, 'skills'));
const commands = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'));
const docs = [...skills.map((s) => join(ROOT, 'skills', s, 'SKILL.md')), ...commands.map((c) => join(ROOT, 'commands', c))];
const CLI = read(join(ROOT, 'bin', 'perf.mjs'));
const SUBCOMMANDS = [...CLI.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    const key = line.slice(0, i);
    const value = line.slice(i + 2);
    // A plain YAML scalar may not contain ": " — quote it.
    if (!/^".*"$/.test(value) && value.includes(': ')) throw new Error(`${key}: unquoted ": " in ${JSON.stringify(value)}`);
    out[key] = /^".*"$/.test(value) ? JSON.parse(value) : value;
  }
  return out;
}

test('the frontmatter parser rejects an unquoted ": " and accepts a quoted one', () => {
  assert.throws(() => frontmatter('---\ndescription: State of a run: phase and workers\n---\n'), /unquoted ": "/);
  assert.equal(frontmatter('---\ndescription: "State of a run: phase"\n---\n').description, 'State of a run: phase');
});

test('every skill has valid frontmatter: name = folder, a description under 1024 chars', () => {
  for (const s of skills) {
    const fm = frontmatter(read(join(ROOT, 'skills', s, 'SKILL.md')));
    assert.equal(fm?.name, s, s);
    assert.ok(fm.description && fm.description.length <= 1024, s);
  }
});

test('every command has valid frontmatter and points at a skill that exists', () => {
  for (const c of commands) {
    const text = read(join(ROOT, 'commands', c));
    assert.ok(frontmatter(text)?.description, c);
    for (const m of text.matchAll(/`([a-z]+(?:-[a-z]+)+)` skill/g)) assert.ok(skills.includes(m[1]), `${c} -> ${m[1]}`);
  }
});

test('every relative link in skills and commands resolves', () => {
  const files = [...docs, ...skills.flatMap((s) => {
    const r = join(ROOT, 'skills', s, 'references');
    return existsSync(r) ? readdirSync(r).map((f) => join(r, f)) : [];
  })];
  for (const f of files) {
    for (const m of read(f).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^https?:/.test(m[1])) continue;
      assert.ok(existsSync(resolve(dirname(f), m[1])), `${f}: ${m[1]}`);
    }
  }
});

test('every `perf <sub>` a skill or command mentions is a real subcommand', () => {
  for (const f of docs) {
    for (const m of read(f).matchAll(/`perf ([a-z]+)/g)) assert.ok(SUBCOMMANDS.includes(m[1]), `${f}: perf ${m[1]}`);
  }
});

test('every lifecycle gate is named by the skill that owns it', () => {
  const owner = { import: 'importing-perf-suite', plan: 'planning-perf-tests', model: 'modeling-workload', env: 'checking-perf-environment', data: 'preparing-perf-data', script: 'generating-load-script' };
  for (const step of Object.keys(CHECKS)) assert.match(read(join(ROOT, 'skills', owner[step], 'SKILL.md')), new RegExp(`perf check ${step} --slug`), step);
});

test('the perf-result schema is byte-identical to stlc\'s canonical copy when stlc is next door', () => {
  const canonical = join(ROOT, '..', 'stlc', 'skills', 'generating-perf-script', 'references', 'perf-result.schema.json');
  if (!existsSync(canonical)) return;
  assert.equal(read(join(ROOT, 'schemas', 'perf-result.schema.json')), read(canonical));
});
