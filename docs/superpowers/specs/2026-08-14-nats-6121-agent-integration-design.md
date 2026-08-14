# NATS Agent 接入设计

> 结论先行：仓库当前没有 NATS Rust 客户端依赖；引入 `async-nats` 或其它 NATS crate 会扩大 DBX Rust 依赖图。因此按本项目的依赖约束，NATS 首期必须采用 Agent，推荐 Go native Agent。本文把 Agent 方案定义为默认实现，而不是备用实现。

## 0. 依赖审计结论

本设计基于 2026-08-14 工作区审计结果：

| 检查项 | 结果 | 影响 |
| --- | --- | --- |
| `crates/dbx-core/Cargo.toml` | 没有 `async-nats`、`nats` 或其它 NATS Rust crate；只有 `rumqttc`（MQTT，且为可选依赖） | Rust 原生实现必须新增 Cargo 依赖，不能作为首期方案 |
| `src-tauri/Cargo.toml` | 没有 NATS Rust crate | Tauri 层也不能通过现有依赖间接复用 NATS 客户端 |
| `Cargo.lock` | 未发现 NATS Rust 包条目 | 不是“锁文件已有但 manifest 漏写”的情况 |
| `vendor/` patch | 只有 MQTT、数据库和 Tauri 相关 patch，没有 NATS 客户端 | 无可直接复用的本地 NATS 实现 |
| `agents/drivers/` | 已有 RabbitMQ、RocketMQ 等 Go native Agent 和发布脚本 | 可以沿用 native Agent 的隔离、打包和注册路径 |

因此本 issue 的技术决策是：**不向 DBX Rust workspace 添加 NATS 依赖；通过 `agents/drivers/nats` 的 Go Agent 接入 NATS。** Agent 自己可以在 Go module 中依赖 `nats.go`，该依赖隔离在 Agent artifact 中，不进入 DBX Rust 应用依赖图。

## 1. 为什么选择 Agent

现有 Agent 体系主要服务 JDBC 或 native database driver：`AgentDriverClient` 通过 stdin/stdout 传 JSON-RPC 2.0，启动时等待 `{"ready":true}`，并可执行 handshake/connect/test 等请求。NATS 的 Core 订阅是长期运行的事件流，与现有“一个调用对应一个响应”的 MQ adapter 方法不同。采用 Agent 可以同时满足“不新增 Rust NATS 依赖”和“将长期连接隔离到独立进程”，但必须为异步事件补齐路由。直接把订阅塞进现有单响应调用会遇到：

- stdout 上同时存在 response 和 unsolicited message event，需要完整的异步事件路由；
- stop/cancel 要求 Agent 可靠清理 NATS subscription；
- AgentRuntime 的 multi-session 语义不能天然表达 NATS subscription 生命周期；
- 诊断一条消息时跨 Rust → JSON-RPC → Go/Java → NATS 增加延迟和故障面。

因此需要在 `AgentDriverClient` 之上增加 NATS 专用 event router；Agent 本身是首期默认实现，不能让前端或 service 直接依赖 Agent method name。

## 2. Agent 形态选择

若启用 Agent，推荐 **Go native Agent**：

- `nats.go` 对 Core NATS、headers、JetStream 支持成熟；
- 仓库已有 native Go Agent 发布与测试范式，如 `agents/drivers/rabbitmq`、`agents/drivers/rocketmq`；
- 无需强行引入 Java/JDBC；
- 可复用 Go 的 TLS、NKey/JWT 和 reconnect 生态。

建议目录：

```text
agents/drivers/nats/
├── go.mod / go.sum
├── main.go             # ready + JSON-RPC dispatcher
├── connection.go       # server URL/auth/TLS/client lifecycle
├── subscriptions.go    # sid -> subscription/task/event routing
├── publish.go
├── jetstream.go
└── *_test.go
```

## 3. DBX Agent 协议边界

Agent 必须遵循仓库既有契约（参考 `agents/docs/agent-protocol-v2.md` 与 `crates/dbx-core/src/db/agent_driver.rs`）：

