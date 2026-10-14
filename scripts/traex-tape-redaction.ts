/**
 * Redaction for TraeX terminal tapes (scripts/record-traex-tape.ts).
 *
 * A tape is committed to a public repository, so everything that identifies
 * the recording machine or account must be removed: the banner greeting's
 * display name, a personal OS login, home/work paths and provider model
 * names. Kept separate from the recorder so the rules are unit-testable
 * (test/traex-tape-redaction.test.ts).
 *
 * Design, after several boundary-based variants each leaked a different shape
 * (CJK prose, `Alice_Smith`, `Alice-Smith@…`):
 *  - Identifying tokens are replaced as case-insensitive SUBSTRINGS of every
 *    decoded string value — no word boundaries. ASCII tokens shorter than 3
 *    are refused outright (they would hit ANSI sequences such as `\x1b[1A`);
 *    a ≥3-character token cannot occur inside a CSI sequence.
 *  - Over-redaction is guarded rather than prevented by boundaries: the
 *    protocol skeleton the tape player relies on (property names and id/type
 *    fields) must survive unchanged, or recording is refused. Property names
 *    are never rewritten; one carrying a token fails the final check.
 *  - Replacement widths are measured with the same headless xterm the worker
 *    renders through, so cursor-addressed repaints replay at identical columns.
 *  - The final check scans values, property names and the ANSI-stripped
 *    visible PTY stream, catching a name split by style codes ("Ali\x1b[0mce").
 *  - Shared service accounts (root, runner, …) identify nobody and are not
 *    treated as secrets; a personal OS login is treated like a name.
 */
import xterm from '@xterm/headless';

const { Terminal } = xterm;

export function stripAnsi(data: string): string {
  // eslint-disable-next-line no-control-regex
  return data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[78]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

/**
 * Display name from a COMPLETE banner greeting row. The salutation varies
 * ("Hello", "Good afternoon", …). Both name endpoints exclude the box edge
 * and whitespace: a cursor-addressed repaint can butt the next row's border
 * against this one ("Alice     ││…"), and a chunk can end mid-name, so only a
 * row whose closing border is present is trusted.
 */
export function parseGreetingName(visible: string): string | undefined {
  return visible.match(/│ [A-Z][a-z]+(?: [a-z]+)?, ([^\s│](?:[^│\n]*[^\s│])?)[ \t]*│/)?.[1];
}

/** Terminal cells per string, as laid out by the worker's headless
 *  TerminalRenderer (same package, default Unicode provider). */
export type CellWidth = (text: string) => number;

const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

export async function measureReplayCells(texts: Iterable<string>): Promise<CellWidth> {
  const term = new Terminal({ cols: 1000, rows: 2, allowProposedApi: true });
  const widths = new Map<string, number>();
  try {
    for (const text of new Set(texts)) {
      if (isAscii(text)) continue;
      await new Promise<void>(resolve => term.write(`\r\x1b[2K${text}`, resolve));
      widths.set(text, term.buffer.active.cursorX);
    }
  } finally {
    term.dispose();
  }
  return (text) => {
    if (isAscii(text)) return text.length;
    const width = widths.get(text);
    if (width === undefined) throw new Error(`no replay width measured for "${text}"`);
    return width;
  };
}

export interface TapeSecrets {
  accountName: string;
  osUser: string;
  homeDir: string;
  workDir: string;
  modelNames: Iterable<string>;
}

const GENERIC_OS_USERS = new Set(['root', 'admin', 'administrator', 'runner', 'ubuntu', 'debian', 'ec2-user', 'node', 'user']);

/** An ASCII token this short cannot be redacted safely (it occurs inside ANSI
 *  sequences and ordinary words) and must not be published either. */
const MIN_ASCII_SECRET = 3;

/** Fields the tape player and worker bridge key on; redaction must not touch them. */
const PROTOCOL_FIELDS = new Set([
  'version', 'kind', 'type', 'operation', 'turn_id', 'root_turn_id', 'session_id', 'thread_id', 'id', 'nativeSessionId',
]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function placeholder(base: string, width: number): string {
  return base.length >= width ? base.slice(0, width) : base.padEnd(width, '-');
}

function mapValues<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map(item => mapValues(item, fn)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValues(item, fn)])) as T;
  }
  return value;
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectText(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectText(item, out);
    }
  }
  return out;
}

function protocolSkeleton(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protocolSkeleton);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      PROTOCOL_FIELDS.has(key) && (item === null || typeof item !== 'object') ? item : protocolSkeleton(item),
    ]));
  }
  return typeof value === 'string' ? '' : value;
}

/** Name/login tokens that must not appear in a tape, longest first. */
export function secretTokens(secrets: Pick<TapeSecrets, 'accountName' | 'osUser'>): string[] {
  const personalUser = !GENERIC_OS_USERS.has(secrets.osUser.toLowerCase());
  const tokens = [
    secrets.accountName,
    ...secrets.accountName.split(/\s+/),
    ...(personalUser ? [secrets.osUser] : []),
  ].filter(Boolean);
  for (const token of tokens) {
    if (isAscii(token) && token.length < MIN_ASCII_SECRET) {
      throw new Error(`"${token}" is too short to redact safely; refusing to record (use an account with a longer display name)`);
    }
  }
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}

export function createTapeRedactor(secrets: TapeSecrets, cellWidth: CellWidth) {
  const nameTokens = secretTokens(secrets);
  const models = [...secrets.modelNames].filter(Boolean);

  const replaceCaseless = (text: string, token: string, base: string): string => {
    const width = cellWidth(token);
    return text.replace(new RegExp(escapeRegExp(token), 'giu'), () => placeholder(base, width));
  };

  const redactText = (text: string): string => {
    let out = text.replaceAll(secrets.workDir, '{{CWD}}').replaceAll(secrets.homeDir, '{{HOME}}');
    for (const token of nameTokens) out = replaceCaseless(out, token, 'tape-user');
    for (const model of models) out = replaceCaseless(out, model, 'tape-model');
    return out;
  };

  const checks = [...nameTokens, secrets.homeDir, secrets.workDir, ...models]
    .filter(Boolean)
    .map(token => ({ token, pattern: new RegExp(escapeRegExp(token), 'iu') }));

  return {
    /** Redact every decoded string value. Throws when that would alter a
     *  protocol field the tape player relies on. */
    redact<T>(value: T): T {
      const redacted = mapValues(value, redactText);
      if (JSON.stringify(protocolSkeleton(redacted)) !== JSON.stringify(protocolSkeleton(value))) {
        throw new Error('redaction would alter a protocol field (id/type); refusing to record');
      }
      return redacted;
    },
    /** Throw if any secret survives in values, property names or the extra
     *  visible texts (pass the ANSI-stripped, concatenated PTY stream). */
    assertClean(value: unknown, visibleTexts: string[] = []): void {
      const haystacks = [...collectText(value), ...visibleTexts];
      for (const { token, pattern } of checks) {
        if (haystacks.some(text => pattern.test(text))) throw new Error(`redaction left "${token}" in the tape`);
      }
    },
  };
}
