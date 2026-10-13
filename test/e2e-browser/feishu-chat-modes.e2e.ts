/**
 * Claude and Codex in every private-chat (DM) mode and regular-group mode.
 *
 * Every probe is a recall request (`followUpMessage`): the bot answers
 * `ACK-<own tag> RECALL <oldest ACK its session holds>`. That one line shows
 * both that the bot answered (the line exists only in its reply, so the DOM
 * check is exact) and which session answered:
 *   - a fresh session recalls the probe's own ACK;
 *   - a continued session recalls the first probe's ACK.
 *
 * DM modes are per bot, so a DM case holds the bot's DM lease exclusively; a
 * group case holds the test group exclusively (chat-lease.ts). Every case reads
 * the current mode first and restores it afterwards, so it also runs safely
 * against a live daemon.
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  expectedReplyMarker,
  expectedRecallMarker,
  followUpMessage,
  getGroupChatName,
  messageTag,
  navigateToMessenger,
  openChat,
  openGroupChat,
  openThreadForMessage,
  pageTextCount,
  sendMentionMessage,
  sendMentionInOpenTopic,
  testMessage,
  typeChatMessage,
  typeThreadReply,
  waitForPageTextCount,
  waitForReplyLine,
  expectNoReplyLine,
} from './helpers.js';
import { publishLabeledPageVideo } from './e2e-video.js';
import { dmLeaseKey, holdLeaseForPage } from './chat-lease.js';
import {
  CHAT_MODE_BOTS,
  CHAT_MODE_SCENARIOS,
  parseChatModeScenario,
  type ChatModeBot,
  type GroupMentionMode,
  type GroupReplyMode,
} from './chat-mode-scenarios.js';

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  agent: PlaywrightAgent;
}

async function openBrowser(): Promise<BrowserSession> {
  checkPrerequisites();
  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error('storageState.json not found. Run: bun run test:e2e-browser:setup');
  }
  const browser = await createBrowser();
  const { context, page } = await createPage(browser);
  const agent = createAgent(page);
  await navigateToMessenger(page);
  return { browser, context, page, agent };
}

async function releaseBrowser(session: Partial<BrowserSession>): Promise<void> {
  await session.agent?.destroy();
  // Closing the context closes the page, which releases its chat leases.
  await session.context?.close();
  try {
    await publishLabeledPageVideo(session.page);
  } catch (error) {
    console.error('Feishu video publish failed:', error);
  }
  await session.browser?.close();
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** A recall probe; its tag starts `e2e-<label>-`, so labels stay [a-z0-9-]. */
function probe(label: string): string {
  return followUpMessage(label);
}

/** The reply line for `p`, sent in a session whose first probe was `first`. */
function line(p: string, first: string = p): string {
  return expectedRecallMarker(p, first);
}

function slug(bot: ChatModeBot): string {
  return bot.toLowerCase();
}

function otherBot(bot: ChatModeBot): ChatModeBot {
  return CHAT_MODE_BOTS.find((name) => name !== bot)!;
}

/** The reply sits in the chat's main stream, not folded into a topic. */
async function assertInlineReply(
  agent: PlaywrightAgent,
  p: string,
  where: '私聊' | '群聊',
): Promise<void> {
  await agent.aiAssert(
    `${where}主消息流（不是右侧话题面板，也不是"话题"列表）中直接显示着一条机器人发出的普通消息，` +
      `正文包含"${expectedReplyMarker(p)}"；它没有被折叠进某条消息下方的"N 条回复"或话题回复里`,
  );
}

// ---------------------------------------------------------------------------
// Command replies
// ---------------------------------------------------------------------------

async function sendAndAwaitText(
  page: Page,
  send: () => Promise<void>,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const before = await pageTextCount(page, text);
  await send();
  await waitForPageTextCount(page, text, before + 1, timeoutMs);
}

