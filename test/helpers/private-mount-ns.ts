/**
 * Run a TS snippet (repo imports allowed) in its own mount + PID namespace:
 * `bwrap --dev-bind / / --unshare-pid --die-with-parent --proc /proc`.
 *
 * WHY: a test that mounts for real (a scratch overlay with `lowerdir=/`, its
 * per-submount overlays, fuse-overlayfs daemons) and is killed before its
 * `finally` — a timeout kill, a cancelled run — used to leave all of it in the
 * HOST mount table, where every later scratch session wrapped it again. Inside
 * the namespace nothing reaches the host: when the snippet ends, or the test
 * runner dies (--die-with-parent kills the namespace's init, the kernel then
 * kills every process in it, fuse daemons included), the mount namespace is
 * freed with every mount in it.
 *
 * Root only: without a user namespace an unprivileged bwrap gets no mount
 * rights, and with one the snippet would no longer exercise the root code path
 * (kernel overlay, tmpfs slot) the daemon runs. Works nested inside isolate-run
 * (no user namespace involved).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsEvalArgs, tsRunnerPrefix } from './ts-runner.js';

function bwrapPrefix(extraTmpfs: readonly string[]): string[] {
  return [
    '--dev-bind', '/', '/',
    '--unshare-pid', '--die-with-parent',
    '--proc', '/proc',
    // Scratch tmpfs upper slots live under /var/tmp/botmux-scratch: keep them off the host's.
    '--tmpfs', '/var/tmp',
    ...extraTmpfs.flatMap(dir => ['--tmpfs', dir]),
  ];
}

let available: boolean | undefined;

/** Can this host give a snippet a private mount + PID namespace with mount rights? */
export function privateMountNsAvailable(): boolean {
  if (available !== undefined) return available;
  available = false;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return available;
  if (spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status !== 0) return available;
  const probe = mkdtempSync(join(tmpdir(), 'private-mount-ns-'));
  try {
    available = spawnInPrivateMountNs(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', probe], { timeoutMs: 20_000 }).status === 0;
  } finally {
    try { rmdirSync(probe); } catch { /* */ }
  }
  return available;
}

/**
 * Run `source` (an ES module; `./src/...js` imports resolve against the repo
 * root) inside a private mount + PID namespace and return its output.
 * `tmpfs` dirs get a fresh tmpfs inside the namespace only.
 */
export function runInPrivateMountNs(
  source: string,
  opts: { env?: NodeJS.ProcessEnv; tmpfs?: readonly string[]; timeoutMs?: number } = {},
): SpawnSyncReturns<string> {
  const { command, prefixArgs } = tsRunnerPrefix();
  const { args } = tsEvalArgs(source);
  return spawnInPrivateMountNs([command, ...prefixArgs, ...args], opts);
}

const SETUP_FAILED = 125;

function spawnInPrivateMountNs(
  command: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; tmpfs?: readonly string[]; timeoutMs?: number },
): SpawnSyncReturns<string> {
  const argv = [
    ...bwrapPrefix(opts.tmpfs ?? []), '--chdir', resolve('.'), '--',
    // Cut propagation from the parent namespace: a mount another process makes
    // or drops meanwhile must not appear in (or vanish from) the snippet's table.
    '/bin/sh', '-c', `mount --make-rprivate / || exit ${SETUP_FAILED}; exec "$@"`, 'private-mount-ns',
    ...command,
  ];
  let run: SpawnSyncReturns<string>;
  // bwrap re-applies the flags of every host mount while it binds `/`; one that
  // another process unmounts right then fails the setup ("Can't bind mount
  // /oldroot/ … Unable to apply mount flags"). Nothing of the snippet ran yet,
  // so that — and only that — is retried.
  for (let attempt = 1; ; attempt++) {
    run = spawnSync('bwrap', argv, {
      encoding: 'utf8',
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 120_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    const setupFailed = run.status === SETUP_FAILED || (run.status === 1 && !run.stdout && /^bwrap: /m.test(run.stderr ?? ''));
    if (!setupFailed || attempt === 3) return run;
  }
}

/** The snippet's result: the last stdout line that parses as JSON. */
export function lastJsonLine<T>(run: SpawnSyncReturns<string>): T {
  const lines = (run.stdout ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    try { return JSON.parse(line) as T; } catch { /* log line */ }
  }
  throw new Error(`no JSON result (exit ${run.status}, signal ${run.signal})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
}
