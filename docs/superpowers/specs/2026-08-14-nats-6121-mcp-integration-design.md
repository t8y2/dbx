# NATS MCP 接入设计

> 关联 issue：#6121。本文补充 NATS 与 DBX MCP Server 的接入边界，当前只记录开发方案，不包含代码。

## 1. 结论

需要考虑 MCP，但不能把 MCP 当成 NATS 实时控制台的替代品：

- Desktop/Web 控制台负责持续订阅、实时消息列表、暂停视图和交互式 Publish；
- MCP 负责 AI 可调用的、短时且有界的连接诊断、Subject 抓取、Publish（受策略保护）和 JetStream 只读查询；
- MCP 通过 `dbx-core` 的 NATS service facade 调用 Go native NATS Agent，不直接连接 NATS，也不直接调用 `nats` CLI；
- MCP 工具不能暴露无上限的长时间 subscribe。订阅工具必须有 `duration_ms`、`max_messages`、`max_bytes` 上限，并在返回前主动取消 Agent subscription；
- `dbx_execute_query` 不用于 NATS。NATS 不是 SQL 数据源，Subject、Header、Reply、Stream、Consumer 都应使用专用 MCP 工具和 DTO。

## 2. 现有 MCP 架构约束

当前 MCP 入口和行为基线：

| 现有能力 | 代码/文档位置 | NATS 接入要求 |
| --- | --- | --- |
| Rust MCP server | `crates/dbx-mcp/src/server.rs`、`crates/dbx-mcp/src/backend.rs` | 在现有 `DbxMcpServer` tool router 中增加 NATS 专用 route；复用 selector、错误和 scope 解析。 |
| MCP tool schema | `rmcp` 的 `#[tool]`/`schemars` | 每个 NATS 工具定义严格的输入 schema、默认上限和描述；不要用自由格式 JSON 逃避 schema。 |
| 连接选择 | `ConnectionSelector`、`resolve_connection` | NATS 工具同样支持 `connection_id`/`connection_name`，并必须经过 `load_scoped_connections` 和 DBX allowlist。 |
| MCP 策略 | `McpGlobalPolicy`、Settings → MCP | Read only 允许连接测试、元数据、订阅抓取和 JetStream 浏览；Publish/ack/purge/配置变更按 Data read/write 或 Full access 和连接只读保护共同限制。 |
| 运行 scope | `McpScope`、`DBX_MCP_SCOPE_CONNECTION_ID(S)` 等 | scope 是硬上限。不能让 NATS 参数中的其它 connection id 越过 scope。 |
| Local backend | `LocalBackend` | 从 DBX storage 读取 NATS profile，解析 secret，找到并启动 NATS Agent。DBX 桌面应用不要求保持打开。 |
| Web backend | `WebBackend` | MCP 通过 DBX Web `/api/nats/*` route 访问，不把 NATS 凭据下发到 MCP client。 |
| 工具隐藏 | scoped/web 模式会隐藏连接变更和 Desktop UI 工具 | NATS 工具不应依赖 `dbx_open_table`/`dbx_execute_and_show`；MCP 是结果返回通道。 |

MCP 当前 `dbx_list_tables` 文案包含“message queue topics”，但这不等于 NATS 已经被支持。NATS 不能通过该工具伪造 Subject 列表：Core NATS 没有通用的服务端 Subject enumeration。建议为 NATS 增加专用工具，或在现有工具中明确只展示 JetStream Streams/Consumers。

## 3. MCP 工具分期

### 3.1 Phase M1：连接和 Core NATS 只读

| 工具 | 作用 | 权限 |
| --- | --- | --- |
| `dbx_nats_test_connection` | 返回 server name/version、headers、JetStream、RTT、最大 payload | Read only |
| `dbx_nats_capture` | 在指定 Subject 上抓取一段时间或固定数量的消息，返回 bounded message list | Read only |
| （暂不暴露）`dbx_nats_list_active_subscriptions` | 若未来 MCP 引入 session-owned live capture，可查看本 session 的任务（不列出 DBX 全局后台订阅） | Read only |

`dbx_nats_capture` 建议输入：

```json
{
  "connection_id": "...",
  "subject": "orders.>",
  "duration_ms": 5000,
  "max_messages": 100,
  "max_bytes": 1048576,
  "headers": true,
  "payload_mode": "text|json|base64"
}
```

