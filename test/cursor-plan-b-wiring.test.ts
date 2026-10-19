import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-level wiring for plan B (#932) ON TOP of #2009's footer-aware drain
// and baseline. #2009 already guarantees attach never needs to wait on an
// unclassifiable tail (baselineCursorTranscript decides deterministically for
// every EOF shape; only a missing file keeps the identity pending, which the
// generic poller resolves), so the remaining plan-B wiring is: ordinary spawn
// activation, the busy-tick attribution-lease refresh (argv first turn +
// type-ahead successors, hard cap), the scratch-sandbox suppression, and
// in-binding chat rotation / observer correction.

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionSlice(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('cursor plan B worker wiring (on #2009)', () => {
  it('poller refreshes queued leases while busy (non-adopt) with a hard since-mark cap', () => {
    const tickStart = source.indexOf("if (structuredBridgeIs('cursor')) {", source.indexOf('function codexBridgeStartTimer'));
    const tickBody = source.slice(tickStart, source.indexOf("if (isPromptReady) emitReadyCodexTurns();", tickStart));
    // Refreshes EVERY queued head (argv confirmed first turn + successors).
    expect(tickBody).toContain('codexBridgeQueue.refreshUnstartedHeadAttributionLease(Date.now(), CURSOR_BUSY_REFRESH_MAX_MS)');
    // Only while the CLI is busy and not in adopt mode.
    expect(tickBody).toContain('!isPromptReady && !lastInitConfig?.adoptMode');
    expect(source).toContain('const CURSOR_BUSY_REFRESH_MAX_MS = 120_000;');
  });

  it('codexBridgeFallbackActive suppresses cursor under the scratch COW sandbox for non-adopt spawns', () => {
    const body = functionSlice('codexBridgeFallbackActive', 'isExistingAppServerSharedBridge');
    expect(body).toContain("lastInitConfig?.cliId === 'cursor'");
    expect(body).toContain("lastInitConfig?.adoptMode !== true");
    expect(body).toContain("lastResolvedSandboxMode === 'scratch'");
  });

  it('spawnCli retains the resolved sandbox mode; stopCodexBridge clears it', () => {
    expect(source).toContain('lastResolvedSandboxMode = sandboxMode;');
    const stopBody = functionSlice('stopCodexBridge', 'retainSecondaryPathIfStillReferenced');
    expect(stopBody).toContain('lastResolvedSandboxMode = undefined;');
  });

  it('spawn bridge chain keys off fallbackActive alone (zeroPromptOnly spec field is gone)', () => {
    expect(source).toContain('spawnBridge && codexBridgeFallbackActive()');
    expect(source).not.toContain('spawnBridge.zeroPromptOnly');
  });

  it('a re-reported DIFFERENT cursor chat while bound drains and re-attaches (rotation / observer correction)', () => {
    const start = source.indexOf('function codexBridgeNotifyCliSessionId');
    const body = source.slice(start, start + 10000);
    const cursorBound = body.slice(body.indexOf("if (structuredBridgeIs('cursor')) {", body.indexOf('if (codexBridgeRolloutPath)')));
    // Same chat → no-op; different chat → drain retired, detach, re-attach.
    expect(cursorBound).toContain('currentChat.toLowerCase() === cliSessionId.toLowerCase()');
    expect(cursorBound).toContain('codexBridgeDetachFile()');
    expect(cursorBound).toContain('Cursor pre-rotation bridge drain failed');
  });

  it('the observed chatId binds the bridge in EVERY mode (the default-mode no-op comment is gone)', () => {
    const start = source.indexOf('function observeCursorCliSessionId');
    const end = source.indexOf('function observeAntigravityCliSessionId', start);
    const body = source.slice(start, end);
    expect(body).toContain('codexBridgeNotifyCliSessionId(chatId)');
    expect(body).not.toContain('No-op in default mode');
  });
});
