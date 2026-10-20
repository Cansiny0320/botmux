/**
 * Startup command + multi-line first prompt, against a REAL worker (tmux
 * backend + claude-code adapter + flushPending / runStartupCommands / writeInput)
 * and a fake Claude Code that behaves like Ink on a loaded host.
 *
 * Incident 2026-10-20 (session f2eaabca): Claude Code printed nothing for 66s.
 * The worker still typed `/effort xhigh`, then the multi-line first prompt 257ms
 * later, into a process that was not reading input. When Ink attached it read
 * the whole backlog as ONE burst, treated it as a paste (every Enter became a
 * newline, every soft-newline `\` stayed literal) and nothing was submitted.
 *
 * The fake CLI keeps raw mode on (no kernel echo) but does not read stdin until
 * it "boots"; then it draws a framed `❯` composer. A chunk that carries Enter
 * together with other bytes is a paste burst, exactly like Ink. Each submit is
 * recorded in the transcript the way Claude does: slash commands as
 * `<command-name>` lines, prompts as `role:user` lines.
 *
 *   A  cold start: 20s of silence (past the 15s first-prompt timeout), then the
 *      composer appears. `/effort xhigh` must be typed only after that, the
 *      prompt only after the command's transcript record, and the prompt must
 *      arrive as a real submit with real newlines.
 *   B  the command's Enter is swallowed (no execution record). The prompt must
 *      be held — never typed behind the command — and the user told; once the
 *      command is executed in the terminal, the held prompt is delivered.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const tmuxAvailable = probeTmuxFunctional().ok;

const FIRST_PROMPT = [
  '状态卡和 CLI 实际状态对不上，排查三处原因：',
  '1. daemon 重启恢复会话后卡片不再更新',
  '2. OSC 停在工作中后没有兜底',
  '3. 排队消息匹配不上结束信号',
].join('\n');

interface FakeEvent { t: number; kind: 'ready' | 'chunk' | 'paste' | 'swallowed' | 'submit'; text?: string }

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.304 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
fs.writeFileSync(cfg.pidFile, String(process.pid));
process.stdin.setRawMode(true);
let composer = '';
let swallowed = false;
let released = false;
const rule = '─'.repeat(48);
const render = () => {
  process.stdout.write('\\x1b[2J\\x1b[H Fake Claude Code\\r\\n\\r\\n' + rule + '\\r\\n❯ '
    + composer.split('\\n').join('\\r\\n  ') + '\\r\\n' + rule + '\\r\\n  ? for shortcuts\\r\\n');
};
const record = content => {
  fs.mkdirSync(path.dirname(cfg.transcript), { recursive: true });
  fs.appendFileSync(cfg.transcript, JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\\n');
};
const submit = () => {
  const text = composer;
  composer = '';
  ev({ kind: 'submit', text });
  const m = /^(\\/[\\w:.-]+)(?:\\s+(.*))?$/.exec(text);
  if (m) {
    record('<command-name>' + m[1] + '</command-name>\\n<command-args>' + (m[2] || '') + '</command-args>');
    record('<local-command-stdout>ok</local-command-stdout>');
  } else {
    record(text);
  }
  render();
};
const onData = buf => {
  const s = buf.toString('utf8');
  ev({ kind: 'chunk', text: s });
  // Ink paste burst: Enter that arrives together with other bytes is a newline.
  if (s.length > 1 && s.includes('\\r')) {
    composer += s.replace(/\\r/g, '\\n');
    ev({ kind: 'paste', text: s });
    render();
    return;
  }
  if (s === '\\r') {
    if (composer.endsWith('\\\\')) { composer = composer.slice(0, -1) + '\\n'; render(); return; }
    if (cfg.swallowCommandEnter && !swallowed && composer.startsWith('/')) {
      swallowed = true;
      composer += '\\n';
      ev({ kind: 'swallowed' });
      render();
      return;
    }
    submit();
    return;
  }
  composer += s;
  render();
};
setTimeout(() => { ev({ kind: 'ready' }); render(); process.stdin.on('data', onData); }, cfg.bootMs);
setInterval(() => {
  if (released || !cfg.releaseFile || !fs.existsSync(cfg.releaseFile)) return;
  released = true;
  composer = composer.replace(/\\n$/, '');
  submit();
}, 100);
setInterval(() => {}, 1000);
`;

interface Scenario {
  name: string;
  bootMs: number;
  swallowCommandEnter: boolean;
}

interface ScenarioRun {
  events: FakeEvent[];
  messages: WorkerToDaemon[];
  logs: string;
  transcript: string;
  releasedAt?: number;
  heldNotice?: Extract<WorkerToDaemon, { type: 'user_notify' }>;
}

function readEvents(file: string): FakeEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeEvent);
}

async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  const root = mkdtempSync(join('/tmp', 'bmx-claude-startup-'));
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  mkdirSync(dataDir);
  mkdirSync(workingDir);
  mkdirSync(claudeDir);
  const eventsFile = join(root, 'events.jsonl');
  const pidFile = join(root, 'cli-pid');
  const releaseFile = join(root, 'release');
  const transcript = claudeJsonlPathForSession(sessionId, workingDir, claudeDir);
  const configFile = join(root, 'fake-claude.json');
  writeFileSync(configFile, JSON.stringify({
    events: eventsFile, pidFile, transcript, bootMs: scenario.bootMs,
    swallowCommandEnter: scenario.swallowCommandEnter,
    releaseFile: scenario.swallowCommandEnter ? releaseFile : undefined,
  }));
  const fakeCli = join(root, 'claude');
  // An extensionless script follows the nearest package.json; never inherit a
  // stray `"type": "module"` from a parent directory.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  // The worker hands the CLI a filtered env, so bake the config path in.
  writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeCli, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const waitFor = async (condition: () => boolean, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) {
        throw new Error(`[${scenario.name}] timed out waiting for ${what}\n${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type !== 'screen_update'))}`);
      }
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const run: ScenarioRun = { events: [], messages, logs: '', transcript: '' };
  try {
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: privateTmuxEnv(root, {
        SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir, cliId: 'claude-code', cliPathOverride: fakeCli, cliConfigDir: claudeDir,
      backendType: 'tmux', startupCommands: ['/effort xhigh'],
      prompt: FIRST_PROMPT, turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    const submits = () => readEvents(eventsFile).filter(e => e.kind === 'submit');
    if (scenario.swallowCommandEnter) {
      await waitFor(
        () => messages.some(m => m.type === 'user_notify' && m.message.includes('/effort xhigh')),
        60_000, 'the held-prompt notice',
      );
      run.heldNotice = messages.find((m): m is Extract<WorkerToDaemon, { type: 'user_notify' }> =>
        m.type === 'user_notify' && m.message.includes('/effort xhigh'));
      // Give a premature prompt write a chance to show up before releasing.
      await new Promise(r => setTimeout(r, 1_500));
      expect(submits(), logs.join('')).toHaveLength(0);
      run.releasedAt = Date.now();
      writeFileSync(releaseFile, 'enter');
    }
    await waitFor(() => submits().length >= 2, 75_000, 'both submits');
    // Let a late retry Enter or a stray write surface before asserting.
    await new Promise(r => setTimeout(r, 2_000));
  } finally {
    run.events = readEvents(eventsFile);
    run.logs = logs.join('');
    run.transcript = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    try { execFileSync('tmux', ['kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* exited */ }
    rmSync(root, { recursive: true, force: true });
  }
  return run;
}

