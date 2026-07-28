# PIP-0001: 数据库连接空闲失效恢复机制

## 状态

Proposed

## 摘要

本 PIP 提议改进 DBX 在 PostgreSQL、openGauss、MySQL 连接空闲失效后的恢复机制，解决 Windows 环境下常见的查询永久执行中、取消无效、连接树持续加载、必须重启应用才能恢复的问题。

核心改动是将连接池检出、连接健康检查、SQL 执行、取消、清理和前端状态恢复纳入统一的超时与恢复模型，避免任一阶段永久挂起。

详细分析和实施计划见：

- `docs/pips/plans/2026-06-24-database-connection-timeout-recovery.md`

## 背景

用户在 Windows 环境下反馈，数据库连接建立后一段时间不活动，再次执行查询时会出现：

- 查询结果区域持续显示执行中。
- 点击中断无法停止。
- 连接状态持续转圈，刷新无效。
- 退出并重启应用后恢复。
- PostgreSQL、openGauss、MySQL 均受影响。

该问题不是单一数据库驱动或 SQL 语句问题。三个数据库共同受影响，说明问题边界位于 DBX 的连接生命周期管理、超时控制、取消机制和前端状态收敛层。

## 问题定义

当数据库连接空闲后，底层 TCP 连接或数据库会话可能被以下因素静默失效：

- 数据库服务端 idle timeout。
- VPN、NAT、防火墙、代理的空闲连接回收。
- Windows 睡眠、网络切换、Wi-Fi/VPN 断开后恢复。
- TCP 半开连接未及时被操作系统发现。

此时 DBX 仍可能持有旧连接池，并且前端仍认为连接有效。下一次操作可能卡在：

- `ensureConnected`
- `checkConnectionHealth`
- pool checkout
- pool recycle/verify
- MySQL ping
- PostgreSQL `SET search_path`
- SQL 执行或结果读取
- PostgreSQL cancel request
- MySQL `KILL QUERY`
- 连接树元数据刷新

当前系统缺少覆盖以上完整链路的统一执行预算，因此用户看到的现象是“前端一直执行中”，而真正的卡点可能在查询执行之前或取消请求本身。

## 目标

1. 空闲连接失效后，查询、刷新、取消操作都必须在可预期时间内完成或返回明确错误。
2. 用户无需重启应用即可通过清池、重连恢复。
3. PostgreSQL、openGauss、MySQL 的恢复行为保持一致。
4. 前端执行中、取消中、加载中状态必须有兜底清理机制。
5. 日志能够定位卡住阶段，便于后续排查。

## 非目标

1. 不保证所有服务端 SQL 一定被成功取消。客户端取消和服务端终止是两个不同结果。
2. 不改变 `query_timeout_secs = 0` 表示禁用 SQL 查询超时的语义。
3. 不重构所有数据库驱动，仅先覆盖 PostgreSQL、openGauss、MySQL 及共享连接管理链路。
4. 不改变连接配置的存储结构，除非提供向后兼容默认值。

## 提案

### 1. 引入数据库操作执行预算

为每次数据库操作建立统一预算，覆盖：

- 连接池等待。
- 新建连接。
- 回收验证。
- 健康检查。
- SQL 执行。
- 取消请求。
- 清理连接池。

建议模型：

```rust
pub struct DbOperationBudget {
    pub checkout_timeout: Duration,
    pub connect_timeout: Duration,
    pub recycle_timeout: Duration,
    pub query_timeout: Option<Duration>,
    pub cancel_timeout: Duration,
    pub cleanup_timeout: Duration,
}
```

其中 `query_timeout = None` 仅表示 SQL 执行不设上限；连接检出、健康检查、取消和清理仍必须有安全上限。

#### SQL 执行超时与基础设施超时的边界原则

本 PIP 区分两类超时，语义不可混淆：

**1. SQL 执行超时 — 遵循用户配置**

- `query_timeout_secs = 0`：表示 SQL 执行本身不设超时。前端不得静默将其变为有限值（如 60s）。现有代码已正确处理：前端 `withFrontendQueryTimeout` 在 `timeoutSecs === 0` 时直接返回 promise 不加超时；后端 `resolve_query_timeout` 在 `Some(0)` 时返回 `None`。
- `query_timeout_secs > 0`：SQL 执行超时为用户配置值。前端兜底超时设为配置值的 2 倍，让后端先触发自己的超时，前端超时仅作为网络异常下的兜底。
- `query_timeout_secs` 缺失或无效：使用默认值 60s（`DEFAULT_QUERY_TIMEOUT_SECS`）。

