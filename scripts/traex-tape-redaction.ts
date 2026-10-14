/**
 * Redaction for TraeX terminal tapes (scripts/record-traex-tape.ts).
 *
 * A tape is committed to a public repository, so everything that identifies
 * the recording machine or account must be removed: the banner greeting's
 * display name, the OS account, home/work paths and provider model names.
 * Kept separate from the recorder so the rules are unit-testable
 * (test/traex-tape-redaction.test.ts).
 *
 * Redaction runs on DECODED string values (never on serialized JSON, where
 * escaping such as \u001b or \" would hide a match), and the final check also
 * scans the ANSI-stripped visible PTY stream, which catches a name whose raw
 * bytes are interrupted by style codes ("Ali\x1b[0mce").
 */

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

export interface TapeSecrets {
  accountName: string;
  osUser: string;
  homeDir: string;
  workDir: string;
  modelNames: Iterable<string>;
}

/** Terminal columns: East Asian wide characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1;
  }
  return width;
}

/** Same-width placeholder keeps the recorded box drawing aligned. */
function placeholder(base: string, original: string): string {
  const width = displayWidth(original);
  return base.length >= width ? base.slice(0, width) : base.padEnd(width, '-');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Word-bounded (Unicode-aware) so `root_turn_id` does not trip `root`. */
const bounded = (token: string) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(token)}(?![\\p{L}\\p{N}_-])`, 'gu');
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** An ASCII token this short cannot be redacted safely: word-bounded
 *  replacement would still hit ANSI sequences (`\x1b[A`) and ordinary words,
 *  and skipping it would publish it. Recording is refused instead. */
const MIN_ASCII_SECRET = 3;

function deepMapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map(item => deepMapStrings(item, fn)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepMapStrings(item, fn)]),
    ) as T;
  }
  return value;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

export function createTapeRedactor(secrets: TapeSecrets) {
  const components = secrets.accountName.split(/\s+/).filter(Boolean);
  for (const token of [...components, secrets.osUser]) {
    if (isAscii(token) && token.length < MIN_ASCII_SECRET) {
      throw new Error(`"${token}" is too short to redact safely; refusing to record (use an account with a longer display name)`);
    }
  }
  const models = [...secrets.modelNames].filter(Boolean);

  const redactText = (text: string): string => {
    let out = text.replaceAll(secrets.workDir, '{{CWD}}').replaceAll(secrets.homeDir, '{{HOME}}');
    out = out.replaceAll(secrets.accountName, placeholder('tape-user', secrets.accountName));
    for (const token of components) {
      // Non-ASCII tokens cannot collide with ANSI/ASCII syntax; over-redacting
      // an unrelated occurrence is harmless, a missed one is a leak.
      out = isAscii(token)
        ? out.replace(bounded(token), placeholder('tape-user', token))
        : out.replaceAll(token, placeholder('tape-user', token));
    }
    for (const model of models) out = out.replaceAll(model, placeholder('tape-model', model));
    return out;
  };

  const checked = [secrets.accountName, ...components, secrets.osUser, secrets.homeDir, ...models];

  return {
    /** Redact every decoded string value of a tape (or any JSON value). */
    redact<T>(value: T): T {
      return deepMapStrings(value, redactText);
    },
    /** Throw if any secret survives in the value or in the extra visible
     *  texts (pass the ANSI-stripped, concatenated PTY stream). */
    assertClean(value: unknown, visibleTexts: string[] = []): void {
      const haystacks = [...collectStrings(value), ...visibleTexts];
      for (const secret of checked) {
        const pattern = isAscii(secret) ? bounded(secret) : new RegExp(escapeRegExp(secret), 'u');
        if (haystacks.some(text => { pattern.lastIndex = 0; return pattern.test(text); })) {
          throw new Error(`redaction left "${secret}" in the tape`);
        }
      }
    },
  };
}
