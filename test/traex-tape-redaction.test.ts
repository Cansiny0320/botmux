import xtermHeadless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  createTapeRedactor,
  measureReplayCells,
  parseGreetingName,
  secretTokens,
  stripAnsi,
  type TapeSecrets,
} from '../scripts/traex-tape-redaction.js';

const { Terminal } = xtermHeadless;

const base = {
  osUser: 'root',
  homeDir: '/home/tapeuser',
  workDir: '/tmp/traex-tape-abc',
  modelNames: ['Secret-Model'],
};

async function redactorFor(accountName: string, overrides: Partial<TapeSecrets> = {}) {
  const secrets = { ...base, accountName, ...overrides };
  const cellWidth = await measureReplayCells([...secretTokens(secrets), ...secrets.modelNames]);
  return createTapeRedactor(secrets, cellWidth);
}

/** Cursor column after rendering `text` in the worker's headless xterm. */
async function cursorAfter(text: string): Promise<number> {
  const term = new Terminal({ cols: 160, rows: 4, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(text, resolve));
  const x = term.buffer.active.cursorX;
  term.dispose();
  return x;
}

describe('TraeX tape redaction', () => {
  it('reads the display name only from a complete greeting row', () => {
    expect(parseGreetingName('│ Hello, alice.dev                             │')).toBe('alice.dev');
    expect(parseGreetingName('│ Good afternoon, Alice Smith              │')).toBe('Alice Smith');
    // Cursor-addressed repaint butting the next row's border against this one.
    expect(parseGreetingName('│ Hello, Alice      ││                       │')).toBe('Alice');
    expect(parseGreetingName(stripAnsi('│ Hello, \x1b[1mAlice\x1b[0m   │'))).toBe('Alice');
    // Chunk ended mid-name: no closing border yet.
    expect(parseGreetingName('│ Hello, Al')).toBeUndefined();
  });

  it('refuses ASCII name parts or personal OS logins too short to redact safely', () => {
    expect(() => secretTokens({ accountName: 'Al Smith', osUser: 'root' })).toThrow(/"Al" is too short/);
    expect(() => secretTokens({ accountName: 'Alice', osUser: 'ab' })).toThrow(/"ab" is too short/);
  });

  it('redacts names wherever they occur: prose, CJK, compound handles, any case', async () => {
    const redactor = await redactorFor('Alice Smith');
    const tape = redactor.redact({
      prompts: ['ask Alice about /home/tapeuser/x'],
      data: [
        '│ Hello, Alice Smith │\x1b[1A',
        '请Alice确认，smith也看一下',
        'mail Alice-Smith@example.org or alice_smith or ALICE.SMITH',
        'Secret-Model; /tmp/traex-tape-abc/f',
      ],
    });
    expect(tape.prompts[0]).toBe('ask tape- about {{HOME}}/x');
    expect(tape.data).toEqual([
      '│ Hello, tape-user-- │\x1b[1A',
      '请tape-确认，tape-也看一下',
      'mail tape--tape-@example.org or tape-_tape- or tape-.tape-',
      'tape-model--; {{CWD}}/f',
    ]);
    expect(() => redactor.assertClean(tape)).not.toThrow();
  });

  it('keeps replay cursor columns identical for wide names (CJK, emoji)', async () => {
    for (const name of ['张三', 'Alice 😀']) {
      const redactor = await redactorFor(name);
      const row = `\x1b[H│ Hello, ${name} │ next`;
      const redacted = redactor.redact({ row }).row;
      expect(redacted).not.toContain(name);
      expect(await cursorAfter(redacted), name).toBe(await cursorAfter(row));
    }
  });

  it('never rewrites property names; one carrying a name fails the final check', async () => {
    const redactor = await redactorFor('Alice');
    const tape = redactor.redact({ payload: { error: { Alice: 'endpoint failed' } } });
    expect(Object.keys(tape.payload.error)).toEqual(['Alice']);
    expect(() => redactor.assertClean(tape)).toThrow(/"Alice"/);
  });

  it('refuses redaction that would alter protocol ids/types', async () => {
    const redactor = await redactorFor('Turn Master');
    expect(() => redactor.redact({
      kind: 'rollout',
      record: { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    })).toThrow(/protocol field/);
    // Free text may still be redacted.
    expect(redactor.redact({ kind: 'pty', data: 'Turn Master said hi' }).data).toBe('tape-user-- said hi');
  });

  it('fails the final check on a name split by style codes in the raw stream', async () => {
    const redactor = await redactorFor('Alice');
    const tape = redactor.redact({ events: [{ kind: 'pty', data: 'hi Ali\x1b[0mce' }] });
    expect(() => redactor.assertClean(tape)).not.toThrow();
    expect(() => redactor.assertClean(tape, [stripAnsi(tape.events[0]!.data)])).toThrow(/"Alice"/);
  });

  it('treats a personal OS login as a secret and a shared service account as not', async () => {
    const personal = await redactorFor('Alice', { osUser: 'alicedev', homeDir: '/home/alicedev' });
    const tape = personal.redact({ v: ['/home/alicedev/x', 'login alicedev_ci'] });
    expect(tape.v).toEqual(['{{HOME}}/x', 'login tape-use_ci']);
    expect(() => personal.assertClean(tape)).not.toThrow();
    expect(() => personal.assertClean({ v: 'by ALICEDEV' })).toThrow(/"alicedev"/);

    const shared = await redactorFor('Alice', { homeDir: '/root' });
    expect(() => shared.assertClean({ root_turn_id: 'x', v: 'logged in as root' })).not.toThrow();
    expect(shared.redact({ v: '/root/iserver' }).v).toBe('{{HOME}}/iserver');
  });
});
