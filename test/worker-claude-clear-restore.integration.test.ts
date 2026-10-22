/**
 * Claude transcript rotation across a daemon restart, against a REAL worker
 * (tmux backend + claude-code adapter + transcript bridge) and a fake Claude
 * Code that keeps its pid-state record the way 2.1.305 does: `/clear` and
 * in-pane `/resume` rewrite `sessions/<pid>.json`'s sessionId, `/compact`
 * appends to the same transcript.
 *
 * Incident 2026-10-22 (session 6b50f4a4): `/clear` moved Claude to a new
 * transcript; after the fleet restart the re-attached worker kept reading the
 * pre-clear file, and four replies (background-task turns) never reached the
 * group, with nothing in the logs. Zero-injection mode, as on that bot: the
 * transcript is how every reply — local turns included — reaches the group.
 *
 * The worker is SIGKILLed between generations so the tmux pane and the fake
 * Claude survive, exactly like a daemon restart. Which launch layers sit in
 * front of the fake depends on the host (the OSC 7501 relay needs bun to run
 * from source, the session scope needs a user systemd); the relay → scope →
 * CLI unwrapping itself is pinned in find-launched-cli-pid.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const runnable = process.platform === 'linux' && probeTmuxFunctional().ok;

// The workers run with locale zh; the expected notice comes from the same key.
setDefaultLocale('zh');
const UNREAD_NOTICE = t('worker.claude_bridge_turn_unread', { cliName: lookupCliDisplayName('claude-code') ?? 'Claude Code' });

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('2.1.305 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const args = process.argv.slice(2);
const after = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
let sid = after('--resume') || after('--session-id');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const procStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), pid: process.pid, sid, ...o }) + '\\n');
const record = o => {
  fs.mkdirSync(cfg.projectDir, { recursive: true });
  fs.appendFileSync(path.join(cfg.projectDir, sid + '.jsonl'), JSON.stringify({
    uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, cwd: cfg.workingDir, ...o,
  }) + '\\n');
};
// Claude's own pid-state record. Withheld until the gate file exists when the
// scenario wants a transcript nobody can locate.
const pidState = () => {
  if (cfg.pidStateGate && !fs.existsSync(cfg.pidStateGate)) return;
  fs.mkdirSync(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', process.pid + '.json'), JSON.stringify({
    pid: process.pid, sessionId: sid, cwd: cfg.workingDir, procStart, version: '2.1.305', kind: 'interactive',
  }));
};
ev({ kind: 'start' });
pidState();
setInterval(pidState, 200);
process.stdin.setRawMode(true);
let composer = '';
let busy = false;
let spin = 0;
const rule = '─'.repeat(48);
const render = () => {
  process.stdout.write('\\x1b[2J\\x1b[H Fake Claude Code ' + (busy ? '|/-+'[spin++ % 4] : '') + '\\r\\n\\r\\n' + rule
    + '\\r\\n❯ ' + composer + '\\r\\n' + rule + '\\r\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    + (busy ? ' · esc to interrupt' : '') + '\\r\\n');
};
const runTurn = (prompt, reply) => {
  busy = true;
  record({ type: 'user', message: { role: 'user', content: prompt } });
  render();
  const spinner = setInterval(render, 300);
  setTimeout(() => {
    clearInterval(spinner);
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } });
    record({ type: 'system', subtype: 'turn_duration', durationMs: cfg.turnMs });
    busy = false;
    render();
    ev({ kind: 'turn', reply });
  }, cfg.turnMs);
};
const command = (name, value) => {
  record({ type: 'user', message: { role: 'user', content: '<command-name>' + name + '</command-name>\\n<command-args>' + (value || '') + '</command-args>' } });
  record({ type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } });
};
const submit = () => {
  const text = composer.replace(/\\x1b\\[20[01]~/g, '').trim();
  composer = '';
  if (!text) { render(); return; }
  ev({ kind: 'submit', text });
  const m = /^\\/(\\S+)(?:\\s+(.*))?$/.exec(text);
  if (m && m[1] === 'clear') { sid = cfg.clearSid; command('/clear'); pidState(); }
  else if (m && m[1] === 'resume') { sid = m[2]; command('/resume', m[2]); pidState(); }
  else if (m && m[1] === 'compact') {
    record({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } });
    record({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } });
  } else if (m) command('/' + m[1], m[2]);
  else { runTurn(text, 'reply: ' + text); return; }
  ev({ kind: 'command', text });
  render();
};
setTimeout(() => {
  render();
  process.stdin.on('data', buf => {
    const s = buf.toString('utf8');
    if (s === '\\r') { submit(); return; }
    composer += s.replace(/\\r/g, '\\n');
    render();
  });
}, 300);
// A background task finishing: Claude wakes up on its own and answers — a
// terminal-local turn with no Lark message behind it.
setInterval(() => {
  if (busy) return;
  for (const name of fs.readdirSync(cfg.notifyDir).sort()) {
    const file = path.join(cfg.notifyDir, name);
    const reply = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    runTurn('<task-notification>\\n<task-id>' + name + '</task-id>\\n<status>completed</status>\\n</task-notification>', reply);
    return;
  }
}, 100);
`;

interface Harness {
  root: string;
  sessionId: string;
  workingDir: string;
  claudeDir: string;
  transcript: (sid: string) => string;
  clearSid: string;
  pidStateGate: string;
  notify: (reply: string) => void;
  commands: () => string[];
  startWorker: (init?: Partial<Extract<DaemonToWorker, { type: 'init' }>>) => Generation;
}

interface Generation {
  child: ChildProcess;
  messages: WorkerToDaemon[];
  logs: string[];
  finals: () => string[];
  notices: () => Extract<WorkerToDaemon, { type: 'user_notify' }>[];
  waitFor: (cond: () => boolean, what: string, timeoutMs?: number) => Promise<void>;
  kill: () => Promise<void>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* best effort */ }
  }
});

