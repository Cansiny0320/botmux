import { describe, it, expect } from 'vitest';
import { botsRosterDigest, botsRosterSignature } from '../src/dashboard/registry.js';
import type { DaemonInfo } from '../src/dashboard/registry.js';

function daemon(over: Partial<DaemonInfo> & { larkAppId: string }): DaemonInfo {
  return {
    botName: over.larkAppId,
    botIndex: 0,
    ipcPort: 7890,
    pid: 1,
    startedAt: 1_000,
    lastHeartbeat: 1_000,
    ...over,
  } as DaemonInfo;
}

describe('botsRosterSignature', () => {
  it('is stable across pure heartbeat bumps (no false bots.changed)', () => {
    const a = [daemon({ larkAppId: 'appA', lastHeartbeat: 1_000 })];
    const b = [daemon({ larkAppId: 'appA', lastHeartbeat: 99_000 })];
    expect(botsRosterSignature(a)).toBe(botsRosterSignature(b));
  });

  it('is order-independent', () => {
    const a = [daemon({ larkAppId: 'appA', botIndex: 0 }), daemon({ larkAppId: 'appB', botIndex: 1 })];
    const b = [daemon({ larkAppId: 'appB', botIndex: 1 }), daemon({ larkAppId: 'appA', botIndex: 0 })];
    expect(botsRosterSignature(a)).toBe(botsRosterSignature(b));
  });

  it('changes when a new bot is added', () => {
    const before = [daemon({ larkAppId: 'appA' })];
    const after = [daemon({ larkAppId: 'appA' }), daemon({ larkAppId: 'appB', botIndex: 1 })];
    expect(botsRosterSignature(before)).not.toBe(botsRosterSignature(after));
  });

  it('changes when a bot is removed', () => {
    const before = [daemon({ larkAppId: 'appA' }), daemon({ larkAppId: 'appB', botIndex: 1 })];
    const after = [daemon({ larkAppId: 'appA' })];
    expect(botsRosterSignature(before)).not.toBe(botsRosterSignature(after));
  });

  it('changes when a bot is renamed', () => {
    const before = [daemon({ larkAppId: 'appA', botName: 'Old' })];
    const after = [daemon({ larkAppId: 'appA', botName: 'New' })];
    expect(botsRosterSignature(before)).not.toBe(botsRosterSignature(after));
  });

  it('changes when a bot cliId changes', () => {
    const before = [daemon({ larkAppId: 'appA', cliId: 'claude-code' })];
    const after = [daemon({ larkAppId: 'appA', cliId: 'codex' })];
    expect(botsRosterSignature(before)).not.toBe(botsRosterSignature(after));
  });
});

// `/events` 建流时推的 `bots.roster` 只带摘要：前端拿它比「断线期间名册变没变」。
describe('botsRosterDigest', () => {
  it('ignores heartbeat bumps but follows roster changes', () => {
    const a = [daemon({ larkAppId: 'appA', lastHeartbeat: 1_000 })];
    const sameButBeat = [daemon({ larkAppId: 'appA', lastHeartbeat: 99_000 })];
    const grown = [daemon({ larkAppId: 'appA' }), daemon({ larkAppId: 'appB', botIndex: 1 })];
    expect(botsRosterDigest(a)).toBe(botsRosterDigest(sameButBeat));
    expect(botsRosterDigest(a)).not.toBe(botsRosterDigest(grown));
  });

  it('changes when a bot was restarted under the same signature (its config may have changed meanwhile)', () => {
    const before = [daemon({ larkAppId: 'appA', pid: 100, startedAt: 1_000, bootInstanceId: 'boot-1' })];
    const restarted = [daemon({ larkAppId: 'appA', pid: 200, startedAt: 5_000, bootInstanceId: 'boot-2' })];
    expect(botsRosterSignature(before)).toBe(botsRosterSignature(restarted));
    expect(botsRosterDigest(before)).not.toBe(botsRosterDigest(restarted));
  });

  it('is order-independent', () => {
    const a = [daemon({ larkAppId: 'appA', botIndex: 0, pid: 1 }), daemon({ larkAppId: 'appB', botIndex: 1, pid: 2 })];
    const b = [daemon({ larkAppId: 'appB', botIndex: 1, pid: 2 }), daemon({ larkAppId: 'appA', botIndex: 0, pid: 1 })];
    expect(botsRosterDigest(a)).toBe(botsRosterDigest(b));
  });

  it('does not carry the roster itself', () => {
    const digest = botsRosterDigest([daemon({ larkAppId: 'cli_secret_app', botName: 'Visible Name' })]);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).not.toContain('cli_secret_app');
  });
});
