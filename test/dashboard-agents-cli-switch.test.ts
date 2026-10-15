/**
 * Saving an Agent warns about linked bots whose CLI would switch. The editor
 * passes its draft input, whose env group is the input form ({ keys, set } —
 * values never reach the browser), so the check must not touch env at all.
 */
import { describe, expect, it } from 'vitest';
import { botsSwitchingCli } from '../src/dashboard/web/agents-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

const bot = { larkAppId: 'cli_a', online: true, cliId: 'claude-code', envKeys: ['A'] } as BotDefaultsRow;

describe('botsSwitchingCli', () => {
  it('handles a draft with an input-shaped env group (regression: threw and blocked saving)', () => {
    const draft = {
      exec: { cliId: 'codex', model: '', reasoningEffort: '', configDir: '' },
      env: { keys: ['A'], set: { B: '2' } },
    };
    expect(botsSwitchingCli(draft as any, [bot]).map(row => row.larkAppId)).toEqual(['cli_a']);
    expect(botsSwitchingCli({ ...draft, exec: { ...draft.exec, cliId: 'claude-code' } } as any, [bot])).toEqual([]);
    expect(botsSwitchingCli({ env: { keys: [] } } as any, [bot])).toEqual([]);
  });

  it('ignores offline bots', () => {
    expect(botsSwitchingCli({ exec: { cliId: 'codex', model: '', reasoningEffort: '', configDir: '' } }, [{ ...bot, online: false }])).toEqual([]);
  });
});
