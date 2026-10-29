/**
 * Per-bot Codex `config.toml` under an isolated CODEX_HOME.
 *
 * The worker seeds `<BOT_HOME>/codex/config.toml` from the host
 * `~/.codex/config.toml` ONCE (the per-bot copy may carry customizations
 * afterwards), so later host edits never reach the bot. The Dashboard shows the
 * path and offers an explicit "re-sync from host" that backs the current copy
 * up first. Both only matter for NEW sessions: a running Codex already read it.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { botConfigSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { secureCodexHome } from './codex-auth-sync.js';

export const CODEX_CONFIG_FILE = 'config.toml';

/** The host Codex config every isolated bot is seeded from. */
export function hostCodexConfigPath(home: string = homedir()): string {
  return join(home, '.codex', CODEX_CONFIG_FILE);
}

/** `<dirname(SESSION_DATA_DIR)>/bots/<appId>` — the worker's BOT_HOME derivation. */
export function botHomeForSessionDataDir(sessionDataDir: string, appId: string): string {
  return botHomePath(dirname(sessionDataDir), appId);
}

/** The per-bot copy the worker seeds and isolated Codex reads (CODEX_HOME=<BOT_HOME>/codex). */
export function isolatedCodexConfigPath(sessionDataDir: string, appId: string): string {
  return join(botHomeForSessionDataDir(sessionDataDir, appId), 'codex', CODEX_CONFIG_FILE);
}

/**
 * Whether a NEW session of this bot runs Codex with the per-bot CODEX_HOME —
 * the bot-config view of the worker's `willRedirectCliData` for codex: the
 * oncall sandbox (or legacy readIsolation) or `codexAuthSync: isolated`, never
 * under scratch (it uses the native ~/.codex), never through a wrapper CLI.
 * The machine-wide BOTMUX_SANDBOX override is not part of bot config and is
 * not modelled here.
 */
export function botUsesIsolatedCodexHome(cfg: {
  cliId?: string;
  sandbox?: unknown;
  readIsolation?: boolean;
  codexAuthSync?: string;
  wrapperCli?: string;
}): boolean {
  if (cfg.cliId !== 'codex' || cfg.wrapperCli) return false;
  let mode;
  try { mode = botConfigSandboxMode(cfg); } catch { return false; }
  if (mode === 'scratch') return false;
  return mode === 'oncall' || cfg.codexAuthSync === 'isolated';
}

export type CodexConfigResyncResult =
  | { ok: true; path: string; backupPath: string | null }
  | { ok: false; error: 'host_config_missing' | 'host_config_not_file' | 'target_not_regular_file' };

/** Read a regular file without following a leaf symlink; null when absent. */
function readRegularFileNoFollow(path: string): Buffer | null | 'not_regular' {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EISDIR') return 'not_regular';
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return 'not_regular';
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `config.toml.bak-<UTC timestamp>`, filesystem-safe (no `:`). */
export function codexConfigBackupName(now: Date): string {
  return `${CODEX_CONFIG_FILE}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Replace the bot's isolated config.toml with the host copy. The existing per-bot
 * file is backed up to `config.toml.bak-<timestamp>` first; both files land 0600.
 * The bot home is bot-writable, so the codex dir is resolved through
 * {@link secureCodexHome} (rejects planted symlinks) and leaves are never followed.
 */
export function resyncIsolatedCodexConfig(opts: {
  botHome: string;
  hostConfigPath?: string;
  now?: Date;
}): CodexConfigResyncResult {
  // The host file is the operator's own (often a dotfiles symlink): following it is fine.
  let host: Buffer;
  try {
    host = readFileSync(opts.hostConfigPath ?? hostCodexConfigPath());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: 'host_config_missing' };
    if (code === 'EISDIR') return { ok: false, error: 'host_config_not_file' };
    throw error;
  }
  const codexHome = secureCodexHome(opts.botHome);
  const target = join(codexHome, CODEX_CONFIG_FILE);
  const current = readRegularFileNoFollow(target);
  if (current === 'not_regular') return { ok: false, error: 'target_not_regular_file' };
  let backupPath: string | null = null;
  if (current !== null) {
    backupPath = join(codexHome, codexConfigBackupName(opts.now ?? new Date()));
    atomicWriteFileSync(backupPath, current, { mode: 0o600, followTargetSymlink: false });
  }
  atomicWriteFileSync(target, host, { mode: 0o600, followTargetSymlink: false });
  return { ok: true, path: target, backupPath };
}
