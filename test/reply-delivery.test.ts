/**
 * `src/core/reply-delivery.ts` 纯函数层：solo 会话判定、transcript 支持白名单、
 * 运行时生效值（配置 transcript 但 CLI 不支持 → fail-closed 回落 send）。
 *
 * Run: vitest run --project unit test/reply-delivery.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// registry 只 mock 本模块用到的读取口；其它导出不需要。resolveReplyDelivery 缺省
// undefined = bots.json 未显式配置，由 effectiveReplyDelivery 按 CLI 补缺省。
// getBot 缺省返回无 sandbox 的配置（等价 off：cursor 的 transcript 能力不受限）。
vi.mock('../src/bot-registry.js', () => ({
  resolveReplyDelivery: vi.fn((): 'send' | 'transcript' | undefined => undefined),
  getOwnerOpenId: vi.fn(() => undefined),
  getBot: vi.fn(() => ({ config: { sandbox: undefined } })),
}));

import { getBot, getOwnerOpenId, resolveReplyDelivery } from '../src/bot-registry.js';
import {
  computeSoloSession,
  computeSoloSessionForBot,
  defaultReplyDeliveryFor,
  effectiveReplyDelivery,
  supportsTranscriptReplyDelivery,
  type SoloSessionInput,
} from '../src/core/reply-delivery.js';

const OWNER = 'ou_owner';

/** 基线：普通群 + 1 人 1 bot + owner 发言 → solo；每个用例只改一处。 */
const SOLO_GROUP: SoloSessionInput = {
  chatType: 'group',
  chatMode: 'group',
  stats: { userCount: 1, botCount: 1 },
  senderType: 'user',
  senderOpenId: OWNER,
  ownerOpenId: OWNER,
};

describe('computeSoloSession', () => {
  const cases: Array<{ name: string; input: Partial<SoloSessionInput>; expected: boolean }> = [
    { name: 'p2p 私聊恒为 solo（不看其它字段）', input: { chatType: 'p2p', chatMode: undefined, stats: undefined, senderType: undefined, senderOpenId: undefined, ownerOpenId: undefined }, expected: true },
    { name: '普通群 + 1/1 + owner 发言 → solo', input: {}, expected: true },
    { name: '话题群 → 非 solo', input: { chatMode: 'topic' }, expected: false },
    { name: 'chatMode 未知 → 非 solo', input: { chatMode: undefined }, expected: false },
    { name: 'stats 未知 → 非 solo', input: { stats: undefined }, expected: false },
    { name: 'userCount 2 → 非 solo', input: { stats: { userCount: 2, botCount: 1 } }, expected: false },
    { name: 'botCount 2 → 非 solo', input: { stats: { userCount: 1, botCount: 2 } }, expected: false },
    { name: 'API 失败的 {999,999} 哨兵 → 非 solo', input: { stats: { userCount: 999, botCount: 999 } }, expected: false },
    { name: 'bot 发言 → 非 solo', input: { senderType: 'bot' }, expected: false },
    { name: '非 owner 发言 → 非 solo', input: { senderOpenId: 'ou_other' }, expected: false },
    { name: '无 owner → 非 solo', input: { ownerOpenId: undefined }, expected: false },
    { name: '无发言者 open_id → 非 solo', input: { senderOpenId: undefined }, expected: false },
    { name: 'chatType 未知 → 非 solo', input: { chatType: undefined }, expected: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(computeSoloSession({ ...SOLO_GROUP, ...c.input })).toBe(c.expected);
    });
  }
});

describe('computeSoloSessionForBot', () => {
  beforeEach(() => {
    vi.mocked(getOwnerOpenId).mockReset();
    vi.mocked(getOwnerOpenId).mockReturnValue(undefined);
  });

  it('owner 从 registry 取：匹配 → solo', () => {
    vi.mocked(getOwnerOpenId).mockReturnValue(OWNER);
    const { ownerOpenId: _omit, ...input } = SOLO_GROUP;
    expect(computeSoloSessionForBot('app_a', input)).toBe(true);
    expect(getOwnerOpenId).toHaveBeenCalledWith('app_a');
  });

  it('registry 无 owner → 非 solo', () => {
    const { ownerOpenId: _omit, ...input } = SOLO_GROUP;
    expect(computeSoloSessionForBot('app_a', input)).toBe(false);
  });

  it('registry 抛错 → fail-closed 非 solo', () => {
    vi.mocked(getOwnerOpenId).mockImplementation(() => { throw new Error('not registered'); });
    const { ownerOpenId: _omit, ...input } = SOLO_GROUP;
    expect(computeSoloSessionForBot('app_a', input)).toBe(false);
  });
});

