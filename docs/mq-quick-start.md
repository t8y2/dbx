# 消息队列管理功能 - 快速开始

## 概述

该功能为 DBX 增加了消息队列（Message Queue）管理能力，首批支持 **Apache Pulsar** 的管理操作。架构保留 Kafka、RocketMQ 扩展点，但在适配器完成前 UI 只允许创建 Pulsar 连接。

## 功能特性

### 已实现（Pulsar 首期核心）
- ✅ **租户管理**：创建、删除、查询、更新租户信息
- ✅ **命名空间管理**：创建、删除、查询命名空间，配置策略
- ✅ **主题管理**：创建普通/分区主题，删除、查询统计信息
- ✅ **订阅管理**：创建、删除订阅，重置游标，清理积压，跳过消息
- ✅ **生产者/消费者监控**：查看活跃的生产者和消费者
- ✅ **策略配置**：发布速率、分发速率、订阅速率、积压配额、保留策略
- ✅ **权限管理**：授予/撤销角色权限
- ✅ **监控统计**：消息速率、吞吐量、积压大小
- ✅ **Raw Admin API**：直接发送自定义管理请求（逃生通道）

### 前端 UI（Pulsar 首期核心可用）
- ✅ 连接配置、控制台入口、租户/命名空间/主题/订阅/监控/生产者消费者/策略/权限/Raw API 面板
- ⚠️ 后续扩展：完整 i18n、Kafka/RocketMQ 适配器、高级 typed policy（最大生产者/消费者数、TTL、deduplication）

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                         前端 (Vue)                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ MqAdminConsole │  │ TenantsPanel │  │ TopicsPanel      │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│           ▼ mq-api.ts (统一 API 层)                          │
│      ┌──────────┴───────────┐                                │
│      │ mq-tauri.ts │ mq-http.ts │                            │
└──────┴─────────────┴────────────────────────────────────────┘
         ▼ Tauri Invoke   ▼ HTTP Fetch
┌─────────────────────────────────────────────────────────────┐
│               Rust 后端 (Tauri / Axum)                       │
│  ┌────────────────┐        ┌──────────────────┐            │
│  │ commands/mq_cmd │  ◀─▶  │ routes/mq        │            │
│  └────────────────┘        └──────────────────┘            │
│           ▼                         ▼                        │
│  ┌────────────────────────────────────────────────────┐    │
│  │         dbx-core/mq/service.rs (*_core)             │    │
│  └────────────────────────────────────────────────────┘    │
│           ▼                                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │    MqAdminRegistry (缓存 adapter 实例)              │    │
│  └────────────────────────────────────────────────────┘    │
│           ▼                                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │    MessageQueueAdmin trait (port.rs)                │    │
│  └────────────────────────────────────────────────────┘    │
│           ▼                                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │  PulsarAdapter (adapters/pulsar.rs)                 │    │
│  │  • 版本探测 (pulsar_version.rs)                     │    │
│  │  • OAuth2 token 缓存 (auth.rs)                      │    │
│  │  • SSRF 防护                                         │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
         ▼ HTTPS
