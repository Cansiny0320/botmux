# Fork Release 双机部署

已批准：两台 Linux x64 主机统一用 Fork 的 GitHub Release 二进制，不另发 npm 包；自动维护只跟随经过测试的 Fork Release。

## 实施与验收

1. 在 `fork/traex-quota-release` 分支保留 Fork 专属部署改动，上游 `feat/traex-quota-fallback` PR 不含私有发行渠道。
2. `src/core/restart-report.ts` 固定仓库；`update-check.ts` 将最新版本、指定版本和回滚列表锁定同一个 Fork，要求完整稳定 Release 资产；失败不降级到 npm。
3. `binary-self-update.ts` 禁止 npm 平台包捷径，强制 SHA-256，保留原子替换和运行时版本探测。前端类型接收 `github-fork` 来源。
4. `.github/workflows/release.yml` 关闭 Fork tag 的 npm 发布触发。Fork Release 经构建、离线故障注入和 Linux 隔离 smoke 后手工发布；不自动跟随上游 master，不承诺尚未运行的 CI。
5. 用 Bun 1.4.3 构建 Linux x64，版本经 `BOTMUX_VERIFY_BAKED_VERSION` 注入，不改 package.json。先建 draft、上传二进制和 SHA-256 及同源 `release.json`，再公开；公开前复核 tag 指向已验证提交。现场发现共享出口 API 匿名额度耗尽，因此查询失败时回退同一 Fork Release 的清单，仍校验稳定版本、资产字段和指定版本一致性；下载/校验失败仍保留旧版本。
6. 两台主机确认无活动推理，备份原入口、bots.json 和 config.json；安装同一 SHA-256 二进制，设置 `traexAutoModel.trigger=quota` 和批准的三模型顺序，保留其他业务配置；顺序重启、检查 daemon/worker、只读更新查询和配置回读。无法直连 GitHub 的主机仅配置 Botmux `httpProxy`，版本元数据和文件下载使用同一出口，不更改系统或业务 CLI 代理。

验证：`vitest run --project unit test/fork-release-channel.test.ts`，既有 quota 单测与 Worker 集成测试、`bun run build`、`node scripts/smoke-bun-binary.mjs <binary>`。更新器测试覆盖来源、缺资产/校验、查询失败、旧版本保留与成功替换。不发送业务测试消息，不创建测试 Bug。

回滚：先停用自动更新，原子恢复备份入口及机器人配置，再重启并检查。业务 ledger、会话数据库、CLI 身份和凭据不迁移、不删除；旧 npm 安装保留但不再作为运行入口。

限制：首个 Fork Release 仅提供 Linux x64，GitHub 不可达则延后更新并保留当前运行版本。Fork 版本号只在本 Fork 渠道内有意义，不比较上游同号版本。