当前 MCP 只提供结果型 `dbx_nats_capture`，不创建可跨 tool call 查询的持久订阅，因此没有实现 `dbx_nats_list_active_subscriptions`。Desktop/Web 的长订阅属于 UI session，不会泄露给 MCP。

服务端必须把 `duration_ms`、`max_messages`、`max_bytes` 限制在安全范围内（例如 100ms-60s、1-1000 条、1-16MiB），参数缺省采用更小的默认值。先达到任一上限就结束 capture，返回 `truncated`、`reason`、`dropped_count` 和消息数组。

### 3.2 Phase M2：Core NATS Publish

| 工具 | 作用 | 权限 |
| --- | --- | --- |
| `dbx_nats_publish` | 向具体 Subject 发布一条消息，支持 reply、headers 和 bounded payload | Data read/write；生产库仍受 DBX 生产保护 |
| `dbx_nats_request` | 可选，向 Subject 发 request/reply 并等待单个响应 | Data read/write；必须有 request timeout 和响应大小上限 |

`dbx_nats_publish` 必须拒绝 wildcard Subject（`*`、`>`），校验 payload 与 server `max_payload`，并在结果中区分：

- `accepted_by_client`：客户端已接受 publish；
- `request_reply_received`：仅 `dbx_nats_request` 有服务端响应；
- `durable_ack`：只有 JetStream publish ack 才能声明，Core NATS 不得伪造。

### 3.3 Phase M3：JetStream 只读（已实现）

| 工具 | 作用 | 权限 |
| --- | --- | --- |
| `dbx_nats_jetstream_info` | JetStream server/account 信息 | Read only |
| `dbx_nats_list_streams` | Stream 列表 | Read only |
| `dbx_nats_get_stream` | Stream subjects、storage、retention、state | Read only |
| `dbx_nats_list_consumers` | Consumer 列表及摘要 | Read only |
| `dbx_nats_get_consumer` | delivered、ack floor、pending、redelivered 等状态 | Read only |
| `dbx_nats_fetch_history` | 用 Stream message get 按 sequence 抓取历史消息 | Read only |

`dbx_nats_fetch_history` 默认不得 ack 业务 Consumer。实现不创建 ephemeral Consumer，而是通过 `$JS.API.STREAM.MSG.GET.<stream>` 读取存储消息；输入受 1-1,000 条和 1-16 MiB 边界限制，整个请求共享连接 request timeout。响应明确 `ack_mode=none`、`consumer_kind=direct_get`、`truncated` 和可选的 `next_sequence`。

`dbx_nats_list_streams` 与 `dbx_nats_list_consumers` 各最多返回 200 项，并带 `truncated`，防止拥有大量管理对象的账户令 MCP 响应无界增长。

### 3.4 Phase M4：显式写操作（谨慎评估）

可以后续增加 `dbx_nats_ack`、`dbx_nats_purge_stream`、`dbx_nats_create_consumer` 等工具，但每个工具都必须：

- 在 MCP policy、连接 read-only、生产库保护三层通过；
- 具备二次确认字段或明确的影响范围参数；
- 超时后返回“结果未知”，不得自动重放可能重复的操作；
- 审计 operation id、stream/consumer、sequence 和结果；
- 默认不在只读/ scoped 客户端的 tool list 中暴露高风险操作。

## 4. MCP 与 Agent 的关系

```text
MCP client (Claude/Cursor/Codex)
        │ stdio JSON-RPC / MCP
        ▼
dbx-mcp (Rust)
        │ DbxBackend + NatsService facade
        ▼
AgentDriverClient + NATS event router
        │ DBX Agent JSON-RPC over stdin/stdout
        ▼
dbx-agent-nats (Go, nats.go)
        │ NATS protocol
        ▼
NATS server
```

- MCP client 永远看不到 NATS Agent 的 method name、stdin/stdout、token 或服务器直接地址；
- `dbx-mcp` 负责 tool schema、connection scope、MCP policy、结果截断和错误映射；
- Agent 负责 NATS client/wire、Core subscription、headers、JetStream request/reply；MCP 和控制台均不直接连接 NATS；
- Desktop/Web 控制台和 MCP 必须共享同一 Rust domain DTO 与 Agent facade，避免两套 payload/header 解码；
- MCP capture 结束时必须调用 `stop_subscription`，连接关闭/工具取消时还要做 best-effort cleanup；无法确认清理时销毁 Agent session/runtime。