┌─────────────────────────────────────────────────────────────┐
│              Apache Pulsar Admin REST API                    │
└─────────────────────────────────────────────────────────────┘
```

## 快速配置

### 1. 创建 Pulsar 连接

在 DBX 中添加新连接，配置如下：

**基本信息**：
- **数据库类型**：选择 `mq` (Message Queue)
- **连接名称**：例如 "Pulsar Production"
- **Host/Port**：填写任意值（MQ 连接不使用这些字段）

**扩展配置** (external_config JSON)：
```json
{
  "systemKind": "pulsar",
  "adminUrl": "https://pulsar.example.com:8443",
  "auth": {
    "kind": "token",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "tlsSkipVerify": false
}
```

### 2. 认证方式

#### Token 认证（最常用）
```json
{
  "kind": "token",
  "token": "your-jwt-token"
}
```

#### Basic 认证
```json
{
  "kind": "basic",
  "username": "admin",
  "password": "admin-secret"
}
```

#### OAuth2 认证（自动缓存 token）
```json
{
  "kind": "oauth2",
  "issuerUrl": "https://auth.example.com/oauth/token",
  "clientId": "pulsar-admin",
  "clientSecret": "client-secret",
  "audience": "https://pulsar.example.com",
  "scope": "pulsar:admin"
}
```

#### API Key 认证
```json
{
  "kind": "apiKey",
  "header": "X-API-Key",
  "value": "your-api-key"
}
```

#### 无认证
```json
{
  "kind": "none"
}
```

### 3. 高级选项

```json
{
  "systemKind": "pulsar",
  "adminUrl": "https://pulsar.example.com:8443",
  "auth": { "kind": "token", "token": "..." },
  "tlsSkipVerify": true,           // 跳过 TLS 证书验证（开发环境）
  "pinnedVersion": "3.1.0"         // 强制使用特定 API profile
}
```

## 使用示例

### 租户管理

```typescript
import { mqListTenants, mqCreateTenant } from '@/lib/mq-api'

// 列出所有租户
const tenants = await mqListTenants(connectionId)

// 创建租户
await mqCreateTenant(connectionId, 'my-tenant', {
  adminRoles: ['admin', 'ops'],
  allowedClusters: ['prod-cluster']
})
```

### 命名空间管理

```typescript
import { mqListNamespaces, mqCreateNamespace } from '@/lib/mq-api'

// 列出租户下的命名空间
const namespaces = await mqListNamespaces(connectionId, 'my-tenant')

// 创建命名空间
await mqCreateNamespace(connectionId, {
  tenant: 'my-tenant',
  namespace: 'my-namespace'
}, {})
```

### 主题管理

```typescript
import { mqListTopics, mqCreateTopic, mqGetTopicStats } from '@/lib/mq-api'

// 列出主题
const topics = await mqListTopics(connectionId, {
  tenant: 'my-tenant',
  namespace: 'my-namespace'
}, {
  includeNonPersistent: false
})

// 创建分区主题
await mqCreateTopic(connectionId, {
  tenant: 'my-tenant',
  namespace: 'my-namespace',
  topic: 'my-topic',
  persistent: true
}, 4) // 4 个分区

// 查询主题统计
const stats = await mqGetTopicStats(connectionId, {
  tenant: 'my-tenant',
  namespace: 'my-namespace',
  topic: 'my-topic',
  persistent: true
})
console.log(`消息速率: ${stats.msgRateIn}/s`)
console.log(`积压大小: ${stats.backlogSize} bytes`)
```

### 订阅管理

```typescript
import { 
  mqListSubscriptions, 
  mqCreateSubscription, 
  mqResetCursor,
  mqClearBacklog 
} from '@/lib/mq-api'

const topicRef = {
  tenant: 'my-tenant',
  namespace: 'my-namespace',
  topic: 'my-topic',
  persistent: true
}

// 列出订阅
const subs = await mqListSubscriptions(connectionId, topicRef)

// 创建订阅（从最早消息开始）
await mqCreateSubscription(connectionId, topicRef, 'my-subscription', {
  kind: 'earliest'
})

// 重置游标到最新
await mqResetCursor(connectionId, topicRef, 'my-subscription', {
  kind: 'latest'
})

// 清空积压
await mqClearBacklog(connectionId, topicRef, 'my-subscription')
```

### 策略配置

```typescript
import { mqSetPublishRate, mqSetRetention } from '@/lib/mq-api'

const scope = {
  level: 'namespace' as const,
  tenant: 'my-tenant',
  namespace: 'my-namespace'
}

// 设置发布速率限制
await mqSetPublishRate(connectionId, scope, {
  publishThrottlingRateInMsg: 1000,      // 1000 msg/s
  publishThrottlingRateInByte: 1048576   // 1 MB/s
})

// 设置保留策略
await mqSetRetention(connectionId, scope, {
  retentionTimeInMinutes: 7 * 24 * 60,   // 7 天
  retentionSizeInMb: 10240                // 10 GB
})
```

### 权限管理

```typescript
import { mqGrantPermission, mqListPermissions } from '@/lib/mq-api'

const scope = {
  level: 'namespace' as const,
  tenant: 'my-tenant',
  namespace: 'my-namespace'
}

// 授予权限
await mqGrantPermission(connectionId, scope, 'my-app-role', ['produce', 'consume'])

// 查询权限
const permissions = await mqListPermissions(connectionId, scope)
console.log(permissions) // { 'my-app-role': ['produce', 'consume'] }
```

## 桌面端命令注册

所有后端功能已通过 Tauri commands 暴露给前端：

```rust
// src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // ... 其他命令
    commands::mq_cmd::mq_test_connection,
    commands::mq_cmd::mq_list_tenants,
    commands::mq_cmd::mq_create_tenant,
    // ... 共 48 个 mq 命令
])
```

## Web 端路由注册

所有后端功能已通过 Axum routes 暴露为 REST API：

```rust
// crates/dbx-web/src/main.rs
.route("/mq/test-connection", post(routes::mq::test_connection))
.route("/mq/tenants/list", post(routes::mq::list_tenants))
.route("/mq/tenants/create", post(routes::mq::create_tenant))
// ... 共 48 个路由
```

## 安全特性

### 1. 只读保护
所有变更操作会检查连接的 `read_only` 标志：
```rust
ensure_connection_writable(&state, &connection_id, "Create tenant").await?;
```

### 2. SSRF 防护
Raw request 路径必须是相对当前 Admin base 的绝对路径：必须以 `/` 开头，不能包含 scheme/host，也不能包含 `..` 路径段：
```rust
if path.contains("://") || path.starts_with("//") || !path.starts_with('/') || path.split('/').any(|seg| seg == "..") {
    return Err("Raw request path is not safe".to_string());
}
```

### 3. OAuth2 Token 缓存
避免每次请求都交换 token（60 秒缓存，5 秒提前刷新）：
```rust
pub struct OAuth2TokenCache {
    token: RwLock<Option<CachedToken>>,
    config: OAuth2Config,
}
```

### 4. 版本兼容性
自动探测 Pulsar 版本，优雅降级不支持的 API：
```rust
async fn detect_pulsar_version(client: &reqwest::Client, base_url: &str) -> PulsarProfile {
    // 探测 /admin/v2/brokers/version
    // 返回 3.1.x baseline profile
}
```

## 编译与运行

### 启用 MQ 功能
```bash
# 默认已启用（default = ["duckdb-bundled", "mq-admin"]）
cargo build --release

