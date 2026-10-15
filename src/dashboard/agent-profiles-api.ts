/**
 * Dashboard HTTP API：Agent 配置模板与 Bot 关联。
 *
 * GET    /api/agents                        — { agents, links }
 * POST   /api/agents                        — { agent, linkBots?: string[] } 新建（可同时关联）
 * PUT    /api/agents/:id                    — { agent } 更新定义（不负责下发）
 * DELETE /api/agents/:id                    — 删除定义及其全部关联
 * PUT    /api/agents/:id/links/:appId       — 关联（覆盖该 Bot 原有关联）
 * DELETE /api/agents/:id/links/:appId       — 解除关联
 * PUT    /api/agents/:id/links/:appId/env   — 把 Agent 的环境变量下发到该 Bot
 *
 * 只管 agents.json。把 Agent 的值写进 Bot 由浏览器调用现有 `PUT /api/bots/:appId/<x>`
 * 完成（校验、热更新、写入不变量全部沿用），这里不做第二条 bots.json 写入路径。
 * 环境变量例外：值常含密钥，不回显给浏览器（响应里只有变量名），因此由这里代为调用
 * 同一个 daemon 接口（`/api/bot-env`，merge 模式）——写入路径仍是 daemon 那一条。
 *
 * 鉴权：/api/agents 不在 PUBLIC_READ_PATHS，未认证请求已被 dashboard.ts 的全局闸 401；
 * 写操作在此再要求 canManageHost。
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import {
  AGENTS_MAX,
  agentLinkedBots,
  normalizeAgentInput,
  redactAgentEnv,
  type AgentEnvConfig,
  type AgentProfile,
  type AgentProfilesDoc,
} from './agent-profiles-model.js';
import {
  AgentProfilesFileError,
  defaultAgentProfilesPath,
  mutateAgentProfiles,
  newAgentId,
  readAgentProfiles,
} from './agent-profiles-store.js';
import { lookupCliSelection } from '../setup/cli-selection.js';
import { cliModelSupportsReasoningEffort, isCodexReasoningEffort } from '../services/codex-reasoning-effort.js';
import { validateWorkingDir } from '../core/working-dir.js';
import { cliSupportsConfigDir } from '../core/cli-config-dir.js';
import { supportsZeroPromptInjection } from '../core/prompt-injection.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface AgentProfilesApiDeps {
  canManageHost: boolean;
  /** 当前 bots.json 里的全部 larkAppId；关联目标必须在其中。 */
  knownBotIds: () => ReadonlySet<string>;
  agentsPath?: () => string;
  now?: () => number;
  /** 测试注入；缺省走 core/working-dir 的真实目录校验。 */
  checkWorkingDir?: (dir: string) => string | null;
  /**
   * 调用目标 Bot daemon 的 `PUT /api/bot-env`（与 Bot 配置页同一条写入路径）。
   * 缺省时 env 下发路由返回 503。
   */
  putBotEnv?: (larkAppId: string, body: { env: string; mode: 'merge'; remove?: string[] }) => Promise<{ status: number; body: any }>;
  /** 测试注入；缺省为随机串。 */
  newEnvRev?: () => string;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ApiError(400, 'bad_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'bad_json');
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultNewEnvRev(): string {
  return randomBytes(9).toString('base64url');
}

function sameVars(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/**
 * 浏览器提交的 env 分组（`{ keys, set }`，见 AgentEnvInput）→ 存储形态 `{ vars, rev, pushed }`。
 * 保留的变量从已存的 Agent 取值；变量集合不变时沿用原版本号，否则换新版本号；下发记录
 * 原样保留。变量名合法性由随后的 normalizeAgentInput 统一校验。
 */
function resolveEnvInput(raw: unknown, stored: AgentEnvConfig | undefined, newRev: () => string): unknown {
  if (raw === undefined || raw === null) return raw;
  if (!isRecord(raw) || !Array.isArray(raw.keys) || (raw.set !== undefined && !isRecord(raw.set))) {
    throw new ApiError(400, 'env:invalid_env');
  }
  const vars: Record<string, string> = {};
  for (const key of raw.keys) {
    if (typeof key !== 'string') throw new ApiError(400, 'env:invalid_env');
    const value = stored?.vars?.[key];
    if (value === undefined) throw new ApiError(400, 'env:missing_value', key);
    vars[key] = value;
  }
  for (const [key, value] of Object.entries(raw.set ?? {})) {
    if (typeof value !== 'string') throw new ApiError(400, 'env:invalid_env_value', key);
    vars[key] = value;
  }
  const unchanged = !!stored?.vars && sameVars(stored.vars, vars);
  return { vars, rev: unchanged ? stored!.rev : newRev(), pushed: stored?.pushed ?? {} };
}

/** 把请求体里的 agent 的 env 分组解析成存储形态，其余字段原样交给 validateAgent。 */
function withResolvedEnv(raw: unknown, stored: AgentEnvConfig | undefined, deps: AgentProfilesApiDeps): unknown {
  if (!isRecord(raw) || !('env' in raw)) return raw;
  return { ...raw, env: resolveEnvInput(raw.env, stored, deps.newEnvRev ?? defaultNewEnvRev) };
}

/**
 * 同一 Bot 的 env 下发整体串行（读定义 → 写 daemon → 记版本）。只锁最后一步记账不够：
 * 两次下发交错时，旧版本可能后写进 daemon、覆盖新版本，而新版本的响应随后记成「已同步」。
 * Dashboard 是单进程，进程内的链式 Promise 即可；按 agents.json 路径区分实例。
 */
const envPushChains = new Map<string, Promise<unknown>>();

async function serializeEnvPush<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = envPushChains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  envPushChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (envPushChains.get(key) === tail) envPushChains.delete(key);
  }
}

