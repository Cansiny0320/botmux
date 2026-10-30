/**
 * #2574, as REAL processes with a REAL fresh `/tmp`.
 *
 * The defect is a cross-process, cross-writer one: the identity wrapper (a
 * `/bin/sh` script) and the daemon's session-temp setup both create
 * `/tmp/bm<uid>`, and which one wins decides whether every later session on the
 * host can create scratch at all. A same-process, mocked-fs test cannot show
 * that — the wrapper's `mkdir -p` is the whole trigger — so these cases run the
 * generated wrapper with `/bin/sh` inside a private tmpfs `/tmp`.
 *
 * A private /tmp is also what makes them ISOLATED. `/tmp/bm<uid>` is keyed by
 * uid, so an in-process test that repaired or re-created it would be mutating
 * state every other test file in the same run shares (vitest runs files in
 * parallel) — verified: the same cases in test/session-temp.test.ts failed
 * intermittently and at moving locations only when run alongside another file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderIdentityEnv, renderIdentityWrapper } from '../src/core/cli-identity.js';
import { privateTmpAvailable, runWithPrivateTmp } from './helpers/session-temp-ns-probe.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

let dir: string;
let previousHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-session-temp-ns-'));
  previousHome = process.env.HOME;
  process.env.HOME = join(dir, 'machine-home');
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'sess-ns';
const repoRoot = process.cwd();
const uid = process.getuid?.() ?? 0;

/** A bytedcli wrapper whose published HOME the caller chooses. */
function writeWrapper(home: string): string {
  const wrapper = join(dir, 'bytedcli-wrapper');
  writeFileSync(wrapper, renderIdentityWrapper('bytedcli', '/bin/echo', 'single'));
  const envDir = join(dir, 'data', 'cli-identity', `${SESSION}.bin`, '.data');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'bytedcli.env'),
    renderIdentityEnv({ tool: 'bytedcli', cloudJwt: 'jwt-probe', home }));
  return wrapper;
}

/** The session-temp module, booted in the child so it sees the private /tmp. */
function bootArgv(): string[] {
  const probe = join(dir, 'boot-probe.ts');
  writeFileSync(probe, [
    `import { ensureSessionTempDir } from ${JSON.stringify(join(repoRoot, 'src/core/session-temp.ts'))};`,
    `const path = ensureSessionTempDir(${JSON.stringify(join(dir, 'data'))}, ${JSON.stringify(SESSION)});`,
    "process.stdout.write('BOOT_OK ' + path + '\\n');",
  ].join('\n'));
  const { command, prefixArgs } = tsRunnerPrefix();
  return [command, ...prefixArgs, probe];
}


/** Publish a bytedcli identity for the session and run its wrapper, in-process. */
function publishAndRunArgv(): string[] {
  const probe = join(dir, 'publish-and-run.ts');
  writeFileSync(probe, [
    `import { renderIdentityWrapper, writeSessionIdentity } from ${JSON.stringify(join(repoRoot, 'src/core/cli-identity.ts'))};`,
    `import { spawnSync } from 'node:child_process';`,
    `import { writeFileSync } from 'node:fs';`,
    `writeSessionIdentity(${JSON.stringify(join(dir, 'data'))}, ${JSON.stringify(SESSION)},`,
    `  { tool: 'bytedcli', cloudJwt: 'jwt-probe', openId: 'ou_alice' }, 'single');`,
    `const wrapper = ${JSON.stringify(join(dir, 'published-wrapper'))};`,
    `writeFileSync(wrapper, renderIdentityWrapper('bytedcli', '/bin/true', 'single'));`,
    `spawnSync('/bin/sh', [wrapper], { env: { ...process.env, SESSION_DATA_DIR: ${JSON.stringify(join(dir, 'data'))}, BOTMUX_SESSION_ID: ${JSON.stringify(SESSION)} } });`,
    `process.stdout.write('RUN_OK\\n');`,
  ].join('\n'));
  const { command, prefixArgs } = tsRunnerPrefix();
  return [command, ...prefixArgs, probe];
}

