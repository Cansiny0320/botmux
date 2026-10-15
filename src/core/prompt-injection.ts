import { getBot } from '../bot-registry.js';
import type { LarkAttachment } from '../types.js';
import type { DaemonSession } from './types.js';

export type PromptInjection = 'default' | 'none';

export {
  isScratchSandbox,
  supportsZeroPromptInjection,
  type ZeroPromptSandboxValue,
} from './zero-prompt-support.js';
import { supportsZeroPromptInjection } from './zero-prompt-support.js';

export function sessionPromptInjection(ds: Pick<DaemonSession, 'session' | 'initConfig'>): PromptInjection {
  // Historical/adopted sessions predate this setting and retain their original
  // input contract. A live worker snapshot also covers an in-place upgrade.
  return ds.session.promptInjection ?? ds.initConfig?.promptInjection ?? 'default';
}

export function zeroPromptInjectionForBot(larkAppId?: string, cliId?: string, frozen?: PromptInjection): boolean {
  if (frozen !== undefined) return frozen === 'none';
  if (!larkAppId) return false;
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.promptInjection === 'none' && supportsZeroPromptInjection(cliId ?? cfg.cliId, cfg);
  } catch {
    return false;
  }
}

/** Attachment names and paths are input data, not instructions. Deliberately
 * bypass customizable prompt fragments, even for the attachment label. */
export function buildZeroPromptInput(content: string, attachments?: LarkAttachment[]): string {
  if (!attachments?.length) return content;
  return [content, ...attachments.map(a => `[${a.type}] ${a.name}: ${a.path}`)].join('\n\n');
}
