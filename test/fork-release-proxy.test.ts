import { it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
const transport = vi.hoisted(() => ({ proxy: vi.fn(), get: vi.fn() }));
vi.mock('../src/core/release-download.js', () => ({ resolveHttpProxy: transport.proxy, getReleaseStream: transport.get }));
import { fetchReleaseLatestVersion } from '../src/core/update-check.js';

it('uses the configured Release proxy for metadata and its API-limit fallback', async () => {
  transport.proxy.mockImplementation((opts?: { includeConfig?: boolean }) => opts?.includeConfig === false ? undefined : 'http://proxy.example:8118');
  transport.get.mockImplementation(async (url: string) => {
    if (url.startsWith('https://api.github.com/')) throw new Error('HTTP 403');
    return Readable.from([JSON.stringify({ tag_name: 'v3.55.3', draft: false, prerelease: false,
      published_at: '2026-10-30T12:00:00Z', assets: [{ name: 'botmux-linux-x64' }, { name: 'botmux-linux-x64.sha256' }] })]);
  });
  expect(await fetchReleaseLatestVersion()).toEqual({ version: '3.55.3', source: 'github-fork' });
  expect(transport.get).toHaveBeenCalledTimes(2);
  for (const call of transport.get.mock.calls) expect(call[1]).toBe('http://proxy.example:8118');
});
