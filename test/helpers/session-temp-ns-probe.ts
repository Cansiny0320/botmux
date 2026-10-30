/**
 * Run a snippet with its own `/tmp` (a fresh tmpfs) so a test can observe what
 * a FRESH host looks like: no `/tmp/bm<uid>` hub, nothing another test left
 * behind. Needed because the hub is keyed by uid, not by test, so every case
 * sharing the host /tmp would otherwise see its neighbours' state.
 *
 * Uses a user namespace when not root (`unshare --user --map-root-user`), so
 * the same probe runs on CI runners, and a mount + PID namespace either way
 * (`--pid --fork --mount-proc`) so a killed run cannot leave a mount behind.
 *
 * Falls back to "unavailable" rather than throwing: the probe is evidence for
 * a platform behaviour, and a host that cannot unshare cannot produce it.
 */
import { spawnSync } from 'node:child_process';

let available: boolean | undefined;

function canUnshare(): boolean {
  const probe = process.platform === 'linux'
    && spawnSync('sh', ['-c', 'command -v unshare && command -v setpriv'], { stdio: 'ignore' }).status === 0;
  if (!probe) return false;
  const userNs = process.getuid?.() !== 0 ? ['--user', '--map-root-user'] : [];
  return spawnSync('unshare', [...userNs, '--mount', '--pid', '--fork', '--mount-proc',
    '/bin/sh', '-c', 'mount -t tmpfs -o mode=755 tmpfs /tmp && test -d /tmp'], { stdio: 'ignore' }).status === 0;
}

/** Can this host give a snippet a private /tmp? */
export function privateTmpAvailable(): boolean {
  if (available === undefined) available = canUnshare();
  return available;
}

/**
 * Run `script` (a POSIX sh script) with a fresh tmpfs mounted at /tmp.
 * `cwd` stays the repo so repo files are reachable; `env` is merged over the
 * caller's, and HOME should point somewhere disposable.
 */
export function runWithPrivateTmp(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string } {
  const userNs = process.getuid?.() !== 0 ? ['--user', '--map-root-user'] : [];
  const result = spawnSync('unshare', [
    ...userNs, '--mount', '--propagation', 'private', '--pid', '--fork', '--mount-proc',
    '/bin/sh', '-c', 'mount -t tmpfs -o mode=755 tmpfs /tmp || exit 125; exec /bin/sh -c "$1"', 'private-tmp', script,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
