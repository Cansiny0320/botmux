# Fork 二进制发行渠道

本 Fork 的部署分支为 `fork/traex-quota-release`，发布地址为 https://github.com/Cansiny0320/botmux/releases 。目前只支持 Linux x64 glibc。

部署使用 Release 的 `botmux-linux-x64` 和同名 `.sha256`，验证 SHA-256 和 `--version` 后原子安装到 `~/.botmux/bin/botmux`。运行 supervisor、daemon 和后续 Worker 都必须来自此独立路径，不能继续运行 npm 包目录中的旧入口。旧二进制和配置应先备份；没有活动推理时重启并检查 daemon。

不发布自有 npm 包，也不要使用上游 README 的 npm/install.sh 命令更新这个 Fork。独立二进制的手工 `botmux update`、后台定时更新和回滚查询均固定到本 Fork；不会拿 npm 同版本平台包替代。GitHub 不可达、Release 未发布或资产不全、校验或兼容性检测失败时，保留原版本。

后台自动更新只安装已公开的稳定 Fork Release，不自动拉取或合并上游源码。新 Release 的发布步骤：

1. 在部署分支集成经过审查的改动，运行相关行为测试和 `bun run build`（Bun 1.4.3）。
2. 通过 `BOTMUX_VERIFY_BAKED_VERSION` 指定版本，运行 `bun scripts/build-bun-binary.mjs --target bun-linux-x64 --out <asset>`，不手改 package.json。
3. 在隔离 Linux 环境运行 compiled smoke 和真实 Worker 的 quota 故障注入测试，不连接真实群或创建业务记录。
4. 提交并推送已验证代码、打不可变 tag；先创建 draft Release，上传二进制及 SHA-256，复核 tag 和资产后再公开。
5. 两台机器安装同一资产、逐台重启，回读版本、SHA-256、运行进程入口、模型顺序、维护开关与健康状态。

上游 PR 仅包含 quota fallback 功能，Fork 渠道改动留在本部署分支。版本号仅在 Fork 内比较，不代表上游同号 Release。