function defaultCheckWorkingDir(dir: string): string | null {
  const result = validateWorkingDir(dir);
  return result.ok ? null : result.error;
}

/** 结构归一化之后的语义校验：CLI 选择键已知、推理强度与模型匹配、目录真实存在。 */
function validateAgent(raw: unknown, deps: AgentProfilesApiDeps): Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> {
  const normalized = normalizeAgentInput(raw);
  if (!normalized.ok) throw new ApiError(400, normalized.error);
  const agent = normalized.value;
  if (agent.exec) {
    const selection = lookupCliSelection(agent.exec.cliId);
    if (!selection) throw new ApiError(400, 'exec:invalid_cli');
    const effort = agent.exec.reasoningEffort;
    if (effort && (!isCodexReasoningEffort(effort)
      || !cliModelSupportsReasoningEffort(selection.cliId, agent.exec.model || undefined, effort))) {
      throw new ApiError(400, 'exec:reasoning_effort_not_supported_by_model');
    }
    if (agent.exec.configDir) {
      if (!cliSupportsConfigDir(selection.cliId)) throw new ApiError(400, 'exec:config_dir_unsupported');
      const error = (deps.checkWorkingDir ?? defaultCheckWorkingDir)(agent.exec.configDir);
      if (error) throw new ApiError(400, 'exec:invalid_config_dir', error);
    }
  }
  if (agent.workspace && agent.workspace.mode !== 'off') {
    const error = (deps.checkWorkingDir ?? defaultCheckWorkingDir)(agent.workspace.workingDir);
    if (error) throw new ApiError(400, 'workspace:invalid_working_dir', error);
  }
  // 零注入只有部分 CLI / 后端 / 沙箱组合支持。Agent 统一了 CLI 时提前拒绝；没统一 CLI
  // 时由各 Bot 的 daemon 在下发时按 Bot 自己的 CLI 校验（失败计入同步失败）。
  if (agent.promptInjection?.mode === 'none' && agent.exec) {
    const cliId = lookupCliSelection(agent.exec.cliId)!.cliId;
    if (!supportsZeroPromptInjection(cliId, {
      backendType: agent.backend?.backendType || undefined,
      sandbox: agent.sandbox?.mode,
    })) {
      throw new ApiError(400, 'promptInjection:unsupported');
    }
  }
  return agent;
}

