# 数据库连接空闲失效恢复方案

## Goal

解决 Windows 环境下数据库连接空闲后再次使用时查询、刷新、取消操作卡死的问题。方案覆盖 PostgreSQL、openGauss、MySQL，并将问题边界从单一驱动缺陷上升到连接生命周期、超时、取消、连接池恢复和前端状态收敛的统一治理。

## Architecture

DBX 桌面端的相关链路由三层组成：

1. 前端 Vue/Pinia 状态层：负责 `ensureConnected`、查询发起、取消、连接树刷新、执行中状态展示。
2. Tauri 命令层：负责把前端请求转发到 Rust core，并注册运行中的查询。
3. Rust core 数据库层：负责连接配置、连接池、健康检查、keepalive、查询执行、取消和清池。

问题发生在跨层边界：底层数据库连接或 TCP 会话已经失效，但前端仍显示连接有效，后端仍复用旧连接池。再次查询时，任务可能卡在连接池检出、连接验证、健康检查、schema 设置、SQL 执行、结果读取或取消请求中。

## Tech Stack

- Desktop: Tauri + Vue + Pinia
- Backend: Rust async/Tokio
- PostgreSQL/openGauss: `deadpool-postgres` + `tokio-postgres-gaussdb`
- MySQL: `mysql_async`
- Query state: `apps/desktop/src/stores/queryStore.ts`
- Connection state: `apps/desktop/src/stores/connectionStore.ts`
- Core owners:
  - `crates/dbx-core/src/connection.rs`
  - `crates/dbx-core/src/query.rs`
  - `crates/dbx-core/src/db/postgres.rs`
  - `crates/dbx-core/src/db/mysql.rs`
  - `src-tauri/src/commands/query.rs`
  - `src-tauri/src/commands/connection.rs`

## Baseline/Authority Refs

本方案基于以下已核对的代码事实：

- PostgreSQL/openGauss 走 `PoolKind::Postgres`：`crates/dbx-core/src/connection.rs`
- MySQL 走 `PoolKind::Mysql`，且已有 `get_conn_with_health_check`：`crates/dbx-core/src/db/mysql.rs`
- 前端查询前会执行 `ensureConnected`，查询 Promise 的前端超时只覆盖 `api.executeMulti`：`apps/desktop/src/stores/queryStore.ts`
- `keepalive_interval_secs` 在前端规范化时默认为 `0`，应用层 keepalive 默认关闭：`apps/desktop/src/stores/connectionStore.ts`
- `deadpool-postgres` 当前配置了 `RecyclingMethod::Verified` 和 `wait_timeout`，但没有显式配置 create/recycle timeout。
- PostgreSQL `CancelToken` 会根据 token 内部 SSL mode 建立取消连接；当前项目调用 `cancel_query(NoTls)`，TLS 连接取消存在高风险。

## Compatibility Boundary

改动必须保持以下兼容性：

- 不改变连接配置的序列化结构，除非提供默认值和迁移兼容。
- 不破坏 MySQL session-scoped pool 保留临时表、用户变量等会话状态的行为。
- PostgreSQL/openGauss 的 schema/search_path 行为保持不变。
- 查询超时为 `0` 时仍表示禁用用户 SQL 查询超时，但连接检出、健康检查、取消、清理操作仍必须有安全上限，避免进程内任务永久挂起。
- 取消和超时可以结束客户端等待，但不能假装服务端一定已经停止 SQL；UI 文案必须区分“已发送取消请求”和“客户端已停止等待并标记连接失效”。

## Verification

验收必须覆盖：

- PostgreSQL、openGauss、MySQL 空闲后首次查询：在配置超时时间内成功或返回明确错误。
- 长查询取消：`pg_sleep`、`SLEEP` 类查询在 2 到 5 秒内退出前端执行中状态。
- 断网、VPN 断开、数据库重启：不需要重启 DBX 即可通过重连恢复。
- 连接树刷新：后端不可达时不会持续转圈。
- 任务泄漏：重复触发超时/取消后，运行中查询记录和连接池数量不会持续增长。

