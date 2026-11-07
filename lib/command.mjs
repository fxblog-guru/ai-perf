import { spawnSync } from 'node:child_process';
import { mask } from './mask.mjs';

// A command a project gives ai-perf to run for it (a volume's seed and count, a scale step's
// `docker compose up --scale api={n}`). It never goes through a shell: the template is split into
// words here, each placeholder filled inside its own word, and the program started with those
// words as its arguments. A value can then never become a second command, whatever it holds, and
// `;`, `&&`, `|` or `$(...)` in a template are plain arguments. Pipes or redirects belong in a
// script the command runs.

// Words separated by spaces; '...' or "..." keeps spaces inside one word. No escapes: a Windows
// path keeps its backslashes.
export function words(template) {
  const out = [];
  let cur = null;
  let quote = null;
  for (const ch of String(template)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur ??= ''; continue; }
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur ?? '') + ch;
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${template}`);
  if (cur !== null) out.push(cur);
  return out;
}

// {name} in any word becomes its value. Values are checked by whoever passes them (a count of
// instances, a row target); an unknown placeholder is left as written.
export const fill = (argv, vars) => argv.map((w) => w.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));

// Runs it and returns { argv, exit_code, stdout, output, duration_s }; output is the tail, masked.
export function runCommand(template, vars = {}, { cwd, env = {}, timeout_s = 600 } = {}) {
  let argv;
  try { argv = fill(words(template), vars); } catch (e) { return { argv: [], exit_code: null, stdout: '', output: e.message, duration_s: 0 }; }
  if (!argv.length) return { argv, exit_code: null, stdout: '', output: 'an empty command', duration_s: 0 };
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: timeout_s * 1000, windowsHide: true });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const why = r.error ? (r.error.code === 'ETIMEDOUT' ? `killed after ${timeout_s} s` : r.error.message) : null;
  return {
    argv: argv.map(mask), exit_code: r.error ? null : r.status, stdout: r.stdout ?? '',
    output: mask([text.slice(-400), why].filter(Boolean).join('\n')), duration_s: Math.round((Date.now() - t0) / 100) / 10,
  };
}