function setup(opts: { turnMs: number; pidStateGated?: boolean; history?: { sid: string; reply: string } }): Harness {
  mkdirSync(join(homedir(), '.botmux'), { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(tmpdir(), 'bmx-clear-restore-'));
  const sessionId = randomUUID();
  const clearSid = randomUUID();
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  const dataDir = join(root, 'data');
  const notifyDir = join(root, 'notify');
  for (const dir of [workingDir, claudeDir, dataDir, notifyDir]) mkdirSync(dir);
  const transcript = (sid: string) => claudeJsonlPathForSession(sid, workingDir, claudeDir);
  const events = join(root, 'events.jsonl');
  const pidStateGate = join(root, 'pid-state-gate');
  if (opts.history) {
    // An older conversation of this session, answered an hour ago.
    const ago = (ms: number) => new Date(Date.now() - 3_600_000 + ms).toISOString();
    mkdirSync(dirname(transcript(opts.history.sid)), { recursive: true });
    writeFileSync(transcript(opts.history.sid), [
      { type: 'user', uuid: randomUUID(), timestamp: ago(0), message: { role: 'user', content: '<task-notification>\n<task-id>old</task-id>\n</task-notification>' } },
      { type: 'assistant', uuid: randomUUID(), timestamp: ago(1_000), message: { role: 'assistant', content: [{ type: 'text', text: opts.history.reply }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 1_000, uuid: randomUUID(), timestamp: ago(1_100) },
    ].map(row => `${JSON.stringify({ sessionId: opts.history!.sid, ...row })}\n`).join(''));
  }
  const configFile = join(root, 'fake-claude.json');
  writeFileSync(configFile, JSON.stringify({
    events, claudeDir, workingDir, notifyDir, clearSid, turnMs: opts.turnMs,
    projectDir: dirname(transcript(sessionId)),
    ...(opts.pidStateGated ? { pidStateGate } : {}),
  }));
  // An extensionless script follows the nearest package.json; never inherit a
  // stray `"type": "module"` from a parent directory.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  const fakeCli = join(root, 'claude');
  writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeCli, 0o755);
  const readEvents = () => (existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  cleanups.push(() => {
    for (const pid of new Set(readEvents().map(e => e.pid as number))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    }
    // Never a bare kill-server: should TMUX_TMPDIR be missing, tmux silently
    // falls back to /tmp and the host's default server would be the target.
    const socket = join(root, `tmux-${process.getuid?.() ?? 0}`, 'default');
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  });

  let notified = 0;
  const harness: Harness = {
    root, sessionId, workingDir, claudeDir, transcript, clearSid, pidStateGate,
    notify: reply => writeFileSync(join(notifyDir, String(++notified).padStart(4, '0')), reply),
    commands: () => readEvents().filter(e => e.kind === 'command').map(e => e.text as string),
    startWorker: (init = {}) => {
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const spawnOptions: SpawnOptions = {
        cwd: resolve('.'),
        env: privateTmuxEnv(root, {
          SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
          LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      };
      const child = process.env.BOTMUX_TEST_WORKER_BINARY
        ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
        : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
      child.on('message', m => messages.push(m as WorkerToDaemon));
      child.stdout?.on('data', b => logs.push(b.toString()));
      child.stderr?.on('data', b => logs.push(b.toString()));
      const kill = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>(done => child.once('exit', () => done()));
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise(done => setTimeout(done, 3_000))]);
      };
      cleanups.push(() => { child.kill('SIGKILL'); });
      child.send({
        type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir,
        cliId: 'claude-code', cliPathOverride: fakeCli, cliConfigDir: claudeDir, backendType: 'tmux',
        prompt: '', promptInjection: 'none', larkAppId: 'app_test', larkAppSecret: 'secret', locale: 'zh',
        ...init,
      } satisfies DaemonToWorker);
      const generation: Generation = {
        child, messages, logs, kill,
        finals: () => messages.flatMap(m => (m.type === 'final_output' ? [m.content] : [])),
        notices: () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'user_notify' }> => m.type === 'user_notify'),
        waitFor: async (cond, what, timeoutMs = 45_000) => {
          const deadline = Date.now() + timeoutMs;
          while (!cond()) {
            if (Date.now() >= deadline || child.exitCode !== null) {
              throw new Error(`timed out waiting for ${what}\n${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type !== 'screen_update'))}`);
            }
            await new Promise(done => setTimeout(done, 50));
          }
        },
      };
      return generation;
    },
  };
  return harness;
}