## 原报告合理性评估

用户提供的 `连接问题报告.txt` 方向基本合理：问题不是某一种数据库的 SQL 或驱动语法错误，而是连接生命周期管理缺陷。报告将影响范围扩展到 PostgreSQL、openGauss、MySQL 是正确的。

但报告中有几处需要修正，避免形成错误实现方向：

| 报告原判断 | 评估 | 修正后表述 |
| --- | --- | --- |
| PostgreSQL/openGauss `pool.get()` 无超时保护 | 基本成立，但不完整 | 项目只显式设置 deadpool `wait_timeout`；连接 create/recycle 验证没有在项目层统一纳入查询超时和取消边界。 |
| `RecyclingMethod::Verified` 发送 `SELECT 1` | 不准确 | deadpool Verified 执行验证 query；项目自己的 stale check 和 keepalive 使用 `SELECT 1`。 |
| PostgreSQL TLS 连接取消一定失败 | 方向成立但需复现确认 | 当前调用 `cancel_query(NoTls)`，TLS 连接取消存在高风险，应改为使用与原连接一致的 TLS connector。 |
| 应用层 keepalive 无超时 | 不准确 | `start_keepalive_task` 外层已有 `tokio::time::timeout`；主要问题是默认关闭、覆盖面不足、健康检查和执行链路超时边界不统一。 |
| MySQL 取连接失败会跳过外层重连逻辑 | 单条查询场景不准确 | `do_execute` 返回错误后，外层仍会进入 `pool_error_action`；但 MySQL 仍存在取消无超时、部分元数据路径直接取连接、session pool 恢复不完整等问题。 |
| 未配置 TCP keepalive | 需要细化 | PostgreSQL 驱动默认启用 TCP keepalive，但默认 idle 约 2 小时，不适合桌面/VPN/NAT 场景；MySQL 当前未显式设置 `tcp_keepalive`。 |

## 修正版问题报告

### 问题描述

在 Windows 电脑上，用户连接 PostgreSQL、openGauss、MySQL 后，如果一段时间不操作，再次执行 SQL 或刷新连接树时可能出现：

- 查询结果区域一直显示执行中。
- 中断按钮无法结束任务。
- 连接树刷新持续转圈。
- 断开、刷新后仍无法恢复。
- 退出并重新打开应用后恢复。

### 根因判断

根因不是单一数据库驱动缺陷，而是跨数据库的连接生命周期恢复策略不完整。

当连接空闲后，数据库服务端、VPN、防火墙、NAT、代理、Windows 睡眠或网络切换都可能让底层 TCP/数据库会话失效。客户端连接池仍保存旧连接，前端也仍认为连接有效。下一次操作触发旧连接复用时，任务可能卡在以下任一阶段：

- 前端 `ensureConnected`
- 后端 `checkConnectionHealth`
- pool checkout
- pool recycle/verify
- 新建连接
- MySQL ping
- PostgreSQL `SET search_path`
- SQL 执行
- 结果流读取
- PostgreSQL cancel request
- MySQL `KILL QUERY`
- 连接树元数据加载

当前系统缺少一个覆盖以上阶段的统一执行预算和恢复机制，因此会出现“查询超时设置存在，但 UI 仍卡住”、“取消按钮可点，但无法停止底层任务”、“刷新连接树也恢复不了”的现象。

### PostgreSQL/openGauss 关键风险

PostgreSQL 和 openGauss 共用 `PoolKind::Postgres` 路径，因此同一类问题会同时影响两者。

主要风险：

