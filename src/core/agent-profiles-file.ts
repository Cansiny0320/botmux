/**
 * Agent 配置模板的存放位置：当前加载的配置文件**路径**所在目录下的专用目录
 * `agent-profiles/`，文件 `agents.json`；原子写入的临时文件与文件锁也在这个目录里。
 *
 * 文件里有 Agent 环境变量的值（provider token），属于沙箱必须屏蔽的凭据：
 * - 放进专用目录：各类沙箱只遮罩这一个目录（scratch 预留、oncall / read-isolation 作为
 *   host-only 根）。目录级遮罩不受目录内 rename 影响（文件级 bind 遮罩会在宿主原子替换
 *   文件时被内核卸掉），也覆盖之后才创建的文件。
 * - 按路径而不按符号链接目标定位：配置写入（writeRawConfigAtomic）用 rename 原子替换，
 *   会把符号链接换成普通文件，按目标定位的目录会随之漂移、把已有 Agent「弄丢」；路径的
 *   所在目录则保持不变。
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const AGENT_PROFILES_DIR_NAME = 'agent-profiles';
export const AGENTS_FILE_NAME = 'agents.json';

/** `botsConfigPath` 为当前加载的配置文件路径（getLoadedConfigPath，可能是符号链接）。 */
export function agentProfilesDirFor(botsConfigPath: string): string {
  return join(dirname(botsConfigPath), AGENT_PROFILES_DIR_NAME);
}

/**
 * 沙箱遮罩用的 Agent 目录：完全解析符号链接后的真实路径——`agent-profiles` 自身若是符号
 * 链接，Dashboard 实际写进的是目标目录，只遮罩别名会漏掉它（macOS 按目标路径判定访问，
 * Linux 可能把不可达的别名遮罩丢掉）。`create` 时先建好目录（0700），使路径可解析，也能
 * 过策略的存在性过滤；建不出来时退回「父目录真实路径 + 目录名」。
 */
export function agentProfilesMaskDir(botsConfigPath: string, opts: { create?: boolean } = {}): string {
  const dir = agentProfilesDirFor(botsConfigPath);
  if (opts.create) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* read-only config dir */ }
  }
  try { return realpathSync(dir); } catch { /* absent */ }
  try { return join(realpathSync(dirname(dir)), basename(dir)); } catch { return dir; }
}
