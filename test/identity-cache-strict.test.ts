import { beforeEach, describe, expect, it, vi } from 'vitest';

const larkGet = vi.fn();
const getBotClient = vi.fn(() => ({ marker: true }));

vi.mock('../src/bot-registry.js', () => ({ getBotClient }));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/tmp/botmux-test' } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/im/lark/client.js', () => ({
  larkGet,
  getMessageDetail: vi.fn(),
}));

describe('resolveVerifiedUserIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a platform owner union_id into target-app identity', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          open_id: 'ou_target_scope',
          union_id: 'on_owner',
          name: 'Owner',
          enterprise_email: 'owner@bytedance.com',
        },
      },
    });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');

    await expect(resolveVerifiedUserIdentityByUnionId('cli_target', 'on_owner')).resolves.toEqual({
      openId: 'ou_target_scope',
      unionId: 'on_owner',
      type: 'user',
      name: 'Owner',
      email: 'owner@bytedance.com',
    });
    expect(larkGet).toHaveBeenCalledWith(
      { marker: true },
      '/open-apis/contact/v3/users/on_owner',
      { user_id_type: 'union_id' },
      { timeoutMs: 3000 },
    );
  });

  it('rejects a union_id response that resolves to another principal', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: { user: { open_id: 'ou_target_scope', union_id: 'on_other' } },
    });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_target', 'on_owner')).resolves.toBeUndefined();
  });

  it('always reads the exact current open_id from the contact API', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          name: 'Current User',
          email: 'personal@example.com',
          enterprise_email: 'current.user@bytedance.com',
        },
      },
    });
    const { resolveVerifiedUserIdentity } = await import('../src/im/lark/identity-cache.js');

    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toEqual({
      openId: 'ou_current',
      type: 'user',
      name: 'Current User',
      email: 'current.user@bytedance.com',
    });
    expect(larkGet).toHaveBeenCalledWith(
      { marker: true },
      '/open-apis/contact/v3/users/ou_current',
      { user_id_type: 'open_id' },
    );
  });

  it('fails closed on a missing or failed contact result', async () => {
    larkGet.mockResolvedValue({ code: 41050 });
    const { resolveVerifiedUserIdentity } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toBeUndefined();

    larkGet.mockRejectedValueOnce(new Error('network'));
    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toBeUndefined();
  });
});

describe('resolveVerifiedUserIdentityByUnionId admission protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validUser = (overrides: Record<string, unknown> = {}) => ({
    code: 0,
    data: {
      user: {
        open_id: 'ou_target_scope',
        union_id: 'on_owner',
        name: 'Owner',
        enterprise_email: 'owner@bytedance.com',
        ...overrides,
      },
    },
  });

  it('trips the per-app scope breaker once and never calls the API again', async () => {
    larkGet.mockResolvedValue({ code: 99991672, msg: 'scope missing' });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_scope_breaker', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_scope_breaker', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a deterministic "cannot mint owner" answer within its TTL', async () => {
    larkGet.mockResolvedValue(validUser({ enterprise_email: '' }));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_cached', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_cached', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('re-resolves a deterministic negative after the negative-cache TTL', async () => {
    vi.useFakeTimers();
    try {
      larkGet
        .mockResolvedValueOnce(validUser({ enterprise_email: '' }))
        .mockResolvedValueOnce(validUser());
      const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
      const first = resolveVerifiedUserIdentityByUnionId('cli_neg_ttl', 'on_owner');
      await vi.runAllTimersAsync();
      await expect(first).resolves.toBeUndefined();
      vi.advanceTimersByTime(60_001);
      const second = resolveVerifiedUserIdentityByUnionId('cli_neg_ttl', 'on_owner');
      await vi.runAllTimersAsync();
      expect(await second).toBeDefined();
      expect(larkGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a successful resolution — credential material is read fresh every turn', async () => {
    larkGet.mockResolvedValue(validUser());
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_fresh_owner', 'on_owner')).resolves.toBeDefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_fresh_owner', 'on_owner')).resolves.toBeDefined();
    expect(larkGet).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent resolutions of the same owner into one API call', async () => {
    let resolveCall: (v: unknown) => void = () => {};
    larkGet.mockReturnValueOnce(new Promise(resolve => { resolveCall = resolve; }));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    const a = resolveVerifiedUserIdentityByUnionId('cli_inflight_owner', 'on_owner');
    const b = resolveVerifiedUserIdentityByUnionId('cli_inflight_owner', 'on_owner');
    resolveCall(validUser());
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBeDefined();
    expect(rb).toBe(ra);
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('keeps non-scope API codes and thrown errors retryable (no negative cache)', async () => {
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    larkGet.mockResolvedValueOnce({ code: 41050 }).mockResolvedValueOnce(validUser());
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_code', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_code', 'on_owner')).resolves.toBeDefined();
    larkGet.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(validUser());
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_throw', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_throw', 'on_owner')).resolves.toBeDefined();
    expect(larkGet).toHaveBeenCalledTimes(4);
  });
});