- `execute_query_with_max_rows_and_cancel` 先 `pool.get()`，之后才进入 `wait_postgres_query`。如果卡在 pool checkout 或 recycle 阶段，用户查询超时和 cancel token 覆盖不到。
- `execute_query_with_schema_and_max_rows_and_cancel` 中 `SET search_path` 和 `RESET search_path` 不在同一个统一可取消预算内。
- `deadpool-postgres` 只配置 `wait_timeout`，应补齐 `create` 和 `recycle` timeout。
- PostgreSQL cancel 当前传入 `NoTls`，TLS 连接取消存在失败风险。
- TCP keepalive 默认周期过长，不能满足桌面网络环境下快速发现半开连接的需求。

### MySQL 关键风险

MySQL 已有 `get_conn_with_health_check`，会对取出的连接做 ping，并在失败后尝试重新取连接。这是有价值的局部修复，但仍不足以覆盖整体问题。

主要风险：

- 单条查询路径中取连接和 ping 发生在 SQL 查询超时包装之前，虽然内部有 5 秒超时，但没有统一纳入任务阶段和 UI 取消模型。
- `kill_query_with_opts` 新建连接和执行 `KILL QUERY` 没有显式 timeout。
- MySQL pool `inactive_connection_ttl` 固定为 300 秒，可能大于企业网络设备或数据库 `wait_timeout`。
- `tcp_keepalive` 未显式设置，依赖系统默认行为。
- 元数据、导出、事务等路径中仍存在直接 `pool.get_conn()` 或连接操作，需要统一审计。

### 前端状态风险

前端 `executeTabSql` 的主要执行状态由 Tauri command 的 resolve/reject 驱动。若后端任务卡在不可取消阶段，前端会持续等待。虽然局部有 `withFrontendQueryTimeout`，但它不覆盖 `ensureConnected` 和所有元数据刷新路径，也不能停止后端任务。

结果是：

- UI 可恢复和后端真实任务停止不是同一件事。
- 前端可能显示错误或超时，但后端旧任务仍持有连接池引用。
- 后续刷新和查询继续撞到旧池或旧任务状态。

## 改进方案

### P0-1：建立统一数据库操作执行预算

新增一个后端执行预算模型，覆盖连接获取、健康检查、SQL 执行、取消和清理。

建议在 `crates/dbx-core/src/query.rs` 或新模块中定义：

```rust
pub struct DbOperationBudget {
    pub checkout_timeout: Duration,
    pub connect_timeout: Duration,
    pub recycle_timeout: Duration,
    pub query_timeout: Option<Duration>,
    pub cleanup_timeout: Duration,
    pub cancel_timeout: Duration,
}
```

默认策略：

- checkout/connect/recycle：使用连接配置的 `connect_timeout_secs`，下限 1 秒，上限 300 秒。
- query：使用 `query_timeout_secs`；`0` 表示不限制 SQL 执行。
- cleanup/cancel：固定 2 到 5 秒，不允许禁用。

验收：

- 即使用户设置 query timeout 为 0，pool checkout、健康检查和取消操作也不会永久挂起。

### P0-2：补齐 PostgreSQL deadpool timeout

在 `crates/dbx-core/src/db/postgres.rs` 创建 pool 时，显式配置 deadpool 的 `wait/create/recycle` timeout。

当前风险代码形态：

```rust
let pool = Pool::builder(mgr)
    .max_size(10)
    .runtime(Runtime::Tokio1)
    .wait_timeout(Some(timeout))
    .build()?;
```

目标：

- `wait_timeout = timeout`
- `create_timeout = timeout`
- `recycle_timeout = timeout`

同时，项目层仍应对 `pool.get()` 包一层明确 timeout，并将错误归类为连接错误或 pool stale。

验收：

- PostgreSQL/openGauss 空闲断链后，`pool.get()` 在 timeout 内返回错误并触发清池或重连。

### P0-3：统一 pool checkout helper

新增或抽象以下 helper，避免各处散落 `pool.get()`、`pool.get_conn()`：

