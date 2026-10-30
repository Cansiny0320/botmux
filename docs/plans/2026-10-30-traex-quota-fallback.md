# 实施计划

1. `src/services/traex-quota.ts` 与测试：结构化额度错误分类、原生模型目录读取、日/周额度解析。验证未知值、普通 429、过期 reset、字段格式。
2. `src/services/traex-auto-model.ts` 与测试：quota-only 策略、严格顺序、耗尽/重置状态恢复；保持容量策略兼容。
3. `src/services/traex-transcript.ts`、`src/worker.ts` 与测试：在终态交付前固定程序切换、精确恢复、原输入不重放、并发/取消保护和最终耗尽失败交付。
4. `docs/design/2026-10-30-traex-quota-fallback.md`：配置、已知边界与验收记录。
5. 验证命令：使用 packageManager 指定的 Bun 运行 `bun run build`；运行 traex-quota、traex-auto-model、traex-transcript 及真实 Worker 相关测试。集成故障注入不得发送真实群消息、创建 Bug 或消耗真实模型额度。

构建会生成 dist 与内嵌资源；不执行 `use:here`，避免替换本机正在运行的其他 Botmux。回滚通过关闭新配置恢复原行为；远程部署需先备份原二进制和配置。

验收：完整构建通过；9 个相关单测文件共 504 项通过、1 项既有跳过；真实 Worker/PTY 的 quota 场景 5 项通过。覆盖首个输入与恢复、严格顺序、全部耗尽停止、普通限流不切换。独立异常探针补齐初始化旁路、真实停止键、查询期间 journal 恢复、部分窗口数据缺失；移除 journal 守卫后同一恢复断言失败。
