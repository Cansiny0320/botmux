/**
 * Agent 配置模板的文件名：与当前加载的 bots.json 同目录（见 dashboard/agent-profiles-store）。
 * 文件里有 Agent 环境变量的值（常含 provider token），属于需要对沙箱屏蔽的凭据文件
 * （见 adapters/backend/scratch-credentials）。叶子模块，不带任何依赖。
 */
export const AGENTS_FILE_NAME = 'agents.json';
