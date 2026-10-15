/**
 * Agent 配置模板的文件名：与当前加载的 bots.json 同目录（见 dashboard/agent-profiles-store）。
 * 文件里有 Agent 环境变量的值（常含 provider token），属于需要对沙箱屏蔽的凭据文件
 * （见 adapters/backend/scratch-credentials）。叶子模块，不带任何依赖。
 */
export const AGENTS_FILE_NAME = 'agents.json';

/**
 * 原子写入的临时文件所在目录（`<agents.json>.tmp.d/<pid>`）。临时文件里是完整定义（含变量
 * 值），放进一个固定的目录，scratch 沙箱才能在会话启动时就预留屏蔽它——逐个枚举只能
 * 覆盖启动时已存在的旁路文件，之后每次保存新建的临时文件会漏掉。与目标同目录，rename
 * 仍是同一文件系统内的原子操作。
 */
export function agentProfilesTempDir(agentsPath: string): string {
  return `${agentsPath}.tmp.d`;
}