/** Send a status command and return the mode label of the new reply. */
async function readModeLabel(
  page: Page,
  send: () => Promise<void>,
  prefix: string,
  timeoutMs = 60_000,
): Promise<string> {
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([a-z-]+)`, 'g');
  const labels = async () =>
    [...(await page.locator('body').innerText()).matchAll(pattern)].map((match) => match[1]);
  const before = (await labels()).length;
  await send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await labels();
    if (now.length > before) return now.at(-1)!;
    await page.waitForTimeout(2_000);
  }
  throw new Error(`No new "${prefix}" status reply within ${timeoutMs}ms`);
}

/**
 * Close whatever session currently owns this chat so the next probe opens a
 * fresh one. Best effort: with no session the bot pre-creates and closes one,
 * or reports there is none.
 */
async function resetSession(page: Page, send: () => Promise<void>): Promise<void> {
  const closed = await pageTextCount(page, '会话已关闭');
  const none = await pageTextCount(page, '没有活跃的会话');
  await send();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await pageTextCount(page, '会话已关闭')) > closed) return;
    if ((await pageTextCount(page, '没有活跃的会话')) > none) return;
    await page.waitForTimeout(2_000);
  }
  console.warn('[chat-modes] /close produced no visible confirmation; continuing');
}

/** Run `run`, then `restore` even if `run` failed; a restore failure never hides `run`'s error. */
async function withRestore(run: () => Promise<void>, restore: () => Promise<void>): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  try {
    await restore();
  } catch (error) {
    if (failure === undefined) throw error;
    console.error('[chat-modes] Restoring the chat mode failed after a test failure:', error);
  }
  if (failure !== undefined) throw failure;
}

// ---------------------------------------------------------------------------
// Private-chat modes
// ---------------------------------------------------------------------------

async function setDmMode({ agent, page }: BrowserSession, label: string): Promise<void> {
  // `topic` is reported as `new-topic`; `/reply-mode new-topic` is accepted too.
  const shown = label === 'topic' ? 'new-topic' : label;
  await sendAndAwaitText(
    page,
    () => typeChatMessage(agent, page, `/reply-mode ${label}`),
    `已切换私聊会话模式为：${shown}`,
  );
}

async function withDmMode(
  session: BrowserSession,
  bot: ChatModeBot,
  mode: 'chat' | 'topic' | 'group',
  run: () => Promise<void>,
): Promise<void> {
  const { agent, page } = session;
  // Before openChat: no other lane may use this bot's DM while its mode differs.
  await holdLeaseForPage(page, dmLeaseKey(bot), 'exclusive');
  await openChat(page, agent, bot);
  const original = await readModeLabel(
    page,
    () => typeChatMessage(agent, page, '/reply-mode'),
    '当前私聊会话模式：',
  );
  await setDmMode(session, mode);
  await withRestore(run, async () => {
    await navigateToMessenger(page);
    await openChat(page, agent, bot);
    await setDmMode(session, original);
  });
}

/** chat: replies inline in the DM, and every DM message shares one session. */
async function dmChatMode(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  const { agent, page } = session;
  await withDmMode(session, bot, 'chat', async () => {
    await resetSession(page, () => typeChatMessage(agent, page, '/close'));
    const p1 = probe(`dmchat-${slug(bot)}-1`);
    await typeChatMessage(agent, page, p1);
    await waitForReplyLine(page, line(p1));
    await assertInlineReply(agent, p1, '私聊');

    const p2 = probe(`dmchat-${slug(bot)}-2`);
    await typeChatMessage(agent, page, p2);
    await waitForReplyLine(page, line(p2, p1));

    await resetSession(page, () => typeChatMessage(agent, page, '/close'));
  });
}

/** thread: each top-level DM opens its own topic with its own session. */
async function dmThreadMode(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  const { agent, page } = session;
  await withDmMode(session, bot, 'topic', async () => {
    const p1 = probe(`dmthread-${slug(bot)}-1`);
    const p2 = probe(`dmthread-${slug(bot)}-2`);
    await typeChatMessage(agent, page, p1);
    await typeChatMessage(agent, page, p2);
    // Both recall their own ACK: two topics, two independent sessions.
    for (const p of [p1, p2]) {
      await openThreadForMessage(agent, { msgHint: p, page, timeoutMs: 180_000 });
      await waitForReplyLine(page, line(p));
      await typeThreadReply(agent, page, '/close');
    }
  });
}

/** group: a DM births a dedicated 1-user + 1-bot group that hosts the session. */
async function dmGroupMode(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  const { agent, page } = session;
  await withDmMode(session, bot, 'group', async () => {
    // The group is named after the first 20 characters of the DM (run-e2e
    // turns AI renaming off); `e2e-sg-` + a 13-digit timestamp is exactly 20.
    const p1 = probe('sg');
    const groupName = messageTag(p1);
    await typeChatMessage(agent, page, p1);
    await openGroupChat(page, agent, groupName, { lease: false, timeoutMs: 90_000 });
    await withRestore(
      async () => {
        await waitForReplyLine(page, line(p1));
        await agent.aiAssert(
          `当前打开的是群聊"${groupName}"；群里有一条说明"从私聊发起了本次会话"的消息，` +
            `并且机器人以普通消息回复了包含"${expectedReplyMarker(p1)}"的内容`,
        );
        // Solo group with a live session: no @ needed, same session continues.
        const p2 = probe(`sg2-${slug(bot)}`);
        await typeChatMessage(agent, page, p2);
        await waitForReplyLine(page, line(p2, p1));
      },
      () => dismissSessionGroup(session),
    );
  });
}

/** `/dismiss` asks for a one-time confirmation token; send it back. */
async function dismissSessionGroup({ agent, page }: BrowserSession): Promise<void> {
  const pattern = /\/dismiss --confirm=([0-9a-f]{64})/g;
  const tokens = async () =>
    [...(await page.locator('body').innerText()).matchAll(pattern)].map((match) => match[1]);
  try {
    const before = (await tokens()).length;
    await typeChatMessage(agent, page, '/dismiss');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const now = await tokens();
      if (now.length > before) {
        await typeChatMessage(agent, page, `/dismiss --confirm=${now.at(-1)}`);
        await page.waitForTimeout(5_000);
        return;
      }
      await page.waitForTimeout(2_000);
    }
    console.warn('[chat-modes] /dismiss confirmation did not appear; the session group is left behind');
  } catch (error) {
    console.warn('[chat-modes] Dismissing the session group failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Regular-group modes
// ---------------------------------------------------------------------------

const GROUP_SETTINGS = {
  reply: { command: '/reply-mode', status: '当前群回复模式：', updated: '已切换当前群回复模式为：' },
  mention: { command: '/mention-mode', status: '当前群 @ 策略：', updated: '已切换当前群 @ 策略为：' },
} as const;

async function reopenGroup({ agent, page }: BrowserSession): Promise<void> {
  // Reload resets the 「话题」 filter that openThreadForMessage leaves selected.
  await navigateToMessenger(page);
  await openGroupChat(page, agent, getGroupChatName());
}

/** Set a per-group mode for `bot`, run, then put the previous mode back. */
async function withGroupSetting(
  session: BrowserSession,
  bot: ChatModeBot,
  kind: keyof typeof GROUP_SETTINGS,
  mode: string,
  run: () => Promise<void>,
): Promise<void> {
  const { agent, page } = session;
  const setting = GROUP_SETTINGS[kind];
  const set = (label: string) =>
    sendAndAwaitText(
      page,
      () => sendMentionMessage(page, agent, bot, `${setting.command} ${label}`),
      `${setting.updated}${label}`,
    );
  const original = await readModeLabel(
    page,
    () => sendMentionMessage(page, agent, bot, setting.command),
    setting.status,
  );
  await set(mode);
  await withRestore(run, async () => {
    await reopenGroup(session);
    await set(original);
  });
}

function resetGroupSession(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  return resetSession(session.page, () => sendMentionMessage(session.page, session.agent, bot, '/close'));
}

/**
 * Hover a top-level group message and open its native topic (reply thread).
 * The reply input then belongs to that topic.
 */
async function openNativeTopic({ agent }: BrowserSession, p: string): Promise<void> {
  await agent.aiAct(
    `在群聊主消息流中找到我发出的、正文以"${messageTag(p)}"开头的那条消息，把鼠标悬停在它上面，` +
      '点击悬浮操作栏里的"回复话题"按钮（也可能叫"话题回复"或"创建话题"；不要点"引用"、"转发"或表情）',
  );
  await agent.aiWaitFor(
    '页面上打开了这条消息的话题回复区域（右侧话题面板或主内容区的话题详情），底部有回复输入框',
    { timeoutMs: 20_000, checkIntervalMs: 2_000 },
  );
}

async function groupReplyMode(
  session: BrowserSession,
  bot: ChatModeBot,
  mode: GroupReplyMode,
): Promise<void> {
  const { agent, page } = session;
  await openGroupChat(page, agent, getGroupChatName());
  await withGroupSetting(session, bot, 'reply', mode, async () => {
    await resetGroupSession(session, bot);
    const label = `gr-${mode}-${slug(bot)}`;
    const p1 = probe(`${label}-1`);
    const p2 = probe(`${label}-2`);

    if (mode === 'chat' || mode === 'chat-topic') {
      // Top level: inline replies, one continuous group session.
      await sendMentionMessage(page, agent, bot, p1);
      await waitForReplyLine(page, line(p1));
      await assertInlineReply(agent, p1, '群聊');
      await sendMentionMessage(page, agent, bot, p2);
      await waitForReplyLine(page, line(p2, p1));
      // A native topic on p2: `chat` folds it into the group session,
      // `chat-topic` gives the topic a session of its own.
      const p3 = probe(`${label}-3`);
      await openNativeTopic(session, p2);
      await sendMentionInOpenTopic(page, agent, bot, p3);
      await waitForReplyLine(page, line(p3, mode === 'chat' ? p1 : p3));
      return;
    }

    // topic / new-topic: each @ gets a reply topic under it. `topic` shares
    // one session across those topics; `new-topic` starts a session per topic.
    await sendMentionMessage(page, agent, bot, p1);
    await sendMentionMessage(page, agent, bot, p2);
    await openThreadForMessage(agent, { msgHint: p1, page, timeoutMs: 180_000 });
    await waitForReplyLine(page, line(p1));
    await openThreadForMessage(agent, { msgHint: p2, page, timeoutMs: 180_000 });
    await waitForReplyLine(page, line(p2, mode === 'topic' ? p1 : p2));
  });
  await resetGroupSession(session, bot);
}

async function groupMentionMode(
  session: BrowserSession,
  bot: ChatModeBot,
  mode: GroupMentionMode,
): Promise<void> {
  const { agent, page } = session;
  await openGroupChat(page, agent, getGroupChatName());
  await withGroupSetting(session, bot, 'mention', mode, async () => {
    await resetGroupSession(session, bot);
    const label = `gm-${mode}-${slug(bot)}`;
    const p1 = probe(`${label}-1`);

    switch (mode) {
      case 'always': {
        // Without an @ the bot stays quiet; with one it answers.
        await typeChatMessage(agent, page, p1);
        await expectNoReplyLine(page, line(p1));
        const p2 = probe(`${label}-2`);
        await sendMentionMessage(page, agent, bot, p2);
        await waitForReplyLine(page, line(p2));
        return;
      }
      case 'never': {
        await typeChatMessage(agent, page, p1);
        await waitForReplyLine(page, line(p1));
        return;
      }
      case 'ambient': {
        // Answers without an @, but yields when the message @s someone else.
        await typeChatMessage(agent, page, p1);
        await waitForReplyLine(page, line(p1));
        const other = otherBot(bot);
        const redirect = testMessage(`${label}-2`, { plain: true });
        await sendMentionMessage(page, agent, other, redirect);
        await page.waitForTimeout(45_000);
        await agent.aiAssert(
          `群聊里在包含"${redirect}"的那条（@了 ${other} 的）消息之后，没有 ${bot} 发出的任何回复消息或卡片；` +
            `${other} 的回复可以有`,
        );
        return;
      }
      case 'topic': {
        // Inside the bot's own topic a reply continues the session without an @.
        await withGroupSetting(session, bot, 'reply', 'new-topic', async () => {
          await sendMentionMessage(page, agent, bot, p1);
          await openThreadForMessage(agent, { msgHint: p1, page, timeoutMs: 180_000 });
          await waitForReplyLine(page, line(p1));
          const p2 = probe(`${label}-2`);
          await typeThreadReply(agent, page, p2);
          await waitForReplyLine(page, line(p2, p1));
        });
        return;
      }
    }
  });
  await resetGroupSession(session, bot);
}

// ---------------------------------------------------------------------------
// Registration: one suite and one case per scenario, both named after it.
// ---------------------------------------------------------------------------

export function registerMidsceneSuites(): void {
  for (const scenario of CHAT_MODE_SCENARIOS) {
    describe(scenario, () => {
      let session: Partial<BrowserSession> = {};

      beforeAll(async () => {
        session = await openBrowser();
      }, 120_000);

      afterAll(async () => {
        await releaseBrowser(session);
      });

      it(scenario, async () => {
        const live = session as BrowserSession;
        const parsed = parseChatModeScenario(scenario);
        if (parsed.kind === 'dm') {
          if (parsed.mode === 'chat') await dmChatMode(live, parsed.bot);
          else if (parsed.mode === 'thread') await dmThreadMode(live, parsed.bot);
          else await dmGroupMode(live, parsed.bot);
        } else if (parsed.kind === 'group-reply') {
          await groupReplyMode(live, parsed.bot, parsed.mode);
        } else {
          await groupMentionMode(live, parsed.bot, parsed.mode);
        }
      }, 25 * 60_000);
    });
  }
}
