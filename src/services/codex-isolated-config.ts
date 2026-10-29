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
import { localSandboxApplies } from '../adapters/backend/sandbox.js';
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
 * Whether a NEW session of this bot runs a LOCAL Codex that reads the per-bot
 * CODEX_HOME (`<BOT_HOME>/codex/config.toml`). That is the file the Dashboard
 * path + "re-sync" act on, so the answer must match a real spawn rather than the
 * static sandbox flag alone. Mirrors the worker's `willRedirectCliData` for codex:
 *
 *   - codex only, never through a wrapper CLI;
 *   - a Codex instance pool takes over NEW ordinary sessions (the binding's
 *     source is 'pool'/'default', so worker `legacyHomePolicy` is false) and each
 *     instance owns its own CODEX_HOME — the BOT_HOME redirect never happens;
 *   - a REMOTE backend (riff / remote-runner / a provably-remote mojo) runs no
 *     local Codex, so `resolveLocalSandboxMode` collapses to 'off' and nothing
 *     local reads this file. This also covers `codexAuthSync: isolated` on a
 *     remote backend: although the worker then provisions a BOT_HOME (its
 *     forcePerBotHome path), the remote process never reads it, so showing the
 *     path + a "synced" success would be a false positive;
 *   - oncall (or legacy readIsolation) / `codexAuthSync: isolated` under a LOCAL
 *     backend; never scratch (it reads the native ~/.codex).
 *
 * The machine-wide BOTMUX_SANDBOX override is not part of bot config and is not
 * modelled here (consistent with the rest of the Dashboard sandbox display).
 */
export function botUsesIsolatedCodexHome(cfg: {
  cliId?: string;
  backendType?: string | null;
  sandbox?: unknown;
  readIsolation?: boolean;
  codexAuthSync?: string;
  wrapperCli?: string;
  /** Normalized bot config: `{ enabled: true, ... }` when a pool is active. */
  codexInstancePool?: unknown;
  /** Static `mojo` block (bots.json); only the remote-proof keys are read. */
  mojo?: unknown;
  env?: Record<string, string>;
}): boolean {
  if (cfg.cliId !== 'codex' || cfg.wrapperCli) return false;
  // Pool-managed new sessions bind a pool/default instance home, not BOT_HOME.
  if (codexInstancePoolEnabled(cfg.codexInstancePool)) return false;
  // Remote backends run no local Codex; the sandbox-driven redirect (and the
  // isolated-auth force path) land in a home no local process reads.
  const backendType = typeof cfg.backendType === 'string' && cfg.backendType ? cfg.backendType : 'pty';
  if (!localSandboxApplies(backendType, mojoRemoteProof(cfg))) return false;
  let mode;
  try { mode = botConfigSandboxMode(cfg); } catch { return false; }
  if (mode === 'scratch') return false;
  return mode === 'oncall' || cfg.codexAuthSync === 'isolated';
}

/** Active pool = a normalized object with `enabled: true`. */
function codexInstancePoolEnabled(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as { enabled?: unknown }).enabled === true;
}

/**
 * The static mojo remote proof, shaped exactly like `isMojoFullyRemote`'s input:
 * the `mojo` block's cloud/localDaemon/jwtEnv merged with the top-level
 * wrapperCli/env (the worker merges the same fields into EffectiveMojoConfig).
 * Undefined for non-mojo backends. Raw static env is passed on purpose: a
 * loader-hook env var can only make the session NON-remote (fail toward "local
 * applies"), which merely keeps the resync section visible rather than wrongly
 * hiding it.
 */
function mojoRemoteProof(cfg: { mojo?: unknown; wrapperCli?: string; env?: Record<string, string> }):
{ cloud?: boolean; localDaemon?: boolean; wrapperCli?: string; jwtEnv?: string; env?: Record<string, string> } | undefined {
  const m = cfg.mojo;
  if (!m || typeof m !== 'object') return undefined;
  const block = m as { cloud?: unknown; localDaemon?: unknown; jwtEnv?: unknown };
  return {
    cloud: block.cloud === true ? true : undefined,
    localDaemon: block.localDaemon === true ? true : undefined,
    wrapperCli: typeof cfg.wrapperCli === 'string' && cfg.wrapperCli ? cfg.wrapperCli : undefined,
    ...(typeof block.jwtEnv === 'string' ? { jwtEnv: block.jwtEnv } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
  };
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
