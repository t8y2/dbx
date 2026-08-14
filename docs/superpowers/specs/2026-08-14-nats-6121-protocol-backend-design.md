# NATS 协议、后端服务与连接模型设计

> 关联 issue：#6121。本文描述接入 NATS 时必须遵守的协议语义和 dbx-core 分层。Core NATS 与 JetStream 只读链路已按本文实现。

## 1. 客户端策略

由于 workspace 当前没有 NATS Rust 客户端依赖，不能在首期直接加入 `async-nats`。NATS wire protocol 由 Go native Agent 中的 `nats.go` 处理；DBX Rust 通过 `AgentDriverClient` + NATS 专用异步 event router 调用 Agent。DBX 不自行实现 NATS parser，只在 Agent 边界验证用户输入和映射结果。Agent 客户端必须支持：

- Core NATS TCP/TLS 连接、INFO/CONNECT 握手、PING/PONG、重连；
- `SUB`/`UNSUB`/`PUB`/`MSG`；
- NATS headers（`HMSG`）；
- request/reply inbox；
- JetStream API request/reply；
- cancellation、bounded buffer 和关闭时的订阅清理。

Go module 依赖应锁定 `nats.go` 版本并纳入 Agent 的 `go.mod/go.sum`；它不会写入 Rust `Cargo.toml` 或 `Cargo.lock`。Agent artifact 必须经过现有 checksum、平台产物和版本 registry 流程。

## 2. Core NATS wire 语义（实现核对表）

| Server -> Client | Client -> Server | DBX 关注点 |
| --- | --- | --- |
| `INFO <json>\r\n` | `CONNECT <json>\r\n` | 读取 `server_id/name/version`, `headers`, `jetstream`, `auth_required`, `tls_required`, `max_payload`；不能把 INFO 当成最终连接成功。 |
| `PING\r\n` | `PONG\r\n` | 客户端库通常自动处理；用于诊断时记录 RTT，不要在 UI 自己实现心跳。 |
| `MSG <subject> <sid> <#bytes>\r\n<payload>\r\n` | `SUB <subject> <sid>\r\n` | Subject、sid、payload bytes 必须按协议解析；订阅 sid 由服务内部生成，不能让前端控制。 |
| `MSG <subject> <sid> <reply> <#bytes>\r\n...` | `UNSUB <sid> [max]\r\n` | reply-to 可能为空；UNSUB max 语义不要拿来实现 UI 消息上限，UI 上限应在 DBX buffer 层。 |
| `HMSG <subject> <sid> [reply] <#header bytes> <#total bytes>\r\n<header><payload>\r\n` | `PUB <subject> [reply] <#bytes>\r\n...` | Header bytes 和 total bytes 不能混淆；payload 可能为空。使用客户端库得到结构化 headers。 |
| `-ERR <text>\r\n` | `PUB`/`SUB` 等 | 错误要映射为 connection/auth/permission/protocol/resource 类别，保留原始文本用于诊断但脱敏。 |

`INFO` 中的 `headers=false` 表示该 server 不支持 headers；此时 Publish headers 应禁用或明确提示，不能静默丢弃。`max_payload` 必须同时用于前端校验和后端最终校验。

## 3. 认证与连接配置

### 3.1 Phase 1 认证

首期连接配置建议：

```ts
interface NatsConnectionConfig {
  serverUrl: string;                 // nats://host:4222 或 tls://host:4222
  auth: { kind: "none" | "password" | "token"; username?: string; token?: string };
  tls: boolean;
  tlsSkipVerify: boolean;
  connectTimeoutSecs: number;
  requestTimeoutSecs: number;
}
```

- username/password 与 token 都通过 secret store 读取，普通配置只保存 kind 和非敏感元数据；
- URL scheme、`tls` 字段和实际 TLS transport 必须一致，冲突时报错；
- 默认端口为 4222，TLS 常见仍使用 4222，不能像 MQTT 一样强行推导 8883；
- 支持 URL 中多个 server 时，保留逻辑 server 列表和当前拨号地址，便于重连诊断；
- NATS token 不是 HTTP Bearer header，不要复用 MQ REST auth 的序列化方式。

### 3.2 Phase 2 高级认证

后续可加入 NKey seed、JWT/operator/account、客户端证书。seed 和签名材料不得进入日志、导出或 Agent JSON-RPC 参数快照。TLS CA/client cert 路径可参照 MQTT 的 `MqttAuth::Certificate`，但字段命名要保持 NATS 专用。

## 4. 后端领域模型

建议新增 `crates/dbx-core/src/nats/`，至少包括：

