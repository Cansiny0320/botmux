import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/chat-reply-mode-store.js');
  const events = await import('../src/core/dashboard-events.js');
  return { registry, store, events };
}

describe('chat reply mode store', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-chat-reply-mode-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_reply_mode',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      ...entry,
    }], null, 2));
  }

  function readEntry(): any {
    return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
  }

  it('reports override, default, effective mode, and inheritance source', async () => {
    // Agent default: flat chat; group A explicitly forks a new topic. Every
    // other group inherits flat chat.
    writeConfig({ regularGroupReplyMode: 'chat', chatReplyModes: { oc_pinned: 'new-topic' } });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));

    expect(store.getChatReplyModeState('app_reply_mode', 'oc_pinned')).toEqual({
      override: 'new-topic',
      default: 'chat',
      effective: 'new-topic',
      inherited: false,
    });
    expect(store.getChatReplyModeState('app_reply_mode', 'oc_inherited')).toEqual({
      override: null,
      default: 'chat',
      effective: 'chat',
      inherited: true,
    });
  });

  it('persists an explicit override even when it equals the current bot default', async () => {
    writeConfig(); // default is chat-topic
    const { registry, store, events } = await freshModules();
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));
    const published: unknown[] = [];
    const off = events.dashboardEventBus.subscribe(event => published.push(event));

    const result = await store.setChatReplyMode('app_reply_mode', 'oc_same_as_default', 'chat-topic');
    off();
    expect(result).toMatchObject({
      ok: true,
      mode: 'chat-topic',
      override: 'chat-topic',
      default: 'chat-topic',
      effective: 'chat-topic',
      inherited: false,
    });
    expect(readEntry().chatReplyModes).toEqual({ oc_same_as_default: 'chat-topic' });
    expect(published).toEqual([{
      type: 'groups.reply-policy.changed',
      body: { chatId: 'oc_same_as_default' },
    }]);

    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    raw[0].regularGroupReplyMode = 'chat';
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const reloaded = await freshModules();
    reloaded.registry.loadBotConfigs().forEach(config => reloaded.registry.registerBot(config));
    expect(reloaded.store.getChatReplyModeState('app_reply_mode', 'oc_same_as_default')).toEqual({
      override: 'chat-topic',
      default: 'chat',
      effective: 'chat-topic',
      inherited: false,
    });
  });

  it('clears only the requested override and restores inheritance idempotently', async () => {
    writeConfig({
      regularGroupReplyMode: 'chat',
      chatReplyModes: { oc_clear: 'new-topic', oc_keep: 'shared' },
    });
    const { registry, store, events } = await freshModules();
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));
    const published: unknown[] = [];
    const off = events.dashboardEventBus.subscribe(event => published.push(event));

    const cleared = await store.clearChatReplyMode('app_reply_mode', 'oc_clear');
    expect(cleared).toEqual({
      ok: true,
      cleared: true,
      override: null,
      default: 'chat',
      effective: 'chat',
      inherited: true,
    });
    expect(readEntry().chatReplyModes).toEqual({ oc_keep: 'shared' });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({ oc_keep: 'shared' });

    const repeated = await store.clearChatReplyMode('app_reply_mode', 'oc_clear');
    off();
    expect(repeated).toMatchObject({ ok: true, cleared: false, inherited: true });
    expect(readEntry().chatReplyModes).toEqual({ oc_keep: 'shared' });
    // 幂等空清除不写盘、不发事件（没有任何策略变化）。
    expect(published).toEqual([
      { type: 'groups.reply-policy.changed', body: { chatId: 'oc_clear' } },
    ]);
  });

  it('canonicalizes legacy aliases and drops invalid siblings before syncing memory', async () => {
    writeConfig({
      regularGroupReplyMode: 'chat',
      chatReplyModes: {
        oc_legacy: 'topic_alias',
        oc_invalid: 'surprise-mode',
      },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));

    await expect(store.setChatReplyMode('app_reply_mode', 'oc_new', 'new-topic')).resolves.toMatchObject({
      ok: true,
      override: 'new-topic',
      effective: 'new-topic',
    });
    expect(readEntry().chatReplyModes).toEqual({
      oc_legacy: 'shared',
      oc_new: 'new-topic',
    });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({
      oc_legacy: 'shared',
      oc_new: 'new-topic',
    });

    // Clearing a missing key is a no-op on disk, but the in-memory registry is
    // re-synced from the (normalized) disk snapshot, healing external edits.
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    raw[0].chatReplyModes = { oc_legacy: 'topic', oc_bad: false };
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    await expect(store.clearChatReplyMode('app_reply_mode', 'oc_missing')).resolves.toMatchObject({
      ok: true,
      cleared: false,
      override: null,
      effective: 'chat',
      inherited: true,
    });
    expect(readEntry().chatReplyModes).toEqual({ oc_legacy: 'topic', oc_bad: false });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({ oc_legacy: 'shared' });
  });

  /**
   * withFileLock 在关闭锁句柄前就释放了锁：较早的写可能在较晚的写「落盘 + 同步内存」
   * 之后才恢复。这里在第一次落盘返回前插入延迟来稳定复现这个窗口。
   */
  async function withDelayedFirstPersist() {
    const mods = await freshModules();
    mods.registry.loadBotConfigs().forEach(config => mods.registry.registerBot(config));
    const configStore = await import('../src/services/config-store.js');
    const real = configStore.rmwBotEntry;
    let calls = 0;
    vi.spyOn(configStore, 'rmwBotEntry').mockImplementation(async (...args: Parameters<typeof real>) => {
      const n = calls++;
      const result = await real(...args);
      if (n === 0) await new Promise(resolve => setTimeout(resolve, 40));
      return result;
    });
    return mods;
  }

  it('concurrent overrides on two chats of one bot both survive in memory (not just on disk)', async () => {
    writeConfig({ regularGroupReplyMode: 'chat' });
    const { registry, store } = await withDelayedFirstPersist();

    const [a, b] = await Promise.all([
      store.setChatReplyMode('app_reply_mode', 'oc_a', 'new-topic'),
      store.setChatReplyMode('app_reply_mode', 'oc_b', 'shared'),
    ]);
    expect(a).toMatchObject({ ok: true, override: 'new-topic' });
    expect(b).toMatchObject({ ok: true, override: 'shared' });
    expect(readEntry().chatReplyModes).toEqual({ oc_a: 'new-topic', oc_b: 'shared' });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({ oc_a: 'new-topic', oc_b: 'shared' });
    expect(store.resolveRegularGroupMode('app_reply_mode', 'oc_b')).toBe('shared');
  });

  it('concurrent clear + set on different chats keep memory consistent with disk', async () => {
    writeConfig({ regularGroupReplyMode: 'chat', chatReplyModes: { oc_old: 'new-topic' } });
    const { registry, store } = await withDelayedFirstPersist();

    await Promise.all([
      store.clearChatReplyMode('app_reply_mode', 'oc_old'),
      store.setChatReplyMode('app_reply_mode', 'oc_new', 'chat-topic'),
    ]);
    expect(readEntry().chatReplyModes).toEqual({ oc_new: 'chat-topic' });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({ oc_new: 'chat-topic' });
  });

  it('concurrent writes to the same chat leave memory on the last persisted value', async () => {
    writeConfig({ regularGroupReplyMode: 'chat' });
    const { registry, store } = await withDelayedFirstPersist();

    await Promise.all([
      store.setChatReplyMode('app_reply_mode', 'oc_same', 'new-topic'),
      store.setChatReplyMode('app_reply_mode', 'oc_same', 'shared'),
    ]);
    expect(readEntry().chatReplyModes).toEqual({ oc_same: 'shared' });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({ oc_same: 'shared' });
  });

  it('a failed write does not wedge the per-bot queue', async () => {
    writeConfig({ regularGroupReplyMode: 'chat' });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));
    const configStore = await import('../src/services/config-store.js');
    const real = configStore.rmwBotEntry;
    vi.spyOn(configStore, 'rmwBotEntry')
      .mockRejectedValueOnce(new Error('file-lock timeout'))
      .mockImplementation(real);

    const [first, second] = await Promise.allSettled([
      store.setChatReplyMode('app_reply_mode', 'oc_a', 'new-topic'),
      store.setChatReplyMode('app_reply_mode', 'oc_b', 'shared'),
    ]);
    expect(first.status).toBe('rejected');
    expect(second).toMatchObject({ status: 'fulfilled', value: { ok: true, override: 'shared' } });
    expect(registry.getBot('app_reply_mode').config.chatReplyModes).toEqual({ oc_b: 'shared' });
  });
});
