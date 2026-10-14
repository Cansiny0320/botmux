import { describe, expect, it } from 'vitest';
import { holdsOnlyMention } from './e2e-browser/helpers.js';

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