1. stdout 只输出 JSON-RPC/ready/event，不输出 banner 或调试文本；调试写 stderr；
2. 启动后输出 `{"ready":true}`；
3. 支持 `handshake`，返回 `protocolVersion`、`agentProtocolVersion`、能力列表；
4. 请求使用 JSON-RPC 2.0 `id/method/params`，响应必须带同一个 id；
5. 所有异步 unsolicited event 必须带明确的 `method`（例如 `subscription_message`），不能伪造一个请求 id；
6. 进程收到 shutdown/EOF 时停止 NATS subscriptions，关闭 client 和所有 goroutine；
7. secret 不写日志；错误返回结构化 category/stage/retryable，payload 只在用户请求返回。

### 3.1 建议 handshake

```json
{
  "protocolVersion": 2,
  "agentProtocolVersion": 2,
  "capabilities": [
    "nats_core",
    "nats_headers",
    "nats_subscription_events",
    "nats_jetstream_read"
  ]
}
```

不要复用 `multi_session` 名称来表达 NATS subscription。只有当 Agent 真正实现独立 session 隔离和运行时共享时才声明该 capability。

## 4. RPC 方法

### 4.1 请求/响应方法

```text
handshake(params) -> AgentHandshake
test_connection({connection}) -> NatsServerInfo
publish({subject, reply, headers, payloadBase64}) -> PublishResult
start_subscription({subscriptionId, subject, queueGroup?}) -> {subscriptionId}
stop_subscription({subscriptionId}) -> {ok:true}
list_subscriptions({}) -> SubscriptionInfo[]
jetstream_info({connection}) -> JetStreamInfo
list_streams({connection}) -> {streams, truncated}
get_stream({connection, stream}) -> StreamInfo
list_consumers({connection, stream}) -> {stream, consumers, truncated}
get_consumer({connection, stream, consumer}) -> ConsumerInfo
fetch_history({connection, history}) -> HistoryPage
shutdown({}) -> {ok:true}
```

`fetch_history` 的 `history` 包含 `stream`、可选 `startSequence`、`maxMessages` 和 `maxBytes`。它只使用 Stream message get，不创建 Consumer；返回 `ackMode=none` 与 `consumerKind=direct_get`。当前实现的握手已经声明 `nats_jetstream_read`。`start_subscription` 必须是幂等的：相同 `subscriptionId` 重复调用返回现有状态，不创建第二条 NATS subscription。`stop_subscription` 对未知 ID 返回成功或明确 `not_found`，但不能让前端卡死。

### 4.2 异步事件

```json
{
  "jsonrpc": "2.0",
  "method": "subscription_message",
  "params": {
    "subscriptionId": "sub-uuid",
    "sequence": 7,
    "message": {
      "subject": "orders.created",
      "reply": "_INBOX.x",
      "headers": [{"key":"Nats-Msg-Id","value":"42"}],
      "payloadBase64": "eyJpZCI6MX0=",
      "payloadText": "{\"id\":1}",
      "receivedAtMs": 1780000000000
    }
  }
}
```

其它事件：`subscription_state`、`subscription_error`、`agent_log`（默认不向用户界面转发）。DBX 端必须按 `subscriptionId` 丢弃迟到事件。

## 5. Rust 适配器设计

如果 Agent 方案被采用，新增 `crates/dbx-core/src/nats/agent.rs`，但对上层仍暴露与原生实现相同的 `NatsService` trait：

```text
NatsServiceBackend
└── Agent(AgentDriverClient + event router)
```

`AgentBackend` 负责：

- spawn `AgentLaunchSpec`；
- handshake/test；
- 将 JSON-RPC response 按 id 路由到调用方；
- 将 unsolicited event 路由到 `broadcast`/bounded mpsc；
- timeout/cancel 时调用 stop，若 Agent 无法确认清理则终止进程并从 registry 删除；
- 映射结构化 Agent error 到 dbx-core error categories。

不能让 Vue 直接依赖 Agent method name；前端只依赖 `NatsMessage`、`NatsSubscriptionInfo` 等领域 DTO。

## 5.1 MCP 调用链（已纳入首期设计）

MCP 不是 Agent 的另一套客户端实现，而是复用同一个 `dbx-core` facade。这样可以避免
Desktop/Web 和 MCP 分别实现一套 NATS 认证、payload 解码和权限判断：

