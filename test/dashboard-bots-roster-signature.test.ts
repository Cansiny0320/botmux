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
  it('follows the signature: equal rosters share a digest, a changed roster gets a new one', () => {
    const a = [daemon({ larkAppId: 'appA', lastHeartbeat: 1_000 })];
    const sameButBeat = [daemon({ larkAppId: 'appA', lastHeartbeat: 99_000 })];
    const grown = [daemon({ larkAppId: 'appA' }), daemon({ larkAppId: 'appB', botIndex: 1 })];
    expect(botsRosterDigest(botsRosterSignature(a))).toBe(botsRosterDigest(botsRosterSignature(sameButBeat)));
    expect(botsRosterDigest(botsRosterSignature(a))).not.toBe(botsRosterDigest(botsRosterSignature(grown)));
  });

  it('does not carry the roster itself', () => {
    const digest = botsRosterDigest(botsRosterSignature([daemon({ larkAppId: 'cli_secret_app', botName: 'Visible Name' })]));
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).not.toContain('cli_secret_app');
  });
});