## 5. 长任务、取消与 MCP 超时

MCP tool call 通常是 request/response，不能把永久订阅挂在一个永不结束的 tool call 上。实现必须遵守：

1. MCP 参数先经过硬上限校验；
2. 创建带随机 `capture_id` 的临时 Agent subscription；
3. 等待 `duration_ms`、`max_messages`、`max_bytes`、客户端 cancellation 或首个 fatal error；
4. 发送 `stop_subscription`，等待有限时间；
5. 返回消息、状态、truncated reason、统计和清理结果；
6. 工具超时或 MCP client 断开时，后台 watchdog 继续清理，不能遗留无限订阅。

返回结构建议：

```json
{
  "captureId": "...",
  "subject": "orders.>",
  "messages": [],
  "receivedCount": 12,
  "droppedCount": 0,
  "truncated": false,
  "stopReason": "duration|message_limit|byte_limit|canceled|error",
  "cleanup": "stopped|agent_restarted|unknown"
}
```

## 6. 权限与安全

MCP 的现有安全策略必须作为 NATS 的上限，而不是仅为 SQL 保留：

- `Read only`：test、capture、JetStream info/list/get/fetch；
- `Data read/write`：增加 Core publish/request；是否允许 ack 需单独 capability/策略字段；
- `Full access`：才可评估 purge、创建/删除 consumer 等运维动作；
- DBX connection `read_only=true`、生产数据库保护和账号权限任何一个拒绝，后端都必须拒绝写操作；
- `connection_id`、Subject、Stream、Consumer 均重新解析和校验，不能信任 MCP client 传入的 display name；
- 普通 MCP 错误和日志不包含 token、NKey seed、密码或完整 payload；capture 返回也要受 payload bytes 上限；
- Web MCP 模式必须在 Web backend 做授权检查，不能由本地 `dbx-mcp` 只靠环境变量决定访问范围；
- `$SYS.>`、`$JS.API.>` 等系统 Subject 在 tool description 中标记风险，默认 capture 仍允许只读，但不能默认自动订阅。

## 7. Local/Web 实现差异

### Local backend

- `dbx-mcp` 读取 DBX storage 和中央 MCP policy；
- 通过 Agent service 找到/安装/启动 `dbx-agent-nats`；
- Agent 只在 MCP tool call 期间或有活动 capture 时保持；
- MCP server 退出时清理所有 capture 和 Agent 子进程。

### Web backend

- 新增 `/api/nats/mcp/*` 或复用 `/api/nats/*` 的受鉴权 route；
- Web server 负责 NATS Agent 的启动位置、凭据读取和连接 scope；
- MCP client 不直接访问 SSE/WebSocket 控制台通道；capture 通过 Web route 返回 bounded JSON；
- 统一错误 code，使 Local/Web 的 tool result 可测试地一致。

## 8. 测试与验收

### Tool schema/权限

- `tools/list` 在不同 MCP policy 下只暴露允许的 NATS 工具；
- scoped MCP 只能解析 allowlist 中的 NATS connection；
- read-only policy 拒绝 publish/request/ack/purge；
- connection-level read-only 和 production protection 覆盖 MCP policy；
- `dbx_execute_query` 对 NATS 返回明确的专用错误，而不是尝试 SQL。

### 行为

- capture 达到 duration/message/bytes 任一上限都会清理订阅；
- MCP cancellation、Agent EOF、NATS 断线不会留下后台 subscription；
- capture 返回 headers、binary payload、JSON payload 的稳定 DTO；
- Core publish 只返回 accepted，不伪造 durable ack；
- JetStream history 默认不改变业务 Consumer pending/ack，也不创建 Consumer；
- Local/Web 对同一 fixture 的 tool result 字段一致。

### 建议命令

```text
cargo test -p dbx-mcp
cargo test -p dbx-core --features mq-admin nats
pnpm --filter @dbx-app/mcp-server test
go test ./agents/drivers/nats/...
```

真实 NATS 验收至少覆盖：无认证、用户名密码、token、TLS、Core publish/subscribe、headers、JetStream stream/consumer/history、权限不足、Agent 缺失和 server 重启。