```text
nats/
├── mod.rs              # NatsRegistry / public exports
├── config.rs           # external_config 解析、secret reference、URL 校验
├── client.rs           # Agent client、connection/reconnect lifecycle
├── service.rs          # test/publish/start/stop/list/pull core functions
├── types.rs            # serde camelCase DTO，与前端一一对应
├── subject.rs          # Subject/queue group/reply 校验
└── jetstream.rs        # JS API request/reply 和 response mapping
```

### 4.1 Core DTO

```rust
struct NatsMessage {
    subject: String,
    reply: Option<String>,
    headers: Vec<NatsHeader>,
    payload_base64: String,
    payload_text: Option<String>,
    received_at_ms: u64,
    size_bytes: usize,
}

struct NatsSubscriptionInfo {
    subscription_id: String,
    subject: String,
    state: "starting" | "active" | "stopped" | "error",
    received_count: u64,
    dropped_count: u64,
    last_error: Option<String>,
}
```

headers 推荐用数组而不是 `Record<string,string>`，因为 NATS header 允许同名多值；前端可按 key 分组显示。

### 4.2 Registry 与生命周期

`NatsRegistry` 按 `connection_id` 缓存 client，并维护 `subscription_id -> task`：

- 第一次 test/start 时惰性建立连接；
- 同一 connection 的 publish、request、subscribe 共享 client，但每个长任务有自己的 cancellation token；
- 停止订阅只取消对应 task 和 sid，不关闭共享连接；
- 关闭 connection 先 cancel 所有任务，等待有限时间，再 drop client；
- 配置 fingerprint 变化时丢弃旧 client，避免认证/TLS 配置泄漏到新连接；
- 每个订阅的 buffer 有固定上限和 dropped count，防止慢 UI 造成无界内存。

## 5. Subject 校验

NATS Subject 与 MQTT 不同：

- token 以 `.` 分隔；
- `*` 只能匹配一个 token；
- `>` 只能作为最后一个 token，匹配剩余 token；
- 普通 publish subject 不应包含 wildcard；
- 空 subject、空 token、超过 server `max_control_line` 的 subject 必须在后端拒绝；
- `$SYS`、`$JS` 等系统 subject 不应默认隐藏，但在 UI 上标记“系统/高风险”。

订阅可以使用 wildcard；Publish 必须是具体 subject。若后端支持 queue group，首期不暴露给普通 Core NATS 订阅，避免把队列消费语义误认为广播订阅；可在 Phase 2 作为高级字段加入。

## 6. Core API 设计

短请求建议与现有 MQ API 风格一致，但使用 NATS 专属命名：

| 目的 | Desktop command（建议） | Web route（建议） | 结果 |
| --- | --- | --- | --- |
| 连接测试 | `nats_test_connection` | `POST /api/nats/mcp/test-connection` | `NatsServerInfo` |
| 发布 | `nats_publish` | `POST /api/nats/mcp/publish` | `NatsPublishResult` |
| 开始订阅 | `nats_start_subscription` | `POST /api/nats/subscriptions/start` | `subscriptionId` |
| 停止订阅 | `nats_stop_subscription` | `POST /api/nats/subscriptions/stop` | `{ok:true}` |
| 列出活动订阅 | `nats_list_subscriptions` | `POST /api/nats/subscriptions/list` | `NatsSubscriptionInfo[]` |
| JetStream account 信息 | `nats_jetstream_info` | `POST /api/nats/mcp/jetstream/info` | `NatsJetStreamInfo` |
| JetStream Streams | `nats_list_streams` / `nats_get_stream` | `POST /api/nats/mcp/jetstream/streams` / `stream` | `NatsStreamList` / `NatsStreamInfo` |
| JetStream Consumers | `nats_list_consumers` / `nats_get_consumer` | `POST /api/nats/mcp/jetstream/consumers` / `consumer` | `NatsConsumerList` / `NatsConsumerInfo` |
| JetStream history | `nats_fetch_history` | `POST /api/nats/mcp/jetstream/history` | `NatsHistoryResult` |

这些命名是设计建议，真正实现时需在 Tauri invoke 注册表和 Web route module 中保持一一对应。

## 7. 实时事件与错误

事件通道必须携带 `connectionId`、`subscriptionId` 和递增 sequence。后端不得把 Agent 原始 message 直接序列化成前端未知结构。

错误分类建议：

