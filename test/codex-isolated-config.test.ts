/**
 * 独立 CODEX_HOME 的 config.toml（#93，维护者选 A：保持「只复制一次」，Dashboard 亮出
 * 路径并提供「从宿主重新同步」）。
 *
 *   - 路径与 worker 的 BOT_HOME 推导同一口径：<dirname(SESSION_DATA_DIR)>/bots/<appId>/codex/config.toml
 *   - 是否独立：codex + (oncall / legacy readIsolation / codexAuthSync=isolated)，scratch 与 wrapper 除外
 *   - resync：先把现有文件备份成 config.toml.bak-<时间>（0600），再用宿主文件覆盖（0600）；
 *     宿主缺失、目标被换成 symlink 都显式报错，不动现有文件
 *   - daemon IPC：GET 信息 / POST resync，未绑定 503、非独立 409、宿主缺失 404
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  botUsesIsolatedCodexHome,
  codexConfigBackupName,
  isolatedCodexConfigPath,
  resyncIsolatedCodexConfig,
} from '../src/services/codex-isolated-config.js';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { config } from '../src/config.js';

const roots: string[] = [];
function tmp(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-codex-cfg-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFile600(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe('isolatedCodexConfigPath', () => {
  it('sits under the bot home next to SESSION_DATA_DIR, matching the worker CODEX_HOME', () => {
    expect(isolatedCodexConfigPath('/srv/botmux/data', 'cli_a')).toBe('/srv/botmux/bots/cli_a/codex/config.toml');
    expect(isolatedCodexConfigPath('/srv/botmux/data/', 'cli_a')).toBe('/srv/botmux/bots/cli_a/codex/config.toml');
  });

  it('refuses an app id that would escape the bots directory', () => {
    expect(() => isolatedCodexConfigPath('/srv/botmux/data', '../x')).toThrow(/unsafe app id/);
  });
});

describe('botUsesIsolatedCodexHome', () => {
  it.each([
    [{ cliId: 'codex', sandbox: 'oncall' }, true],
    [{ cliId: 'codex', sandbox: true }, true],
    [{ cliId: 'codex', readIsolation: true }, true],
    [{ cliId: 'codex', codexAuthSync: 'isolated' }, true],
    [{ cliId: 'codex', sandbox: 'off', codexAuthSync: 'shared' }, false],
    [{ cliId: 'codex' }, false],
    // scratch reads the native ~/.codex; the BOT_HOME redirect never applies.
    [{ cliId: 'codex', sandbox: 'scratch' }, false],
    [{ cliId: 'codex', sandbox: 'scratch', codexAuthSync: 'isolated' }, false],
    // wrapperCli strips spawn args, so the worker cannot redirect.
    [{ cliId: 'codex', sandbox: 'oncall', wrapperCli: 'aiden x codex' }, false],
    [{ cliId: 'claude-code', sandbox: 'oncall' }, false],
    [{ cliId: 'codex', sandbox: 'bogus' }, false],
  ] as const)('%j → %s', (cfg, expected) => {
    expect(botUsesIsolatedCodexHome(cfg)).toBe(expected);
  });

  // Remote backends / instance pool: worker does NOT put a local Codex on the
  // BOT_HOME config.toml, so the Dashboard must not show the path or report a
  // false "synced". Mirrors worker resolveLocalSandboxMode + legacyHomePolicy.
  const remoteCases: Array<[Parameters<typeof botUsesIsolatedCodexHome>[0], boolean, string]> = [
    [{ cliId: 'codex', backendType: 'riff', sandbox: 'oncall' }, false, 'riff: no local CLI, sandbox collapses to off'],
    [{ cliId: 'codex', backendType: 'remote-runner', sandbox: 'oncall' }, false, 'remote-runner exempt'],
    [{ cliId: 'codex', backendType: 'riff', codexAuthSync: 'isolated' }, false, 'riff + isolated still has no local reader'],
    [{ cliId: 'codex', backendType: 'mojo', sandbox: 'oncall', mojo: { cloud: true, localDaemon: false } }, false, 'provably-remote mojo exempt'],
    [{ cliId: 'codex', backendType: 'mojo', sandbox: 'oncall', mojo: { cloud: true, localDaemon: true } }, true, 'mojo with a local daemon executes locally'],
    [{ cliId: 'codex', backendType: 'mojo', sandbox: 'oncall', mojo: { cloud: false } }, true, 'mojo cloud off executes locally'],
    [{ cliId: 'codex', backendType: 'mojo', sandbox: 'oncall', mojo: { cloud: true, localDaemon: false }, env: { LD_PRELOAD: '/x.so' } }, true, 'loader-hook env makes mojo remote unprovable → local'],
    [{ cliId: 'codex', backendType: 'tmux', codexAuthSync: 'isolated', codexInstancePool: { enabled: true } }, false, 'pool owns the CODEX_HOME of new sessions'],
    [{ cliId: 'codex', backendType: 'tmux', codexAuthSync: 'isolated', codexInstancePool: { enabled: false } }, true, 'pool disabled → ordinary BOT_HOME redirect'],
    [{ cliId: 'codex', backendType: 'tmux', sandbox: 'oncall' }, true, 'local tmux oncall still isolated'],
  ];
  it.each(remoteCases)('remote/pool %j → %s (%s)', (cfg, expected) => {
    expect(botUsesIsolatedCodexHome(cfg)).toBe(expected);
  });
});

describe('resyncIsolatedCodexConfig', () => {
  it('backs the current per-bot file up (0600) and replaces it with the host copy (0600)', () => {
    const root = tmp();
    const host = join(root, 'host-config.toml');
    writeFileSync(host, 'model = "host-v2"\n', { mode: 0o644 });
    const botHome = join(root, 'bots', 'cli_a');
    mkdirSync(join(botHome, 'codex'), { recursive: true, mode: 0o700 });
    const target = join(botHome, 'codex', 'config.toml');
    writeFileSync(target, 'model = "bot-custom"\n', { mode: 0o644 });

    const now = new Date('2026-10-30T01:02:03.456Z');
    const result = resyncIsolatedCodexConfig({ botHome, hostConfigPath: host, now });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(target, 'utf8')).toBe('model = "host-v2"\n');
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(result.backupPath).toBe(join(result.path, '..', codexConfigBackupName(now)));
    expect(result.backupPath!.endsWith('config.toml.bak-2026-10-30T01-02-03-456Z')).toBe(true);
    expect(readFileSync(result.backupPath!, 'utf8')).toBe('model = "bot-custom"\n');
    expect(lstatSync(result.backupPath!).mode & 0o777).toBe(0o600);
    // The host file is read, never modified.
    expect(readFileSync(host, 'utf8')).toBe('model = "host-v2"\n');
  });

  it('creates the per-bot codex dir and skips the backup when nothing was seeded yet', () => {
    const root = tmp();
    const host = join(root, 'host-config.toml');
    writeFile600(host, 'x = 1\n');
    const botHome = join(root, 'bots', 'fresh');

    const result = resyncIsolatedCodexConfig({ botHome, hostConfigPath: host });

    expect(result).toMatchObject({ ok: true, backupPath: null });
    expect(readFileSync(join(botHome, 'codex', 'config.toml'), 'utf8')).toBe('x = 1\n');
    expect(readdirSync(join(botHome, 'codex')).filter(name => name.includes('.bak-'))).toEqual([]);
  });

  it('reports a missing host file without touching the per-bot copy', () => {
    const root = tmp();
    const botHome = join(root, 'bots', 'cli_a');
    mkdirSync(join(botHome, 'codex'), { recursive: true, mode: 0o700 });
    const target = join(botHome, 'codex', 'config.toml');
    writeFile600(target, 'keep = true\n');

    const result = resyncIsolatedCodexConfig({ botHome, hostConfigPath: join(root, 'missing.toml') });

    expect(result).toEqual({ ok: false, error: 'host_config_missing' });
    expect(readFileSync(target, 'utf8')).toBe('keep = true\n');
    expect(readdirSync(join(botHome, 'codex'))).toEqual(['config.toml']);
  });

  it('refuses a per-bot config.toml that was swapped for a symlink, leaving its target alone', () => {
    const root = tmp();
    const host = join(root, 'host-config.toml');
    writeFile600(host, 'host = 1\n');
    const victim = join(root, 'victim.txt');
    writeFile600(victim, 'do not overwrite\n');
    const botHome = join(root, 'bots', 'cli_a');
    mkdirSync(join(botHome, 'codex'), { recursive: true, mode: 0o700 });
    symlinkSync(victim, join(botHome, 'codex', 'config.toml'));

    const result = resyncIsolatedCodexConfig({ botHome, hostConfigPath: host });

    expect(result).toEqual({ ok: false, error: 'target_not_regular_file' });
    expect(readFileSync(victim, 'utf8')).toBe('do not overwrite\n');
  });

  it('refuses a planted codex-dir symlink instead of writing through it', () => {
    const root = tmp();
    const host = join(root, 'host-config.toml');
    writeFile600(host, 'host = 1\n');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const botHome = join(root, 'bots', 'cli_a');
    mkdirSync(botHome, { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(botHome, 'codex'));

    expect(() => resyncIsolatedCodexConfig({ botHome, hostConfigPath: host })).toThrow(/not a regular directory/);
    expect(existsSync(join(elsewhere, 'config.toml'))).toBe(false);
  });
});

describe('daemon IPC /api/bot-codex-config', () => {
  const APP_ID = 'cli_codex_cfg_test';
  let dir: string;
  let handle: IpcServerHandle | null = null;
  let previousBotsConfig: string | undefined;
  let previousHome: string | undefined;
  let previousDataDir: string;

  function boot(bot: Record<string, unknown>): Promise<void> {
    writeFileSync(join(dir, 'bots.json'), JSON.stringify([{ larkAppId: APP_ID, larkAppSecret: 'secret', ...bot }], null, 2));
    __testOnly_resetBotRegistry();
    loadBotConfigs().forEach((c: any) => registerBot(c));
    setLarkAppId(APP_ID);
    return startIpcServer({ port: 0, host: '127.0.0.1' }).then(h => { handle = h; });
  }
  const call = (method: string, path: string) => fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

  beforeEach(() => {
    dir = tmp();
    previousBotsConfig = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = join(dir, 'bots.json');
    previousHome = process.env.HOME;
    process.env.HOME = join(dir, 'home');
    mkdirSync(join(dir, 'home', '.codex'), { recursive: true });
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    setLarkAppId('');
    config.session.dataDir = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousBotsConfig === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = previousBotsConfig;
  });

  it('reports the isolated path and existence for an oncall Codex bot', async () => {
    await boot({ cliId: 'codex', sandbox: 'oncall' });
    const res = await call('GET', '/api/bot-codex-config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      isolated: true,
      path: join(dir, 'bots', APP_ID, 'codex', 'config.toml'),
      exists: false,
      hostPath: join(dir, 'home', '.codex', 'config.toml'),
      hostExists: false,
    });
  });

  it('POST resync backs up and copies, then GET sees the file', async () => {
    await boot({ cliId: 'codex', codexAuthSync: 'isolated' });
    writeFile600(join(dir, 'home', '.codex', 'config.toml'), 'model = "host"\n');
    const codexDir = join(dir, 'bots', APP_ID, 'codex');
    mkdirSync(codexDir, { recursive: true, mode: 0o700 });
    writeFile600(join(codexDir, 'config.toml'), 'model = "old"\n');

    const res = await call('POST', '/api/bot-codex-config/resync');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; backupPath: string };
    expect(body.ok).toBe(true);
    expect(readFileSync(join(codexDir, 'config.toml'), 'utf8')).toBe('model = "host"\n');
    expect(readFileSync(body.backupPath, 'utf8')).toBe('model = "old"\n');

    const info = await (await call('GET', '/api/bot-codex-config')).json() as { exists: boolean; hostExists: boolean };
    expect(info).toMatchObject({ exists: true, hostExists: true });
  });

  it('POST resync surfaces a missing host config as 404 host_config_missing', async () => {
    await boot({ cliId: 'codex', sandbox: 'oncall' });
    const res = await call('POST', '/api/bot-codex-config/resync');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'host_config_missing' });
  });

  it('POST resync refuses (409) a bot whose new sessions use the shared ~/.codex', async () => {
    await boot({ cliId: 'codex' });
    writeFile600(join(dir, 'home', '.codex', 'config.toml'), 'model = "host"\n');
    const res = await call('POST', '/api/bot-codex-config/resync');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'codex_home_not_isolated' });
    expect(existsSync(join(dir, 'bots', APP_ID, 'codex', 'config.toml'))).toBe(false);
  });

  it.each(['GET /api/bot-codex-config', 'POST /api/bot-codex-config/resync'])('%s answers 503 before the daemon is bound', async (route) => {
    await boot({ cliId: 'codex', sandbox: 'oncall' });
    setLarkAppId('');
    const [method, path] = route.split(' ') as [string, string];
    const res = await call(method, path);
    expect(res.status).toBe(503);
  });
});
