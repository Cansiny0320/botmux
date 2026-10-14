/**
 * Real worker lifecycle for a Linux credential-only pane on a persistent tmux
 * backend: the relay outbox must survive a daemon-restart-style worker exit
 * (SIGTERM → shutdownWorkerForParentExit), be re-served by the successor
 * worker WITHOUT killing the live CLI, and only be removed by a real close.
 *
 * Fully hermetic: HOME, SESSION_DATA_DIR and bots.json live in a temp dir (the
 * worker resolves the enrollment marker from `homedir()`), and `tmux` on PATH
 * is a shim pinned to a private socket.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import {
  DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME,
  isolationPaneMarkerPath,
} from '../src/adapters/cli/read-isolation.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }
const credentialOnlyRuntime = process.platform === 'linux'
  && (() => {
    const probe = probeHostCredentialIsolationMechanism();
    return probe.supported && probe.mechanism === 'bwrap';
  })();

const cases = [
  { label: 'managed Claude Code pane', cliId: 'claude-code', version: '2.1.0 (Claude Code)', existingAppServer: false },
  // The external-App-Server remote TUI takes an EARLIER shutdown branch (it
  // never runs killCli); the relay outbox must survive that branch too.
  { label: 'Codex remote TUI on an existing App Server', cliId: 'codex', version: 'codex-cli 0.136.0', existingAppServer: true },
];

describe('credential-only relay across a real worker lifecycle (tmux)', () => {
  it.skipIf(!realTmux || !credentialOnlyRuntime).each(cases)(
    '$label: keeps the outbox through SIGTERM, re-serves it on reattach, removes it on close',
    async ({ cliId, version, existingAppServer }) => {
      const sessionId = randomUUID();
      // Short path: tmux socket paths are length-limited.
      const dir = mkdtempSync('/tmp/credonly-life-');
      const socket = join(dir, 'socket');
      const dataDir = join(dir, '.botmux', 'data');
      mkdirSync(dataDir, { recursive: true });
      // Device enrolled: mandatory credential isolation; bot sandbox stays OFF.
      writeFileSync(join(dir, '.botmux', DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME), '{}', { mode: 0o600 });
      const bots = join(dir, 'bots.json');
      writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId }]));
      const report = join(dir, 'report.jsonl');
      const script = join(dir, 'fake-cli');
      writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, relay: process.env.BOTMUX_SEND_RELAY || null }) + '\\n');
console.log('Ready >'); setInterval(() => {}, 1 << 30);
`, { mode: 0o700 });
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o700 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: bots,
        BOTMUX_NO_CLAIM: '1',
      };
      for (const key of Object.keys(env)) if (key.startsWith('BOTMUX_') && key !== 'BOTMUX_NO_CLAIM') delete env[key];
      delete env.TMUX;
      delete env.TMUX_PANE;
      const sessionRoot = join(dataDir, 'sandboxes', sessionId);
      const outbox = join(sessionRoot, 'outbox');
      const capabilityLeaf = join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME);
      const reports = (): Array<{ pid: number; relay: string | null }> => existsSync(report)
        ? readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
      const paneAlive = (): boolean => spawnSync(realTmux!, ['-S', socket, 'has-session', '-t', `bmx-${sessionId.slice(0, 8)}`]).status === 0;
      const init = (bootId: string) => ({
        type: 'init', sessionId, chatId: 'virtual_probe', rootMessageId: 'om_probe', workingDir: dir,
        cliId, cliPathOverride: script, backendType: 'tmux', prompt: '', apiOnly: true,
        ...(existingAppServer ? {
          existingAppServerEndpoint: 'ws://127.0.0.1:9',
          cliSessionId: '019a0000-0000-7000-8000-000000000001',
        } : {}),
        larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner', daemonBootId: bootId,
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
      });
      const startWorker = (bootId: string): { worker: ChildProcess; logs: () => string } => {
        const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let logs = '';
        worker.stdout?.on('data', data => { logs += String(data); });
        worker.stderr?.on('data', data => { logs += String(data); });
        worker.send(init(bootId));
        return { worker, logs: () => logs };
      };
      const stop = async (worker: ChildProcess, how: 'SIGTERM' | 'close') => {
        const exited = once(worker, 'exit');
        if (how === 'close') worker.send({ type: 'close' });
        else worker.kill('SIGTERM');
        const timer = setTimeout(() => worker.kill('SIGKILL'), 15_000);
        try { if (worker.exitCode === null && worker.signalCode === null) await exited; }
        finally { clearTimeout(timer); }
      };
      let current: ChildProcess | undefined;
      try {
        // 1. Fresh credential-only spawn: the CLI sees the relay, the host has it.
        const first = startWorker('boot-1');
        current = first.worker;
        await vi.waitFor(() => expect(reports().length, first.logs()).toBe(1), { timeout: 30_000 });
        expect(reports()[0]!.relay).toBe(outbox);
        await vi.waitFor(() => expect(existsSync(capabilityLeaf), first.logs()).toBe(true), { timeout: 10_000 });
        await vi.waitFor(() => expect(readFileSync(isolationPaneMarkerPath(dataDir, sessionId), 'utf8'), first.logs())
          .toContain('committed'), { timeout: 30_000 });
        const cliPid = reports()[0]!.pid;

        // 2. Daemon restart shape: SIGTERM. The pane survives; so must its outbox.
        await stop(first.worker, 'SIGTERM');
        current = undefined;
        expect(paneAlive()).toBe(true);
        expect(existsSync(outbox), first.logs()).toBe(true);

        // 3. Successor worker reattaches the SAME live CLI and re-serves the relay.
        const second = startWorker('boot-2');
        current = second.worker;
        await vi.waitFor(() => expect(second.logs()).toContain('REATTACH'), { timeout: 30_000 });
        await vi.waitFor(() => expect(existsSync(capabilityLeaf), second.logs()).toBe(true), { timeout: 10_000 });
        expect(reports(), second.logs()).toHaveLength(1); // no cold spawn
        expect(() => process.kill(cliPid, 0)).not.toThrow();

        // 4. A real close removes the pane and the relay tree.
        await stop(second.worker, 'close');
        current = undefined;
        await vi.waitFor(() => expect(existsSync(sessionRoot), second.logs()).toBe(false), { timeout: 10_000 });
        expect(paneAlive()).toBe(false);
      } finally {
        if (current) await stop(current, 'close').catch(() => undefined);
        try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
