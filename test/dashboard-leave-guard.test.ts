import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: confirmMock }));

const { holdHashNavigation, pendingLeavePrompt, setLeaveGuard } = await import('../src/dashboard/web/leave-guard.js');

const PROMPT = { title: 'Unsaved', message: 'Leave anyway?' };

describe('leave guard', () => {
  let release: (() => void) | undefined;
  const replaceState = vi.fn();
  const location = { hash: '#/message-listeners' };

  beforeEach(() => {
    confirmMock.mockReset();
    replaceState.mockReset();
    vi.stubGlobal('history', { state: null, replaceState });
    vi.stubGlobal('location', location);
  });
  afterEach(() => {
    release?.();
    release = undefined;
    vi.unstubAllGlobals();
  });

  it('lets navigation through when no page holds unsaved edits', () => {
    release = setLeaveGuard(() => null);
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('puts the URL back and stays when the user keeps editing', async () => {
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValueOnce(false);
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '#/message-listeners');
    await Promise.resolve();
    expect(location.hash).toBe('#/message-listeners');
  });

  it('navigates on confirmation and lets that one hashchange pass', async () => {
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValueOnce(true);
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
    await Promise.resolve();
    expect(location.hash).toBe('#/roles');
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(false);
    // Only once: a later navigation is held again while edits remain.
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
  });

  it('drops the guard when its page unregisters', () => {
    const unregister = setLeaveGuard(() => PROMPT);
    expect(pendingLeavePrompt()).toEqual(PROMPT);
    unregister();
    expect(pendingLeavePrompt()).toBeNull();
  });
});
