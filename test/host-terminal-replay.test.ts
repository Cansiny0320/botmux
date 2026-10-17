import { describe, it, expect } from 'vitest';
import { OutputRing, TerminalModeTracker } from '../src/dashboard/host-terminal-replay.js';
import {
  clampTerminalSize,
  hostTerminalTargetKey,
  parseClientControl,
  parseHostTerminalTarget,
} from '../src/dashboard/host-terminal-protocol.js';
import { ctrlChord, hostTerminalKeyBytes } from '../src/dashboard/web/host-terminal-keys.js';

const b = (s: string) => Buffer.from(s, 'latin1');

describe('TerminalModeTracker', () => {
  it('tracks alt screen, mouse, bracketed paste and keypad; restore emits the live state', () => {
    const t = new TerminalModeTracker();
    t.feed(b('hello\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h\x1b[?25l\x1b='));
    expect(t.altScreen).toBe(true);
    const seq = t.restoreSequence();
    expect(seq.startsWith('\x1b[?1047h')).toBe(true);
    expect(seq).toContain('\x1b[?1;25;1002;1003;1004;1005;1015l');
    expect(seq).toContain('\x1b[?1000;1006;2004h');
    expect(seq.endsWith('\x1b=')).toBe(true);
  });

  it('never emits an alt-screen reset: in xterm that is DECRC, which would yank the cursor', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?1049h vim \x1b[?1049l$ '));
    expect(t.altScreen).toBe(false);
    expect(t.restoreSequence()).not.toMatch(/\x1b\[\?(1049|1047|47)[lh]/);
  });

  it('parses sequences split across chunks', () => {
    const t = new TerminalModeTracker();
    t.feed(b('abc\x1b[?10'));
    t.feed(b('49h tail'));
    expect(t.altScreen).toBe(true);
    t.feed(b('\x1b'));
    t.feed(b('[?1049l'));
    expect(t.altScreen).toBe(false);
  });

  it('RIS resets everything back to defaults', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?1049h\x1b[?2004h\x1b[?25l'));
    t.feed(b('\x1bc'));
    expect(t.altScreen).toBe(false);
    expect(t.isOn(2004)).toBe(false);
    expect(t.isOn(25)).toBe(true);
  });

  it('ignores ordinary CSI / SGR traffic', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[31mred\x1b[0m \x1b[2J\x1b[H\x1b]0;title\x07'));
    expect(t.altScreen).toBe(false);
    expect(t.isOn(1000)).toBe(false);
  });
});

describe('OutputRing', () => {
  it('keeps everything while under capacity', () => {
    const r = new OutputRing(1024);
    r.push(b('one\r\n'));
    r.push(b('two\r\n'));
    expect(r.snapshot().toString()).toBe('one\r\ntwo\r\n');
  });

  it('drops whole chunks from the head and starts the replay on a line boundary', () => {
    const r = new OutputRing(100);
    r.push(b('x'.repeat(20 * 1024)));
    r.push(b('partial-line\nkept-1\n' + 'y'.repeat(60)));
    const snap = r.snapshot().toString();
    expect(snap.startsWith('kept-1\n')).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(100);
  });

  it('copies frames instead of pinning the caller buffer', () => {
    const r = new OutputRing(1024);
    const big = Buffer.alloc(64 * 1024, 0x61);
    r.push(big.subarray(0, 3));
    big.fill(0x62);
    expect(r.snapshot().toString()).toBe('aaa');
  });
});

describe('host-terminal protocol', () => {
  it('accepts shell / tmux / herdr targets and rejects option-looking names', () => {
    expect(parseHostTerminalTarget({ kind: 'shell' })).toEqual({ kind: 'shell' });
    expect(parseHostTerminalTarget({ kind: 'tmux', session: 'work' })).toEqual({ kind: 'tmux', session: 'work' });
    expect(parseHostTerminalTarget({ kind: 'herdr', session: '中文 session' })).toEqual({ kind: 'herdr', session: '中文 session' });
    expect(parseHostTerminalTarget({ kind: 'tmux', session: '-t' })).toBeNull();
    expect(parseHostTerminalTarget({ kind: 'tmux', session: 'a\u0007b' })).toBeNull();
    expect(parseHostTerminalTarget({ kind: 'tmux', session: '' })).toBeNull();
    expect(parseHostTerminalTarget({ kind: 'ssh', session: 'x' })).toBeNull();
    expect(hostTerminalTargetKey({ kind: 'tmux', session: 'w' })).toBe('tmux:w');
  });

  it('clamps terminal sizes and validates control frames', () => {
    expect(clampTerminalSize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize(99999, 99999)).toEqual({ cols: 1000, rows: 500 });
    expect(clampTerminalSize(0, 10)).toBeNull();
    expect(clampTerminalSize('80', 24)).toBeNull();
    expect(parseClientControl('{"t":"resize","cols":80.7,"rows":24}')).toEqual({ t: 'resize', cols: 80, rows: 24 });
    expect(parseClientControl('{"t":"ack","bytes":-5}')).toBeNull();
    expect(parseClientControl('{"t":"visibility","hidden":true}')).toEqual({ t: 'visibility', hidden: true });
    expect(parseClientControl('not json')).toBeNull();
    // 旧调试终端的 JSON 输入帧不再被当成输入：输入只走二进制帧。
    expect(parseClientControl('{"type":"input","data":"rm -rf /"}')).toBeNull();
  });
});

describe('host-terminal touch keys', () => {
  it('encodes arrows per DECCKM and maps the sticky-Ctrl chord', () => {
    expect(hostTerminalKeyBytes('up', false)).toBe('\x1b[A');
    expect(hostTerminalKeyBytes('up', true)).toBe('\x1bOA');
    expect(hostTerminalKeyBytes('left', true)).toBe('\x1bOD');
    expect(hostTerminalKeyBytes('shiftTab', false)).toBe('\x1b[Z');
    expect(hostTerminalKeyBytes('ctrlC', false)).toBe('\x03');
    expect(ctrlChord('c')).toBe('\x03');
    expect(ctrlChord('D')).toBe('\x04');
    expect(ctrlChord('[')).toBe('\x1b');
    expect(ctrlChord('?')).toBe('\x7f');
    expect(ctrlChord(' ')).toBe('\x00');
    expect(ctrlChord('1')).toBeNull();
    expect(ctrlChord('ab')).toBeNull();
  });
});
