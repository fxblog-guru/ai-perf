import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Controller and workers read each other's files every tick. Write-then-rename keeps a reader from
// seeing half a file; on Windows the rename fails while a reader holds the target, so retry briefly.
export function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; } catch (e) {
      if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(5);
    }
  }
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function appendLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readLines(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  // A line can be read while it is still being appended; skip it rather than fail the reader.
  return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
