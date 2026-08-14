# NATS #6121 小步迭代与验证计划

> 本文是执行顺序和验收门禁。每一步都应先有可观察结果，再进入下一步；任何一步失败都停留在当前分支，不把未验证能力带入下一阶段。

## 当前执行记录（2026-08-14）

- S0-S4 与 MCP Core 工具已完成；Rust workspace 仍不含 NATS client crate，Go Agent 固定使用 `github.com/nats-io/nats.go v1.47.0`。
- S6 已完成只读交付：Agent、`dbx-core`、Tauri、Web、Desktop 和 MCP 均有 JetStream info、Stream/Consumer 列表/详情以及 bounded history 路径。
- S6 history 使用 Stream message get，不创建 Consumer 且不会 ack；wire fixture 覆盖 Agent 对 `$JS.API.INFO`、`STREAM.LIST`、`STREAM.INFO`、`CONSUMER.LIST`、`CONSUMER.INFO`、`STREAM.MSG.GET` 的 read-only 调用。
- S5（持久化 Subject/收藏）和 S7（JetStream 写操作）仍未开始，不应因 S6 完成被误报为已交付。

## 1. 迭代总原则

- 每个 PR 只引入一个可验证的领域变化；
- 先建立纯函数/协议 mock，再接真实 NATS server；
- 先只读，再写入；先 Core NATS，再 JetStream；
- Desktop 与 Web 每一步都保持同名领域 DTO；
- 所有长任务都有取消测试和资源清理测试；
- 每阶段都记录：功能、已知限制、测试命令、手工环境、日志/截图。

## 2. 阶段门禁总表

| 阶段 | 目标 | 必须通过的门禁 | 失败时回退 |
| --- | --- | --- | --- |
| S0 | 契约和 fixture | DTO、错误分类、secret 脱敏、mock server fixture | 不引入运行时依赖 |
| S1 | 连接测试 | none/password/token、TLS/timeout、server info | 仅保留连接配置，不开放控制台 |
| S2 | Core subscribe | 实时消息、取消、buffer 上限、断线状态 | 禁用自动重连和消息写入 |
| S3 | Core publish | subject/header/payload 校验、只读保护、成功语义 | 只允许订阅查看 |
| S4 | 前端控制台 | Desktop/Web UI、事件过滤、JSON/header 展示 | 后端 API 可用但隐藏 UI |
| S5 | 持久化体验 | 最近 Subject/订阅配置、迁移兼容 | 默认不自动恢复 |
| S6 | JetStream 只读 | stream/consumer/info/history 不 ack | 保留 Core MVP |
| S7 | JetStream 写操作 | ack/purge/配置变更有保护和审计 | 不发布写操作 |
| M1 | MCP 只读工具 | test、bounded capture、JetStream read tools、scope/policy | 暂不开放 MCP Publish |
| M2 | MCP 写入工具 | Publish/request 的 policy、production guard、timeout | 只保留 MCP 只读工具 |

## 3. S0：依赖审计、Agent 契约、样例与可观测性

### 工作项

- 固定 `NatsConnectionConfig`、`NatsMessage`、`NatsSubscriptionInfo`、`NatsServerInfo`、JetStream DTO；
- 建立 `agents/drivers/nats` Go module，锁定 `nats.go` 版本；不得在 Rust manifest 中加入 NATS crate；
- 完成 Agent ready/handshake、JSON-RPC response 和 unsolicited event 的最小 fixture；
- 定义 JSON camelCase、Base64 字段、时间戳单位、headers 多值表示；
- 定义 error category 和 event envelope；
- 创建 fake NATS server/transport fixture，至少能发送 INFO、MSG、HMSG、-ERR 和 request/reply；
- 在设计文档中记录 server 版本、headers、JetStream capability 的探测方式。

### 验证

- Rust serde round-trip tests；
- TypeScript fixture 与 Rust snapshot 字段一致；
- payload 二进制 round-trip；
- secret redaction snapshot 不包含 password/token/NKey seed；
- fake server 每个响应都有可解释的断言失败信息；
- Agent artifact 的 checksum、平台命名和 registry 元数据通过现有发布脚本检查。

## 4. S1：连接测试（不提供订阅/Publish UI）

### 工作项

- 解析 `nats://`/`tls://` URL；
- 配置 none/password/token；
- 建立 registry、test connection、drop connection；
- 返回 server name/version/headers/JetStream/RTT；
- 对 DNS、认证失败、TLS 失败、超时做稳定错误分类；
- Desktop command 和 Web route 返回同一 DTO。

### 验证

```text
cargo test -p dbx-core nats
cargo test -p dbx-web nats
pnpm exec vitest run apps/desktop/src/lib/nats
pnpm typecheck
go test ./agents/drivers/nats/...
```

手工矩阵：本地 `nats-server -js`、无认证、用户名密码、token、错误端口、TLS 自签证书、server 重启。

## 5. S2：Core NATS 订阅

### 工作项

- `start_subscription` / `stop_subscription`；
- Subject wildcard 校验；
- 事件 envelope、subscriptionId、sequence；
- 每订阅 bounded buffer 和 dropped count；
- stop/unmount/connection close 的 cancellation；
- 断线状态和恢复策略（先提示，后续再自动重连）。

### 验证

- 两个 Subject 同时订阅，消息不得串线；
- 重复 start 相同 Subject 幂等；
- stop 后发送消息不再到达；
- 发送 5000 条消息时内存有界，UI 显示 dropped count；
- server 重启时状态转为 disconnected/error，重连不重复注册 sid；
- `cargo test` 覆盖 cancellation 和 registry drop；
- Vue 测试覆盖旧 subscriptionId 事件丢弃和卸载清理。

