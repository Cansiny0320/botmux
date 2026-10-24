/**
 * 决策看板 daemon 服务：管家开关闸、CLI 动作、提交即投递（一批 = 一次投递 = 一条消息）、
 * 投递失败落在批次上并可重投、重启补投、同一批次不并发重复投递。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionBoardService, boardErrorStatus, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import type { StewardConfig } from '../src/core/decision-board/model.js';

const APP = 'cli_steward';
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]).toString('base64');

let dir: string;
let steward: StewardConfig | undefined;
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let deliverImpl: DecisionBoardServiceDeps['deliver'];
let service: DecisionBoardService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-svc-'));
  steward = { enabled: true, chatId: 'oc_steward' };
  delivered = [];
  deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => steward,
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => '主人',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: input => deliverImpl(input),
    log: () => {},
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addDecideItem(title = 'PR #1 合不合') {
  const res = await service.cli({
    action: 'add', title, fields: { question: '合不合？' }, options: ['A=合 → 风险小', 'B=不合'],
  }, { sessionId: 'sess-1' }) as { item: { seq: number; rev: number } };
  return res.item;
}

describe('管家开关', () => {
  it('没开管家时 CLI 一律拒绝，且不建库', async () => {
    steward = undefined;
    await expect(service.cli({ action: 'list' }, { sessionId: 's' })).rejects.toMatchObject({ code: 'not_steward' });
    expect(boardErrorStatus(await service.cli({ action: 'guide' }, { sessionId: 's' }).catch(e => e)).status).toBe(409);
    expect(service.meta().counts).toEqual({ decide: 0, active: 0, all: 0 });
    expect(existsSync(join(dir, 'decision-board.sqlite'))).toBe(false);
  });
});

describe('CLI 动作', () => {
  it('add 返回飞书侧栏打开的链接；有问题默认待拍板；推荐项必须在选项里', async () => {
    const res = await service.cli({ action: 'add', title: 't', fields: { question: 'q', recommend: 'a' }, options: ['A=x', 'B=y'] }, { sessionId: 's' }) as any;
    expect(res.item).toMatchObject({ seq: 1, state: 'decide', stateLabel: '待拍板', recommend: 'A',
      url: `https://dash.example/board/${APP}/1` });
    expect(new URL(res.item.appLink).searchParams.get('url')).toBe(`https://dash.example/board/${APP}/1`);
    await expect(service.cli({ action: 'add', title: 't2', fields: { recommend: 'C' }, options: ['A=x'] }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'unknown_recommend' });
    await expect(service.cli({ action: 'set', ref: '1', fields: { recommend: 'Z' } }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'unknown_recommend' });
  });

  it('错误的选项 / 关联 / 状态给出可读原因', async () => {
    await expect(service.cli({ action: 'add', title: 't', options: ['无等号'] }, { sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_option' });
    await expect(service.cli({ action: 'add', title: 't', links: ['pr=bad'] }, { sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(service.cli({ action: 'add', title: 't', fields: { state: 'merged' } }, { sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(service.cli({ action: 'show', ref: '99' }, { sessionId: 's' })).rejects.toMatchObject({ code: 'item_not_found' });
  });

  it('set --clear-ask 清掉问题、选项和推荐', async () => {
    const item = await addDecideItem();
    await service.cli({ action: 'set', ref: `#${item.seq}`, clearAsk: true, fields: { state: 'active' } }, { sessionId: 's' });
    const shown = await service.cli({ action: 'show', ref: String(item.seq) }, { sessionId: 's' }) as any;
    expect(shown.item.question).toBeUndefined();
    expect(shown.item.options).toEqual([]);
    expect(shown.item.state).toBe('active');
  });

  it('attach 校验图片文件头；guide 输出预置 + 追加', async () => {
    const item = await addDecideItem();
    const res = await service.cli({ action: 'attach', ref: String(item.seq), files: [{ name: 'a.png', mimeType: 'image/png', dataBase64: PNG_B64 }] }, { sessionId: 's' }) as any;
    expect(res.files).toHaveLength(1);
    await expect(service.cli({ action: 'attach', ref: String(item.seq), files: [{ name: 'a.png', mimeType: 'image/png', dataBase64: Buffer.from('nope').toString('base64') }] }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'invalid_files' });
    steward = { enabled: true, chatId: 'oc_steward', guideText: '推进标准：只催不合' };
    const guide = await service.cli({ action: 'guide' }, { sessionId: 's' }) as any;
    expect(guide.guide.trimEnd().endsWith('推进标准：只催不合')).toBe(true);
  });
});

describe('提交与投递', () => {
  it('提交多项 = 一次投递：一条消息里带全部决定，附图随回合送出，批次标为已送达', async () => {
    const a = await addDecideItem('a');
    const b = await addDecideItem('b');
    const { file } = service.upload({ name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_B64 });
    const da = service.putDraft(a.seq, 'owner', { choice: 'A', text: '合吧', fileIds: [file.id], baseRev: a.rev }).draft!;
    const db = service.putDraft(b.seq, 'owner', { text: '先别动', baseRev: b.rev }).draft!;
    const res = await service.submit({ author: 'owner', submitter: 'local', nonce: 'n1', items: [
      { seq: a.seq, draftUpdatedAt: da.updatedAt }, { seq: b.seq, draftUpdatedAt: db.updatedAt },
    ] });
    expect(res.batch).toMatchObject({ id: 1, delivery: 'delivered', sessionId: 'sess-steward', attempts: 1 });
    expect(delivered).toHaveLength(1);
    const msg = delivered[0];
    expect(msg.chatId).toBe('oc_steward');
    expect(msg.ownerOpenId).toBe('ou_owner');
    expect(msg.turnId).toMatch(new RegExp(`^board:${APP}:1:`));
    expect(msg.banner).toBe('收到 2 项（#1）');
    expect(msg.prompt).toContain('【决策看板 · 批次 #1】主人');
    expect(msg.prompt).toContain('#1 a（待拍板）\n  选：A 合\n  说明：合吧\n  附图：1 张');
    expect(msg.prompt).toContain('#2 b（待拍板）\n  选：未选\n  说明：先别动');
    expect(msg.attachments).toHaveLength(1);
    expect(readFileSync(msg.attachments[0].path).toString('base64')).toBe(PNG_B64);
    // 草稿已清空，决定待管家执行
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => d.seq)).toEqual([a.seq, b.seq]);
  });

  it('管家没选群：批次落库但标为失败，补上群后重投成功', async () => {
    steward = { enabled: true };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'B', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(res.batch).toMatchObject({ delivery: 'failed', error: 'steward_chat_missing' });
    expect(delivered).toHaveLength(0);
    steward = { enabled: true, chatId: 'oc_steward' };
    const again = await service.redeliver(res.batch.id);
    expect(again.batch.delivery).toBe('delivered');
    expect(delivered).toHaveLength(1);
  });

  it('投递抛错记在批次上；daemon 起来后补投；已送达的不再投', async () => {
    deliverImpl = async () => { throw new Error('worker down'); };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(res.batch).toMatchObject({ delivery: 'failed', error: 'worker down' });
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's2' }; };
    await service.redeliverUndelivered();
    expect(delivered).toHaveLength(1);
    await service.redeliverUndelivered();
    expect(delivered).toHaveLength(1);
    // 同一 nonce 再点一次：返回原批次，不再投递
    const dup = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(dup.duplicate).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('同一批次的并发投递只投一次', async () => {
    let release: (() => void) | undefined;
    deliverImpl = input => new Promise(resolve => { release = () => { delivered.push(input); resolve({ sessionId: 's' }); }; });
    steward = { enabled: true };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    steward = { enabled: true, chatId: 'oc_steward' };
    const p1 = service.deliverBatch(res.batch.id);
    const p2 = service.deliverBatch(res.batch.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    const [b1, b2] = await Promise.all([p1, p2]);
    expect(b1.delivery).toBe('delivered');
    expect(b2).toEqual(b1);
    expect(delivered).toHaveLength(1);
  });
});
