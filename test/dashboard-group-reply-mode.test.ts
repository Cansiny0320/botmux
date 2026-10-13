import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupReplyModeRow } from '../src/dashboard/web/group-reply-mode.js';
import { setReplyModeForGroup, type GroupsActionDeps } from '../src/dashboard/groups-action-helpers.js';
import { dashboardEventInvalidatesGroupsMatrix } from '../src/dashboard/groups-matrix-snapshot.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

const inherited = { override: null, default: 'chat', effective: 'chat', inherited: true } as const;

it('offers inherit + four modes, shows the source, and saves/rolls back via PUT', async () => {
  let failure = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { mode } = JSON.parse(init.body as string);
    return new Response(JSON.stringify(failure
      ? { ok: false, error: 'chat_mode_unconfirmed' }
      : { ok: true, override: mode === 'inherit' ? null : mode }), { status: failure ? 503 : 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = { chatId: 'oc_a', appId: 'app-a', botName: '助手', state: inherited, onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupReplyModeRow, props)); });
  const select = () => renderer.root.findByType('select');
  try {
    expect(select().props.value).toBe('inherit');
    expect(select().findAllByType('option').map(o => o.props.value))
      .toEqual(['inherit', 'chat-topic', 'chat', 'shared', 'new-topic']);
    const source = renderer.root.find(n => n.props.className === 'group-reply-mode-source').children.join('');
    expect(source).toMatch(/继承|inherits/);

    await act(async () => select().props.onChange({ currentTarget: { value: 'new-topic' } }));
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_a/reply-mode/app-a', expect.objectContaining({
      method: 'PUT', body: '{"mode":"new-topic"}',
    }));
    expect(select().props.value).toBe('new-topic');
    expect(props.onSaved).toHaveBeenCalledOnce();

    failure = true;
    await act(async () => select().props.onChange({ currentTarget: { value: 'chat' } }));
    expect(select().props.value).toBe('new-topic'); // rolled back
    expect(props.onSaved).toHaveBeenCalledOnce();

    failure = false;
    await act(async () => select().props.onChange({ currentTarget: { value: 'inherit' } }));
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_a/reply-mode/app-a', expect.objectContaining({ body: '{"mode":"inherit"}' }));
    expect(select().props.value).toBe('inherit');
  } finally { await act(async () => renderer.unmount()); }
});

it('topic groups only allow clearing a dormant override', async () => {
  const base = { chatId: 'oc_t', appId: 'app-a', botName: 'b', topicGroup: true, onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupReplyModeRow, { ...base, state: inherited })); });
  try {
    expect(renderer.root.findByType('select').props.disabled).toBe(true);
    await act(async () => renderer.update(React.createElement(GroupReplyModeRow, {
      ...base, state: { override: 'new-topic', default: 'chat', effective: 'new-topic', inherited: false },
    })));
    const select = renderer.root.findByType('select');
    expect(select.props.disabled).toBe(false);
    expect(select.findAllByType('option').map(o => o.props.value)).toEqual(['inherit', 'new-topic']);
  } finally { await act(async () => renderer.unmount()); }
});

it('proxies to the exact bot daemon and invalidates the snapshot only on success', async () => {
  const proxyToDaemon = vi.fn(async () => new Response('{"ok":true}'));
  const invalidateGroups = vi.fn();
  const deps = { proxyToDaemon, invalidateGroups } as unknown as GroupsActionDeps;
  expect(await setReplyModeForGroup('oc_a', 'app-a', '{"mode":"inherit"}', deps)).toEqual({ status: 200, body: { ok: true } });
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a', '/api/group-reply-mode/oc_a', expect.objectContaining({ method: 'PUT', body: '{"mode":"inherit"}' }));
  expect(invalidateGroups).toHaveBeenCalledOnce();
  proxyToDaemon.mockResolvedValue(new Response('{"ok":false}', { status: 409 }));
  await setReplyModeForGroup('oc_a', 'app-a', '{"mode":"chat"}', deps);
  expect(invalidateGroups).toHaveBeenCalledOnce();
});

it('daemon reply-policy events (e.g. from /reply-mode in Lark) invalidate the groups matrix', () => {
  expect(dashboardEventInvalidatesGroupsMatrix({ type: 'groups.reply-policy.changed' })).toBe(true);
  expect(dashboardEventInvalidatesGroupsMatrix({ type: 'session.update' })).toBe(false);
});