```text
MCP client
  -> dbx-mcp tool/schema
  -> connection selector + scope + McpGlobalPolicy
  -> dbx-core::nats::NatsService
  -> AgentDriverClient (JSON-RPC over stdin/stdout)
  -> dbx-agent-nats (Go + nats.go)
  -> NATS server
```

Core MCP 初始交付了三个 bounded 工具；当前 JetStream 只读工具也沿用同一条链路，未新增任何直接 NATS 或 Rust client 路径：

| MCP 工具 | Agent 方法 | 约束 |
| --- | --- | --- |
| `dbx_nats_test_connection` | `test_connection` | 只读；返回 server capability、RTT 和 `max_payload` |
| `dbx_nats_capture` | `capture`（内部临时订阅） | 必须同时受 `duration_ms`、`max_messages`、`max_bytes` 限制；完成、取消或超时都要清理订阅 |
| `dbx_nats_publish` | `publish` | 仅具体 Subject；MCP read-only、连接 read-only、生产保护任一命中即拒绝 |

实现边界如下：

- MCP client 不接触 Agent method、stdin/stdout、NATS URL 或 token；凭据只由 Local/Web backend 解析并传到 Agent 进程边界。
- `connection_id` 必须通过现有 selector、allowlist 和 scope 重新解析；不能接受 MCP client 自带的未经校验连接配置。
- `dbx_execute_query` 不路由到 NATS；Subject、Header、Reply 和 JetStream 对象只能通过专用 DTO 返回。
- `dbx_nats_capture` 是短时结果型工具，不暴露永久 subscription。工具结束后由 Rust 发起 stop/关闭；Agent 无法确认清理时销毁该 Agent session。
- Web backend 必须在 Web server 侧重复鉴权和 scope 检查，不能只信任本地 `dbx-mcp` 的环境变量。

详细的 tool schema、Local/Web route、错误码和 MCP 验收矩阵见
[`2026-08-14-nats-6121-mcp-integration-design.md`](2026-08-14-nats-6121-mcp-integration-design.md)。

当前实现保持 Rust workspace 不添加 NATS crate，MCP 通过 Agent facade 接入；持久化 Core subscription event router 和 JetStream read-only RPC 均已开放。JetStream 写 RPC（ack、purge、create/update/delete）仍未实现也不在 capability 中声明。

## 6. Agent 安装与版本

若决定发布 Agent：

- 在 Agent catalog/registry 中登记 `nats`、平台 artifact、sha256、最低版本；
- 复用 `agent_service.rs` 的下载、校验、安装进度和本地 `agents/drivers/<db-type>/build/libs` 发现逻辑（native artifact 走对应平台目录）；
- 连接测试在 Agent 缺失时给出“安装 NATS Agent”的明确提示；首期不提供 Native 回退路径；
- 版本升级不能替换正在使用的进程，先建立新 client，再原子切换 registry；
- Agent 进程 stderr tail 应进入诊断错误，但过滤 credential 和 payload。

不建议为了 NATS 新增 Java JRE 依赖；如果仓库未来决定统一 native runtime，再在 release checklist 中记录平台矩阵、静态链接和签名校验。

## 7. Agent 测试策略

### 单元测试

- ready/handshake JSON 解析；
- request id 与 response out-of-order 路由；
- unsolicited message event 不阻塞普通 RPC；
- 重复 start/stop 幂等；
- Agent EOF/kill 时所有 pending 请求失败，订阅状态变为 error；
- stdout 无调试污染，stderr tail 可诊断。

### 集成测试

用本地 NATS server（或 testcontainer）覆盖：

- username/password/token/TLS 连接；
- Core publish/subscribe 和 headers；
- server 重启后的重连状态；
- JetStream stream/consumer/history/ack；
- Agent 与 Native backend 返回相同 DTO。

## 8. 后续是否引入 Rust 原生客户端

首期不维护 Rust native backend。未来如果要替换 Agent，必须先完成一次独立的依赖评审：确认 `async-nats` 的 license、传递依赖、TLS/平台支持、供应链审计、构建体积和与当前 Rust MSRV 的兼容性，并补充 Native/Agent DTO 等价性测试。未完成评审前，不得把 NATS crate 加入 workspace。
