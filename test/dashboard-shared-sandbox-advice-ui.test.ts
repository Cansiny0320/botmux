import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedBotSandboxAdvice } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

const shared = {
  larkAppId: 'cli_demo', cliId: 'claude-code', sandboxMode: 'off',
  oncallSharedChatCount: 2, allowedUsersCount: 3,
} as unknown as BotDefaultsRow;

const render = (bot: Partial<BotDefaultsRow>) =>
  renderToStaticMarkup(createElement(SharedBotSandboxAdvice, { bot: { ...shared, ...bot } as BotDefaultsRow }));
const lines = (html: string) => [...html.matchAll(/<p>(.*?)<\/p>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));

describe('Dashboard shared-bot sandbox advice', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders in the browser bundle, where there is no `process`', () => {
    // The page bundle has no Node globals: reading process.platform there threw
    // and took the whole sandbox section down for every shared bot.
    vi.stubGlobal('process', undefined);
    expect(render({ cliId: 'codex-app', sandboxNetworkPolicyPlatform: 'linux' })).toContain('data-shared-sandbox-advice="unsupported"');
    expect(render({ cliId: 'codex-app', sandboxNetworkPolicyPlatform: 'darwin' })).toContain('data-shared-sandbox-advice="unverified"');
    expect(render({ cliId: 'claude-code' })).toContain('data-shared-sandbox-advice="verified"');
  });

  it('is short lines, one fact each, with the verified list folded away', () => {
    const html = render({ cliId: 'claude-code', sandboxNetworkPolicyPlatform: 'linux' });
    const text = lines(html);
    expect(text.slice(0, 5)).toEqual([
      '⚠️ 建议开启白名单隔离',
      '这个 bot 被多人使用，群成员可以通过 agent 读到本机凭证。',
      '原因：开了 Oncall 值班模式、allowedUsers 有多人',
      expect.stringMatching(/^开启：在下方选「.+」，新会话生效。$/),
      '当前 CLI：Claude，已验证可用。',
    ]);
    // Folded: a closed <details> holding the matrix list.
    expect(html).toMatch(/<details><summary>已验证可用的 CLI（Linux 实测）<\/summary><p>Claude、Codex、Gemini、OpenCode、Pi、Oh My Pi、Grok Build、Kimi<\/p><\/details>/);
    expect(html).not.toMatch(/<details open/);
  });

  it('says nothing for a bot only its owner uses, or one already isolated', () => {
    expect(render({ oncallSharedChatCount: 0, allowedUsersCount: 1 })).toBe('');
    expect(render({ effectiveSandboxMode: 'oncall' } as Partial<BotDefaultsRow>)).toBe('');
  });
});
