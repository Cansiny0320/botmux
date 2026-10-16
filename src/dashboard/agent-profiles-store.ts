/**
 * agents.json 持久化：位置见 core/agent-profiles-file（配置文件旁的专用目录）、
 * 0600、跨进程文件锁 + 原子 rename。
 *
 * 只有 Dashboard 进程读写本文件；Bot 真正生效的配置仍在 bots.json（由各 daemon 的
 * 逐字段 IPC 写入），这里只存 Agent 模板与 larkAppId → agentId 的关联。
 *
 * 读盘失败（JSON 损坏、非对象）时**拒绝写入**：宁可让 Dashboard 报错，也不能用空
 * 文档覆盖掉用户手里唯一一份 Agent 定义。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, promises as fsp, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLoadedConfigPath } from '../bot-registry.js';
import { resolveBotsConfigFile } from '../core/config-dir.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import {
  AGENT_PROFILES_VERSION,
  emptyAgentProfilesDoc,
  normalizeAgentProfilesDoc,
  type AgentProfilesDoc,
} from './agent-profiles-model.js';
import { AGENTS_FILE_NAME, agentProfilesDirFor } from '../core/agent-profiles-file.js';

const migratedPaths = new Set<string>();

/** 位置规则见 core/agent-profiles-file.ts。首次解析时把早期位置的文件挪过来。 */
export function defaultAgentProfilesPath(): string {
  const configPath = getLoadedConfigPath() ?? resolveBotsConfigFile();
  const path = join(agentProfilesDirFor(configPath), AGENTS_FILE_NAME);
  if (!migratedPaths.has(path)) {
    migratedPaths.add(path);
    migrateLegacyAgentProfiles(path, configPath);
  }
  return path;
}

/**
 * 早期（未发版）版本把 agents.json 直接放在配置文件所在目录。新位置还没有文件时，一次性
 * 挪进专用目录；失败只记日志，不影响读写（新位置为空即视为尚未配置 Agent）。
 */
export function migrateLegacyAgentProfiles(path: string, configPath: string): void {
  if (existsSync(path)) return;
  const legacy = join(dirname(configPath), AGENTS_FILE_NAME);
  try { if (!statSync(legacy).isFile()) return; } catch { return; }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      renameSync(legacy, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      copyFileSync(legacy, path);
      chmodSync(path, 0o600);
      unlinkSync(legacy);
    }
    logger.info(`[agent-profiles] moved ${legacy} → ${path}`);
  } catch (error) {
    logger.warn(`[agent-profiles] could not move ${legacy} → ${path}: ${(error as Error).message}`);
  }
}

export class AgentProfilesFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfilesFileError';
  }
}

export async function readAgentProfiles(path: string): Promise<AgentProfilesDoc> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAgentProfilesDoc();
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgentProfilesFileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentProfilesFileError(`${path} must be a JSON object`);
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== undefined && version !== AGENT_PROFILES_VERSION) {
    throw new AgentProfilesFileError(`${path} has unsupported version ${String(version)}`);
  }
  const { doc, dropped } = normalizeAgentProfilesDoc(raw);
  if (dropped.length) logger.warn(`[agent-profiles] ignoring invalid agents in ${path}: ${dropped.join(', ')}`);
  return doc;
}

async function writeAgentProfilesAtomic(path: string, doc: AgentProfilesDoc): Promise<void> {
  // 临时文件含变量值，与目标同在专用目录里（沙箱遮罩的是整个目录，见 agent-profiles-file）。
  const tmp = `${path}.tmp.${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await fsp.rename(tmp, path);
}

/**
 * 锁内读-改-写。`mutate` 直接修改拿到的文档并返回结果；返回 `{ write: false }` 时不落盘。
 * `mutate` 抛出的错误原样上抛（调用方据此映射 HTTP 状态）。
 */
export async function mutateAgentProfiles<T>(
  path: string,
  mutate: (doc: AgentProfilesDoc) => { write: boolean; result: T },
): Promise<T> {
  await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    const doc = await readAgentProfiles(path);
    const { write, result } = mutate(doc);
    if (write) await writeAgentProfilesAtomic(path, doc);
    return result;
  });
}

export function newAgentId(): string {
  return `ag_${randomBytes(9).toString('base64url')}`;
}
