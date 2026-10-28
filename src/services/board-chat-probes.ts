/**
 * 决策看板核实群时用哪些 bot、按什么顺序：管家 bot 自己在最前，其后是 bots.json 里本机其他
 * 同品牌（飞书 / Lark 的群互相查不到）、有飞书凭据的 bot，按 bots.json 顺序。
 *
 * 其他 bot 的客户端按需建在本进程内存里（{@link createDetachedLarkClient}），按 appId 缓存，
 * 凭据变了（指纹不同）就重建；缓存里只存 secret 的 sha256 指纹做比较，不另存 secret。
 */
import { createHash } from 'node:crypto';
import type * as Lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../bot-registry.js';
import type { ChatProbe } from '../core/decision-board/chat-lookup.js';
import { larkGet } from '../im/lark/lark-get.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';

type ProbeConfig = Pick<BotConfig, 'larkAppId' | 'larkAppSecret' | 'brand' | 'apiOnly'>;

/** 管家之后要试的其他 bot：同品牌、非 apiOnly、有 secret、不是管家自己，按 appId 去重、保持 bots.json 顺序。 */
export function siblingChatProbeConfigs<T extends ProbeConfig>(self: { larkAppId: string; brand?: BotConfig['brand'] }, configs: readonly T[]): T[] {
  const brand = normalizeBrand(self.brand);
  const seen = new Set([self.larkAppId]);
  const out: T[] = [];
  for (const cfg of configs) {
    if (!cfg.larkAppId || seen.has(cfg.larkAppId)) continue;
    if (cfg.apiOnly === true || !cfg.larkAppSecret) continue;
    if (normalizeBrand(cfg.brand) !== brand) continue;
    seen.add(cfg.larkAppId);
    out.push(cfg);
  }
  return out;
}

function chatProbe(appId: string, client: () => Lark.Client): ChatProbe {
  return {
    appId,
    fetchChat: (chatId, signal) => larkGet(client(), `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {}, { signal }),
  };
}

export interface BoardChatProbeDeps {
  self: { larkAppId: string; brand?: BotConfig['brand'] };
  /** 管家 bot 自己的客户端（daemon 注册的那个）。 */
  ownClient(): Lark.Client;
  /** bots.json 里的全部 bot；读不到时抛，只用管家自己查。 */
  configs(): readonly ProbeConfig[];
  createClient(cfg: ProbeConfig): Lark.Client;
}

export function createBoardChatProbes(deps: BoardChatProbeDeps): () => ChatProbe[] {
  const cache = new Map<string, { fingerprint: string; client: Lark.Client }>();
  const clientFor = (cfg: ProbeConfig): Lark.Client => {
    const fingerprint = createHash('sha256').update(`${normalizeBrand(cfg.brand)}\0${cfg.larkAppSecret}`).digest('hex');
    const cached = cache.get(cfg.larkAppId);
    if (cached?.fingerprint === fingerprint) return cached.client;
    const client = deps.createClient(cfg);
    cache.set(cfg.larkAppId, { fingerprint, client });
    return client;
  };
  return () => {
    let siblings: ProbeConfig[] = [];
    try {
      siblings = siblingChatProbeConfigs(deps.self, deps.configs());
    } catch {
      // bots.json 读不到：只用管家自己查，查不到照常报错。
    }
    const live = new Set(siblings.map(cfg => cfg.larkAppId));
    for (const appId of cache.keys()) if (!live.has(appId)) cache.delete(appId);
    return [
      chatProbe(deps.self.larkAppId, deps.ownClient),
      ...siblings.map(cfg => chatProbe(cfg.larkAppId, () => clientFor(cfg))),
    ];
  };
}
