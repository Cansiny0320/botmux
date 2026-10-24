/**
 * bot-admin-unions-store：每个 bot 用自己的凭证把管理员解析成 union_id 并发布，兄弟 bot
 * 按 allowedUsers 指纹读取——同机 bot 判「同一个 owner」的数据来源。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeBotAdminUnions,
  createBotAdminUnionsPublisher,
  readBotAdminUnions,
  writeBotAdminUnions,
} from '../src/services/bot-admin-unions-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-admin-unions-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('computeBotAdminUnions', () => {
  it('maps every admin form to union_id; the first entry is the owner', async () => {
    const lookup = vi.fn(async (openId: string) => ({ ou_mail: 'on_mail', ou_lit: 'on_lit', ou_phone: 'on_phone' } as Record<string, string>)[openId]);
    const { snapshot, complete } = await computeBotAdminUnions(
      ['me@example.com', 'on_direct', 'ou_lit', '+86 138 0000 0000'],
      new Map([['me@example.com', 'ou_mail'], ['on_direct', 'ou_direct'], ['ou_lit', 'ou_lit'], ['+86 138 0000 0000', 'ou_phone']]),
      lookup,
    );
    expect(complete).toBe(true);
    expect(snapshot.owner).toBe('on_mail');
    expect(snapshot.admins).toEqual(['on_mail', 'on_direct', 'on_lit', 'on_phone']);
    // on_ 本身就是 union_id，不必再查。
    expect(lookup).not.toHaveBeenCalledWith('ou_direct');
  });

  it('skips entries this app could not resolve (they are not effective admins)', async () => {
    const { snapshot, complete } = await computeBotAdminUnions(
      ['gone@example.com', 'on_invisible', 'on_kept'],
      new Map([['on_kept', 'ou_kept']]),
      async () => 'on_unexpected',
    );
    expect(complete).toBe(true);
    expect(snapshot.admins).toEqual(['on_kept']);
    // 主 owner 没解析出来 → 不发布 owner，本 bot 作为发送方不会被兄弟信任。
    expect(snapshot.owner).toBeUndefined();
  });

  it('a literal ou_ entry is used as-is even when the resolution map lacks it', async () => {
    const { snapshot } = await computeBotAdminUnions(['ou_only'], new Map(), async id => (id === 'ou_only' ? 'on_only' : undefined));
    expect(snapshot.owner).toBe('on_only');
  });

  it('transient lookup failure → incomplete (retry later); definitive miss → complete', async () => {
    const transient = await computeBotAdminUnions(['ou_a'], new Map([['ou_a', 'ou_a']]), async () => undefined);
    expect(transient.complete).toBe(false);
    expect(transient.snapshot.admins).toEqual([]);
    const definitive = await computeBotAdminUnions(['ou_a'], new Map([['ou_a', 'ou_a']]), async () => null);
    expect(definitive.complete).toBe(true);
    expect(definitive.snapshot.admins).toEqual([]);
  });
});

describe('readBotAdminUnions', () => {
  async function publish(appId: string, raw: string[], unions: Record<string, string>): Promise<void> {
    const { snapshot } = await computeBotAdminUnions(raw, new Map(raw.map(r => [r, `ou_${r}`])), async ou => unions[ou]);
    writeBotAdminUnions(dir, appId, snapshot);
  }

  it('returns the published owner/admins while allowedUsers is unchanged', async () => {
    await publish('cli_a', ['me@example.com'], { 'ou_me@example.com': 'on_me' });
    const got = readBotAdminUnions(dir, 'cli_a', ['me@example.com']);
    expect(got?.owner).toBe('on_me');
    expect([...(got?.admins ?? [])]).toEqual(['on_me']);
  });

  it('a changed allowedUsers (not yet republished) reads as nothing', async () => {
    await publish('cli_a', ['me@example.com'], { 'ou_me@example.com': 'on_me' });
    expect(readBotAdminUnions(dir, 'cli_a', ['someone@example.com'])).toBeUndefined();
    // 换顺序也算变化：顺序决定谁是主 owner。
    await publish('cli_b', ['a@example.com', 'b@example.com'], { 'ou_a@example.com': 'on_a', 'ou_b@example.com': 'on_b' });
    expect(readBotAdminUnions(dir, 'cli_b', ['b@example.com', 'a@example.com'])).toBeUndefined();
  });

  it('missing, corrupt or unsafe-name snapshots read as nothing', () => {
    expect(readBotAdminUnions(dir, 'cli_none', ['me@example.com'])).toBeUndefined();
    mkdirSync(join(dir, 'bot-admin-unions'), { recursive: true });
    writeFileSync(join(dir, 'bot-admin-unions', 'cli_bad.json'), '{not json');
    expect(readBotAdminUnions(dir, 'cli_bad', ['me@example.com'])).toBeUndefined();
    expect(readBotAdminUnions(dir, '../escape', ['me@example.com'])).toBeUndefined();
  });

  it('empty current allowedUsers never yields admins', async () => {
    await publish('cli_open', [], {});
    expect(readBotAdminUnions(dir, 'cli_open', [])).toBeUndefined();
  });
});

describe('createBotAdminUnionsPublisher', () => {
  it('writes once per allowedUsers state, retries after a transient lookup failure, caches lookups', async () => {
    let raw = ['me@example.com'];
    let resolution = new Map([['me@example.com', 'ou_me']]);
    const results: Array<string | undefined> = [undefined, 'on_me'];
    const lookup = vi.fn(async () => results.shift());
    const publisher = createBotAdminUnionsPublisher({
      dataDir: dir,
      larkAppId: 'cli_pub',
      readState: () => ({ rawAllowedUsers: raw, resolution }),
      lookupUnion: lookup,
    });

    await publisher.publish();
    // 第一次查询瞬时失败：快照里还没有 owner，下次心跳会重试。
    expect(readBotAdminUnions(dir, 'cli_pub', raw)?.owner).toBeUndefined();
    await publisher.publish();
    expect(readBotAdminUnions(dir, 'cli_pub', raw)?.owner).toBe('on_me');
    expect(lookup).toHaveBeenCalledTimes(2);

    // 状态没变：不再重算、不重写文件、不再查。
    const file = join(dir, 'bot-admin-unions', 'cli_pub.json');
    const before = readFileSync(file, 'utf-8');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      await publisher.publish();
    } finally {
      nowSpy.mockRestore();
    }
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(lookup).toHaveBeenCalledTimes(2);

    // 改了 owner：重新发布；同一个 ou_ 已缓存，新 ou_ 才查。
    raw = ['me@example.com', 'on_peer'];
    resolution = new Map([['me@example.com', 'ou_me'], ['on_peer', 'ou_peer']]);
    await publisher.publish();
    expect([...(readBotAdminUnions(dir, 'cli_pub', raw)?.admins ?? [])]).toEqual(['on_me', 'on_peer']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the bot is gone', async () => {
    const publisher = createBotAdminUnionsPublisher({
      dataDir: dir, larkAppId: 'cli_gone', readState: () => undefined, lookupUnion: async () => 'on_x',
    });
    await publisher.publish();
    expect(readBotAdminUnions(dir, 'cli_gone', ['x'])).toBeUndefined();
  });
});
