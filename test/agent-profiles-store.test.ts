/**
 * Where agents.json (Agent env values — provider tokens) lives: a dedicated dir
 * beside the REAL loaded bots.json, so sandboxes mask one directory and a
 * symlinked config never pulls the file into a project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProfilesDirFor } from '../src/core/agent-profiles-file.js';
import { migrateLegacyAgentProfiles, mutateAgentProfiles } from '../src/dashboard/agent-profiles-store.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-profiles-store-'))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('agent profiles location', () => {
  it('follows the real config file through a symlink', () => {
    mkdirSync(join(root, 'home', '.botmux'), { recursive: true });
    mkdirSync(join(root, 'project'));
    const real = join(root, 'home', '.botmux', 'bots.json');
    writeFileSync(real, '[]');
    symlinkSync(real, join(root, 'project', 'bots.json'));
    expect(agentProfilesDirFor(join(root, 'project', 'bots.json'))).toBe(join(root, 'home', '.botmux', 'agent-profiles'));
    // Not created yet: beside the given path.
    expect(agentProfilesDirFor(join(root, 'none', 'bots.json'))).toBe(join(root, 'none', 'agent-profiles'));
  });

  it('moves an early agents.json (beside the config or its symlink) into the dir once', () => {
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'project'));
    const real = join(root, 'home', 'bots.json');
    writeFileSync(real, '[]');
    const link = join(root, 'project', 'bots.json');
    symlinkSync(real, link);
    writeFileSync(join(root, 'project', 'agents.json'), '{"version":1,"agents":[],"links":{}}');
    const target = join(agentProfilesDirFor(link), 'agents.json');
    migrateLegacyAgentProfiles(target, link);
    expect(readFileSync(target, 'utf-8')).toContain('"version":1');
    expect(existsSync(join(root, 'project', 'agents.json'))).toBe(false);
    // Already there: an older stray copy is left alone.
    writeFileSync(join(root, 'home', 'agents.json'), 'stale');
    migrateLegacyAgentProfiles(target, link);
    expect(readFileSync(target, 'utf-8')).toContain('"version":1');
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
