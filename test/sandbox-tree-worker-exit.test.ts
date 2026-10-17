/**
 * Worker wiring for the per-session sandbox tree on a detach-style exit.
 *
 * The real lifecycle (tmux / PTY × oncall / scratch / credential-only, daemon
 * restart and transfer) is exercised in
 * sandbox-relay-lifecycle.integration.test.ts, which needs tmux + bwrap and
 * skips without them. These source-shape checks keep the single decision point
 * pinned on every runner.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}\n', start));
}

describe('sandbox tree on a detach-style worker exit', () => {
  it('decides "outlives the worker" once, after every flavour established its tree', () => {
    const decision = 'sandboxTreeOutlivesWorker = sandboxTreeSurvivesWorkerExit({';
    const at = source.indexOf(decision);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(source.indexOf(decision, at + 1)).toBe(-1);
    expect(source.slice(at, source.indexOf('});', at))).toContain('ownsTree: sandboxCleanup !== null');
    // Every spawn-time tree handle (oncall, scratch Linux/macOS, credential-only;
    // fresh or reattach) is taken before the decision reads it.
    const spawnStart = source.indexOf('async function spawnCli(');
    const spawnEnd = source.indexOf('\nfunction killCli(', spawnStart);
    const handles = [...source.slice(spawnStart, spawnEnd).matchAll(/sandboxCleanup = (?:sbx|att|credentialRelay)\.cleanup;/g)];
    expect(handles.length).toBeGreaterThanOrEqual(8);
    for (const handle of handles) expect(spawnStart + handle.index!).toBeLessThan(at);
    // Only killCli resets it; nothing else re-derives a second rule.
    expect([...source.matchAll(/^\s+sandboxTreeOutlivesWorker = /gm)]).toHaveLength(2);
    expect(functionBody('function killCli(')).toContain('sandboxTreeOutlivesWorker = false;');
  });

  it('a parent-exit shutdown preserves the tree exactly when the pane outlives the worker', () => {
    const body = functionBody('function shutdownWorkerForParentExit(');
    expect(body).toContain('const preserveSandbox = sandboxTreeOutlivesWorker;');
    expect(body).toContain('killCli({ preserveSandbox });');
  });

  it('a crashed worker keeps the tree of a pane that is still running', () => {
    const body = functionBody('function teardownSandboxBestEffort(');
    expect(body).toMatch(/if \(!sandboxTreeOutlivesWorker\) \{\s*try \{ sandboxCleanup\?\.\(\); \}/);
    // The watcher and this generation's capability leaf still go away.
    expect(body).toContain('sandboxStopWatcher?.()');
    expect(body).toContain('unlinkManagedOriginCapabilityFiles();');
  });

  it('never recreates the oncall outbox on a warm reattach', () => {
    expect(source).toContain('if (outbox && !willReattachPersistent) {');
    const armAt = source.indexOf('const att = attachSandboxOutbox({ sessionId: cfg.sessionId, dataDir });');
    expect(armAt).toBeGreaterThanOrEqual(0);
    expect(source.slice(armAt, armAt + 400)).toContain('refusing to reattach session');
  });
});
