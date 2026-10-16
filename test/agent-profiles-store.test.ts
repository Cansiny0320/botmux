/**
 * Where agents.json (Agent env values — provider tokens) lives: a dedicated dir
 * beside the loaded config PATHNAME, so sandboxes mask one directory and the
 * location survives config writers replacing a symlinked bots.json with a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProfilesDirFor, agentProfilesMaskDir } from '../src/core/agent-profiles-file.js';
import { migrateLegacyAgentProfiles, mutateAgentProfiles } from '../src/dashboard/agent-profiles-store.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-profiles-store-'))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('agent profiles location', () => {
  it('stays beside the config pathname, even across a symlink being replaced by a file', () => {
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'project'));
    const real = join(root, 'home', 'bots.json');
    writeFileSync(real, '[]');
    const link = join(root, 'project', 'bots.json');
    symlinkSync(real, link);
    const before = agentProfilesDirFor(link);
    expect(before).toBe(join(root, 'project', 'agent-profiles'));
    // writeRawConfigAtomic renames a temp file over the path: the link becomes a file.
    writeFileSync(join(root, 'project', 'bots.json.tmp'), '[]');
    renameSync(join(root, 'project', 'bots.json.tmp'), link);
    expect(agentProfilesDirFor(link)).toBe(before);
  });

  it('masks the real directory when agent-profiles is itself a symlink', () => {
    mkdirSync(join(root, 'cfg'));
    mkdirSync(join(root, 'elsewhere'));
    const config = join(root, 'cfg', 'bots.json');
    writeFileSync(config, '[]');
    symlinkSync(join(root, 'elsewhere'), join(root, 'cfg', 'agent-profiles'));
    // The Dashboard writes through the link into the target, so that is what gets masked.
    expect(agentProfilesMaskDir(config)).toBe(join(root, 'elsewhere'));
  });

  it('pre-creates the mask dir for isolated spawns, and falls back to the canonical parent', () => {
    const config = join(root, 'cfg2', 'bots.json');
    mkdirSync(join(root, 'cfg2'));
    expect(agentProfilesMaskDir(config)).toBe(join(root, 'cfg2', 'agent-profiles'));
    expect(existsSync(join(root, 'cfg2', 'agent-profiles'))).toBe(false);
    expect(agentProfilesMaskDir(config, { create: true })).toBe(join(root, 'cfg2', 'agent-profiles'));
    expect(statSync(join(root, 'cfg2', 'agent-profiles')).mode & 0o777).toBe(0o700);
  });

  it('moves an early agents.json (beside the config) into the dir once', () => {
    const config = join(root, 'bots.json');
    writeFileSync(config, '[]');
    writeFileSync(join(root, 'agents.json'), '{"version":1,"agents":[],"links":{}}');
    const target = join(agentProfilesDirFor(config), 'agents.json');
    migrateLegacyAgentProfiles(target, config);
    expect(readFileSync(target, 'utf-8')).toContain('"version":1');
    expect(existsSync(join(root, 'agents.json'))).toBe(false);
    // Already there: a later stray copy is left alone.
    writeFileSync(join(root, 'agents.json'), 'stale');
    migrateLegacyAgentProfiles(target, config);
    expect(readFileSync(target, 'utf-8')).toContain('"version":1');
    expect(readFileSync(join(root, 'agents.json'), 'utf-8')).toBe('stale');
  });

  it('creates the private dir and writes temp copies inside it', async () => {
    const path = join(agentProfilesDirFor(join(root, 'bots.json')), 'agents.json');
    const writes = vi.spyOn(fsPromises, 'writeFile');
    try {
      await mutateAgentProfiles(path, doc => ({ write: true, result: doc }));
      expect(statSync(join(root, 'agent-profiles')).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const written = writes.mock.calls.map(args => String(args[0]));
      expect(written.length).toBeGreaterThan(0);
      expect(written.every(file => file.startsWith(join(root, 'agent-profiles') + '/'))).toBe(true);
    } finally {
      writes.mockRestore();
    }
  });
});
