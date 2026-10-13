/**
 * Whole-process-table `ps` scans must not fall over at Node's default 1MiB
 * exec maxBuffer (ENOBUFS / ERR_CHILD_PROCESS_STDIO_MAXBUFFER), which silently
 * drops every caller into its fail-closed branch on a busy host.
 *
 *  1. Static guard: every whole-table `ps` exec in src/ passes the shared
 *     PROCESS_TABLE_MAX_BUFFER (so the cap stays uniform and new scans can't
 *     regress to the default).
 *  2. Behavioural: in a child process with a fake `ps` on PATH that prints
 *     >1MiB, the real call sites return the correct answer instead of their
 *     ENOBUFS fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PROCESS_TABLE_MAX_BUFFER } from '../src/utils/exec-limits.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Text of the call starting at `start` (the callee name) up to its closing paren. */
function callText(src: string, start: number): string {
  const open = src.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

// exec-family call whose first argument is `ps` with a whole-table selector
// (-A / -a… / -e…), in either execFile form (`'ps', ['-A', …]`) or shell form
// (`'ps -A …'`). Single-pid lookups (`-p <pid>`) are bounded and excluded.
const WHOLE_TABLE_PS =
  /\b(?:execSync|execFileSync|execFile|pExecFile|spawnSync)\(\s*'ps(?:'\s*,\s*\[\s*'-[Aae][^']*'| -[Aae][^']*')/g;

describe('PROCESS_TABLE_MAX_BUFFER', () => {
  it('is well above Node\'s 1MiB default', () => {
    expect(PROCESS_TABLE_MAX_BUFFER).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('every whole-table ps exec in src/ uses the shared cap', () => {
    const hits: string[] = [];
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(WHOLE_TABLE_PS)) {
        const where = `${relative(process.cwd(), file)}:${src.slice(0, m.index).split('\n').length}`;
        hits.push(where);
        if (!/\bmaxBuffer:\s*PROCESS_TABLE_MAX_BUFFER\b/.test(callText(src, m.index!))) missing.push(where);
      }
    }
    expect(missing).toEqual([]);
    // Non-vacuous: the known scans (reasonix, zellij ×2, tmux, session-discovery,
    // browser-restart, worker-pool) are all seen by the matcher.
    for (const f of [
      'src/adapters/cli/reasonix.ts',
      'src/adapters/backend/zellij-backend.ts',
      'src/adapters/backend/tmux-backend.ts',
      'src/core/session-discovery.ts',
      'src/core/browser-restart.ts',
      'src/core/worker-pool.ts',
    ]) expect(hits.some(h => h.startsWith(`${f}:`)), f).toBe(true);
    expect(hits.filter(h => h.startsWith('src/adapters/backend/zellij-backend.ts:'))).toHaveLength(2);
  });

  it('browser-restart\'s default runner (used for `ps -Axo command=`) carries the cap', () => {
    const src = readFileSync(join(SRC, 'core/browser-restart.ts'), 'utf-8');
    expect(src).toMatch(/const run = opts\.run \?\? \(async \(file, args\) => pExecFile\(file, args, \{[^}]*maxBuffer: PROCESS_TABLE_MAX_BUFFER[^}]*\}\)\)/);
    expect(src).toMatch(/await run\('ps', \['-Axo', 'command='\]\)/);
  });
});

describe('whole-table ps scans survive >1MiB output (child process, fake ps)', () => {
  let dir: string;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-ps-maxbuf-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fill = (row: (i: number) => string, tail: string) => {
      const rows: string[] = [];
      let size = 0;
      for (let i = 0; size < 2 * 1024 * 1024; i++) { const r = row(i); rows.push(r); size += r.length + 1; }
      rows.push(tail);
      return rows.join('\n') + '\n';
    };
    const pad = 'x'.repeat(60);
    writeFileSync(join(dir, 'pidppid.txt'), fill(i => `${100000 + i} 1`, '777777 4242'));
    writeFileSync(join(dir, 'uidcomm.txt'), fill(() => `${uid} bash-${pad}`, `${uid} zsh`));
    writeFileSync(join(dir, 'rsscmd.txt'), fill(i => `10 /usr/bin/other-${i} ${pad}`, '204800 /Applications/Fake.app/Contents/MacOS/Fake'));
    writeFileSync(join(dir, 'cmd.txt'), fill(i => `/usr/bin/other-${i} ${pad}`, '/usr/sbin/launchd'));
    const sh = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    sh('ps', [
      `D='${dir}'`,
      'case "$*" in',
      '  *uid=*) exec cat "$D/uidcomm.txt" ;;',
      '  *rss=*) exec cat "$D/rsscmd.txt" ;;',
      '  *command=*) exec cat "$D/cmd.txt" ;;',
      '  *) exec cat "$D/pidppid.txt" ;;',
      'esac',
    ].join('\n'));
    sh('osascript', 'exit 0');
    sh('open', 'exit 0');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns real results instead of the ENOBUFS fallback', () => {
    const result = spawnSyncTsEvalWithRepoImports(`
      import { execFileSync } from 'node:child_process';
      import { getChildPids } from './src/core/session-discovery.js';
      import { noTmuxProcessForCurrentUser } from './src/adapters/backend/tmux-backend.js';
      import { detectRunningBrowsers, restartBrowser } from './src/core/browser-restart.js';

      // Control: the fixture really exceeds Node's default maxBuffer.
      let control = 'no-error';
      try { execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' }); }
      catch (e) { control = e.code ?? String(e); }

      const browsers = await detectRunningBrowsers(
        [{ bundleId: 'com.example.fake', label: 'Fake' }],
        { platform: 'darwin', appPathFor: async () => '/Applications/Fake.app' },
      );
      const restart = await restartBrowser(
        { bundleId: 'com.example.fake' },
        { appPath: '/Applications/Fake.app', sleep: async () => {}, quitTimeoutMs: 200 },
      );
      console.log(JSON.stringify({
        control,
        children: getChildPids(4242),
        noTmux: noTmuxProcessForCurrentUser(),
        browsers: browsers.map(b => [b.bundleId, b.memMB]),
        restart,
      }));
    `, {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const out = JSON.parse(String(result.stdout).trim().split('\n').pop()!);
    expect(out.control).toBe('ENOBUFS');
    expect(out.children).toEqual([777777]);
    expect(out.noTmux).toBe(true);
    expect(out.browsers).toEqual([['com.example.fake', 200]]);
    expect(out.restart).toEqual({ ok: true, quit: true, relaunched: true });
  }, 90_000);
});
