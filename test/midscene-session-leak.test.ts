/**
 * A suite whose beforeAll fails half-way must not leave its browser, or the
 * chat lease its page took, behind (run 40170880120; see session-setup.ts).
 * Runs the real suite registration, beforeAll/afterAll and chat leases; only
 * Chromium and Feishu are faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  browsers: [] as Array<{ closed: boolean }>,
  failOpenChat: false,
  failMessenger: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: import('node:fs').PathLike) =>
    String(p).endsWith('storageState.json') || fs.existsSync(p);
  return { ...fs, existsSync, default: { ...fs, existsSync } };
});

vi.mock('./e2e-browser/e2e-video.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./e2e-browser/e2e-video.js')>()),
  publishLabeledPageVideo: async () => {},
}));

vi.mock('./e2e-browser/helpers.js', async (importOriginal) => {
  const helpers = await importOriginal<typeof import('./e2e-browser/helpers.js')>();
  const { holdLeaseForPage, dmLeaseKey } = await import('./e2e-browser/chat-lease.js');
  return {
    ...helpers,
    checkPrerequisites: () => {},
    createBrowser: async () => {
      const browser = { closed: false, close: async () => { browser.closed = true; } };
      fake.browsers.push(browser);
      return browser;
    },
    createPage: async () => {
      const onClose: Array<() => void> = [];
      let closed = false;
      const page = {
        isClosed: () => closed,
        once: (event: string, cb: () => void) => { if (event === 'close') onClose.push(cb); },
      };
      const context = {
        close: async () => {
          if (closed) return;
          closed = true;
          for (const cb of onClose) cb();
        },
      };
      return { context, page };
    },
    createAgent: () => ({ destroy: async () => {} }),
    navigateToMessenger: async () => {
      if (fake.failMessenger) throw new Error('Feishu Messenger chat list not loaded');
    },
    // The real openChat takes the shared DM lease before it checks the title bar.
    openChat: async (page: never, _agent: unknown, bot: string) => {
      await holdLeaseForPage(page, dmLeaseKey(bot), 'shared');
      if (fake.failOpenChat) throw new Error('the title bar shows a topic, not [Botmux]Claude');
    },
  };
});

const { runFeishuScenario } = await import('./e2e-browser/midscene-suite.js');
const { acquireLease } = await import('./e2e-browser/chat-lease.js');

afterEach(() => {
  fake.browsers.length = 0;
  fake.failOpenChat = false;
  fake.failMessenger = false;
});

describe('Feishu E2E half-built sessions', () => {
  it('closes the browser and frees the DM lease when openChat fails in beforeAll', async () => {
    fake.failOpenChat = true;
    await expect(runFeishuScenario('conversation-follow-up')).rejects.toThrow(/title bar/);
    expect(fake.browsers.map(b => b.closed)).toEqual([true]);
    // A leaked shared holder would make this exclusive wait time out.
    const release = await acquireLease('dm:Claude', 'exclusive', 200);
    release();
  });

  it('closes the browser when Messenger never loads for a chat-mode case', async () => {
    fake.failMessenger = true;
    await expect(runFeishuScenario('dm-chat-claude')).rejects.toThrow(/not loaded/);
    expect(fake.browsers.map(b => b.closed)).toEqual([true]);
  });
});