```text
invalid_config  URL/Subject/header 校验失败
auth            用户名、密码、token、NKey 或 TLS 客户端认证失败
connection      DNS、TCP、TLS、超时、重连失败
permission      publish/subscribe/request 无权限
protocol        不支持 headers、非法响应、JS API 响应格式错误
resource        buffer 满、订阅数超限、payload 超过 max_payload
server          -ERR 或 JetStream API error
```

日志保留 server name/version、operation、subject（必要时脱敏）和错误类别，不记录 password/token/payload 全文。payload 是否进入 debug log 必须默认关闭。

## 8. JetStream 协议接入

JetStream 管理接口本质是 request/reply subject。客户端通过 `_INBOX.<random>` 创建 reply inbox，向 `$JS.API.*` 发送 JSON 请求，并等待一个响应或错误响应。

首期只做只读请求：

| 能力 | 典型 API subject | 说明 |
| --- | --- | --- |
| JetStream server info | `$JS.API.INFO` | 判断启用状态、域、API 可用性和限制 |
| Stream names | `$JS.API.STREAM.NAMES` | 支持 offset/limit 时做分页；否则限制返回数量 |
| Stream info | `$JS.API.STREAM.INFO.<stream>` | subjects、storage、retention、state |
| Consumer names | `$JS.API.CONSUMER.NAMES.<stream>` | 列出 consumer |
| Consumer info | `$JS.API.CONSUMER.INFO.<stream>.<consumer>` | delivered、ack floor、num pending、num ack pending |

历史消息浏览已使用 `$JS.API.STREAM.MSG.GET.<stream>` 按 Stream sequence 读取。该方式不创建 Consumer，也没有 ack，因此不会改变业务 Consumer 的 pending/ack 状态；它比临时 pull consumer 更适合 DBX 的明确只读面。每次读取共用一个 request timeout，最多返回 1,000 条或 16 MiB。已删除 sequence 计入 `skippedCount`，达到边界时返回 `truncated=true` 和 `nextSequence`。

严禁把历史浏览默认实现为业务 durable consumer 的 ack 消费。若用户选择 ack，操作结果需返回 `ack` 是否发送成功，以及消息的 stream/consumer/sequence。

JetStream API 响应中的 `error` 对象必须先判断再反序列化数据；未知字段允许保留到 `raw`，未知 API 错误不能被当成空列表。

## 9. 与 nats CLI 的对照验证

开发阶段可以用 `nats` CLI 作为人工 oracle，但 DBX 不应通过 shell 调用 CLI 承载产品功能。以下命令用于确认 broker、Subject 和 JetStream fixture 的预期行为：

```text
nats server check                  # 检查 server 可达性（按 CLI 版本可能需要 --server）
nats sub 'orders.>'                # 对照 Core NATS wildcard 订阅
nats pub orders.created '{"id":1}'
nats req orders.echo 'ping'        # 对照 request/reply inbox 行为
nats stream ls                     # 查看 JetStream Stream 名称
nats stream info ORDERS            # 查看 subjects、state、retention
nats consumer ls ORDERS            # 查看 Consumer
nats consumer info ORDERS DBX_VIEW # 对照 delivered/ack/pending 状态
```

自动化测试应直接使用 NATS client 或测试 server，不能依赖本机是否安装了 CLI。CLI 输出字段也不能直接作为稳定 API 契约，因为不同 CLI 版本会调整表格和默认分页。

## 10. 连接/传输层复用

- 连接测试通过现有 connection lifecycle 进入 `NatsRegistry`，而不是前端直接用 WebSocket 连接 NATS；
- SSH/proxy transport 要区分逻辑 NATS URL 与 local TCP endpoint，TLS server name/SNI 仍使用逻辑 host；
- 连接超时使用 `ConnectionConfig.effective_connect_timeout_secs()`；request timeout 使用 `query_timeout_secs`；
- 所有异步操作都接受 cancellation token，前端关闭 panel 后必须可取消；
- AppState drop connection 时复用现有 registry 清理钩子，不能留下后台订阅。

## 11. 后端测试

- URL、端口、TLS scheme、auth 配置解析和 secret 脱敏；
- wildcard Subject 合法/非法边界；
- `max_payload`、header unsupported、空 payload；
- publish 请求 JSON 到 Agent/nats.go 调用的字段映射；
- 同 connection 多订阅独立取消；
- buffer 上限和 dropped count；
- NATS `-ERR`、断线、重连、超时、取消后的状态转换；
- JetStream API 响应成功/错误/未知字段；
- JetStream 浏览不 ack，也不创建 Consumer；目前没有显式 ack RPC；
- mock server 至少覆盖 INFO、PING、MSG/HMSG、request/reply。