describe('supportsTranscriptReplyDelivery', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['claude-code', true],
    ['codex', true],
    ['traex', true],
    ['coco', true],
    ['hermes', true],
    ['mtr', true],
    ['pi', true],
    ['oh-my-pi', true],
    ['ebsd', true],
    ['grok', true],
    // cursor 的转写兜底自 #932 起在普通 spawn 下也始终开启；codex-app 天然转写模式。
    ['cursor', true],
    ['codex-app', false],
    ['gemini', false],
    [undefined, false],
    ['', false],
  ];
  for (const [cliId, expected] of cases) {
    it(`${cliId ?? '(undefined)'} → ${expected}`, () => {
      expect(supportsTranscriptReplyDelivery(cliId)).toBe(expected);
    });
  }
});

describe('defaultReplyDeliveryFor', () => {
  const cases: Array<[string | undefined, 'send' | 'transcript']> = [
    // 缺省一律 send：transcript 是 opt-in，不随 CLI 自动翻转。
    ['claude-code', 'send'],
    ['codex', 'send'],
    ['hermes', 'send'],
    ['cursor', 'send'],
    ['codex-app', 'send'],
    [undefined, 'send'],
    ['', 'send'],
  ];
  for (const [cliId, expected] of cases) {
    it(`${cliId ?? '(undefined)'} → ${expected}`, () => {
      expect(defaultReplyDeliveryFor(cliId)).toBe(expected);
    });
  }
});

describe('effectiveReplyDelivery', () => {
  beforeEach(() => {
    vi.mocked(resolveReplyDelivery).mockReset();
    vi.mocked(resolveReplyDelivery).mockReturnValue(undefined);
    vi.mocked(getBot).mockReset();
    vi.mocked(getBot).mockReturnValue({ config: { sandbox: undefined } } as any);
  });

  it('未配置 + claude-code → send（缺省不翻转，与上游一致）', () => {
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('send');
    expect(resolveReplyDelivery).toHaveBeenCalledWith('app_a');
  });

  it('未配置 + codex → send（CLI 缺省）', () => {
    expect(effectiveReplyDelivery('app_a', 'codex')).toBe('send');
  });

  it('未配置 + cursor → send', () => {
    expect(effectiveReplyDelivery('app_a', 'cursor')).toBe('send');
  });

  it('显式 send + claude-code → send（退回旧行为）', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('send');
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('send');
  });

  it('显式 transcript + claude-code → transcript', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('transcript');
  });

  it('显式 transcript + codex → transcript', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'codex')).toBe('transcript');
  });

  it('显式 transcript + cursor → transcript（#932 起普通 spawn 也有转写采集）', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'cursor')).toBe('transcript');
  });

  it('显式 transcript + cursor + scratch 沙箱 → 回落 send（host 读不到 merged mirror，不能静默）', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    vi.mocked(getBot).mockReturnValue({ config: { sandbox: 'scratch' } } as any);
    expect(effectiveReplyDelivery('app_a', 'cursor')).toBe('send');
  });

  it('显式 transcript + cursor + oncall 沙箱 → transcript（oncall bind 宿主目录可读）', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    vi.mocked(getBot).mockReturnValue({ config: { sandbox: 'oncall' } } as any);
    expect(effectiveReplyDelivery('app_a', 'cursor')).toBe('transcript');
  });

  it('supportsTranscriptReplyDeliveryForBot: cursor scratch=false / oncall=true / 其它 always-on CLI 不受 scratch 影响', async () => {
    const { supportsTranscriptReplyDeliveryForBot } = await import('../src/core/reply-delivery.js');
    expect(supportsTranscriptReplyDeliveryForBot('cursor', { sandbox: 'scratch' })).toBe(false);
    expect(supportsTranscriptReplyDeliveryForBot('cursor', { sandbox: 'oncall' })).toBe(true);
    expect(supportsTranscriptReplyDeliveryForBot('cursor')).toBe(true);
    // codex/grok 的 transcript 桥不经过 cursor 的 merged-mirror 路径，scratch 不收窄
    expect(supportsTranscriptReplyDeliveryForBot('codex', { sandbox: 'scratch' })).toBe(true);
    expect(supportsTranscriptReplyDeliveryForBot('antigravity', { sandbox: 'scratch' })).toBe(false);
  });

  it('显式 transcript + antigravity → 仍回落 send（只有零注入转写）', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'antigravity')).toBe('send');
  });

  it('无 larkAppId → send（即使是 claude-code），且不查 registry', () => {
    expect(effectiveReplyDelivery(undefined, 'claude-code')).toBe('send');
    expect(resolveReplyDelivery).not.toHaveBeenCalled();
  });

  it('registry 抛错 → fail-closed send（claude-code 也不补缺省）', () => {
    vi.mocked(resolveReplyDelivery).mockImplementation(() => { throw new Error('boom'); });
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('send');
  });
});