# 或显式指定
cargo build --release --features mq-admin
```

### 禁用 MQ 功能
```bash
cargo build --release --no-default-features --features duckdb-bundled
```

### 检查编译
```bash
cargo check --package dbx-core --features mq-admin
cargo check --package dbx --features mq-admin
cargo check --package dbx-web --features mq-admin
```

## 后续扩展

### 添加新的 MQ 系统（如 Kafka）

当前版本仅在架构和类型层预留 Kafka/RocketMQ；前端连接对话框不会提供这些选项。新增适配器并完成验证后，再开放 UI 选择。

1. 实现 `MessageQueueAdmin` trait：
```rust
// crates/dbx-core/src/mq/adapters/kafka.rs
pub struct KafkaAdapter {
    config: Arc<ConnectionConfig>,
    client: KafkaAdminClient,
}

#[async_trait]
impl MessageQueueAdmin for KafkaAdapter {
    async fn test_connection(&self) -> Result<MqClusterInfo, String> {
        // Kafka 特定的连接测试
    }
    
    async fn list_topics(&self, ns: &NamespaceRef, opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String> {
        // Kafka 使用不同的 topic 模型，适配到统一接口
    }
    
    // ... 实现其他方法
}
```

2. 在 `MqAdminRegistry::build_adapter` 中注册：
```rust
match mq_config.system_kind {
    MqSystemKind::Pulsar => { /* ... */ }
    MqSystemKind::Kafka => {
        Ok(Arc::new(KafkaAdapter::new(config.clone()).await?))
    }
    // ...
}
```

3. 适配器、能力位和端到端验证完成后，再在连接对话框开放对应系统选择。

## 常见问题

### Q: 连接测试失败 "SSL certificate problem"
A: 开发环境可设置 `tlsSkipVerify: true`，生产环境应配置正确的 CA 证书。

### Q: 权限不足 "Not authorized"
A: 检查 token 是否有 `admin` 或相应的角色权限。

### Q: 某些 API 返回 404
A: 可能是 Pulsar 版本不支持该 API，检查 `test_connection` 返回的 `capabilities`。

### Q: OAuth2 token 一直刷新失败
A: 检查 `issuerUrl`、`clientId`、`clientSecret`、`audience` 是否正确。

### Q: 如何调试 Admin API
A: 使用 Raw API 面板或直接调用 `mqRawRequest`：
```typescript
const response = await mqRawRequest(connectionId, {
  method: 'GET',
  path: '/admin/v2/clusters',
  query: {},
  body: null
})
console.log(response.body)
```

 