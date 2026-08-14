# NATS 支持（Issue #6121）开发总览

> 状态：已实现 Core NATS MVP 和 JetStream 只读浏览。本文同时记录仍然后置的写管理边界。
>
> 关联 issue：[t8y2/dbx#6121](https://github.com/t8y2/dbx/issues/6121)

## 1. 背景与目标

Issue #6121 希望在 DBX 中增加 NATS 数据源和类似 RabbitMQ Management UI 的基础可视化能力，第一阶段优先覆盖：

- NATS 连接管理：Server URL、用户名/密码、Token、连接测试；
- Core NATS Subject 调试：订阅、实时消息查看、Header/Payload 展示、JSON 格式化、Publish；
- JetStream 基础信息：Stream、Stream Subjects、Consumer、Pending/Ack 状态，以及历史消息浏览/消费；
- 如果 JetStream 首期风险过高，至少先交付“连接 → Subscribe → 实时查看 → Publish”。

本方案的首要交付目标是一个可独立验收的 Core NATS MVP，JetStream 作为第二阶段能力。所有阶段均要求可回滚、可观测，并且桌面端和 Web/API 端保持同一业务契约。

## 2. 现有仓库基线

### 2.1 可复用的消息队列框架

仓库已经有完整的 MQ 管理分层：

| 层 | 现有位置 | 对 NATS 的复用方式 |
| --- | --- | --- |
| 领域模型/能力 | `crates/dbx-core/src/mq/types.rs` | 复用 `MqClusterInfo`、`MqCapabilities` 的能力驱动思想；NATS 专有字段单独建类型，不强行套用 Pulsar 的 tenant/namespace。 |
| 服务层 | `crates/dbx-core/src/mq/service.rs` | 复用 connection lookup、只读保护、超时、错误映射和 Desktop/Web 共用 core 函数模式。 |
| 适配器 | `crates/dbx-core/src/mq/port.rs`、`crates/dbx-core/src/mq/adapters/` | 可新增 `nats` 适配器，但 Core NATS 的长生命周期订阅不应直接塞进纯请求/响应方法。建议 NATS 使用独立 `NatsService`，JetStream 管理 API 再以 capability 适配器接入。 |
| 桌面 API | `src-tauri/src/commands/mq_cmd.rs`、`apps/desktop/src/lib/backend/mq-tauri.ts` | 复用命名、invoke 包装和错误处理风格；长订阅事件另设 event channel，不让 invoke 请求长期阻塞。 |
| Web API | `crates/dbx-web/src/routes/mq.rs`、`apps/desktop/src/lib/backend/mq-http.ts` | 复用 POST route 和统一 API wrapper；实时消息使用 SSE/WebSocket，不能用一个未结束的普通 JSON POST 假装流式接口。 |
| 前端控制台 | `apps/desktop/src/components/mq/MqAdminConsole.vue` 及 `apps/desktop/src/components/mq/` | 复用控制台壳层、panel toolbar、消息详情、发送/浏览交互和 capability 隐藏策略。 |
| 连接模型 | `crates/dbx-core/src/models/connection.rs`、前端 connection store | 使用既有 `MessageQueue + driver_profile=nats + external_config.systemKind=nats` 模型；NATS 专有 URL、认证和 TLS 字段由 `NatsConnectionConfig` 解析，避免映射到 HTTP 管理型 MQ adapter。 |
| Agent | `crates/dbx-core/src/db/agent_driver.rs`、`agents/docs/agent-protocol-v2.md` | 由于 Rust workspace 没有 NATS crate，首期采用 `agents/drivers/nats` Go native Agent；Rust 侧复用 Agent client 并新增异步事件路由。 |

### 2.2 MQTT 代码的边界

`crates/dbx-core/src/mqtt/` 已经处理了异步长连接、订阅恢复、消息缓冲、发布确认、TLS 和认证。它可以作为生命周期和消息缓冲的参考，但不能直接复用 MQTT 类型或 Topic 校验：

- MQTT 的 Topic Filter（`+`、`#`）和 NATS Subject token（`.` 分隔、`*`、`>`）规则不同；
- MQTT 的 QoS/retain/no-local 与 NATS Core NATS 不对应；
- MQTT v5 properties/header 与 NATS headers 的 wire format 不同；
- JetStream 的 ack、consumer、stream 是服务端持久化资源，不等价于 MQTT subscription。

## 3. 总体架构决策

### 3.1 推荐方案：Go native Agent + Rust NATS service facade

仓库依赖审计确认 `crates/dbx-core/Cargo.toml`、`src-tauri/Cargo.toml` 和 `Cargo.lock` 都没有 NATS Rust 客户端。引入 `async-nats` 会新增 Rust workspace 依赖，因此按本项目约束，首期采用 `agents/drivers/nats` Go native Agent；Rust 侧只实现 `NatsService` facade、JSON-RPC event router 和领域 DTO。理由：

1. 不向 DBX Rust 依赖图引入 NATS crate；
2. Go `nats.go` 依赖隔离在 Agent artifact，适合 Core NATS、headers、JetStream 和 NKey/JWT；
3. 现有 native Agent 发布、安装、校验、stderr 诊断和平台 artifact 流程可以复用；
4. Rust 继续统一处理连接 registry、权限、超时、取消、事件 envelope 和前端契约。

### 3.2 不建议的方案：把 NATS 伪装成 JDBC Agent

NATS 不是关系型数据库，不应实现 `listTables/executeQuery` 之类无意义的 JDBC 映射。这样会导致：

- 长订阅被迫变成轮询；
- Header、subject、reply-to 和 ack 语义丢失；
- Agent 协议和 NATS 协议之间多一层难以排障的转换；
- Java/JDBC Agent 的发布和运行时体系被无必要地扩大。

### 3.3 Rust 原生客户端何时可以重新评估

只有在未来明确接受新增 Rust 依赖、完成 license/供应链/平台构建审查，并证明原生 client 能显著降低维护成本时，才重新评估把 Agent 替换为 Rust client。首期不允许以“后续再换回 Rust”为前提跳过 Agent 契约设计。

## 4. 功能分期

### Phase 0：连接与只读诊断

- NATS URL、TLS、username/password、token 配置；
- `test_connection` 返回 server name、version、headers、JetStream 是否可用；
- 无消息订阅，无写入动作；
- 目标是确认连接模型、secret 脱敏和错误分类。

### Phase 1：Core NATS 调试（首个可发布 MVP）

- 输入并校验 Subject；
- 创建/停止临时订阅；
- 实时消息列表（Subject、Reply、Headers、Payload、时间、大小）；
- JSON payload 格式化、原始文本/Base64 切换、复制；
- Publish（Subject、可选 Reply、Headers、Payload）；
- 订阅/发布并发、断线提示、取消订阅和消息上限。

### Phase 2：Subject/连接体验增强

- 订阅配置本地持久化（默认关闭自动恢复，避免意外接收大量消息）；
- Subject 历史、收藏和最近消息；
- TLS CA/client cert、NKey/JWT 等高级认证；
- 代理/SSH tunnel 的真实拨号地址与逻辑 server URL 分离。

### Phase 3：JetStream 只读浏览（已实现）

- Stream 列表/详情/subjects；
- Consumer 列表/详情；
- Pending、Ack Pending、Delivered、Redelivered 等状态；
- 历史消息浏览（`$JS.API.STREAM.MSG.GET` 的按 sequence 直接读取）；
- 明确区分“浏览”与“ack 消费”，默认浏览不得确认消息；
- 最后再考虑 Stream/Consumer 创建、删除、ack、purge 等写管理操作。

## 5. 跨层数据流

```text
Vue NatsConsole
  ├─ request API: test / publish / list streams / pull history
  └─ stream API: start subscription -> event messages -> stop subscription
        │
        ├─ Tauri: invoke + AppHandle event channel
        └─ Web: HTTP request + SSE/WebSocket event channel
        │
  dbx-core NatsService
  ├─ connection registry (per connection id)
  ├─ bounded message buffer / cancellation
  ├─ Agent JSON-RPC facade + event router
  └─ JetStream request/reply facade
        │
  dbx-agent-nats (Go + nats.go)
        │
  NATS server (4222 / optional TLS)
```

必须在 service 层做连接 ID 隔离：一个 DBX 连接的订阅、缓冲和取消不能影响另一个连接。关闭连接时要先停止订阅任务，再释放客户端和 registry entry。

## 6. 非目标与安全边界

首期不包含：

- 直接实现 NATS wire parser；
- 批量删除 Stream、清空 Stream、强制 ack 全部消息；
- 任意 `$SYS.>` 监控面板；
- 把用户密码、token、NKey seed 写入普通连接导出或日志；
- 默认自动消费并 ack JetStream 历史消息。

所有 Publish、ack、purge、Stream/Consumer 变更都必须经过现有生产环境只读保护（参考 `useMqMutationGuard` 与后端 `ensure_connection_writable` 的模式）。

## 7. 交付物与验收入口

本设计对应的实现交付应至少包括：

1. NATS 连接配置和 secret 迁移说明；
2. `NatsService`/registry、Desktop command、Web route 和前端 backend wrapper；
3. Core NATS 控制台及组件测试；
4. JetStream capability、Stream/Consumer 浏览和历史读取测试；
5. 本目录下的逐阶段验证记录，以及 issue #6121 的最终验收截图/日志。

实现前先阅读同目录的以下专项文档：

- `2026-08-14-nats-6121-frontend-component-reuse-design.md`
- `2026-08-14-nats-6121-protocol-backend-design.md`
- `2026-08-14-nats-6121-agent-integration-design.md`
- `2026-08-14-nats-6121-incremental-validation-plan.md`
- `2026-08-14-nats-6121-mcp-integration-design.md`

MCP 不是控制台实时通道的替代品。MCP 只暴露有界 capture、诊断、Publish 和 JetStream 工具；持续订阅仍由 Desktop/Web 控制台处理。MCP 的所有 NATS 调用都经过现有 connection scope、`McpGlobalPolicy`、连接只读和生产保护。

## 8. 关键待决策项

开始编码前需要在实现 PR 的描述中记录以下决定；如果没有特别理由，采用括号内的推荐值：

| 决策 | 推荐值 | 原因 |
| --- | --- | --- |
| 数据源类型 | 独立 `nats` 类型 | 避免复用 `mq` 的 HTTP admin URL 和 tenant/namespace 假设 |
| 客户端实现 | Go native Agent (`nats.go`) | 避免向 Rust workspace 增加 NATS 依赖；Agent artifact 复用现有 native Agent 发布链路 |
| Web 实时通道 | SSE | 事件是单向 server -> browser，断开/权限模型简单 |
| 订阅恢复 | 默认关闭，用户显式开启 | 防止重启 DBX 后意外接收大量消息 |
| JetStream 历史浏览 | Stream message get + ack none | 不创建 Consumer，不改变业务 Consumer 的 pending/ack 状态；兼容不启用 direct-get 的 Stream |
| Queue group | Phase 2 | 首期先表达广播订阅，避免混淆消费语义 |
| headers 多值模型 | 数组 DTO | NATS 允许同名 header，多值不能压成单值 map |
