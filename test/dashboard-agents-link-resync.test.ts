/**
 * Linking can change the server-side sync proof (a relink turns the env record
 * unclaimed), so the link dialogs must plan the sync from the snapshot the link
 * call returns — not from the possibly stale one they were opened with.
 */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

import { AddBotsDialog, LinkDialog } from '../src/dashboard/web/agents-page.js';
import type { AgentProfile } from '../src/dashboard/agent-profiles-model.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); });

const bot = { larkAppId: 'cli_a', online: true, cliId: 'claude-code', envKeys: ['A_VAR'] } as BotDefaultsRow;
const base = { description: '', createdAt: 1, updatedAt: 1 };
// The dialog's snapshot still shows the agent's push to cli_a as current…
const stale: AgentProfile = {
  ...base, id: 'ag_aaaa', name: 'A',
  env: { keys: ['A_VAR'], rev: 'r1', pushed: { cli_a: { rev: 'r1', keys: ['A_VAR'] } } },
};
const other: AgentProfile = { ...base, id: 'ag_bbbb', name: 'B' };
// …but the bot was relinked elsewhere meanwhile, so the link returns no proof.
const fresh: AgentProfile = { ...stale, env: { keys: ['A_VAR'], rev: 'r1', pushed: {} } };
const afterLink = { ok: true, agents: [fresh, other], links: { cli_a: 'ag_aaaa' } };

function stubDaemon() {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith('/env') ? { ...afterLink, envKeys: ['A_VAR'] } : afterLink),
  }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const dialogNode = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, querySelector: () => null };
const createNodeMock = (element: { type: unknown }) => (element.type === 'dialog' ? dialogNode : null);

function primaryButton(view: TestRenderer.ReactTestRenderer) {
  return view.root.find(node => node.type === 'button' && /btn-primary/.test(String(node.props.className)));
}

describe('link dialogs re-plan the sync after linking', () => {
  it('LinkDialog pushes env when the link turned the record into no proof', async () => {
    const fetcher = stubDaemon();
    const onDone = vi.fn(async () => undefined);
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(LinkDialog, {
        target: { appId: 'cli_a', agentId: 'ag_aaaa' },
        snapshot: { agents: [stale, other], links: { cli_a: 'ag_bbbb' } },
        bots: [bot],
        cliState: { status: 'ready', options: [] } as any,
        onClose: () => undefined,
        onDone,
      }), { createNodeMock });
    });
    await act(async () => { primaryButton(view).props.onClick(); });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/agents/ag_aaaa/links/cli_a',
      '/api/agents/ag_aaaa/links/cli_a/env',
    ]);
    expect(onDone).toHaveBeenCalledWith({ agents: [fresh, other], links: { cli_a: 'ag_aaaa' } });
    act(() => view.unmount());
  });

  it('AddBotsDialog pushes env when the link turned the record into no proof', async () => {
    const fetcher = stubDaemon();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(AddBotsDialog, {
        open: true,
        agent: stale,
        snapshot: { agents: [stale, other], links: { cli_a: 'ag_bbbb' } },
        candidates: [bot],
        allBots: [bot],
        onClose: () => undefined,
        onDone: async () => undefined,
      }), { createNodeMock });
    });
    const toggle = view.root.find(node => typeof node.props.onToggle === 'function');
    await act(async () => { toggle.props.onToggle('cli_a', true); });
    await act(async () => { primaryButton(view).props.onClick(); });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/agents/ag_aaaa/links/cli_a',
      '/api/agents/ag_aaaa/links/cli_a/env',
    ]);
    act(() => view.unmount());
  });
});
