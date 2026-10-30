import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fetchReleaseVersion, fetchLatestVersion, fetchRollbackVersions, fetchConfiguredPackageArtifact } from '../src/core/update-check.js';
import { replaceStandaloneBinary, releaseAssetName } from '../src/core/binary-self-update.js';

const release = (version = '3.55.1', extra = {}) => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  published_at: '2026-10-30T12:00:00Z',
  assets: [{ name: 'botmux-linux-x64' }, { name: 'botmux-linux-x64.sha256' }], ...extra,
});
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('Fork release-only channel', () => {
  it('resolves both manual and scheduled latest from the Fork, ignoring npm overrides', async () => {
    const fetchImpl = reply(release());
    expect(await fetchReleaseVersion('latest', { fetchImpl, registry: 'https://example.com/' }))
      .toEqual({ version: '3.55.1', source: 'github-fork' });
    expect(await fetchLatestVersion({ fetchImpl })).toBe('3.55.1');
    for (const [url] of vi.mocked(fetchImpl).mock.calls) {
      expect(url).toBe('https://api.github.com/repos/Cansiny0320/botmux/releases/latest');
    }
  });
  it.each([
    release('3.55.1', { draft: true }), release('3.55.1', { prerelease: true }),
    release('3.55.1', { assets: [{ name: 'botmux-linux-x64' }] }), {},
  ])('rejects unpublished or incomplete releases without falling back to npm', async body => {
    const fetchImpl = reply(body);
    expect((await fetchReleaseVersion('latest', { fetchImpl })).version).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('fails closed on outages, unsupported channels and mismatched exact versions', async () => {
    const fetchImpl = reply(release(), 503);
    expect((await fetchReleaseVersion('latest', { fetchImpl })).version).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const exact = reply(release('3.55.2'));
    expect((await fetchReleaseVersion('3.55.1', { fetchImpl: exact })).version).toBeNull();
    const channel = reply(release());
    expect((await fetchReleaseVersion('canary', { fetchImpl: channel })).version).toBeNull();
    expect(channel).not.toHaveBeenCalled();
  });
  it('offers only complete stable Fork releases for rollback and never resolves npm artifacts', async () => {
    const fetchImpl = reply([release('3.55.2'), release(), release('3.55.0', { draft: true })]);
    expect(await fetchRollbackVersions('3.55.2', { fetchImpl })).toEqual({ ok: true,
      versions: [{ version: '3.55.1', publishedAt: '2026-10-30T12:00:00Z' }] });
    const registry = reply({});
    expect(await fetchConfiguredPackageArtifact('botmux-linux-x64', '3.55.1', { fetchImpl: registry })).toBeNull();
    expect(registry).not.toHaveBeenCalled();
  });
  it('requires checksum, keeps old binary on failure, and installs only the Fork asset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-update-'));
    try {
      const target = join(dir, 'botmux'); writeFileSync(target, 'old');
      const bytes = Buffer.alloc(1_100_000, 1);
      const fetchStream = vi.fn(async () => Readable.from([bytes]));
      const registry = vi.fn(async () => { throw new Error('must not use registry'); });
      const deps = { fetchStream, resolveRegistryArtifact: registry, fetchChecksum: async () => null };
      await expect(replaceStandaloneBinary('3.55.1', target, deps)).rejects.toThrow(/SHA-256/);
      expect(readFileSync(target, 'utf8')).toBe('old');
      const result = await replaceStandaloneBinary('3.55.1', target, { ...deps,
        fetchChecksum: async () => createHash('sha256').update(bytes).digest('hex'),
        probeBinary: () => ({ status: 0, stdout: '3.55.1', stderr: '' }),
      });
      expect(result.source).toBe('github-release');
      expect(readFileSync(target)).toEqual(bytes);
      expect(registry).not.toHaveBeenCalled();
      expect(fetchStream).toHaveBeenCalledWith(`https://github.com/Cansiny0320/botmux/releases/download/v3.55.1/${releaseAssetName()}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
