# Message Queue Admin Module

Apache Pulsar 管理 API 的 Rust 实现。

## 模块结构

```
mq/
├── mod.rs              - MqAdminRegistry 注册表
├── types.rs            - 类型定义
├── auth.rs             - 认证机制 (OAuth2 缓存)
├── config.rs           - 配置解析
├── port.rs             - MessageQueueAdmin trait
├── service.rs          - 服务层函数
└── adapters/
    ├── pulsar.rs       - Pulsar 实现
    ├── rabbitmq.rs     - RabbitMQ 实现 (Java agent)
    └── pulsar_version.rs - 版本探测
```

## 核心 Trait

```rust
#[async_trait]
pub trait MessageQueueAdmin: Send + Sync {
    async fn list_tenants(&self) -> Result<Vec<TenantInfo>, String>;
    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<NamespaceInfo>, String>;
    async fn list_topics(&self, ns: &NamespaceRef, opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String>;
    // ... 45 more methods
}
```

## 使用示例

```rust
// AppState 会在存在 SSH/Proxy transport layer 时，把 Admin URL 改写到本地转发端点。
let config = state.mq_admin_config_for_connection(&connection.id, &connection).await?;

let adapter = state.mq_registry.get_or_build_config(&connection.id, config).await?;
let tenants = adapter.list_tenants().await?;
```

通常业务代码优先复用 `service.rs` 中的 `mq_*_core` 函数；只有需要直接组合底层能力时才访问 `MqAdminRegistry`。

## Feature Flag

```toml
[features]
default = ["mq-admin"]
mq-admin = []
```

## 文档

完整文档请参考：`docs/mq-index.md`