## 6. S3：Core NATS Publish

### 工作项

- Subject、reply、headers、文本/JSON/Base64 payload；
- `max_payload` 前后端双重校验；
- headers 不支持时明确禁用；
- 使用 `useMqMutationGuard` 对 Publish 做只读确认；
- 明确“交给客户端”与“请求/响应确认”的差异。

### 验证

- subscriber 收到精确 payload、reply、headers；
- wildcard publish 被拒绝；
- 空 payload、超限 payload、无效 header 被拒绝；
- read-only connection 后端直接拒绝，即使绕过前端；
- publish timeout 不会误报成功；
- JSON 格式化失败保留原文。

## 7. S4：前端控制台

### 工作项

- 按《前端组件复用设计》接入 `NatsConsole.vue`；
- 复用消息列表、详情、复制、toolbar、mutation guard；
- Desktop event 和 Web SSE/WebSocket 两条 transport；
- capability-driven JetStream tab；
- 响应式布局与大消息折叠。

### 验证

```text
pnpm exec vitest run apps/desktop/src/components/mq apps/desktop/src/components/nats
pnpm typecheck
pnpm lint
```

浏览器/桌面手工验收：连接、开始/停止订阅、实时消息、复制、JSON、headers、断线提示、只读保护、小屏幕布局。

## 8. S5：Subject 与订阅配置持久化

### 工作项

- 保存最近 Subject、收藏和显式订阅配置；
- 旧连接配置无新字段时安全默认；
- 明确是否自动恢复（推荐默认关闭，用户主动开启）；
- 导出/同步只带非敏感订阅配置；
- 删除连接/重命名连接不留下孤儿 subscription。

### 验证

- 旧快照导入不报错、不覆盖现有配置；
- 新快照往返保持 Subject 大小写和 wildcard；
- 密码/token/NKey seed 不出现在快照；
- 重启 DBX 后只恢复用户开启的订阅；
- 连接 ID 改变时旧事件被隔离。

## 9. S6：JetStream 只读

### 工作项

- 探测 JetStream enabled/API domain；
- Stream names/info、Consumer names/info；
- 显示 subjects、storage、retention、state、pending/ack 状态；
- 使用 ephemeral/ack none 的只读历史浏览；
- 分页、batch、timeout、历史消息上限；
- 处理 API error envelope、权限不足和 server 版本差异。

### 验证

使用 `nats-server -js` fixture，通过 NATS Agent 连接：

- 创建测试 stream 和 producer；
- DBX 能列出 stream/consumer 并显示状态；
- 浏览历史消息不会减少业务 consumer pending；
- batch 超限和无效 stream/consumer 有明确错误；
- JetStream 关闭时 Core NATS 控制台仍可用，JetStream tab 隐藏或显示不可用原因。

## 10. S7：JetStream 写操作（可选后续）

先实现 ack，再评估 purge、consumer/stream 配置变更。每个动作必须具备：

- capability 检查；
- 后端只读保护；
- 二次确认和影响范围文案；
- request id/operation log；
- 超时后的“结果未知”状态，不自动重试可能重复的 ack/purge；
- 集成测试证明只影响目标 stream/consumer。

## 11. M1/M2：MCP 接入验证

MCP 不能把永久 Core NATS subscription 作为永不返回的 tool call。先实现 bounded `dbx_nats_capture`，再实现 Publish：

### M1 只读

- `tools/list` 根据 `McpGlobalPolicy` 和 connection scope 暴露 NATS 工具；
- `dbx_nats_test_connection`、`dbx_nats_capture`、JetStream info/list/get/fetch 均为 bounded request；
- capture 达到 duration/message/bytes 任一上限后主动 stop Agent subscription；
- MCP cancellation、Agent EOF、NATS 断线都不留下后台订阅；
- Local/Web backend 返回同一 DTO；
- NATS connection 不能被 `dbx_execute_query` 当成 SQL 使用。

### M2 写入

- `dbx_nats_publish` 只允许具体 Subject，不能 wildcard；
- Read only、连接只读、生产保护和账号权限任一拒绝都必须生效；
- Core NATS publish 只能返回 client accepted，不能伪造 durable ack；
- request/reply 有 request timeout 和 response bytes 上限；
- MCP tool timeout 后返回结果未知并完成 Agent cleanup，不自动重放。

## 12. 发布前检查

### 自动检查

```text
pnpm typecheck
pnpm lint
pnpm test
cargo fmt --check
cargo test -p dbx-core --features mq-admin
cargo test -p dbx-web
go test ./agents/drivers/nats/...     # 仅 Agent 方案启用时
```

### 安全检查

- 搜索日志、快照、错误、截图，确认无 password/token/NKey seed；
- 生产保护覆盖 publish、ack、purge、配置变更；
- subject/header/payload 大小均有上限；
- 订阅关闭和连接删除不会留下后台任务；
- Web 事件通道经过连接权限检查，不能越权订阅别人的 connectionId。

### Issue 验收记录

最终在 issue #6121 中逐项勾选：

- [ ] 连接 URL/认证/测试连接；
- [ ] Subject 订阅和实时消息；
- [ ] Header/Payload/JSON；
- [ ] 指定 Subject Publish；
- [ ] Stream/Consumer/状态；
- [ ] 历史消息浏览且默认不 ack；
- [ ] Desktop/Web 验证；
- [ ] 已知限制、NATS server 版本和复现步骤。
