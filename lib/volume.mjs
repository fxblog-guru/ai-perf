import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../controller/files.mjs';
import { projectDir } from './checks.mjs';
import { runCommand, words } from './command.mjs';

// Volume (data/manifest.json `volume`): is it still fast with production-sized data? The plan gives
// a target size per entity (rows of orders, of tenants), the command that seeds it and the command
// that counts it. ai-perf counts after seeding (perf volume --seed) and again just before every run
// that is not a smoke, and the run keeps what it counted: a run is "at volume" only when every
// entity reached min_pct of its target in that count, never because a seed once said it was done.

export const VOLUME_DEFAULT = { min_pct: 95, timeout_s: 600 };
// Two runs whose counts of an entity are farther apart than this measured another data set.
export const VOLUME_DRIFT_PCT = 5;
const SOURCES = ['contract', 'measured', 'confirmed', 'imported', 'assumed', 'default'];
const isInt = (v) => Number.isInteger(v) && v > 0;

export function checkVolume(vol) {
  if (vol === undefined) return [];
  if (!vol || typeof vol !== 'object' || Array.isArray(vol)) return ['volume: { entities: { <name>: { target, count, seed?, source } }, min_pct? }'];
  const errors = [];
  for (const k of Object.keys(vol)) if (!['entities', 'min_pct', 'timeout_s'].includes(k)) errors.push(`volume.${k}: unknown key`);
  if (vol.min_pct !== undefined && !(typeof vol.min_pct === 'number' && vol.min_pct > 0 && vol.min_pct <= 100)) errors.push('volume.min_pct: a number in (0, 100], the share of each target a run must count to be at volume');
  if (vol.timeout_s !== undefined && !(typeof vol.timeout_s === 'number' && vol.timeout_s > 0)) errors.push('volume.timeout_s: seconds before a seed or count command is killed, > 0');
  const es = vol.entities;
  if (!es || typeof es !== 'object' || Array.isArray(es) || !Object.keys(es).length) { errors.push('volume.entities: at least one entity, e.g. { "orders": { "target": 5000000, "count": "...", "seed": "...", "source": "measured" } }'); return errors; }
  for (const [name, e] of Object.entries(es)) {
    const at = `volume.entities.${name}`;
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) errors.push(`${at}: a name of letters, digits, . _ -`);
    if (!e || typeof e !== 'object') { errors.push(`${at}: { target, count, seed?, source }`); continue; }
    for (const k of Object.keys(e)) if (!['target', 'count', 'seed', 'source'].includes(k)) errors.push(`${at}.${k}: unknown key`);
    if (!isInt(e.target)) errors.push(`${at}.target: the row count production has (or will have), a whole number > 0`);
    for (const k of ['count', 'seed']) {
      if (e[k] === undefined && k === 'seed') continue;
      if (typeof e[k] !== 'string' || !e[k].trim()) { errors.push(`${at}.${k}: a command${k === 'count' ? ' that prints the row count' : ''}`); continue; }
      try { words(e[k]); } catch (x) { errors.push(`${at}.${k}: ${x.message}`); }
    }
    // P3: a size is a number like any other, with its origin.
    if (!SOURCES.includes(e.source)) errors.push(`${at}.source: one of ${SOURCES.join(', ')} (P3: where the production size comes from)`);
  }
  return errors;
}

// The count a command printed: its last line that holds anything, a whole number (5000000,
// 5,000,000, 5_000_000 or 5 000 000). Anything else is no count.
export function parseCount(text) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const n = line.replace(/[,_ ]/g, '');
  return /^\d+$/.test(n) ? Number(n) : null;
}

const fmt = (n) => (n === null || n === undefined ? '?' : n.toLocaleString('en-US'));