const promptReadyCount = (g: Generation) => g.messages.filter(m => m.type === 'prompt_ready').length;

/** Let the CLI finish a background turn and wait for its reply to be forwarded. */
async function backgroundTurn(h: Harness, g: Generation, reply: string): Promise<void> {
  h.notify(reply);
  await g.waitFor(() => g.finals().some(text => text.includes(reply)), `the forwarded reply "${reply}"`);
}

async function passthrough(h: Harness, g: Generation, command: string): Promise<void> {
  g.child.send({ type: 'raw_input', content: command, turnId: `om_${randomUUID().slice(0, 8)}` } satisfies DaemonToWorker);
  await g.waitFor(() => h.commands().includes(command), `${command} to run in the CLI`);
  // One bridge poll tick (1s) for the worker to observe the rotation.
  await new Promise(done => setTimeout(done, 1_500));
}

/** SIGKILL the worker (pane and CLI survive), then re-attach a new one. */
async function restart(h: Harness, g: Generation): Promise<Generation> {
  await g.kill();
  const next = h.startWorker({ resume: true });
  await next.waitFor(() => promptReadyCount(next) > 0, 'the re-attached CLI to be ready');
  return next;
}

describe.skipIf(!runnable)('Claude transcript rotation across a daemon restart', () => {
  it('after /clear, the restored worker reads the post-clear transcript and replays nothing', async () => {
    const h = setup({ turnMs: 1_000 });
    const first = h.startWorker();
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the clear');
    await passthrough(h, first, '/clear');
    await backgroundTurn(h, first, 'R2 after the clear');
    expect(readFileSync(h.transcript(h.clearSid), 'utf8')).toContain('R2 after the clear');

    const restored = await restart(h, first);
    await backgroundTurn(h, restored, 'R3 after the restart');
    expect(restored.finals().filter(text => /R[12] /.test(text)), restored.logs.join('')).toEqual([]);
    expect(restored.notices().map(n => n.message)).not.toContain(UNREAD_NOTICE);
  }, 150_000);

  it('after /compact, the restored worker stays on the same transcript and replays nothing', async () => {
    const h = setup({ turnMs: 1_000 });
    const first = h.startWorker();
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the compact');
    await passthrough(h, first, '/compact');
    expect(readFileSync(h.transcript(h.sessionId), 'utf8')).toContain('compact_boundary');

    const restored = await restart(h, first);
    await backgroundTurn(h, restored, 'R2 after the restart');
    expect(readFileSync(h.transcript(h.sessionId), 'utf8')).toContain('R2 after the restart');
    expect(restored.finals().filter(text => text.includes('R1 ')), restored.logs.join('')).toEqual([]);
    expect(restored.notices().map(n => n.message)).not.toContain(UNREAD_NOTICE);
  }, 150_000);

  it('an in-pane /resume to an older conversation forwards only what happens after it', async () => {
    const olderSid = randomUUID();
    const h = setup({ turnMs: 1_000, history: { sid: olderSid, reply: 'OLD reply from an hour ago' } });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    await backgroundTurn(h, g, 'R1 before the resume');
    await passthrough(h, g, `/resume ${olderSid}`);
    await backgroundTurn(h, g, 'R2 after the resume');
    expect(readFileSync(h.transcript(olderSid), 'utf8')).toContain('R2 after the resume');
    expect(g.finals().filter(text => text.includes('OLD reply')), g.logs.join('')).toEqual([]);
  }, 150_000);

  it('turns the bridge cannot read are reported once, and forwarded once the transcript is found', async () => {
    // No pid-state record: after /clear nothing can tell the bridge where the
    // CLI writes. Turns long enough to be judged.
    const h = setup({ turnMs: 3_500, pidStateGated: true });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    await backgroundTurn(h, g, 'R1 before the clear');
    await passthrough(h, g, '/clear');

    for (const reply of ['R2 unread', 'R3 unread']) {
      const readyBefore = promptReadyCount(g);
      h.notify(reply);
      await g.waitFor(() => readFileSync(h.transcript(h.clearSid), 'utf8').includes(reply)
        && promptReadyCount(g) > readyBefore, `the CLI to finish "${reply}"`);
    }
    expect(g.finals().filter(text => text.includes('unread'))).toEqual([]);
    expect(g.notices().filter(n => n.message === UNREAD_NOTICE), g.logs.join('')).toHaveLength(1);

    // Claude's state becomes readable: the bridge moves over and delivers the
    // replies it missed — once each, with no second notice.
    writeFileSync(h.pidStateGate, '');
    await g.waitFor(() => ['R2 unread', 'R3 unread'].every(reply => g.finals().some(text => text.includes(reply))),
      'the unread replies to be forwarded');
    expect(g.finals().filter(text => text.includes('unread'))).toHaveLength(2);
    expect(g.finals().filter(text => text.includes('R1 '))).toHaveLength(1);
    expect(g.notices().filter(n => n.message === UNREAD_NOTICE)).toHaveLength(1);
  }, 150_000);
});