function expectCleanStartupSequence(run: ScenarioRun): void {
  const submits = run.events.filter(e => e.kind === 'submit').map(e => e.text ?? '');
  // No byte ever reached the composer as a paste burst.
  expect(run.events.filter(e => e.kind === 'paste'), run.logs).toEqual([]);
  expect(submits[0], run.logs).toBe('/effort xhigh');
  expect(submits[1], run.logs).toContain(FIRST_PROMPT);
  expect(submits[1]).not.toContain('\\\n');
  expect(submits[1]).not.toContain('/effort');
  expect(submits, run.logs).toHaveLength(2);
  // The prompt's first byte followed the command's execution record.
  const commandAt = run.events.find(e => e.kind === 'submit')!.t;
  const firstPromptChunk = run.events.find(e => e.kind === 'chunk' && FIRST_PROMPT.startsWith(e.text ?? '\u0000'));
  expect(firstPromptChunk, run.logs).toBeDefined();
  expect(firstPromptChunk!.t).toBeGreaterThan(commandAt);
  expect(run.transcript).toContain('<command-name>/effort</command-name>');
  // Every submit warning carries this error code (activation and ordinary wording alike).
  expect(run.messages.filter(m => m.type === 'user_notify' && m.message.includes('submit_unconfirmed')), run.logs)
    .toEqual([]);
}

it.skipIf(!tmuxAvailable)(
  'startup command + multi-line first prompt survive a cold start and a swallowed command Enter',
  async () => {
    const [cold, swallowed] = await Promise.all([
      runScenario({ name: 'A cold start', bootMs: 20_000, swallowCommandEnter: false }),
      runScenario({ name: 'B swallowed command Enter', bootMs: 0, swallowCommandEnter: true }),
    ]);

    // A: a write before the fake booted would have been read as one paste burst.
    expectCleanStartupSequence(cold);

    // B: the prompt was held behind the unconfirmed command, the user was told,
    // and delivery resumed only once the command actually ran.
    expect(swallowed.heldNotice, swallowed.logs).toBeDefined();
    expect(swallowed.heldNotice!.kind).toBe('input_not_submitted');
    expect(swallowed.events.some(e => e.kind === 'swallowed')).toBe(true);
    const promptChunks = swallowed.events.filter(e => e.kind === 'chunk' && FIRST_PROMPT.includes(e.text ?? '\u0000'));
    expect(promptChunks.length, swallowed.logs).toBeGreaterThan(0);
    expect(Math.min(...promptChunks.map(e => e.t))).toBeGreaterThan(swallowed.releasedAt!);
    expectCleanStartupSequence(swallowed);
  },
  120_000,
);