// Seeds (when asked) then counts every entity, from the project root. Returns what a run records.
export function countVolume(root, vol, { seed = false } = {}) {
  const minPct = vol.min_pct ?? VOLUME_DEFAULT.min_pct;
  const timeout_s = vol.timeout_s ?? VOLUME_DEFAULT.timeout_s;
  const entities = {};
  for (const [name, e] of Object.entries(vol.entities)) {
    const vars = { entity: name, target: e.target };
    const row = { target: e.target, count: null, pct: null, ok: false };
    entities[name] = row;
    if (seed && e.seed) {
      const s = runCommand(e.seed, vars, { cwd: root, timeout_s, env: { PERF_ENTITY: name, PERF_TARGET: String(e.target) } });
      row.seed = { exit_code: s.exit_code, duration_s: s.duration_s };
      if (s.exit_code !== 0) row.seed.output = s.output;
    }
    const c = runCommand(e.count, vars, { cwd: root, timeout_s, env: { PERF_ENTITY: name, PERF_TARGET: String(e.target) } });
    const n = c.exit_code === 0 ? parseCount(c.stdout) : null;
    if (n === null) { row.error = c.exit_code === 0 ? `the count command printed no count (${c.stdout.trim().split('\n').pop()?.slice(0, 80) || 'nothing'})` : `the count command failed (${c.exit_code === null ? c.output.split('\n').pop() : `exit ${c.exit_code}`})`; continue; }
    row.count = n;
    row.pct = Math.round((n / e.target) * 1000) / 10;
    row.ok = row.pct >= minPct;
  }
  const rows = Object.entries(entities);
  return {
    counted_at: new Date().toISOString(), min_pct: minPct, entities,
    at_volume: rows.every(([, r]) => r.ok),
    short: rows.filter(([, r]) => r.count !== null && !r.ok).map(([k]) => k),
    failed: rows.filter(([, r]) => r.count === null).map(([k]) => k),
  };
}

// "orders 4,980,000 of 5,000,000 (99.6 %)" for every entity.
export const describeVolume = (v) => Object.entries(v.entities).map(([k, r]) => (r.count === null ? `${k} not counted: ${r.error}` : `${k} ${fmt(r.count)} of ${fmt(r.target)} (${r.pct} %)`)).join(', ');

// Why two runs' counts make them another experiment, or null when they measured the same data
// size. Runs without a volume plan both: nothing to compare (the fingerprint holds the plan).
export function volumeDiff(a, b) {
  if (!a && !b) return null;
  if (!a || !b) return [`one run counted its data (${describeVolume(a ?? b)}), the other did not`];
  const out = [];
  for (const k of new Set([...Object.keys(a.entities), ...Object.keys(b.entities)])) {
    const x = a.entities[k]?.count ?? null;
    const y = b.entities[k]?.count ?? null;
    if (x === null || y === null) out.push(`${k} was not counted in ${x === null ? 'the earlier' : 'the later'} run`);
    else if ((Math.abs(x - y) / Math.max(x, y)) * 100 > VOLUME_DRIFT_PCT) out.push(`${k} ${fmt(x)} -> ${fmt(y)} rows`);
  }
  return out.length ? out : null;
}

export function renderVolume(v) {
  const lines = ['# Data volume', '', `${v.at_volume ? 'At volume' : 'NOT at volume'}: every entity must count at least ${v.min_pct} % of its target. Counted ${v.counted_at}.`, '',
    '| Entity | Target | Counted | % | Seeded |', '|---|---|---|---|---|'];
  for (const [k, r] of Object.entries(v.entities)) lines.push(`| ${k} | ${fmt(r.target)} | ${r.count === null ? `not counted: ${r.error}` : fmt(r.count)} | ${r.pct ?? '—'} | ${r.seed ? (r.seed.exit_code === 0 ? `yes, ${r.seed.duration_s} s` : `failed (exit ${r.seed.exit_code ?? 'none'})`) : '—'} |`);
  lines.push('');
  return lines.join('\n');
}

export function writeVolume(root, slug, v) {
  const dir = join(projectDir(root, slug), 'data');
  writeJson(join(dir, 'volume.json'), v);
  writeFileSync(join(dir, 'volume.md'), renderVolume(v));
}
