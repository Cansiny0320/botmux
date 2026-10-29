import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downgradeForbiddenReadWrite,
  findForbiddenReadWritePaths,
  forbiddenReadWriteMessage,
  type ProtectedRoots,
} from '../src/services/sandbox-path-guard.js';

describe('sandbox readWrite guard', () => {
  let root: string;
  let roots: ProtectedRoots;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-sbx-guard-'));
    const home = join(root, 'home', 'alice');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    mkdirSync(join(root, 'data', 'botmux'), { recursive: true });
    roots = { homeDirs: [home], botmuxHomes: [join(home, '.botmux'), join(root, 'data', 'botmux')] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const reasons = (paths: string[]) =>
    findForbiddenReadWritePaths(paths, roots).map(f => [f.path, f.reason]);

  it('rejects the filesystem root in every spelling', () => {
    expect(reasons(['/', '//', '/./', ' / '])).toEqual([
      ['/', 'filesystem_root'], ['//', 'filesystem_root'], ['/./', 'filesystem_root'], [' / ', 'filesystem_root'],
    ]);
  });

  it('rejects HOME, its ancestors and `~` forms', () => {
    const home = roots.homeDirs[0]!;
    expect(reasons(['~', '~/', home, `${home}/`, join(root, 'home'), `${home}/../alice`, '~/..'])).toEqual([
      ['~', 'home'], ['~/', 'home'], [home, 'home'], [`${home}/`, 'home'],
      [join(root, 'home'), 'home'], [`${home}/../alice`, 'home'], ['~/..', 'home'],
    ]);
  });

  it('rejects the botmux data roots (default and configured) and their ancestors', () => {
    expect(reasons(['~/.botmux', join(root, 'data', 'botmux'), join(root, 'data')])).toEqual([
      ['~/.botmux', 'botmux_home'], [join(root, 'data', 'botmux'), 'botmux_home'], [join(root, 'data'), 'botmux_home'],
    ]);
  });

  it('rejects a symlink that resolves to a protected root', () => {
    const link = join(root, 'innocent');
    symlinkSync(roots.homeDirs[0]!, link);
    const rootLink = join(root, 'rootlink');
    symlinkSync('/', rootLink);
    expect(reasons([link, rootLink])).toEqual([[link, 'home'], [rootLink, 'filesystem_root']]);
  });

  it('accepts deeper paths, siblings with a shared name prefix, and relative entries', () => {
    const home = roots.homeDirs[0]!;
    expect(reasons([
      '~/projects/app', `${home}/.botmux/bots/x/work`, `${home}-other`, join(root, 'data', 'botmux-cache'),
      'relative/dir', '', '/opt/proj',
    ])).toEqual([]);
  });

  it('names every offending entry in the message', () => {
    const message = forbiddenReadWriteMessage(findForbiddenReadWritePaths(['/', '~'], roots));
    expect(message).toContain('「/」');
    expect(message).toContain('「~」');
  });

  it('downgrades stored HOME / botmux-home offenders to readOnly, drops `/`, keeps everything else', () => {
    const { lists, downgraded, dropped } = downgradeForbiddenReadWrite(
      { readWrite: ['/', '~/projects/app', '~', '~/.botmux'], readOnly: ['/opt/ref'], deny: ['~/secret'] },
      roots,
    );
    expect(downgraded.map(f => f.path)).toEqual(['~', '~/.botmux']);
    expect(dropped.map(f => f.path)).toEqual(['/']);
    expect(lists).toEqual({
      readWrite: ['~/projects/app'], readOnly: ['/opt/ref', '~', '~/.botmux'], deny: ['~/secret'],
    });
  });

  it('returns lists unchanged when nothing is forbidden', () => {
    const input = { readWrite: ['~/projects/app'] };
    expect(downgradeForbiddenReadWrite(input, roots)).toEqual({ lists: input, downgraded: [], dropped: [] });
    expect(downgradeForbiddenReadWrite(undefined, roots)).toEqual({ lists: undefined, downgraded: [], dropped: [] });
  });
});
