import { describe, expect, it } from 'vitest';
import { holdsOnlyMention, inputHolds, normalizeInput, pickMentionOption } from './e2e-browser/helpers.js';

describe('Feishu E2E mention check', () => {
  it('accepts only the intended bot chip, never a bare query or a neighbour', () => {
    expect(holdsOnlyMention('@[Botmux]Claude ', 'Claude')).toBe(true);
    expect(holdsOnlyMention('@BotmuxCodex ', 'Codex')).toBe(true);
    // The typed filter query before a pick has no display name yet.
    expect(holdsOnlyMention('@Claude', 'Claude')).toBe(false);
    // CI picked neighbouring bots from the dropdown.
    expect(holdsOnlyMention('@[Botmux]Aiden ', 'Claude')).toBe(false);
    expect(holdsOnlyMention('@[Botmux]OpenCode ', 'Codex')).toBe(false);
    expect(holdsOnlyMention('@[Botmux]Claude @[Botmux]Codex ', 'Claude')).toBe(false);
    // A stray literal @ broke `/reply-mode` parsing in CI.
    expect(holdsOnlyMention('@@[Botmux]Claude ', 'Claude')).toBe(false);
  });
});

describe('Feishu E2E typed-input check', () => {
  const zw = '​';
  it('ignores the editor padding and catches lost leading keystrokes', () => {
    expect(normalizeInput(`/reply-mode ${zw}\n${zw}\n${zw}`)).toBe('/reply-mode');
    expect(inputHolds(`/reply-mode ${zw}\n${zw}\n${zw}`, '/reply-mode ')).toBe(true);
    const chip = `${zw}\n@[Botmux]Claude\n`;
    expect(inputHolds(`${chip}  /reply-mode ${zw}\n${zw}`, ' /reply-mode ', chip)).toBe(true);
    // Without the chip as lead, the chip is unexpected leading text.
    expect(inputHolds('@[Botmux]Claude /reply-mode', ' /reply-mode ')).toBe(false);
    // CI: the daemon received these.
    expect(inputHolds(`eply-mode new-topic ${zw}`, '/reply-mode new-topic ')).toBe(false);
    expect(inputHolds(
      '2e-sg2-claude-1791992364019 RECALL_FIRST_MARKER 请立刻调用',
      'e2e-sg2-claude-1791992364019 RECALL_FIRST_MARKER 请立刻调用',
    )).toBe(false);
    // Leftovers a clear missed would be sent with the command.
    expect(inputHolds('eply-mode eply-mode /reply-mode', '/reply-mode')).toBe(false);
  });

  it('does not fail a long probe over rendering differences in its middle', () => {
    const probe =
      'e2e-turn1-1792003390393 RECALL_FIRST_MARKER 请立刻调用 botmux send 在本话题里回复一行内容：' +
      '"ACK-e2e-turn1-1792003390393 RECALL <标记>"（尖括号部分替换成那串标记原文，不要加引号）。做完这一步就结束本轮工作。';
    // Probes end in a fixed sentence; any difference sits mid-text.
    const rendered = probe.replace('"ACK', '“ACK').replace('>"', '>”');
    expect(probe.slice(-24)).not.toContain('"');
    expect(inputHolds(`${rendered} ${zw}`, probe)).toBe(true);
  });
});

describe('Feishu E2E member-list pick', () => {
  // Boxes from a CI screenshot at 1920×1080: the list opens above the input.
  const editor = { x: 631, y: 1015, width: 1260, height: 37 };
  const inChatHeader = { x: 649, y: 799, width: 64, height: 16 };
  const outsideHeader = { x: 649, y: 875, width: 210, height: 16 };
  const inChatRow = { x: 679, y: 834, width: 100, height: 17, fresh: true };
  const outsideRow = { x: 679, y: 910, width: 100, height: 17, fresh: true };
  // The sender label of a reply just above the list, and the chat-list entry.
  const senderLabel = { x: 672, y: 680, width: 86, height: 14, fresh: false };
  const chatListEntry = { x: 380, y: 197, width: 100, height: 17, fresh: false };

  it('clicks the member under 「会话内成员」, never the same-named bot outside the chat', () => {
    const list = {
      editor,
      options: [chatListEntry, senderLabel, outsideRow, inChatRow],
      inChat: [inChatHeader],
      outside: [outsideHeader],
    };
    expect(pickMentionOption(list)).toEqual(inChatRow);
    expect(pickMentionOption({ ...list, options: [senderLabel, outsideRow] })).toBeNull();
  });

  it('only takes rows in the band right above the input', () => {
    // Fresh same-named rows on every side of the band: the chat list redrawn
    // at the list's height (left), beyond the input's right edge, below the
    // input, and far above it.
    const outside = {
      left: { x: 200, y: 850, width: 100, height: 17, fresh: true },
      right: { x: editor.x + editor.width + 10, y: 850, width: 100, height: 17, fresh: true },
      below: { x: 679, y: editor.y + editor.height + 4, width: 100, height: 17, fresh: true },
      farAbove: { x: 679, y: editor.y - 600, width: 100, height: 17, fresh: true },
    };
    for (const [where, row] of Object.entries(outside)) {
      const headed = { editor, inChat: [inChatHeader], outside: [outsideHeader] };
      const bare = { editor, inChat: [], outside: [] };
      expect(pickMentionOption({ ...headed, options: [row] }), `${where}, with headers`).toBeNull();
      expect(pickMentionOption({ ...bare, options: [row] }), `${where}, without headers`).toBeNull();
      expect(pickMentionOption({ ...headed, options: [row, inChatRow] }), `${where}, with headers`).toEqual(inChatRow);
      expect(pickMentionOption({ ...bare, options: [row, inChatRow] }), `${where}, without headers`).toEqual(inChatRow);
    }
  });

  it('waits while the list is still a skeleton row', () => {
    expect(pickMentionOption({ editor, options: [chatListEntry, senderLabel], inChat: [], outside: [] })).toBeNull();
  });

  it('without section headers takes the topmost row that appeared after typing @', () => {
    const list = { editor, options: [senderLabel, outsideRow, inChatRow], inChat: [], outside: [] };
    expect(pickMentionOption(list)).toEqual(inChatRow);
    // A header elsewhere on the page (not above the input) does not count.
    const farHeader = { x: 1300, y: 40, width: 64, height: 16 };
    expect(pickMentionOption({ ...list, inChat: [farHeader] })).toEqual(inChatRow);
  });
});
