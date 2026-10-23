import { describe, expect, it } from 'vitest';
import { holdsOnlyMention, inputHolds, normalizeInput, pickMentionOption, pickTopicIcon } from './e2e-browser/helpers.js';

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

  it('bounds the in-chat section only by the 「会话外的人」 header below it in the list', () => {
    // The same words elsewhere at the rows' height (a profile card right of
    // the list), or above the in-chat header, must not cut the section off.
    const beside = { ...outsideHeader, x: editor.x + editor.width + 20, y: inChatRow.y - 4 };
    const above = { ...outsideHeader, y: inChatHeader.y - 60 };
    for (const header of [beside, above]) {
      expect(pickMentionOption({ editor, options: [inChatRow], inChat: [inChatHeader], outside: [header] })).toEqual(inChatRow);
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

describe('Feishu E2E topic icon pick', () => {
  // A CI screenshot at 1920×1080: the seed's text, and its hover toolbar
  // 👍 💬 ↪ topic ⋯ (each a button wrapping an svg), plus the read tick below.
  const text = { x: 684, y: 956, width: 290, height: 18 };
  const button = (cx: number) => ({ x: cx - 11, y: 947, width: 22, height: 22 });
  const svg = (cx: number) => ({ x: cx - 7, y: 951, width: 14, height: 14 });
  const centres = [1004, 1028, 1052, 1076, 1101];
  const toolbar = centres.flatMap((cx) => [button(cx), svg(cx)]);
  const tick = { x: 993, y: 971, width: 13, height: 13 };

  it('takes the icon left of 「⋯」, once per nested button and svg', () => {
    expect(pickTopicIcon(text, [...toolbar, tick])).toEqual(button(1076));
    expect(pickTopicIcon(text, [...toolbar].reverse())).toEqual(button(1076));
    // A larger element right after 「⋯」 (a reaction panel) is not an icon.
    const panel = { x: 1118, y: 930, width: 60, height: 60 };
    expect(pickTopicIcon(text, [...toolbar, panel])).toEqual(button(1076));
  });

  it('rejects every shape that is not an icon, whichever bound it breaks', () => {
    // The probe collects every element up to 40×40 near the message: corner
    // dots, 1px dividers, hover panels. Between the topic icon and 「⋯」:
    const sliverV = { x: 1087, y: 947, width: 2, height: 22 }; // width < 10
    const sliverH = { x: 1078, y: 960, width: 22, height: 6 }; // height < 10
    // Right after 「⋯」:
    const barW = { x: 1118, y: 947, width: 60, height: 22 }; // only width > 40
    const barH = { x: 1118, y: 930, width: 22, height: 60 }; // only height > 40
    const upper = { x: 1118, y: 920, width: 22, height: 22 }; // centre above the row
    for (const extra of [sliverV, sliverH, barW, barH, upper]) {
      expect(pickTopicIcon(text, [...toolbar, extra])).toEqual(button(1076));
    }
  });

  it('finds nothing without a toolbar right next to the message', () => {
    expect(pickTopicIcon(text, [tick])).toBeNull();
    // Icon-sized emoji inside the message text are not a toolbar.
    expect(pickTopicIcon(text, [700, 730, 760, 790].map((x) => ({ x, y: 957, width: 16, height: 16 })))).toBeNull();
    // The vision agent's target: icons far right of the message.
    expect(pickTopicIcon(text, centres.map((cx) => button(cx + 500)))).toBeNull();
    // Three icons are not a toolbar; nor are icons on another message's row.
    expect(pickTopicIcon(text, centres.slice(0, 3).map(button))).toBeNull();
    expect(pickTopicIcon(text, centres.map((cx) => ({ ...button(cx), y: 1010 })))).toBeNull();
  });
});
