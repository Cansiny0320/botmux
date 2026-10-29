import { describe, it, expect } from 'vitest';
import {
  allowlistSandboxCliSupport,
  allowlistSandboxVerifiedClis,
  sharedBotSandboxAdvice,
} from '../src/core/shared-bot-sandbox-advice.js';
import { CLI_DISPLAY_NAMES } from '../src/adapters/cli/display-names.js';

const solo = {
  sandboxMode: 'off',
  cliId: 'claude-code',
  oncallChatCount: 0,
  defaultOncallEnabled: false,
  allowedUsersCount: 1,
  triggerUserAuthEnabled: false,
};

describe('sharedBotSandboxAdvice', () => {
  it('says nothing for a bot only its owner uses', () => {
    expect(sharedBotSandboxAdvice(solo)).toBeNull();
    expect(sharedBotSandboxAdvice({ ...solo, allowedUsersCount: 0 })).toBeNull();
    // Older daemons report no counts at all.
    expect(sharedBotSandboxAdvice({ ...solo, oncallChatCount: null, allowedUsersCount: undefined })).toBeNull();
  });

  it('flags each way other people reach the agent', () => {
    expect(sharedBotSandboxAdvice({ ...solo, oncallChatCount: 2 })?.reasons).toEqual(['oncall']);
    expect(sharedBotSandboxAdvice({ ...solo, defaultOncallEnabled: true })?.reasons).toEqual(['oncall']);
    expect(sharedBotSandboxAdvice({ ...solo, allowedUsersCount: 2 })?.reasons).toEqual(['allowedUsers']);
    expect(sharedBotSandboxAdvice({ ...solo, triggerUserAuthEnabled: true })?.reasons).toEqual(['triggerUserAuth']);
    expect(sharedBotSandboxAdvice({ ...solo, oncallChatCount: 1, allowedUsersCount: 3, triggerUserAuthEnabled: true })?.reasons)
      .toEqual(['oncall', 'allowedUsers', 'triggerUserAuth']);
  });

  it('is silenced only by the allowlist sandbox, not by scratch', () => {
    const shared = { ...solo, oncallChatCount: 1 };
    expect(sharedBotSandboxAdvice({ ...shared, sandboxMode: 'oncall' })).toBeNull();
    expect(sharedBotSandboxAdvice({ ...shared, sandboxMode: 'scratch' })).not.toBeNull();
    expect(sharedBotSandboxAdvice({ ...shared, sandboxMode: undefined })).not.toBeNull();
  });

  it('carries whether the bot CLI is known to work under the sandbox', () => {
    const shared = { ...solo, allowedUsersCount: 2 };
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'claude-code' })?.cliSupport).toBe('verified');
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'codex-app' })?.cliSupport).toBe('unsupported');
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'relay' })?.cliSupport).toBe('unverified');
    expect(sharedBotSandboxAdvice({ ...shared, cliId: undefined })?.cliSupport).toBe('unverified');
  });
});

describe('allowlist sandbox CLI support table', () => {
  it('names only real CLIs, so the advice can list them by display name', () => {
    for (const id of allowlistSandboxVerifiedClis()) expect(CLI_DISPLAY_NAMES[id]).toBeTruthy();
    expect(allowlistSandboxVerifiedClis()).not.toContain('codex-app');
    expect(allowlistSandboxCliSupport('not-a-cli')).toBe('unverified');
  });
});
