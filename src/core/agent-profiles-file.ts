/**
 * Agent 配置模板的存放位置：**实际**加载的 bots.json（解析符号链接后）同目录下的专用目录
 * `agent-profiles/`，文件 `agents.json`；原子写入的临时文件与文件锁也在这个目录里。
 *
 * 文件里有 Agent 环境变量的值（provider token），属于沙箱必须屏蔽的凭据：
 * - 跟随 bots.json 的真实位置：bots.json 在哪里受保护，Agent 文件就同样受保护——项目里
 *   放一个指向 ~/.botmux/bots.json 的符号链接，不会把含 token 的文件写进项目。
 * - 放进专用目录：沙箱只需遮罩这一个目录。目录级遮罩不受目录内 rename 影响（文件级 bind
 *   遮罩会在宿主原子替换文件时被内核卸掉），也覆盖之后才创建的文件。
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AGENT_PROFILES_DIR_NAME = 'agent-profiles';
export const AGENTS_FILE_NAME = 'agents.json';

/** `botsConfigPath` 为当前加载的配置文件路径（可能是符号链接，尚不存在时按原样）。 */
export function agentProfilesDirFor(botsConfigPath: string): string {
  let real = botsConfigPath;
  try { real = realpathSync(botsConfigPath); } catch { /* config not created yet */ }
  return join(dirname(real), AGENT_PROFILES_DIR_NAME);
}
