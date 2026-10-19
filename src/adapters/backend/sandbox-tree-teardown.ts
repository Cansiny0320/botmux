/**
 * Close-time teardown of a session's per-session sandbox tree
 * (`<data>/sandboxes/<sid>`) when no worker is left to run its own cleanup —
 * e.g. the worker crashed (its persistent pane outlived it, so it kept the tree
 * for a successor) and the session is closed before any successor attached.
 *
 * Each flavour gets its own teardown, never a blind recursive rm:
 *  - Linux scratch: unmount first (submount binds → sub-overlays → main overlay
 *    → tmpfs slot), then remove — a still-mounted merged root is the full-root
 *    COW view of the whole host;
 *  - macOS scratch: unlock the clone tree, then remove;
 *  - oncall / credential-only: reclaim the recorded deny-mask mountpoints, then
 *    remove (refused if anything is mounted below the tree).
 *
 * The caller must already have proven the session's pane gone.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { mountsAtOrUnder, SCRATCH_TREE_MARKER, teardownDirectSandboxSession } from './sandbox.js';
import { teardownScratchSession } from './scratch-sandbox.js';
import { teardownMacScratchSession } from './scratch-sandbox-darwin.js';

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export function teardownSessionSandboxTree(sessionId: string, dataDir: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
  let canonicalDataDir = dataDir;
  try { canonicalDataDir = realpathSync(dataDir); } catch { /* keep lexical */ }
  const sessionRoot = join(canonicalDataDir, 'sandboxes', sessionId);
  if (!exists(sessionRoot)) return;
  if (exists(join(sessionRoot, SCRATCH_TREE_MARKER))) {
    if (process.platform === 'darwin') teardownMacScratchSession(sessionId, dataDir);
    else teardownScratchSession(sessionId, dataDir);
    return;
  }
  // A Linux tree with mounts but no marker can only be a scratch tree whose
  // meta write was lost: the scratch teardown still unmounts its default
  // layout first and refuses to remove anything that stays mounted.
  if (process.platform === 'linux' && mountsAtOrUnder(sessionRoot)?.length !== 0) {
    teardownScratchSession(sessionId, dataDir);
    return;
  }
  teardownDirectSandboxSession(sessionId, dataDir);
}