**2. 基础设施超时 — 始终有硬性上限**

以下阶段与 SQL 执行无关，即使用户设置 `query_timeout_secs = 0`，也必须有硬性超时上限，否则可能导致应用永久挂起：

- pool checkout（连接池等待）
- pool create（新建连接）
- pool recycle（回收验证）
- 健康检查（ping）
- 取消请求（PostgreSQL cancel / MySQL KILL QUERY）
- 连接池清理

这些超时值由 `DbOperationBudget` 中对应的非 `Option` 字段控制，不受 `query_timeout_secs` 影响。

#### checkout 阶段的 cancel token 集成

`deadpool-postgres` 的 `pool.get()` 不原生接受 `CancellationToken`。当前代码中 `pool.get().await` 为裸调用，无法在 checkout 阶段响应取消请求。

统一 checkout helper 应使用 `tokio::select!` 包装 `pool.get()` 以支持取消：

```rust
async fn checkout_with_cancel(
    pool: &Pool,
    cancel_token: Option<CancellationToken>,
    checkout_timeout: Duration,
) -> Result<deadpool_postgres::Object, String> {
    let get_future = tokio::time::timeout(checkout_timeout, pool.get());
    match cancel_token {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err("cancelled during pool checkout".to_string()),
                result = get_future => result.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())),
            }
        }
        None => get_future.await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())),
    }
}
```

当取消触发时，`pool.get()` future 被 drop，deadpool 内部会正确回滚等待状态。checkout timeout 通过 `tokio::time::timeout` 实现，超时错误应归类为连接错误并触发清池。

### 2. 补齐 PostgreSQL/openGauss pool timeout

PostgreSQL/openGauss 共用 `PoolKind::Postgres`。创建 `deadpool-postgres` pool 时应显式配置：

- wait timeout
- create timeout
- recycle timeout

同时在项目层统一包装 `pool.get()`，确保 checkout/recycle 阶段错误可被归类为连接池失效并触发恢复。

### 3. 统一 MySQL checkout 和 cancel 保护

MySQL 现有 `get_conn_with_health_check` 是有效的局部保护，但需要纳入统一执行预算。

需要补齐：

- `kill_query_with_opts` 的建连 timeout。
- `KILL QUERY` 执行 timeout。
- 元数据、事务、导出等路径中的直接 `pool.get_conn()` 审计。
- MySQL `tcp_keepalive` 默认配置。

### 4. 改进取消机制

取消请求必须覆盖两个阶段：

- SQL 已经在服务端执行：发送 PostgreSQL cancel 或 MySQL `KILL QUERY`。
- 尚未进入 SQL 执行，例如卡在 checkout/health check：取消客户端任务，标记连接池可疑，并按策略清理 pool。

PostgreSQL TLS 连接取消必须使用与原连接兼容的 TLS connector，避免当前 `cancel_query(NoTls)` 在 TLS 场景下失败。

#### TLS cancel 改造说明

当前代码 `cancel_postgres_query` 使用 `NoTls` 调用 `pg_cancel_token.cancel_query(NoTls)`。`tokio_postgres::CancelToken::cancel_query` 需要显式传入 `MakeSslConnect` 参数，**不会自动升级到 SSL**。若 PostgreSQL 服务器配置了 `hostssl` 或强制 TLS，`NoTls` 的 cancel 请求会被服务器拒绝。

改造步骤：

1. **验证阶段**：在改造前先编写测试验证当前驱动版本在 TLS 连接场景下 `cancel_query(NoTls)` 的实际行为，确认是否确实失败（服务器是否接受非 TLS cancel 请求取决于 `pg_hba.conf` 配置）。
2. **存储 TLS connector**：在创建连接池时，将 `MakeRustlsConnect` 实例（或等价 TLS 配置）与 `CancelToken` 一并存储，使 cancel 时能重建正确的 TLS 连接。
3. **重建 connector**：由于 `MakeRustlsConnect` 不一定实现 `Clone`，可能需要在 cancel 时从原始 `pg_config` 和 SSL 配置重新构建 connector。
4. **不降低证书校验**：cancel connector 必须使用与原连接相同的证书校验级别，不能为了 cancel 成功而降低安全性。

改造后的 `cancel_postgres_query` 签名应类似：

