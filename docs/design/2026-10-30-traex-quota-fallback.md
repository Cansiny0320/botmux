# TraeX 额度耗尽切换

已批准：固定程序按 GPT-6.1-Sol → GPT-5.6-Sol → DeepSeek-V4-Flash 切换，保留原生会话；不由 Agent 选择模型，不因排队、普通 429、网络或认证失败切换。

## 实现与压力测试结论

- 为现有 `traexAutoModel` 增加 `trigger: "quota"`，未配置时仍使用原容量策略。仅影响显式启用的托管 TraeX 终端，其他 CLI、adopt、RPC、durable / at-most-once 保持原行为。
- 原始结构化 `usageLimitExceeded` / `usage_limit_exceeded` 才识别为额度失败。目录里的 daily / weekly depleted 状态用于跳过已耗尽备选及确定 resetTime；缺失信息是 unknown，不是无限额度。
- 在失败终态结算前读取实时目录，再复用 exact native resume 和原输入退休机制。保持原 turn 身份，只注入一条继续输入；恢复提示要求先检查已经成功的外部操作。桥接层不重放报警，业务层仍依赖原有认领/账本去重，不宣称通用外部操作 exactly-once。
- 有序池单次恢复只向后走；最后一项失败后发送正常失败终态，不自动循环。后续独立输入按服务端 resetTime 重新选择；没有 resetTime 的耗尽状态不擅自推断每日重置点。
- 人工取消、改模型或会话 generation 变化优先；异步目录响应不能恢复已取消任务。缺少精确 native session 或原 turn 身份时不自动切换。
- 失败读取不能吞掉终态；重复错误不能生成两条继续输入。构建、单测和真实 Worker 故障注入分别验收。

## 配置

Dashboard 的 Auto 模型池中将切换条件选择为“额度耗尽”，或配置：

```json
{"model":"auto","traexAutoModel":{"enabled":true,"trigger":"quota","models":["preferred-model","backup-model","last-model"],"queueTimeoutMs":30000}}
```

`queueTimeoutMs` 仅兼容原配置结构，quota 模式不使用排队时长。模型名必须来自当前 CLI 的目录；不内置某个账号的模型名单。新输入重新读取额度信息。没有重置时间且始终缺失恢复信息时保持停止，可通过 `/model` 人工选择后重试，不推断跨日恢复。

## 发布边界

额度切换是通用功能，发布渠道修改不属于本功能补丁。自维护 Fork 必须单独确保更新渠道保留功能，不能仅改 GitHub 地址而继续下载上游 npm 二进制。