describe('session temp layout created by the identity wrapper (#2574)', () => {
  it.skipIf(!privateTmpAvailable())('leaves the uid hub at 0700 even under the default umask 022', () => {
    // The wrapper is the FIRST writer on a fresh host: nothing has created the
    // hub yet. `mkdir -p -m 700` would mode only the leaf and leave the hub at
    // 0755, which is what made every later session fail its private-owner check.
    const home = `/tmp/bm${uid}/probe/identity-home/bytedcli/deadbeef`;
    const wrapper = writeWrapper(home);
    const script = [
      'set -e',
      'umask 022',
      `SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} BOTMUX_SESSION_ID=${SESSION} \\`,
      `  PATH=/usr/bin:/bin HOME=${JSON.stringify(process.env.HOME!)} /bin/sh ${JSON.stringify(wrapper)}`,
      `printf 'hub=%s\\n' "$(stat -c %a /tmp/bm${uid})"`,
      `printf 'inner=%s\\n' "$(stat -c %a /tmp/bm${uid}/probe)"`,
    ].join('\n');

    const run = runWithPrivateTmp(script);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('hub=700');
    // Every intermediate level the wrapper creates is private, not just the leaf.
    expect(run.stdout).toContain('inner=700');
  });

  it.skipIf(!privateTmpAvailable())('a daemon session still boots after the wrapper created the layout first', () => {
    // End to end on one fresh /tmp: wrapper creates the tree, then the daemon's
    // own session-temp setup runs. Before the fix this threw
    // "session temp alias parent is not a private owned directory".
    const wrapper = writeWrapper(`/tmp/bm${uid}/probe/identity-home/bytedcli/deadbeef`);
    const script = [
      'set -e',
      'umask 022',
      `cd ${JSON.stringify(repoRoot)}`,
      `SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} BOTMUX_SESSION_ID=${SESSION} \\`,
      `  PATH=/usr/bin:/bin HOME=${JSON.stringify(process.env.HOME!)} /bin/sh ${JSON.stringify(wrapper)}`,
      `HOME=${JSON.stringify(process.env.HOME!)} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n');

    const run = runWithPrivateTmp(script);
    expect(run.stderr, 'daemon boot after the wrapper must not throw').not.toContain('not a private owned directory');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('BOOT_OK ');
  });

  it.skipIf(!privateTmpAvailable())('adopts an alias the wrapper left as a real directory, on the cache filesystem', () => {
    // Same first-writer problem one level down: the wrapper also crosses the
    // alias name, leaving <hub>/<hash>/... as plain directories in /tmp (tmpfs
    // on the hosts this targets). Those must end up on the cache filesystem —
    // adopting the directory in place would keep the scratch on tmpfs, which is
    // the exact outcome #2467 exists to prevent.
    const home = `/tmp/bm${uid}/<hash>/probe/identity-home/bytedcli/deadbeef`;
    void home;
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      // Wrapper-created shape: hub (0755) + alias name as a real directory.
      `mkdir -m 755 /tmp/bm${uid}`,
      `  mkdir -m 700 -p /tmp/bm${uid}/CACHEHASH/wrapper-profile/wrapper-session`,
      `echo from-tmp > /tmp/bm${uid}/CACHEHASH/wrapper-profile/wrapper-session/artifact`,
      `HOME=${JSON.stringify(process.env.HOME!)} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
      `printf 'aliaslink=%s\\n' "$(test -L /tmp/bm${uid}/CACHEHASH && echo yes || echo no)"`,
      `printf 'hub=%s\\n' "$(stat -c %a /tmp/bm${uid})"`,
    ].join('\n');

    // The alias name is a hash of the child's cache path, which depends on the
    // child's HOME; ask the child to report it rather than predicting it.
    const discovery = runWithPrivateTmp([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(process.env.HOME!)} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    expect(discovery.status, discovery.stderr).toBe(0);
    const bootedPath = /BOOT_OK (\S+)/.exec(discovery.stdout)?.[1];
    expect(bootedPath).toBeDefined();
    const aliasName = bootedPath!.split('/')[3];
    expect(aliasName).toMatch(/^[0-9a-f]{8}$/);

    const prepared = script.replaceAll('CACHEHASH', aliasName);
    const run = runWithPrivateTmp(prepared);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('aliaslink=yes');
    expect(run.stdout).toContain('hub=700');
    expect(run.stdout).toContain('BOOT_OK ');
  });

  it.skipIf(!privateTmpAvailable())('lands an adopted tree on disk, not on the tmpfs /tmp', () => {
    // Stated as the property that matters: after adoption the session scratch
    // must resolve OUTSIDE /tmp (the private /tmp here IS a tmpfs, as on the
    // Linux hosts this targets).
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -m 755 /tmp/bm${uid}`,
      `  mkdir -m 700 -p /tmp/bm${uid}/HASH/prof/sess`,
      `echo x > /tmp/bm${uid}/HASH/prof/sess/artifact`,
      `HOME=${JSON.stringify(process.env.HOME!)} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')} > /dev/null`,
      // realpath of the alias must be outside /tmp
      `real=$(realpath /tmp/bm${uid}/HASH)`,
      `case "$real" in /tmp/*) echo "STILL_IN_TMP $real";; *) echo "OFF_TMP $real";; esac`,
    ].join('\n');

    const discovery = runWithPrivateTmp([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(process.env.HOME!)} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    const aliasName = /BOOT_OK (\S+)/.exec(discovery.stdout)![1].split('/')[3];

    const run = runWithPrivateTmp(script.replaceAll('HASH', aliasName));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('OFF_TMP');
    expect(run.stdout).not.toContain('STILL_IN_TMP');
  });
});

describe('a hub replaced by a symlink (#2574)', () => {
  it.skipIf(!privateTmpAvailable())('never receives a write from the wrapper, through realpath or through mkdir', () => {
    // Two ways to leak into a foreign tree, and both must be shut: publishing a
    // path that RESOLVES into it (realpath), and publishing a lexical
    // `<hub>/...` path that the executor's `mkdir -p` then follows. Only a
    // private /tmp can plant this safely: the real hub is shared with every
    // other test file in the run.
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -p /tmp/foreign-tree`,
      `rm -rf /tmp/bm${uid}`,
      `ln -s /tmp/foreign-tree /tmp/bm${uid}`,
      // Publish THROUGH the real path under test (writeSessionIdentity), so the
      // HOME the wrapper gets is the one the daemon would have published. A
      // hand-written env file with a hub-spelled HOME is a different scenario:
      // it proves only that mkdir follows a link, which is expected.
      `HOME=${JSON.stringify(process.env.HOME!)} ${publishAndRunArgv().map(a => JSON.stringify(a)).join(' ')}`,
      `printf 'entries=%s\\n' "$(find /tmp/foreign-tree -mindepth 1 | wc -l)"`,
    ].join('\n');

    const run = runWithPrivateTmp(script);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('entries=0');
  });
});