```rust
async fn cancel_postgres_query(
    pg_cancel_token: tokio_postgres::CancelToken,
    tls: tokio_postgres_rustls::MakeRustlsConnect,
) {
    match tokio::time::timeout(Duration::from_secs(5), pg_cancel_token.cancel_query(tls)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => log::warn!("Failed to send PostgreSQL cancel request: {err}"),
        Err(_) => log::warn!("Timed out sending PostgreSQL cancel request"),
    }
}
```

### 5. 前端状态兜底恢复

前端需要对以下阶段设置超时并清理状态：

- `ensureConnected`
- `checkConnectionHealth`
- `executeMulti`
- `cancelQuery`
- 连接树元数据刷新

#### 各阶段超时值定义

| 阶段 | 超时值 | 计算规则 | 说明 |
|------|--------|----------|------|
| `ensureConnected`（首次连接） | `connect_timeout_secs + 2s` | `connectionAttemptTimeoutMs(config)` | 已有实现，复用现有逻辑。Agent 驱动类型有 30s 下限。 |
| `ensureConnected`（健康检查快路径） | 5s | 固定值 | 当 `hasRecentConnectionHealthCheck` 为 true 时跳过；否则调用 `checkConnectionHealth`，需加 5s 超时。当前代码缺少此超时。 |
| `checkConnectionHealth` | `max(connect_timeout_secs * 2, 5s)` | 基于连接超时倍数 | 健康检查应在连接超时的 2 倍内完成，但不低于 5s。当前代码无超时保护。 |
| `executeMulti`（SQL 执行） | `query_timeout_secs > 0` 时为 `query_timeout_secs * 2`；`query_timeout_secs = 0` 时为 `0`（不设超时） | 前端超时是后端超时的 2 倍，让后端先触发自己的超时 | 现有实现已正确处理：`queryTimeoutSecs === 0 ? 0 : frontendTimeoutSecs`。前端超时仅作为兜底，不是 SQL 执行本身的超时控制。 |
| `cancelQuery` | 10s | 固定值 | 取消请求应在 10s 内返回。超时后强制清理 `isCancelling` 状态。当前代码无超时保护。 |
| 连接树元数据刷新 | `max(query_timeout_secs + 5s, 15s)` | 复用 `metadataLoadTimeoutMs` | 已有实现，`query_timeout_secs = 0` 时使用 60s。 |

所有超时触发后必须清理：

- `isExecuting`
- `isCancelling`
- `executionId`
- 连接节点 `isLoading`

若错误表明连接失效，应调用连接丢失处理，并提供重新连接入口。

### 6. 默认启用更适合桌面环境的 keepalive

#### 当前默认值不一致问题

现有代码存在两层 keepalive 默认值不一致：

- **Rust 模型层**：`default_keepalive_interval_secs()` 返回 `60`（开启），通过 `#[serde(default = "default_keepalive_interval_secs")]` 生效。从 Rust API（web 后端、测试代码等）直接创建的 `ConnectionConfig` 默认 keepalive 为 60 秒。
- **前端 UI 层**：`ConnectionDialog.vue` 中 `config.keepalive_interval_secs = ... ?? 0`（关闭）。从前端保存的连接配置默认 keepalive 为 0（关闭）。

这意味着从前端 UI 创建的连接和从 Rust API 直接创建的连接在 keepalive 行为上不一致。P1-1 必须统一两层默认值策略。

#### 统一策略

应用层 keepalive 统一默认开启：

- 默认间隔：30 秒（前后端统一使用此值作为默认值）。
- 修改 `default_keepalive_interval_secs()` 返回 `30`，同步修改前端 `ConnectionDialog.vue` 的 fallback 值为 `30`。
- 用户可以关闭（设为 0）。
- 关闭时提示可能受 VPN/NAT/防火墙 idle timeout 影响。

驱动层建议：

- PostgreSQL/openGauss：默认注入或设置短周期 TCP keepalive。
- MySQL：设置 `tcp_keepalive=30000` 或等价 builder 参数。

keepalive 是预防手段，不能替代超时和清池恢复。

### 7. 增加阶段化日志

每个查询或刷新操作输出阶段日志：

- `ensureConnected`
- `pool.checkout`
- `pool.recycle`
- `ping`
- `schema.set`
- `query.execute`
- `result.fetch`
- `cancel`
- `cleanup`

日志应包含：

- `trace_id`
- `connection_id`
- `database`
- `db_type`
- `pool_key`
- `client_session_id`
- `stage`
- `elapsed_ms`
- `timeout_ms`
- `error`

## 兼容性

### 查询超时

`query_timeout_secs = 0` 继续表示不限制 SQL 执行时间。这一语义在前后端必须保持一致：

