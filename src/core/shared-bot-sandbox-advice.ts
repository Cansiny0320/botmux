import type { CliId } from '../adapters/cli/types.js';

/**
 * Whether a CLI is known to work under the allowlist file sandbox
 * (`sandbox: "oncall"`), from the oncall-sandbox CLI matrix
 * (scripts/oncall-cli-matrix, table in docs/file-sandbox.md):
 *
 *   verified    — start, first turn, shell tool, workdir read/write, network,
 *                 `botmux send` relay and host-credential isolation all pass
 *                 on tmux AND pty (resume too, where the adapter resumes at all)
 *   unsupported — the CLI refuses to start under the sandbox by design
 *   (absent)    — not verified; the advice does not vouch for it
 *
 * Update together with the table whenever the matrix is re-run.
 */
export const ALLOWLIST_SANDBOX_CLI_SUPPORT: Readonly<Partial<Record<CliId, 'verified' | 'unsupported'>>> = {
  'claude-code': 'verified',
  'codex': 'verified',
  'codex-app': 'unsupported',
  'gemini': 'verified',
  'opencode': 'verified',
  'pi': 'verified',
  'oh-my-pi': 'verified',
  'grok': 'verified',
  'kimi': 'verified',
};

export type SandboxCliSupport = 'verified' | 'unsupported' | 'unverified';

export function allowlistSandboxCliSupport(cliId: string | null | undefined): SandboxCliSupport {
  return (cliId && ALLOWLIST_SANDBOX_CLI_SUPPORT[cliId as CliId]) || 'unverified';
}

/** CLIs verified under the allowlist sandbox, in table order. */
export function allowlistSandboxVerifiedClis(): CliId[] {
  return (Object.keys(ALLOWLIST_SANDBOX_CLI_SUPPORT) as CliId[])
    .filter(id => ALLOWLIST_SANDBOX_CLI_SUPPORT[id] === 'verified');
}

/** Why a bot counts as used by more than its owner. */
export type SharedBotReason = 'oncall' | 'allowedUsers' | 'triggerUserAuth';

export interface SharedBotSandboxAdviceInput {
  /** Resolved sandbox mode of the bot ('off' | 'oncall' | 'scratch'). */
  sandboxMode: string | null | undefined;
  cliId: string | null | undefined;
  /** Current oncall bindings (any group member can talk to the bot there). */
  oncallChatCount: number | null | undefined;
  /** `defaultOncall.enabled`: every new group auto-binds to oncall. */
  defaultOncallEnabled: boolean | null | undefined;
  /** Number of `allowedUsers` entries. */
  allowedUsersCount: number | null | undefined;
  triggerUserAuthEnabled: boolean | null | undefined;
}

export interface SharedBotSandboxAdvice {
  reasons: SharedBotReason[];
  cliSupport: SandboxCliSupport;
}

/**
 * Advice shown on a bot that other people use while its file sandbox is off:
 * those people talk to an agent that runs as this OS user and can read the
 * host's credentials. Display only — no default and no behavior changes.
 *
 * Shared means any of: an oncall binding or default-oncall (any group member
 * can talk), more than one allowedUsers entry, or trigger-user auth (the bot
 * acts for whoever sends the message). Scratch does not count as protected:
 * it keeps the whole disk readable. null = nothing to say.
 */
export function sharedBotSandboxAdvice(input: SharedBotSandboxAdviceInput): SharedBotSandboxAdvice | null {
  if (input.sandboxMode === 'oncall') return null;
  const reasons: SharedBotReason[] = [];
  if ((input.oncallChatCount ?? 0) > 0 || input.defaultOncallEnabled === true) reasons.push('oncall');
  if ((input.allowedUsersCount ?? 0) > 1) reasons.push('allowedUsers');
  if (input.triggerUserAuthEnabled === true) reasons.push('triggerUserAuth');
  if (reasons.length === 0) return null;
  return { reasons, cliSupport: allowlistSandboxCliSupport(input.cliId) };
}
