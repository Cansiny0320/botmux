/**
 * Which botmux credential files a file-sandboxed (oncall) session can see.
 *
 * Two broad grants used to re-expose them:
 *  - a workingDir that is an ancestor of the botmux root (workingDir=~, the
 *    default when none is configured) re-opened `~/.botmux` readWrite for a
 *    session WITH a Feishu transport — bots.json, .dashboard-secret and the
 *    sibling bots' send-cred.json included;
 *  - the read-only install-root grant exposed a git checkout's non-code files
 *    (.env, bots configs, browser login state, .git).
 *
 * Policy-level checks here; the same layouts are enforced at the kernel level
 * by test/sandbox-credential-visibility.bwrap.test.ts. All files are fakes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accessForPath,
  buildFsPolicy,
  FsPolicyConfigError,
  type FsPolicyContext,
} from '../src/adapters/cli/fs-policy.js';
import { botmuxInstallRootMaskPaths } from '../src/adapters/cli/install-root-masks.js';

const H = '/home/u';
const BH = `${H}/.botmux`;
const CHECKOUT = `${H}/src/botmux`;

const ctx = (o: Partial<FsPolicyContext> = {}): FsPolicyContext => ({
  platform: 'linux',
  homeDir: H,
  botmuxHome: BH,
  defaultBotmuxHome: BH,
  sessionDataDir: `${BH}/data`,
  sessionId: 'sess-1',
  workingDir: H,
  currentAppId: 'cli_self',
  botHome: `${BH}/bots/cli_self`,
  redirectedCliData: true,
  loadedBotsConfigPath: `${BH}/bots.json`,
  botmuxInstallRoot: CHECKOUT,
  ...o,
});

const access = (o: Partial<FsPolicyContext>, path: string) => accessForPath(buildFsPolicy(ctx(o)).rules, path).access;
const hidden = (a: string) => a === 'deny' || a === 'none';

describe('botmux root under a broad workingDir (transport session)', () => {
  for (const workingDir of [H, '/']) {
    it(`workingDir=${workingDir}: botmux credentials are neither readable nor writable`, () => {
      for (const p of [
        `${BH}/bots.json`,
        `${BH}/bots.json.bak-1`,
        `${BH}/.dashboard-secret`,
        `${BH}/.dashboard-token`,
        `${BH}/.env`,
        `${BH}/config.json`,
        `${BH}/bots/cli_other/send-cred.json`,
        `${BH}/bots/cli_other`,
        `${BH}/data/webhook-master.key`,
        `${BH}/data/session-stores/cli_other`,
        `${BH}/a-file-created-later`,
      ]) {
        expect(hidden(access({ workingDir }, p)), p).toBe(true);
      }
    });

    it(`workingDir=${workingDir}: the session's own surface stays usable`, () => {
      expect(access({ workingDir }, `${BH}/bots/cli_self`)).toBe('readWrite');
      expect(access({ workingDir }, `${BH}/bots/cli_self/send-cred.json`)).toBe('readWrite');
      expect(access({ workingDir }, `${BH}/bin`)).toBe('readOnly');
      expect(access({ workingDir }, `${BH}/claude-plugin`)).toBe('readOnly');
      expect(access({ workingDir }, `${BH}/data/session-stores/cli_self`)).toBe('readOnly');
      expect(access({ workingDir }, `${BH}/data/attachments/cli_self`)).toBe('readWrite');
      expect(access({ workingDir }, `${BH}/data/turn-sends/sess-1.jsonl`)).toBe('readWrite');
      // The rest of the working dir is unaffected.
      expect(access({ workingDir }, `${H}/proj/main.ts`)).toBe('readWrite');
    });
  }

  it('a project workingDir sees the same ~/.botmux as workingDir=~', () => {
    for (const p of [`${BH}/bots.json`, `${BH}/bots/cli_other/send-cred.json`, `${BH}/.dashboard-secret`]) {
      expect(hidden(access({ workingDir: `${H}/proj` }, p)), p).toBe(true);
    }
    expect(access({ workingDir: `${H}/proj` }, `${BH}/bots/cli_self/send-cred.json`)).toBe('readWrite');
  });

  it('a custom data root still hides the default ~/.botmux', () => {
    const custom = '/srv/botmux';
    const o = { botmuxHome: custom, sessionDataDir: `${custom}/data`, botHome: `${custom}/bots/cli_self`, loadedBotsConfigPath: `${custom}/bots.json` };
    for (const p of [`${BH}/bots.json`, `${BH}/.dashboard-secret`, `${custom}/bots.json`, `${custom}/bots/cli_other/send-cred.json`]) {
      expect(hidden(access({ ...o, workingDir: '/' }, p)), p).toBe(true);
    }
    expect(access({ ...o, workingDir: '/' }, `${custom}/bots/cli_self/send-cred.json`)).toBe('readWrite');
  });

  it('a bots config outside the botmux root is hidden by its exact path', () => {
    const cfg = `${H}/proj/bots.json`;
    expect(access({ workingDir: `${H}/proj`, loadedBotsConfigPath: cfg }, cfg)).toBe('deny');
    expect(access({ workingDir: `${H}/proj`, loadedBotsConfigPath: cfg }, `${H}/proj/other.json`)).toBe('readWrite');
  });

  it('a user sandboxPaths grant of the whole root does not re-open it', () => {
    expect(access({ userPaths: { readOnly: [BH] } }, `${BH}/bots.json`)).toBe('deny');
    expect(access({ userPaths: { readWrite: [H] } }, `${BH}/.dashboard-secret`)).toBe('deny');
  });

  it('refuses a workingDir at or inside the botmux root, except inside the own BOT_HOME', () => {
    for (const workingDir of [BH, `${BH}/data`, `${BH}/bots`, `${BH}/bots/cli_other`]) {
      expect(() => buildFsPolicy(ctx({ workingDir })), workingDir).toThrow(FsPolicyConfigError);
    }
    expect(() => buildFsPolicy(ctx({ workingDir: `${BH}/bots/cli_self` }))).not.toThrow();
    expect(() => buildFsPolicy(ctx({ workingDir: `${BH}/bots/cli_self/work` }))).not.toThrow();
  });
});

describe('install-root masks in the policy', () => {
  const masks = [`${CHECKOUT}/.env`, `${CHECKOUT}/test-bots.json`, `${CHECKOUT}/storageState.json`, `${CHECKOUT}/.git`, `${CHECKOUT}/data`];

  it('hides non-code checkout files while code stays read-only', () => {
    const o = { workingDir: `${H}/proj`, botmuxInstallRootMaskPaths: masks };
    for (const p of [...masks, `${CHECKOUT}/data/x.db`, `${CHECKOUT}/.git/config`]) expect(access(o, p), p).toBe('deny');
    for (const p of [`${CHECKOUT}/dist/cli.js`, `${CHECKOUT}/node_modules/x/index.js`, `${CHECKOUT}/package.json`, `${CHECKOUT}/src/cli.ts`]) {
      expect(access(o, p), p).toBe('readOnly');
    }
  });

  it('still hides them when the workingDir is an ancestor of the checkout', () => {
    const o = { workingDir: `${H}/src`, botmuxInstallRootMaskPaths: masks };
    expect(access(o, `${CHECKOUT}/.env`)).toBe('deny');
    expect(access(o, `${H}/src/other-project/.env`)).toBe('readWrite');
  });

  it('leaves the checkout alone for a bot whose workingDir is the checkout itself', () => {
    const o = { workingDir: CHECKOUT, botmuxInstallRootMaskPaths: masks };
    expect(access(o, `${CHECKOUT}/.git/config`)).not.toBe('deny');
    expect(access(o, `${CHECKOUT}/.env`)).not.toBe('deny');
  });

  it('only honours paths strictly inside the install root', () => {
    const o = { workingDir: `${H}/proj`, botmuxInstallRootMaskPaths: [CHECKOUT, `${H}/proj/x`, '/usr'] };
    expect(access(o, `${CHECKOUT}/dist/cli.js`)).toBe('readOnly');
    expect(access(o, `${H}/proj/x`)).toBe('readWrite');
    expect(access(o, '/usr/bin/env')).toBe('readOnly');
  });
});

describe('botmuxInstallRootMaskPaths (real git checkout)', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'install-root-masks-')));
    const files: Record<string, string> = {
      'package.json': '{}',
      'src/cli.ts': 'code',
      'dist/cli.js': 'built',
      'packages/core/package.json': '{}',
      'packages/core/dist/index.js': 'built',
      'node_modules/dep/index.js': 'dep',
      '.env.example': 'API_KEY=',
      'bots.json.example': '[]',
      '.gitignore': '.env\ndist/\nnode_modules/\nstorageState.json\ndata/\n',
      '.env': 'API_KEY=fake-not-a-secret',
      'storageState.json': '{"cookies":[]}',
      'test-bots.json': '[{"larkAppSecret":"fake"}]',
      'data/x.db': 'db',
      'docs/notes.md': 'untracked note',
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    symlinkSync('/usr', join(root, 'usr-link'));
    git('init', '-q');
    git('add', 'package.json', 'src/cli.ts', 'packages/core/package.json', '.env.example', 'bots.json.example', '.gitignore');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('masks untracked and ignored entries, keeps code, build outputs, templates and symlinks', () => {
    const { paths, fallbackReason } = botmuxInstallRootMaskPaths(root);
    expect(fallbackReason).toBeUndefined();
    const rel = paths.map(p => p.slice(root.length + 1)).sort();
    expect(rel).toEqual(['.env', '.git', 'data', 'docs', 'storageState.json', 'test-bots.json']);
  });

  it('a non-git install root has nothing to mask', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'install-root-plain-')));
    try {
      writeFileSync(join(plain, '.env'), 'x');
      expect(botmuxInstallRootMaskPaths(plain).paths).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('falls back to well-known credential names when git cannot list the checkout', () => {
    const broken = realpathSync(mkdtempSync(join(tmpdir(), 'install-root-broken-')));
    try {
      writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent\n');
      for (const name of ['.env', '.env.example', 'test-bots.json', 'storageState.json', 'package.json']) {
        writeFileSync(join(broken, name), 'x');
      }
      const { paths, fallbackReason } = botmuxInstallRootMaskPaths(broken);
      expect(fallbackReason).toBeTruthy();
      expect(paths.map(p => p.slice(broken.length + 1)).sort()).toEqual(['.env', '.git', 'storageState.json', 'test-bots.json']);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