- `checkout_postgres_client(pool, budget)`
- `checkout_mysql_conn(pool, budget)`
- `run_with_connection_recovery(state, pool_key, operation)`

要求：

- 支持 cancel token。
- 支持 timeout。
- 错误统一进入 `pool_error_action`。
- timeout 后标记 pool stale 或直接 remove。

受影响文件：

- `crates/dbx-core/src/db/postgres.rs`
- `crates/dbx-core/src/db/mysql.rs`
- `crates/dbx-core/src/query.rs`
- `crates/dbx-core/src/connection.rs`

验收：

- grep 不应再出现关键执行路径中未包装的 `pool.get().await` 和 `pool.get_conn().await`。

### P0-4：修复取消路径

PostgreSQL：

- 将 `cancel_postgres_query` 改为接收或重建正确 TLS connector。
- 对 cancel request 保持 2 秒 timeout。
- cancel 失败时，将当前连接池标记为可疑，必要时清理 session-scoped pool。

MySQL：

- `kill_query_with_opts` 中 `Conn::new(opts)` 添加 timeout。
- `query_drop("KILL QUERY ...")` 添加 timeout。
- kill 失败不应阻塞前端取消状态收敛。

前端：

- cancel 请求超时后，前端必须退出 `isCancelling`。
- 如果后端确认无法取消，应显示“已停止等待，连接可能已失效”，并提供重新连接入口。

验收：

- `SELECT pg_sleep(60)` 和 `SELECT SLEEP(60)` 取消后，UI 2 到 5 秒内退出执行中状态。

### P0-5：前端状态必须有兜底恢复

改造 `apps/desktop/src/stores/queryStore.ts`：

- `ensureConnected` 阶段加入前端超时。
- `api.executeMulti` 超时后，主动调用 cancel。
- cancel 超时后，清理当前 tab 的 `isExecuting`、`isCancelling`、`executionId`。
- 对连接错误调用 `markConnectionLost`，同时清理连接树 loading 状态。

改造 `apps/desktop/src/stores/connectionStore.ts`：

- `checkConnectionHealth` 加前端超时。
- 刷新连接树失败后必须清理 node loading。
- 增加“强制重连/清理连接池”动作，调用后端清池命令。

验收：

- 任意失败路径都不能让 tab 永久处于执行中。
- 任意刷新失败都不能让连接节点永久转圈。

### P1-1：调整 keepalive 默认策略

建议默认开启应用层 keepalive：

- `keepalive_interval_secs = 30`
- UI 中允许用户关闭，但关闭时提示可能受 VPN/NAT/防火墙 idle timeout 影响。

PostgreSQL/openGauss：

- 如果用户未在 URL 参数中指定 keepalive，默认注入：
  - `keepalives=1`
  - `keepalives_idle=30`
  - `keepalives_interval=10`
  - `keepalives_retries=3`

MySQL：

- 如果用户未指定 `tcp_keepalive`，默认使用 `tcp_keepalive=30000` 或 builder 设置。

注意：

- TCP keepalive 是预防手段，不是唯一恢复机制。
- 企业网络 idle timeout 可能短于 30 秒，仍需要应用层超时和清池。

验收：

- 新建 PostgreSQL/openGauss/MySQL 连接默认具备短周期 keepalive。
- 老连接读取时通过 normalize 补默认值，但不覆盖用户显式配置。

### P1-2：统一 idle timeout 语义

当前语义混杂：

- `idle_timeout_secs` 主要用于 session-scoped pool 清理。
- MySQL driver pool 有 `inactive_connection_ttl=300s`。
- PostgreSQL pool 没有等价空闲 TTL。

建议拆分语义：

- `client_session_idle_timeout_secs`：清理 tab/session scoped pool。
- `pool_inactive_connection_ttl_secs`：驱动池空闲连接最大保留时间。
- `keepalive_interval_secs`：应用层 ping 间隔。

