import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * `--dangerously-bypass-hook-trust` exists from traecli 0.200.16 on (the
 * release that added the "Hooks need review" startup gate). Older releases
 * reject the flag at argv parsing — `error: unexpected argument
 * '--dangerously-bypass-hook-trust' found` — and exit before drawing anything,
 * so the session crash-loops. A host can carry several installs on PATH, which
 * is why the same bot may fail on one host/session and not another.
 */
export const TRAEX_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';
export const TRAEX_HOOK_TRUST_MIN_VERSION = '0.200.16';

export type TraexHookTrustSupport =
  | { status: 'supported' | 'unsupported'; version: string }
  /** No traecli binary (missing, or a wrapper/launcher of another name), no
   *  version output, or an unparsable one. Callers keep the historical
   *  behaviour (pass the flag) rather than guess. */
  | { status: 'unknown' };

/** `traecli 0.212.1\ninstallation: internal` → `0.212.1`. */
export function parseTraexVersion(raw: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(raw)?.[1];
}

/** Semver precedence for the x.y.z[-pre] shapes traecli prints: numeric core
 *  first; at an equal core a pre-release sorts before the release. */
export function compareTraexVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    return { core: core.split('.').map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface TraexVersionProbeDeps {
  /** Identity of the installed file; undefined when it does not exist. */
  identify?: (bin: string) => string | undefined;
  runVersion?: (bin: string) => string;
}

// Only a file that IS traecli is asked for its version. A wrapper script or a
// renamed launcher may not implement `--version` and would instead start a
// session (and outlive the probe's timeout); those keep the historical launch.
const TRAECLI_BINARY_NAMES = new Set(['traex', 'traecli']);

const defaultIdentify = (bin: string): string | undefined => {
  try {
    const real = realpathSync(bin);
    if (!TRAECLI_BINARY_NAMES.has(basename(real))) return undefined;
    const st = statSync(real);
    return `${real}\0${st.dev}:${st.ino}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return undefined;
  }
};

const defaultRunVersion = (bin: string): string => execFileSync(bin, ['--version'], {
  encoding: 'utf8',
  timeout: 3_000,
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Keyed by the installed file's identity, so an in-place upgrade (new inode /
// mtime) or a different install on PATH is probed afresh, and a respawn of the
// same binary costs nothing.
const supportCache = new Map<string, TraexHookTrustSupport>();

export function probeTraexHookTrustSupport(bin: string, deps: TraexVersionProbeDeps = {}): TraexHookTrustSupport {
  const identity = (deps.identify ?? defaultIdentify)(bin);
  if (identity === undefined) return { status: 'unknown' };
  const cached = supportCache.get(identity);
  if (cached) return cached;
  let support: TraexHookTrustSupport;
  try {
    const version = parseTraexVersion((deps.runVersion ?? defaultRunVersion)(bin));
    support = version === undefined
      ? { status: 'unknown' }
      : {
        status: compareTraexVersions(version, TRAEX_HOOK_TRUST_MIN_VERSION) < 0 ? 'unsupported' : 'supported',
        version,
      };
  } catch {
    support = { status: 'unknown' };
  }
  supportCache.set(identity, support);
  return support;
}

/** Test isolation only. */
export function resetTraexVersionProbeCache(): void {
  supportCache.clear();
}

/** The option a clap-based traecli refused at startup, if its output shows one. */
export function traexRejectedArgument(output: string): string | undefined {
  return /unexpected argument '(--?[A-Za-z0-9][\w-]*)'/.exec(output)?.[1];
}
