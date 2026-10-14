/**
 * Record a real TraeX session as a replayable terminal tape.
 *
 * TraeX is distributed internally only, so CI cannot run the real binary.
 * This script drives a local `traex` through a 160x50 PTY (the worker's render
 * size) and captures, with relative timestamps:
 *   - every PTY output chunk,
 *   - every line appended to the session rollout JSONL,
 *   - every line appended to the global history.jsonl,
 *   - the submits we typed.
 * test/helpers/traex-tape-player.mjs replays the result as a fake `traex`.
 *
 * Only the rollout records the worker bridge consumes are kept (see
 * keepRollout); records carrying system prompts or reasoning are dropped. Paths are replaced by
 * placeholders. Review the tape before committing it.
 *
 * Usage: node --import tsx scripts/record-traex-tape.ts [out.json] [prompt...]
 * (node-pty delivers no output under bun, so run it with node.)
 */
import { execFileSync } from 'node:child_process';
import { spawn as ptySpawn } from 'node-pty';
import { findTraexRolloutSetByPid } from '../src/services/traex-transcript.js';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

type TapeEvent =
  | { t: number; kind: 'pty'; data: string }
  | { t: number; kind: 'rollout'; record: unknown }
  | { t: number; kind: 'history'; record: unknown }
  | { t: number; kind: 'submit'; text: string };

const out = resolve(process.argv[2] ?? 'test/fixtures/traex-tape/two-turns.json');
const prompts = process.argv.length > 3
  ? process.argv.slice(3)
  : ['只回复一个词：好。不要调用任何工具。', '只回复一个词：行。不要调用任何工具。'];

const traeHome = process.env.TRAE_HOME?.trim() || join(homedir(), '.trae');
const sessionsRoot = join(traeHome, 'cli', 'sessions');
const historyPath = join(traeHome, 'cli', 'history.jsonl');
const workDir = mkdtempSync(join(tmpdir(), 'traex-tape-'));
const bin = process.env.TRAEX_BIN ?? 'traex';

