import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/**
 * Which of `needles` some live process on this host still references: as a
 * substring of its argv or of the environment it was started with (TMPDIR=…,
 * a bwrap bind source, a Gateway socket path), or as its cwd (equal or below).
 *
 * A read-only liveness probe for sweeps that delete per-session directories —
 * never a way to pick processes to signal. Returns null where /proc does not
 * exist (macOS): the caller cannot tell and must rely on its other guards.
 */
export function findLiveProcessReferences(
  needles: readonly string[],
  procRoot = '/proc',
): Set<string> | null {
  if (procRoot === '/proc' && process.platform !== 'linux') return null;
  let pids: string[];
  try { pids = readdirSync(procRoot); } catch { return null; }
  const found = new Set<string>();
  if (needles.length === 0) return found;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let blob = '';
    // Each read is independent: a process may exit, or deny one file, midway.
    try { blob += readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8'); } catch { /* gone */ }
    try { blob += `\0${readFileSync(`${procRoot}/${pid}/environ`, 'utf8')}`; } catch { /* gone / not ours */ }
    let cwd = '';
    try { cwd = readlinkSync(`${procRoot}/${pid}/cwd`); } catch { /* gone / not ours */ }
    for (const needle of needles) {
      if (found.has(needle)) continue;
      if (blob.includes(needle) || cwd === needle || cwd.startsWith(`${needle}/`)) found.add(needle);
    }
    if (found.size === needles.length) break;
  }
  return found;
}