- **后端**：`resolve_query_timeout(Some(0))` 返回 `None`，SQL 执行不受 `tokio::time::timeout` 约束。
- **前端**：`withFrontendQueryTimeout` 在 `timeoutSecs === 0` 时直接返回 promise，不施加前端超时。

本 PIP 不得在任何路径中静默将 `query_timeout_secs = 0` 变为有限 SQL 超时。连接检出、健康检查、取消、清理属于基础设施阶段，必须有独立于 `query_timeout_secs` 的硬性上限（见"SQL 执行超时与基础设施超时的边界原则"）。

### MySQL session-scoped pool

MySQL session-scoped pool 用于保留临时表、用户变量等会话状态。清理策略不得在正常连续查询时破坏该行为。只有明确空闲超时、连接失效、用户关闭 tab 或用户强制断开时才清理。

### PostgreSQL search_path

PostgreSQL/openGauss 的 schema 执行上下文行为保持不变，但 `SET search_path` 和 `RESET search_path` 必须纳入超时和错误恢复。

### 清池操作的并发安全

清池操作（`remove_pool_by_key`、`remove_connection_pools_detached`、`close_database_pool`）通过 `RwLock` 保护 `connections` HashMap。需要明确以下并发场景：

#### 1. 清池对在途查询的影响

- **已 checkout 的连接不受影响**：当 `pool.get()` 成功返回 `Object` 后，调用方持有该连接的引用。即使 pool 从 HashMap 中移除，已 checkout 的连接仍可正常使用，直到 `Object` 被 drop 时归还到原 pool（此时原 pool 可能已被关闭，连接被直接丢弃）。
- **新 checkout 请求失败**：pool 从 HashMap 移除后，新的 `pool.get()` 请求将找不到 pool，触发重连流程。
- **结论**：清池操作是安全的，不会中断在途查询，但新请求会触发重连。

#### 2. base pool 与 session-scoped pool 的清理顺序

- `close_database_pool` 先收集所有需要清理的 key（base pool key + session pool keys），然后统一获取写锁批量移除。
- 清理顺序：先停止 keepalive task → 清理 pool_activity → 获取 connections 写锁批量移除 → 关闭移除的 pools。
- **要求**：不允许在持有 `connections` 写锁的同时执行 pool 内部操作（如 `close_pool_kind`），避免死锁。当前代码在 drop 写锁后才调用 `close_pool_kind`，符合此要求。

#### 3. 并发清池的竞态条件

- 多个操作可能同时触发同一 pool 的清理（如超时清理 + 用户手动断开）。`remove_pool_by_key` 通过写锁保证幂等性：第二次调用时 `remove` 返回 `None`，不会重复关闭。
- **要求**：P2 实施时确保所有清池入口都通过 `remove_pool_by_key` 或 `drain_connection_pools` 统一路径，不绕过写锁直接操作 HashMap。

## 分阶段实施

### 阶段 1：止血

目标：避免永久卡死。

范围：

- PostgreSQL/openGauss pool checkout、create、recycle 加 timeout。
- MySQL cancel 加 timeout。
- 前端 `ensureConnected`、`checkConnectionHealth`、`cancelQuery` 加兜底超时。
- 超时后清理 UI 执行状态。

验收：

- 数据库不可达时，查询、取消、刷新都能在可预期时间内返回。

### 阶段 2：自动恢复

目标：空闲失效后可自动重连或明确失败。

范围：

- 统一 checkout helper。
- pool checkout/ping timeout 进入连接错误分类。
- 连接错误后清理对应 pool。
- 添加强制清池和重新连接入口。

#### timeout 错误消息格式与 is_connection_error 匹配

当前 `is_connection_error` 通过 `lower.contains("timed out")` 匹配超时错误，仅排除 `starts_with("query timed out after ")` 格式。需要确保以下各 timeout 场景的错误消息能被正确分类：