function listRollouts(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listRollouts(p, acc);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

// The banner greets the logged-in account ("Hello, <name>" / "Good
// afternoon, <name>"); never commit it.
let accountName: string | undefined;
// Provider model names (banner + status bar + turn_context) are not ours to publish.
const modelNames = new Set<string>();

function sameWidth(base: string, width: number): string {
  return base.length >= width ? base.slice(0, width) : base.padEnd(width, '-');
}

function sanitize(text: string): string {
  let out = text
    .replaceAll(workDir, '{{CWD}}')
    .replaceAll(homedir(), '{{HOME}}');
  // Same-width placeholders keep the recorded box drawing aligned.
  if (accountName) out = out.replaceAll(accountName, sameWidth('tape-user', accountName.length));
  for (const model of modelNames) out = out.replaceAll(model, sameWidth('tape-model', model.length));
  return out;
}

// TraeX 0.209's banner logo blinks forever (◆/─ eyes repainted in place), so
// the PTY is never byte-silent. Quiescence for recording purposes ignores
// chunks whose visible content is only those glyphs.
function stripAnsi(data: string): string {
  // eslint-disable-next-line no-control-regex
  return data.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[78]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function isLogoBlink(data: string): boolean {
  return /^[◆─\s]*$/.test(stripAnsi(data));
}

// Allow-list of rollout records the worker bridge consumes. Everything else
// (session_meta, world_state, thread_settings_applied, model-side history
// items, reasoning) carries system prompts or private context.
const KEPT_EVENT_MSGS = new Set(['task_started', 'task_complete', 'token_count', 'turn_aborted']);

function keepRollout(record: any): unknown | undefined {
  const p = record?.payload ?? {};
  if (record?.type === 'event_msg' && KEPT_EVENT_MSGS.has(p.type)) {
    return JSON.parse(sanitize(JSON.stringify(record)));
  }
  if (record?.type === 'history_mutation' && Array.isArray(p.display_completions)) {
    const display = p.display_completions.filter((c: any) =>
      c?.item?.type === 'UserMessage' || c?.item?.type === 'AgentMessage');
    if (display.length === 0) return undefined;
    return JSON.parse(sanitize(JSON.stringify({
      timestamp: record.timestamp,
      type: 'history_mutation',
      payload: { version: p.version, operation: p.operation, turn_id: p.turn_id, items: [], display_completions: display },
    })));
  }
  if (record?.type === 'turn_context') {
    return { timestamp: record.timestamp, type: 'turn_context', payload: { turn_id: p.turn_id, model: p.model, effort: p.effort } };
  }
  return undefined;
}

const existing = new Set(listRollouts(sessionsRoot));
const historyBase = existsSync(historyPath) ? statSync(historyPath).size : 0;
const startedAt = Date.now();
const now = () => Date.now() - startedAt;
const events: TapeEvent[] = [];
let lastPtyAt = 0;
let screenTail = '';

const pty = ptySpawn(bin, [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--no-alt-screen',
  '-c', 'check_for_update_on_startup=false',
  '-c', 'notice.hide_rate_limit_model_nudge=true',
  '-C', workDir,
], { name: 'xterm-256color', cols: 160, rows: 50, cwd: workDir, env: process.env as Record<string, string> });

const rawPty: Array<{ t: number; data: string }> = [];
pty.onData((data) => {
  const t = now();
  if (!isLogoBlink(data)) lastPtyAt = t;
  screenTail = (screenTail + data).slice(-4000);
  const visibleTail = stripAnsi(screenTail);
  // Only a COMPLETE greeting row (closing box edge present) is trusted: a
  // chunk can end mid-name, and names may contain spaces.
  // The salutation varies ("Hello", "Good afternoon", …).
  accountName ??= visibleTail.match(/│ [A-Z][a-z]+(?: [a-z]+)?, (\S(?:[^│\n]*\S)?)[ \t]*│/)?.[1];
  const model = visibleTail.match(/model:\s+(\S+)\s+\/model/)?.[1];
  if (model && model !== 'loading') modelNames.add(model);
  rawPty.push({ t, data });
});

let rolloutPath: string | undefined;
let rolloutOffset = 0;
let rolloutPending = '';
let historyOffset = historyBase;
let historyPending = '';
const terminals: string[] = [];

function readAppended(path: string, offset: number): { text: string; next: number } {
  const size = statSync(path).size;
  if (size <= offset) return { text: '', next: offset };
  const buf = readFileSync(path).subarray(offset, size);
  return { text: buf.toString('utf8'), next: size };
}

// history.jsonl is shared by every TraeX pane under this TRAE_HOME. Buffer
// it raw and keep only the recorded session's lines once that is proven.
const historyLines: Array<{ t: number; line: string }> = [];

const poll = setInterval(() => {
  if (!rolloutPath) {
    // Another pane may create a rollout concurrently: accept only one the
    // spawned process itself holds open (fd ownership, Linux /proc).
    const owned = findTraexRolloutSetByPid(pty.pid);
    if (owned === undefined) {
      clearInterval(poll);
      pty.kill();
      throw new Error('cannot prove rollout ownership (fd enumeration unavailable); refusing to record');
    }
    rolloutPath = listRollouts(sessionsRoot).find(p => {
      const sid = p.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1]?.toLowerCase();
      return !existing.has(p) && !!sid && owned.has(sid);
    });
  }
  if (rolloutPath && existsSync(rolloutPath)) {
    const { text, next } = readAppended(rolloutPath, rolloutOffset);
    rolloutOffset = next;
    rolloutPending += text;
    const lines = rolloutPending.split('\n');
    rolloutPending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record?.type === 'event_msg' && record.payload?.type === 'task_complete') terminals.push(record.payload.turn_id);
      if (record?.type === 'turn_context' && typeof record.payload?.model === 'string') modelNames.add(record.payload.model);
      const kept = keepRollout(record);
      if (kept) events.push({ t: now(), kind: 'rollout', record: kept });
    }
  }
  if (existsSync(historyPath)) {
    const { text, next } = readAppended(historyPath, historyOffset);
    historyOffset = next;
    historyPending += text;
    const lines = historyPending.split('\n');
    historyPending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) historyLines.push({ t: now(), line });
    }
  }
}, 10);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitQuiet(quietMs: number, capMs: number, predicate: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate() && now() - lastPtyAt >= quietMs) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for quiet screen\n${screenTail}`);
}

try {
  // Startup: composer marker drawn and the banner's model cell resolved.
  await waitQuiet(3_000, 60_000, () => /[›❯]/.test(screenTail) && !/model:\s+loading/.test(screenTail));
  for (const prompt of prompts) {
    const before = terminals.length;
    events.push({ t: now(), kind: 'submit', text: prompt });
    pty.write(`\x1b[200~${prompt}\x1b[201~`);
    await sleep(200);
    pty.write('\r');
    await waitQuiet(3_000, 180_000, () => terminals.length > before);
  }
  await sleep(500);
} finally {
  clearInterval(poll);
  pty.kill();
}

const nativeSessionId = rolloutPath?.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1];
if (!nativeSessionId) throw new Error('no owned rollout was recorded');
for (const { t, line } of historyLines) {
  const record = JSON.parse(line);
  if (record?.session_id === nativeSessionId) events.push({ t, kind: 'history', record });
}
for (const chunk of rawPty) events.push({ t: chunk.t, kind: 'pty', data: chunk.data });
events.sort((a, b) => a.t - b.t);

// Sanitize and validate the WHOLE tape (prompts included), not just events:
// the account name may be learnt mid-stream, so this runs last.
if (!accountName) throw new Error('could not find the banner greeting; refusing to write an unsanitized tape');
const tape = JSON.parse(sanitize(JSON.stringify({
  version: 1,
  recordedWith: (() => { try { return execFileSync(bin, ['--version']).toString().split('\n')[0]; } catch { return 'unknown'; } })(),
  cols: 160,
  rows: 50,
  nativeSessionId,
  prompts,
  events,
})));
const serialized = JSON.stringify(tape);
// Independent of what the banner parser learnt: the OS account must never
// appear either (it is usually a prefix of the greeting name). Each part of
// a multi-word display name is checked too.
const secrets = new Set([accountName, ...accountName.split(/\s+/), userInfo().username, homedir(), ...modelNames]);
for (const secret of secrets) {
  if (!secret || secret.length < 3) continue;
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word-bounded so identifiers such as `root_turn_id` do not trip a `root` account.
  if (new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(serialized)) {
    throw new Error(`sanitizer left "${secret}" in the tape`);
  }
}
writeFileSync(out, `${JSON.stringify(tape, null, 1)}\n`);
console.log(`tape: ${out} (${tape.events.length} events, session ${nativeSessionId})`);
