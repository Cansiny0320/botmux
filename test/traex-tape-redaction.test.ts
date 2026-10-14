import { describe, expect, it } from 'vitest';
import { createTapeRedactor, parseGreetingName, stripAnsi } from '../scripts/traex-tape-redaction.js';

const base = {
  osUser: 'tapeuser',
  homeDir: '/home/tapeuser',
  workDir: '/tmp/traex-tape-abc',
  modelNames: ['Secret-Model'],
};

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

  it('refuses ASCII name parts or OS users too short to redact safely', () => {
    expect(() => createTapeRedactor({ ...base, accountName: 'Al Smith' })).toThrow(/"Al" is too short/);
    expect(() => createTapeRedactor({ ...base, accountName: 'Alice', osUser: 'ab' })).toThrow(/"ab" is too short/);
  });

  it('redacts the full name, each name part, paths and models in decoded strings', () => {
    const redactor = createTapeRedactor({ ...base, accountName: 'Alice Smith' });
    const tape = redactor.redact({
      prompts: ['ask Alice about /home/tapeuser/x'],
      events: [
        { kind: 'pty', data: '│ Hello, Alice Smith │\x1b[1A' },
        { kind: 'pty', data: 'Smith said hi; Smithson unrelated; Secret-Model; /tmp/traex-tape-abc/f' },
      ],
    });
    expect(tape.prompts[0]).toBe('ask tape- about {{HOME}}/x');
    expect(tape.events[0]!.data).toBe('│ Hello, tape-user-- │\x1b[1A');
    expect(tape.events[1]!.data).toBe('tape- said hi; Smithson unrelated; tape-model--; {{CWD}}/f');
    expect(() => redactor.assertClean(tape)).not.toThrow();
  });

  it('keeps box alignment for wide (CJK) names and redacts any-length non-ASCII parts', () => {
    const redactor = createTapeRedactor({ ...base, accountName: '张三' });
    const tape = redactor.redact({ data: '│ 下午好, 张三 │ 张三说' });
    expect(tape.data).toBe('│ 下午好, tape │ tape说');
    expect(() => redactor.assertClean(tape)).not.toThrow();
  });

  it('redacts and detects an ASCII name embedded in CJK prose', () => {
    const redactor = createTapeRedactor({ ...base, accountName: 'Alice Smith' });
    const tape = redactor.redact({ data: '请Alice确认，Smith也看一下' });
    expect(tape.data).toBe('请tape-确认，tape-也看一下');
    expect(() => redactor.assertClean({ data: '请Alice确认' })).toThrow(/"Alice"/);
  });

  it('covers property names in both redaction and the final check', () => {
    const redactor = createTapeRedactor({ ...base, accountName: 'Alice' });
    const tape = redactor.redact({ payload: { error: { Alice: 'endpoint failed' } } });
    expect(Object.keys(tape.payload.error)).toEqual(['tape-']);
    expect(() => redactor.assertClean({ payload: { error: { Alice: 'x' } } })).toThrow(/"Alice"/);
  });

  it('keeps terminal cell width for emoji display names', () => {
    const redactor = createTapeRedactor({ ...base, accountName: 'Alice 😀' });
    const row = '│ Hello, Alice 😀 │';
    const out = redactor.redact({ row }).row;
    // "Alice 😀" spans 8 cells (the emoji is wide): the border must not move.
    expect(out).toBe('│ Hello, tape-use │');
  });

  it('fails the final check on a name split by style codes in the raw stream', () => {
    const redactor = createTapeRedactor({ ...base, accountName: 'Alice' });
    const tape = redactor.redact({ events: [{ kind: 'pty', data: 'hi Ali\x1b[0mce' }] });
    expect(() => redactor.assertClean(tape)).not.toThrow();
    expect(() => redactor.assertClean(tape, [stripAnsi(tape.events[0]!.data)])).toThrow(/"Alice"/);
  });

  it('flags the OS user and home dir left anywhere, but not inside identifiers', () => {
    const redactor = createTapeRedactor({ ...base, accountName: 'Alice', osUser: 'root', homeDir: '/root' });
    expect(() => redactor.assertClean({ k: 'root_turn_id', v: 'deadroot' })).not.toThrow();
    expect(() => redactor.assertClean({ v: 'logged in as root' })).toThrow(/"root"/);
    expect(redactor.redact({ v: '/root/iserver' }).v).toBe('{{HOME}}/iserver');
  });
});