若暂不改配置结构，则先将 MySQL `inactive_connection_ttl` 与 `idle_timeout_secs` 对齐，并为 PostgreSQL 使用应用层 keepalive 和 session pool cleanup 弥补。

验收：

- session-scoped pool 空闲后按配置被清理。
- base pool 不因短 idle timeout 破坏正常连接复用。

### P1-3：统一连接错误分类

当前 `is_connection_error` 覆盖较宽，包含 `timed out` 等词，需保留同时避免误判普通 SQL 超时。

改进：

- 保留 `Query timed out after ...` 不作为连接错误的特殊规则。
- 将 pool checkout timeout、ping timeout、cancel connect timeout 归类为连接/池错误。
- 将 SQL 执行 timeout 归类为 query timeout，并按数据库类型决定是否清池。

验收：

- 单纯慢 SQL 超时不会被错误提示为配置错误。
- 半开连接导致的 checkout/ping/cancel timeout 会触发清池或重连。

### P2-1：增加阶段化日志

每个 query execution id 输出阶段日志：

- `ensureConnected:start/done/error`
- `pool.checkout:start/done/error`
- `pool.recycle:start/done/error`
- `ping:start/done/error`
- `schema.set:start/done/error`
- `query:start/done/error`
- `cancel:start/done/error`
- `cleanup:start/done/error`

日志字段：

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

验收：

- 用户报告卡住时，可以从日志判断卡在前端、Tauri 命令、pool checkout、SQL 执行还是 cancel。

### P2-2：增加强制诊断和恢复入口

UI 增加连接级操作：

- 检查连接健康
- 强制断开并清理连接池
- 重新连接
- 复制诊断信息

诊断信息包括：

- 连接类型
- 当前连接状态
- 活跃查询数量
- pool key 列表
- 最近一次健康检查结果
- 最近一次错误

验收：

- 用户不需要重启应用即可清理旧连接池并重新连接。

## 推荐实施顺序

### 阶段 1：止血

目标：不再永久卡死。

任务：

1. PostgreSQL pool get/create/recycle 加 timeout。
2. MySQL kill query 加 timeout。
3. 前端 `ensureConnected` 和 `checkConnectionHealth` 加超时。
4. cancel 超时后强制恢复 UI 状态。
5. timeout/连接错误后清理对应 pool。

验收：

- 三类数据库无法访问时，查询和刷新都能在可预期时间内结束。

### 阶段 2：恢复

目标：空闲断链后自动重连或明确失败。

任务：

1. 统一 checkout helper。
2. pool checkout/ping 错误进入 `pool_error_action`。
3. session-scoped pool 清理覆盖查询、count、explain、export。
4. 新增强制重连/清池入口。

验收：

- 数据库恢复后，不重启应用即可重新查询。

### 阶段 3：预防

目标：减少空闲断链发生概率。

任务：

1. 默认开启应用层 keepalive。
2. 设置 PostgreSQL/openGauss TCP keepalive 参数。
3. 设置 MySQL `tcp_keepalive`。
4. 对齐 idle timeout 与 inactive TTL。

验收：

- 空闲 5 到 30 分钟后，常规网络环境下连接仍可用或能自动重连。

### 阶段 4：可观测性

目标：后续问题能快速定位。

任务：

1. 阶段化日志。
2. 连接诊断面板。
3. 测试环境断链脚本。

验收：

- QA 可以稳定复现并判断卡点阶段。

## 测试方案

### 单元测试

建议新增或扩展：

- `crates/dbx-core/src/query.rs`
  - `pool_error_action` 对 checkout timeout、ping timeout、query timeout 的分类。
  - cancel token 在 checkout 前取消时应返回 canceled。
- `crates/dbx-core/src/db/mysql.rs`
  - `kill_query_with_opts` timeout 分支。
- `apps/desktop/src/stores/queryStore.ts`
  - 前端 query timeout 后清理 `isExecuting`。
  - cancel timeout 后清理 `isCancelling`。