function snapshot(doc: AgentProfilesDoc, knownBotIds: ReadonlySet<string>) {
  // 已从 bots.json 删除的 Bot 不再展示其关联；文件里的残留在下次写入相关 Agent 时自然覆盖。
  const links = Object.fromEntries(Object.entries(doc.links).filter(([appId]) => knownBotIds.has(appId)));
  // 环境变量的值不出 Dashboard 服务端。
  return { agents: doc.agents.map(agent => redactAgentEnv(agent)), links };
}

function requireAgent(doc: AgentProfilesDoc, id: string): AgentProfile {
  const agent = doc.agents.find(entry => entry.id === id);
  if (!agent) throw new ApiError(404, 'agent_not_found');
  return agent;
}

function requireKnownBot(deps: AgentProfilesApiDeps, appId: string): void {
  if (!deps.knownBotIds().has(appId)) throw new ApiError(404, 'bot_not_found');
}

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { throw new ApiError(400, 'bad_path'); }
}

/** 处理了请求返回 true。 */
export async function handleAgentProfilesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AgentProfilesApiDeps,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/agents' && !path.startsWith('/api/agents/')) return false;
  const agentsPath = (deps.agentsPath ?? defaultAgentProfilesPath)();
  const now = deps.now ?? Date.now;
  const linkMatch = /^\/api\/agents\/([^/]+)\/links\/([^/]+)$/.exec(path);
  const envMatch = /^\/api\/agents\/([^/]+)\/links\/([^/]+)\/env$/.exec(path);
  const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path);

  try {
    if (req.method === 'GET' && path === '/api/agents') {
      const doc = await readAgentProfiles(agentsPath);
      jsonRes(res, 200, { ok: true, ...snapshot(doc, deps.knownBotIds()) });
      return true;
    }

    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (!isWrite || (path !== '/api/agents' && !agentMatch && !linkMatch && !envMatch)) {
      jsonRes(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    if (!deps.canManageHost) throw new ApiError(403, 'forbidden');

    if (req.method === 'POST' && path === '/api/agents') {
      const body = await readJsonBody(req);
      const input = validateAgent(withResolvedEnv(body.agent, undefined, deps), deps);
      const linkBots = Array.isArray(body.linkBots)
        ? [...new Set(body.linkBots.filter((id): id is string => typeof id === 'string' && !!id))]
        : [];
      for (const appId of linkBots) requireKnownBot(deps, appId);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        if (doc.agents.length >= AGENTS_MAX) throw new ApiError(409, 'too_many_agents');
        const ts = now();
        const agent: AgentProfile = { id: newAgentId(), ...input, createdAt: ts, updatedAt: ts };
        doc.agents.push(agent);
        for (const appId of linkBots) doc.links[appId] = agent.id;
        return { write: true, result: { agent, doc } };
      });
      jsonRes(res, 200, { ok: true, agent: redactAgentEnv(result.agent), ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (agentMatch && req.method === 'PUT') {
      const id = decodeSegment(agentMatch[1]);
      const body = await readJsonBody(req);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        const current = requireAgent(doc, id);
        // 保留的环境变量从当前定义取值：在锁内解析，避免与并发保存交错。
        const input = validateAgent(withResolvedEnv(body.agent, current.env, deps), deps);
        const next: AgentProfile = { id, ...input, createdAt: current.createdAt, updatedAt: now() };
        doc.agents = doc.agents.map(entry => (entry.id === id ? next : entry));
        return { write: true, result: { agent: next, doc } };
      });
      jsonRes(res, 200, { ok: true, agent: redactAgentEnv(result.agent), ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (agentMatch && req.method === 'DELETE') {
      const id = decodeSegment(agentMatch[1]);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        requireAgent(doc, id);
        const unlinked = agentLinkedBots(doc, id);
        doc.agents = doc.agents.filter(entry => entry.id !== id);
        for (const appId of unlinked) delete doc.links[appId];
        return { write: true, result: { unlinked, doc } };
      });
      jsonRes(res, 200, { ok: true, unlinked: result.unlinked, ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (linkMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = decodeSegment(linkMatch[1]);
      const appId = decodeSegment(linkMatch[2]);
      if (req.method === 'PUT') requireKnownBot(deps, appId);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        requireAgent(doc, id);
        const previous = doc.links[appId] ?? null;
        if (req.method === 'PUT') {
          if (previous === id) return { write: false, result: { previous, doc } };
          doc.links[appId] = id;
          return { write: true, result: { previous, doc } };
        }
        // 只解除「确实关联到这个 Agent」的边：并发下已改关联到别的 Agent 时不误删。
        if (previous !== id) return { write: false, result: { previous, doc } };
        delete doc.links[appId];
        // 已下发的环境变量留在 Bot 上（与其它分组一致），从此归 Bot 自己管：清掉**所有**
        // Agent 对该 Bot 的下发记录（含此前改关联留下的），以后关联别的 Agent 时不会被
        // 当成「Agent 已删除的变量」移除。
        for (const entry of doc.agents) {
          if (entry.env) delete entry.env.pushed[appId];
        }
        return { write: true, result: { previous, doc } };
      });
      jsonRes(res, 200, { ok: true, previous: result.previous, ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (envMatch && req.method === 'PUT') {
      const id = decodeSegment(envMatch[1]);
      const appId = decodeSegment(envMatch[2]);
      requireKnownBot(deps, appId);
      const putBotEnv = deps.putBotEnv;
      if (!putBotEnv) throw new ApiError(503, 'env_push_unavailable');
      const outcome = await serializeEnvPush(`${agentsPath}\0${appId}`, async () => {
        const doc = await readAgentProfiles(agentsPath);
        const agent = requireAgent(doc, id);
        if (doc.links[appId] !== id) throw new ApiError(409, 'not_linked');
        if (!agent.env) throw new ApiError(409, 'env_unmanaged');
        const vars = agent.env.vars ?? {};
        const rev = agent.env.rev;
        const keys = Object.keys(vars).sort();
        // 之前由任何 Agent 下发、而当前 Agent 不再声明的变量从 Bot 上移除；Bot 自己加的
        // 变量不在任何下发记录里，不受影响。
        const previouslyManaged = new Set(doc.agents.flatMap(entry => entry.env?.pushed[appId]?.keys ?? []));
        const remove = [...previouslyManaged].filter(key => !Object.prototype.hasOwnProperty.call(vars, key));
        const pushed = await putBotEnv(appId, {
          env: keys.length ? JSON.stringify(vars) : '',
          mode: 'merge',
          ...(remove.length ? { remove } : {}),
        });
        if (pushed.status < 200 || pushed.status >= 300 || pushed.body?.ok === false) {
          const reason = pushed.body?.message ?? pushed.body?.reason;
          return {
            status: pushed.status >= 400 ? pushed.status : 502,
            body: {
              ok: false,
              error: String(pushed.body?.error ?? 'env_push_failed'),
              ...(reason ? { message: String(reason) } : {}),
            },
          };
        }
        const result = await mutateAgentProfiles(agentsPath, current => {
          const target = requireAgent(current, id);
          if (!target.env) return { write: false, result: { doc: current } };
          for (const other of current.agents) {
            if (other.id !== id && other.env) delete other.env.pushed[appId];
          }
          target.env.pushed[appId] = { rev, keys };
          return { write: true, result: { doc: current } };
        });
        return {
          status: 200,
          body: {
            ok: true,
            envKeys: Array.isArray(pushed.body?.envKeys) ? pushed.body.envKeys : keys,
            ...snapshot(result.doc, deps.knownBotIds()),
          },
        };
      });
      jsonRes(res, outcome.status, outcome.body);
      return true;
    }

    jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  } catch (error) {
    if (error instanceof ApiError) {
      jsonRes(res, error.status, { ok: false, error: error.code, ...(error.detail ? { message: error.detail } : {}) });
    } else if (error instanceof AgentProfilesFileError) {
      jsonRes(res, 500, { ok: false, error: 'agents_file_invalid', message: error.message });
    } else {
      jsonRes(res, 500, { ok: false, error: 'agents_api_failed', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
}