| 场景 | 错误来源 | 错误消息格式（lowercase） | 当前是否匹配 | 处理方式 |
|------|----------|---------------------------|--------------|----------|
| DBX query timeout | `tokio::time::timeout` | `"query timed out after {n} seconds"` | 已排除（`is_dbx_query_timeout_error`） | 保持排除，不触发清池 |
| PostgreSQL pool checkout timeout | `deadpool-postgres PoolError::Timeout(TimeoutType::Wait)` | `"pool wait timeout"` | **不匹配**（是 "timeout" 不是 "timed out"） | 需新增匹配 `"pool"` + `"timeout"` 组合，或匹配 deadpool 的 `TimeoutType` 枚举变体 |
| PostgreSQL pool create timeout | `deadpool-postgres PoolError::Timeout(TimeoutType::Create)` | `"pool create timeout"` | **不匹配** | 同上 |
| PostgreSQL pool recycle timeout | `deadpool-postgres PoolError::Timeout(TimeoutType::Recycle)` | `"pool recycle timeout"` | **不匹配** | 同上 |
| checkout helper 超时（`tokio::time::timeout` 包装） | 自定义 `tokio::time::timeout` | `"elapsed"` 或自定义消息 | **不匹配** | checkout helper 应返回包含 `"connection"` 或 `"checkout timed out"` 的错误消息 |
| MySQL ping timeout | 自定义 `tokio::time::timeout` | 自定义消息 | 取决于消息内容 | 确保消息包含 `"connection"` 或 `"timed out"` |
| Agent RPC timeout | Agent 驱动 | `"agent rpc call timed out ..."` | 已排除（`is_agent_rpc_timeout_error`） | 保持排除 |

实施要求：

1. checkout helper 返回的错误消息应包含 `"checkout timed out"` 或 `"connection"` 关键词，确保 `is_connection_error` 能正确匹配。
2. 对于 deadpool 的 `PoolError::Timeout`，应在错误转换层（如 `pg_pool_error_to_string`）统一添加 `"timed out"` 关键词，或在 `is_connection_error` 中新增 `"pool"` + `"timeout"` 组合匹配。
3. P2 实施时需编写单元测试覆盖以上每种 timeout 场景的错误分类。

验收：

- 数据库恢复后，不重启应用即可重新查询。

### 阶段 3：预防

目标：减少空闲失效概率。

范围：

- 默认开启应用层 keepalive。
- PostgreSQL/openGauss 设置短周期 TCP keepalive。
- MySQL 设置 `tcp_keepalive`。
- 对齐 idle timeout 和 driver inactive TTL。

验收：

- 常规 Windows/VPN/NAT 环境下，空闲后连接可用或能自动恢复。

### 阶段 4：可观测性

目标：后续问题可定位。

范围：

- 阶段化日志。
- 连接诊断信息。
- 断链复现脚本和 QA 手册。

验收：

- 用户报告“执行中”时，可以从日志判断卡在具体阶段。

## 测试计划

### 自动化测试

- PostgreSQL/openGauss：pool checkout timeout、query timeout、cancel timeout。
- MySQL：ping timeout、kill query timeout、connection error 分类。
- 前端：执行超时后清理 tab 状态；取消超时后清理 `isCancelling`；连接树刷新失败后清理 loading。

### 手工测试

Windows 环境验证：

1. 建立 PostgreSQL/openGauss/MySQL 连接。
2. 执行 `SELECT 1`。
3. 停止数据库或断开 VPN。
4. 再次执行 `SELECT 1`。
5. 验证 UI 不永久执行中。
6. 恢复数据库或 VPN。
7. 验证无需重启应用即可重连恢复。

取消验证：

- PostgreSQL/openGauss：`SELECT pg_sleep(60)`。
- MySQL：`SELECT SLEEP(60)`。
- 点击取消后，UI 必须在 2 到 5 秒内退出取消中状态。

## 风险

- 过早清理 session-scoped pool 可能破坏会话状态。
- TLS cancel 改造需要复用正确证书配置，不能降低证书校验。
- 默认 keepalive 会增加少量后台请求。
- 部分半开 TCP 场景难以稳定自动化复现。
- 将所有 timeout 都视为连接失效可能误伤慢网络，需要区分 query timeout 与 checkout/ping/cancel timeout。

## 回滚策略

可独立回滚：

- keepalive 默认值。
- 新增 UI 诊断入口。
- 连接参数默认注入策略。

不建议回滚：

- pool checkout timeout。
- cancel timeout。
- UI 状态兜底清理。

这些属于防止应用永久挂起的基础安全边界。

## 验收标准

1. PostgreSQL、openGauss、MySQL 空闲失效后，查询不会永久执行中。
2. 中断操作不会永久取消中。
3. 连接树刷新不会永久加载中。
4. 数据库或网络恢复后，不重启应用即可重新连接。
5. 日志能指出失败阶段。
6. 自动化和手工测试覆盖查询、取消、健康检查、元数据刷新、空闲清理和重连恢复。

## 相关文档

- `docs/pips/plans/2026-06-24-database-connection-timeout-recovery.md`