- `apps/desktop/src/stores/connectionStore.ts`
  - `ensureConnected` health check timeout 后清理连接状态。

### 集成测试

PostgreSQL/openGauss：

1. 创建连接。
2. 执行 `SELECT 1`。
3. 断开网络或停止数据库。
4. 执行 `SELECT 1`。
5. 断言超时内返回错误，UI 不保持执行中。
6. 恢复数据库。
7. 再次执行 `SELECT 1`，断言可恢复。

MySQL：

1. 创建连接。
2. 设置测试库 `wait_timeout=5` 或使用测试容器配置。
3. 空闲超过 10 秒。
4. 执行 `SELECT 1`。
5. 断言成功重连或明确失败。
6. 执行 `SELECT SLEEP(60)` 并取消，断言 2 到 5 秒内 UI 恢复。

前端：

1. mock `api.checkConnectionHealth` 永不 resolve。
2. 调用 `ensureConnected`。
3. 断言超时后连接错误被记录，loading 状态被清理。
4. mock `api.executeMulti` 永不 resolve。
5. 调用 `executeTabSql`。
6. 断言前端超时后 tab 状态恢复。

### 手工验证

Windows 场景：

- Wi-Fi 断开/恢复。
- VPN 断开/恢复。
- 系统睡眠 5 分钟后恢复。
- 数据库容器停止/启动。
- 防火墙阻断数据库端口。

每个场景验证：

- 查询不会永久执行中。
- 中断不会永久取消中。
- 连接树不会永久加载中。
- 重新连接后可恢复。
- 不需要退出 DBX。

## Rollback

若改动引入新问题：

- 可回退 keepalive 默认值到 0，但保留超时和 UI 状态恢复。
- 可先只对 PostgreSQL/openGauss 启用 deadpool create/recycle timeout。
- 可通过配置开关控制新的强制清池策略。

不建议回退：

- cancel timeout。
- 前端状态兜底清理。
- pool checkout timeout。

这些属于防永久挂起的基础安全边界。

## Risks

- 对 session-scoped pool 清理过早可能破坏 MySQL 临时表、用户变量、PostgreSQL session state。
- PostgreSQL TLS cancel connector 改造需要注意证书配置复用，避免取消连接绕过证书校验。
- 将 SQL timeout 后统一清池可能影响长查询用户；需要保留 `query_timeout_secs=0` 的语义。
- keepalive 默认开启会增加少量后台请求；应允许用户关闭。
- 部分网络半开场景难以稳定自动化复现，需要手工和脚本结合。

## Retirement

需要逐步减少以下旧模式：

- 在各驱动和业务路径中直接调用 `pool.get().await`、`pool.get_conn().await`。
- 前端只依赖 Tauri command resolve/reject 恢复执行状态。
- cancel 仅处理 SQL 已执行阶段，不处理连接获取和健康检查阶段。
- keepalive 默认关闭且不提示风险。
- 错误分类分散在前端和后端，缺少统一连接恢复语义。

保留但收敛：

- MySQL `get_conn_with_health_check` 可保留，但应纳入统一 checkout helper。
- PostgreSQL `RecyclingMethod::Verified` 可保留，但必须有 recycle timeout。
- 前端 `withFrontendQueryTimeout` 可保留，但只能作为 UI 兜底，不应替代后端执行预算。

## 最终验收标准

1. PostgreSQL、openGauss、MySQL 三类数据库空闲失效后，查询不会永久执行中。
2. 用户点击中断后，UI 在 2 到 5 秒内退出取消中状态。
3. 连接树刷新失败后不会永久转圈。
4. 数据库或网络恢复后，不重启 DBX 即可重新连接并查询。
5. 日志能明确指出失败阶段。
6. 回归测试覆盖查询、取消、健康检查、元数据刷新、空闲清理和清池恢复。
