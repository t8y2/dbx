# ADR: Scheduler / Task Center 公共契约（冻结版）

- 状态：Accepted（Wave 1 契约冻结，A0 撰写）
- 日期：2026-10-05
- 决策人：Agent 0（架构契约 Owner）
- 规格来源：[docs/scheduler/implementation-plan.md](../scheduler/implementation-plan.md)（§ 编号引用均指该文件）
- 配套提示词：[docs/scheduler/agent-prompts.md](../scheduler/agent-prompts.md)
- 适用范围：统一 Scheduler / Task Center / Task Runtime（Database Backup、SSH Task、Files Task 及未来插件任务）

---

## 0. 本 ADR 的地位与冲突规则

1. 本 ADR 把 implementation-plan.md §0–§83、§106–§111 中的**公共契约**正式冻结。后续 Agent（A1–A10）只读本 ADR + implementation-plan.md 即可开工，**不得**在各自 worktree 中重新定义或改写契约。
2. 冲突裁决顺序：**本 ADR > implementation-plan.md > agent-prompts.md > 各 Agent 自行判断**。本 ADR 与 plan 有出入之处全部集中在 [§14 偏差记录](#14-与-implementation-plan的偏差记录)，均已给出理由。
3. Wave 1（A0/A1/A2）合并后，`TaskDefinition / TaskRun / TaskTrigger / TaskExecutionPolicy / TaskRunStatus / ResidentSession / task-provider contribution / task/* RPC / scheduler/* API` 进入冻结状态；任何修改必须经 Agent 0 审核并修订本 ADR。
4. 本 ADR 只定契约，不定实现细节。凡标注“实现自由度”的条目，Agent 可按仓库风格自行实现。

---

## 1. 总则（不可违反的架构不变量）

1. **只有一个 Scheduler。** `Scheduler != business executor`：Scheduler 负责 when / where / how many times / timeout / retry / cancel / log / persistence / process lifetime；Provider 负责 what to do。
2. **依赖方向严格单向**（见 `crates/ARCHITECTURE.md`）：
   `dbx-plugin-runtime ← dbx-core ← src-tauri / dbx-web`。
   `dbx-plugin-runtime` **不得**依赖 `dbx-core`（含 dev 依赖）。Scheduler 对插件的适配放在 `dbx-core/src/scheduler/providers/plugin.rs`。
3. **Backup 是 Builtin Provider**（`dbx.database-backup`），不重写 export 算法；SSH / Files 是 Plugin Task Provider。
4. **UI 不拥有任务生命周期**；Background Worker 才是执行宿主。UI 关闭不得停止 enabled 任务。
5. **每个执行实例都有 run id；所有日志 / artifact / 事件都归属 run id。**
6. **Secret 永不进入** task config、payload、log、event、artifact metadata、export、数据库（详见 §10）。
7. **Plugin 不直接读写 scheduler SQLite**；所有 API 只调用 `SchedulerService`，绝不直接操作 SQLite。
8. **Scheduler 不知道 SSH / Files / Backup 业务字段**——核心代码中不得出现 `if provider_id == "io.dbx.ssh.tasks"` 之类的条件分支。
9. **Manifest 声明能力，Runtime 强制能力**；插件执行只走固定 `task/*` RPC，不得出现任意 RPC。
10. 所有长期 / 常驻任务必须可恢复（recovery），不允许出现永久卡死的 run。
11. 时间存储一律 **UTC RFC3339 字符串**（沿用 `chrono::DateTime<Utc>::to_rfc3339()` 的仓库现状）；展示时用任务自己的 IANA `timeZone`。内部计算一律 UTC。
12. serde 约定：结构体字段 `#[serde(rename_all = "camelCase")]`；枚举值除特别注明外 `kebab-case`；`TaskRunStatus` 用 `lowercase`；`TaskTrigger` 用 `#[serde(tag = "type", rename_all = "camelCase")]`。SQLite 中的状态字符串与 serde 序列化值完全一致。

---

## 2. Domain Model（冻结类型）

### 2.1 TaskDefinition

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub id: String,                        // 默认 uuid v4 simple（沿用 BackupStore 现状）
    pub name: String,
    pub provider_type: TaskProviderType,   // "builtin" | "plugin"
    pub provider_id: String,               // 带命名空间，见 §2.2
    pub target: TaskTarget,
    pub trigger: TaskTrigger,
    pub execution: TaskExecutionPolicy,
    pub config_version: u32,               // 见 §14 偏差 D2；schema 迁移用，第一版恒为 1
    pub config: serde_json::Value,         // provider 不透明配置（不含 configVersion 键）
    pub enabled: bool,
    pub created_at: String,                // RFC3339 UTC
    pub updated_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_run_status: Option<TaskRunStatus>,
    pub version: i64,                      // optimistic locking，保存必须校验
}
```

- **逻辑 identity**（UI 默认命名用）：`provider_id + trigger_id + connection_id`，例如「SSH Execute · prod-web-01」。trigger_id 形如 `io.dbx.ssh.tasks/execute`。
- **update 语义**：带 `version` 的 CAS。客户端提交的 `version` 与存储不一致 → `version_conflict`（HTTP 409）。`next_run_at / last_run_at / last_run_status` 只由 Scheduler 写，API 层不接受客户端直接覆盖。
- **config_version 是 TaskDefinition 一等字段并单独成列**，`config` JSON 里**不得**再嵌 `configVersion` 键（plan §70/§106 的内嵌写法被本 ADR 取代，见 §14 D2）。

### 2.2 TaskProviderType 与 provider id 命名

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskProviderType { Builtin, Plugin }   // "builtin" | "plugin"
```

Provider ID 必须稳定且带命名空间（反向域名风格）：`dbx.database-backup`、`io.dbx.ssh.tasks`、`io.dbx.files.tasks`。**禁止**裸 `ssh` / `files` / `backup`。Trigger ID = `<provider id>/<trigger id>`，如 `io.dbx.files.tasks/sync`。

### 2.3 TaskTarget

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTarget {
    pub connection_id: Option<String>,
    pub plugin_id: Option<String>,
    pub resource_id: Option<String>,
}
```

第一版主要使用 `connection_id`；`plugin_id` 由 host 从 provider 推导时可自动填充；`resource_id` 预留（workspace / cluster）。

### 2.4 TaskTrigger

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TaskTrigger {
    Manual,
    Once { at: String, time_zone: String },        // at: RFC3339 或 "YYYY-MM-DDTHH:mm" 本地时间 + IANA tz
    Interval { seconds: u64 },                     // seconds >= 1
    Cron { expression: String, time_zone: String },// 标准 5-field cron + IANA tz
    Startup,
}
```

冻结语义：

| 类型 | 语义 |
|---|---|
| `manual` | 只能被手动 / API 触发，不参与 `enqueue_due` |
| `once` | 到 `at`（按 `time_zone` 解释）触发一次；入队后清除 `next_run_at`，任务保留、不自动删除、不自动 disable；可再次手动执行 |
| `interval` | 距上次 fire `seconds` 间隔，按 UTC 计算 |
| `cron` | 标准 5-field（`minute hour day-of-month month day-of-week`），第一版**不支持**秒域；`time_zone` 必须是 IANA 名称（`chrono_tz::Tz` 可解析），计算入口 `trigger.next_after(last_fire) -> DateTime<Utc>` |
| `startup` | worker 每次（重）启动时对 enabled 任务触发一次 |

- **DST 语义（冻结，沿用 `scheduled_backup/models.rs::BackupSchedule::next_after` 现状）**：歧义本地时间（fall back）取**第一次出现**；不存在本地时间（spring forward）取 gap 后**第一个有效时刻**。必须用 `Asia/Shanghai`、`America/Los_Angeles`、`UTC` 三时区 + spring forward / fall back 用例测试。
- **禁止**：timezone 放 UI 本地状态、用本地 `Date.setHours()` 推算 cron、丢失 timezone 后由 UI 反推。
- Cron 解析库由 A1 在 `dbx-core` 内引入（workspace 现无 cron 依赖，允许新增），但解析结果必须满足上述 5-field + IANA + DST 语义，供 `dbx-core` 独占使用，不进 `dbx-plugin-runtime`。

### 2.5 TaskExecutionPolicy

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionPolicy {
    pub mode: TaskExecutionMode,                 // "run" | "resident"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub concurrency: TaskConcurrencyPolicy,
    #[serde(default)]
    pub retry: TaskRetryPolicy,
    #[serde(default)]
    pub misfire: TaskMisfirePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<TaskRestartPolicy>,      // 仅 mode = resident 时有效
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskExecutionMode { Run, Resident }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskConcurrencyPolicy { Forbid, Queue, Replace, Parallel }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRetryPolicy {
    #[serde(default = "default_max_attempts")]         // 1 = 不重试
    pub max_attempts: u32,
    #[serde(default)]
    pub backoff_seconds: u64,
    #[serde(default)]
    pub backoff_strategy: TaskBackoffStrategy,          // "fixed" | "exponential"
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskBackoffStrategy { Fixed, Exponential }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskMisfirePolicy { Coalesce, FireOnce, Skip }  // "coalesce" | "fire-once" | "skip"（见 §14 D3）

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRestartPolicy {
    pub enabled: bool,
    #[serde(default = "default_max_restarts")]
    pub max_restarts: u32,                              // 上限内 restart；超限 → degraded
    #[serde(default = "default_restart_backoff")]
    pub backoff_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_window_seconds: Option<u64>,            // 窗口内计数；None = 进程生命周期
}
```

冻结语义与默认值：

- **timeout**：作用于 run 模式整次执行、resident 模式的 `start` 阶段；resident 运行期不受 `timeout_seconds` 约束（由 restart policy 管理）。超时链路必须完整：timeout → `CancellationToken` 取消 → executor 真正停止（resident 走 stop）→ cleanup → run 标记 `timeout`。**禁止**只改 DB 状态而放任后台执行继续。
- **concurrency 默认值**：run 模式 = `Forbid`；resident = `Replace`（每个 TaskDefinition 最多 1 个 active session，新 start 替换旧 session）。`Queue` 排队等待前序结束；`Parallel` 允许并发 run。
- **misfire 默认 `coalesce`**：离线期间错过的 N 次触发合并为 1 次；`fire-once` 同样只补 1 次但按最后一次预定时间入队（与 coalesce 的差别仅在 run 记录的 trigger 快照）；`skip` 直接放弃并写一条 `skipped` 状态的 run 记录（可追溯）。
- **restart 必须有界**：`max_restarts` 内按 `backoff_seconds` 重启；窗口内到达上限 → session 进入 `degraded`，**禁止**无限 crash loop。

### 2.6 TaskRun / TaskRunStatus / TaskRunTrigger

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRunStatus { Queued, Starting, Running, Success, Failed, Cancelled, Timeout, Skipped }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRunTrigger { Manual, Scheduled, Startup, Retry, Restart }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,                    // uuid v4 simple
    pub task_id: String,
    pub status: TaskRunStatus,
    pub trigger: TaskRunTrigger,
    pub attempt: u32,                  // 从 1 开始
    pub worker_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub exit_code: Option<i32>,
    pub error_code: Option<String>,    // 机器码，见 §8.4
    pub error_message: Option<String>,
    pub progress_percent: Option<f64>, // 0.0–100.0
    pub artifacts_count: u32,
    pub created_at: String,
}
```

**Run 状态机（冻结）**：

```
Queued → Starting → Running → { Success | Failed | Cancelled | Timeout }
Queued → Cancelled            （取消排队中的 run）
Queued/Running → Skipped      （仅 misfire = skip / queue 策略裁决时，由 Scheduler 写）
Failed/Timeout → (retry) → 新 TaskRun（attempt + 1，trigger = "retry"）
任意运行态 →（recovery，见 §5.4）
```

- 重试**新建 TaskRun**（不复用旧 run 行），`attempt` 递增，方便审计与日志隔离。
- **Retry 分类（冻结）**：不自动重试 —— invalid config、missing provider、missing connection、permission denied、explicit cancel；可重试 —— network、connection reset、temporary timeout、transient、plugin unavailable。分类由 `TaskError`（§6.3）承载。
- run 的 `payload_json`（DB 列）存触发时快照（trigger、解析后的 target 等），**不得含 secret**（§10）。
- Cancel 语义与现有 `BackupStore::cancel` 一致：queued → 直接置 cancelled；running → 置取消标记 + 触发 cancellation token，executor 真正停止后落 `cancelled`。

### 2.7 ResidentSession 状态机（冻结）

状态：`stopped / starting / running / stopping / crashed / degraded`（小写字符串存储）。

```
(start) → starting → running → stopping → stopped
running → crashed → (restart policy 允许) → starting（attempt+1）
running → crashed → (超 max_restarts) → degraded
degraded → (手动 start / restart) → starting
任意态 → stopped（显式 stop / 删除任务）
```

- 每个 TaskDefinition 同时最多 1 个 active session。
- Session 持久化在 `task_runtime_sessions`，含 `heartbeat_at / restart_count`；心跳超时由 Supervisor 判定 → `crashed` → 按 restart policy 处理。
- Recovery 时 resident 走 reconcile（`task/status` 探测），**不**直接置 failed（与 run 模式不同，见 §5.4）。

### 2.8 Task Health

`healthy / warning / invalid / unavailable`（小写）：

| Health | 条件 |
|---|---|
| `healthy` | provider 存在、trigger 可解析、connection 存在 |
| `warning` | connection 缺失/不可用（任务保留，提示重连） |
| `invalid` | 插件升级后 trigger 不存在、trigger 无法解析、config 校验失败 |
| `unavailable` | provider 插件被卸载/未安装 |

任务在任何非 healthy 状态下**不得自动删除**；`invalid / unavailable` 任务不参与 `enqueue_due`。

---

## 3. SchedulerStore 职责边界（冻结）

### 3.1 职责

`SchedulerStore` **只负责持久化与原子状态转移，不执行任何插件、不调用任何 provider**。方法清单（签名细节 A1 按仓库风格定，方法集不得缩水）：

```
list_tasks / get_task / save_task(CAS version) / delete_task
enqueue_manual / enqueue_due / claim / update_run / finish_run
append_log / list_logs / save_artifact / list_artifacts
recover / acquire_lease / heartbeat_lease / release_lease
append_audit
```

- 数据库文件：`<data-dir>/scheduler/state.db`。**不得**继续写 `database-backups/state.db`。
- SQLite 访问模式沿用 `BackupStore::access` 现状：`spawn_blocking` + 每次打开连接 + `busy_timeout` + `PRAGMA journal_mode=WAL`。
- 所有状态转移事务使用 `TransactionBehavior::Immediate`（BEGIN IMMEDIATE）。

### 3.2 七张表 Schema（冻结；DDL 可加 `IF NOT EXISTS` / 索引，不得改列语义）

```sql
CREATE TABLE IF NOT EXISTS task_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,     -- §14 D2
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_status TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_task_definitions_next_run ON task_definitions(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- §2.6 小写
  trigger_type TEXT NOT NULL,       -- §2.6 小写
  attempt INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  exit_code INTEGER,
  error_code TEXT,
  error_message TEXT,
  progress_percent REAL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES task_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_active ON task_runs(status);

CREATE TABLE IF NOT EXISTS task_runtime_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  session_id TEXT NOT NULL,         -- plugin 侧 session id（task/start 返回）
  state TEXT NOT NULL,              -- §2.7 小写
  heartbeat_at TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,                -- 文件 URI / 路径；大文件本体绝不进 SQLite
  content_type TEXT,
  size INTEGER,
  checksum TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_run ON task_artifacts(run_id);

CREATE TABLE IF NOT EXISTS task_log_index (
  run_id TEXT NOT NULL,
  segment INTEGER NOT NULL,         -- 1 起始；日志按大小 rotation（建议 32MB）→ 每 run 多段（§14 D4）
  path TEXT NOT NULL,               -- scheduler/logs/YYYY/MM/DD/<run-id>/000001.log
  byte_size INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, segment)
);

CREATE TABLE IF NOT EXISTS task_audit (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  action TEXT NOT NULL,             -- create/update/delete/run/cancel/enable/disable/resident_start/resident_stop/resident_restart
  actor_type TEXT NOT NULL,         -- user | system | worker | plugin
  actor_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name TEXT PRIMARY KEY,            -- 第一版固定 "scheduler"
  worker_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,        -- RFC3339 UTC
  heartbeat_at TEXT NOT NULL
);
```

### 3.3 Claim 事务（冻结，必须原子）

**禁止 SELECT 后再 UPDATE 的竞态写法。** Claim 在一个 `TransactionBehavior::Immediate` 事务内完成：

```sql
BEGIN IMMEDIATE;
SELECT ... FROM task_runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1;
UPDATE task_runs SET status = 'starting', worker_id = ? WHERE id = ?;
COMMIT;
```

- 并发 claim（多 worker / 多线程）必须由该事务保证同一 run 只被一个 worker 拿到——这是必测项。
- `enqueue_due` 与 `next_run_at` 推进在同一事务内完成（沿用 `BackupStore::enqueue_due` 现状）：入队 + 推进 next fire 原子提交，崩溃不会重放已错过的 interval（misfire 语义接管）。
- **dispatch 顺序不变量（冻结）**：worker 必须先把 run 置为 `running` 再调用 executor。因此 recovery 时 `starting` 状态意味着 executor 尚未启动。

### 3.4 Lease / Recovery 语义（冻结）

- `acquire_lease`：BEGIN IMMEDIATE → 读 `scheduler_leases` → 若 `lease_until < now` 或不存在则写入 `(name, worker_id, lease_until = now + ttl)` → COMMIT；否则获取失败。
- worker 循环内定期 `heartbeat_lease` 续期；正常 shutdown `release_lease`。
- Recovery（每次 worker 启动、拿到 lease 后执行）：
  - run 模式：`running` → `failed`，`error_code = "worker_interrupted"`；`starting` → 回到 `queued`（依据 §3.3 不变量，executor 尚未启动，重排安全，attempt 不消耗）。
  - resident：`running` session → 标记 `crashed` → reconcile（探测 `task/status`）→ 按 restart policy 决定重启或 `degraded`。
  - Desktop 单 worker 部署允许额外叠加现有 fs2 `worker.lock` 文件锁作为进程级防线（可选，实现自由度），但 DB lease 表语义必须完整实现（多 worker 预留）。
- Engine 主循环（轮询间隔必须可配置，不得硬编码在业务逻辑中）：
  `startup → load store → recover → acquire lease → loop{ heartbeat → enqueue_due → claim → dispatch → reconcile residents → sleep/wake } → shutdown{ release lease }`。

---

## 4. SchedulerService / Engine / Registry（冻结边界）

```rust
pub struct SchedulerEngine {
    store: SchedulerStore,
    registry: Arc<TaskExecutorRegistry>,
    worker_id: String,
    // poll_interval 等必须显式注入，不得硬编码（实现自由度）
}

pub struct TaskExecutorRegistry {
    builtins: HashMap<String, Arc<dyn TaskExecutor>>,        // provider_id → executor
    plugins: PluginTaskExecutorRegistry,                      // dbx-core 侧适配 dbx-plugin-runtime
}

pub struct SchedulerService { store: SchedulerStore, registry: Arc<TaskExecutorRegistry> }
```

- `SchedulerService`：create/update/delete、manual run、cancel、validation、provider dispatch、resident 动作。**所有 API（Tauri command / web route）只调用 SchedulerService。**
- 第一版不做 priority queue；SQLite 的 `next_run_at / status / created_at` 足够。**禁止**引入 Redis / RabbitMQ / Quartz / Temporal / Airflow / Kafka 队列。
- 一个 provider 配置错误不得卡死整个 scheduler loop（loop 内 per-run 错误隔离）。

---

## 5. Executor Traits（冻结签名；异步风格见 §14 D1）

### 5.1 上下文与结果

```rust
#[derive(Debug, Clone)]
pub struct TaskExecutionContext {
    pub task: TaskDefinition,
    pub run: TaskRun,
    pub cancellation: tokio_util::sync::CancellationToken,   // 沿用仓库现状
    pub logger: TaskLogger,
    pub progress: TaskProgressReporter,
}

#[derive(Debug, Clone)]
pub struct TaskExecutionResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
    pub artifacts: Vec<TaskArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {   // 与 task_artifacts 表列一致
    pub name: String,
    pub uri: String,
    pub content_type: Option<String>,
    pub size: Option<u64>,
    pub checksum: Option<String>,
}
```

### 5.2 TaskExecutor（run 模式）与 ResidentExecutor（常驻）

**采用 `#[async_trait]` 宏**（`dbx-core` 现有统一风格：`admin/mq/port.rs`、`admin/nacos/port.rs`、`host/external/traits.rs`）。**不使用 RPITIT，不引入 BoxFuture 第二套抽象**（plan §17 的 `impl Future` 写法被本 ADR 取代，见 §14 D1）。

```rust
#[async_trait]
pub trait TaskExecutor: Send + Sync {
    /// 校验连接 / 参数 / 环境；不得触碰 secret 明文。
    async fn validate(&self, task: &TaskDefinition) -> Result<(), TaskError>;
    /// 执行一次 run。实现必须尊重 context.cancellation。
    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError>;
}

#[async_trait]
pub trait ResidentExecutor: Send + Sync {
    async fn start(&self, context: TaskExecutionContext) -> Result<ResidentSession, TaskError>;
    async fn stop(&self, session: &ResidentSession) -> Result<(), TaskError>;
    async fn status(&self, session: &ResidentSession) -> Result<ResidentStatus, TaskError>;
}
```

- 两个 trait 分开（plan §18 的“合并为单一 trait”建议**不采纳**，见 §14 D5）。Provider 按 manifest `capabilities` 决定实现哪个；`resident` capability 必须实现 `ResidentExecutor`。
- `ResidentSession { id, task_id, run_id, plugin_id, state, heartbeat_at, restart_count }`；`ResidentStatus { state, heartbeat_at, restart_count }`（与 `task/status` RPC 返回一致）。
- Registry 按 `provider_id` 查找 executor；插件 executor 由 `dbx-core/src/scheduler/providers/plugin.rs` 适配（经 `dbx-plugin-runtime` 的 sidecar 会话），Core 不感知具体插件协议细节以外的内容。

### 5.3 TaskLogger / TaskProgressReporter / 日志格式

- 日志行 JSONL：`{ "seq": 1024, "timestamp": "2026-10-05T02:01:02Z", "level": "info", "stream": "stdout", "message": "backup started" }`。`seq` 由 Logger 按 run 单调分配（从 1 开始）；`stream ∈ stdout | stderr | system`；`level ∈ debug | info | warn | error`。
- 文件布局：`scheduler/logs/YYYY/MM/DD/<run-id>/000001.log`，按大小 rotation（建议 32MB）；索引入 `task_log_index`。
- 持久化与 UI 解耦：日志先落盘（经 `TaskLogger.append`），再广播事件；UI 关闭后日志继续积累；UI 重开 = snapshot + tail。
- Plugin 事件日志桥：Plugin `task/log` 事件 → `TaskLogger.append()` + EventBus 广播（Desktop + Web）。

### 5.4 TaskError 与错误分类

```rust
pub struct TaskError {
    pub kind: TaskErrorKind,        // 分类，决定 retry 行为
    pub code: String,               // 机器码（§8.4 词表）
    pub message: String,
}

pub enum TaskErrorKind {
    NonRetryable,   // invalid config / missing provider / missing connection / permission denied / cancelled
    Retryable,      // network / connection reset / temporary timeout / transient / plugin unavailable
    Cancelled,      // 显式取消，不重试
}
```

`error_code` 保留词（可扩展，但语义不得改）：`worker_interrupted`、`timeout`、`provider_unavailable`、`invalid_config`、`connection_missing`、`permission_denied`。

---

## 6. Plugin Task Contract（冻结）

### 6.1 Manifest：`task-provider` contribution

`PluginContribution` 新增变体 `TaskProvider(PluginTaskProviderContribution)`；serde tag 为 kebab-case → `"type": "task-provider"`。schema（`plugins/manifest.schema.json`）与 Rust 类型同步新增，且 `deny_unknown_fields` 语义保持。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginTaskProviderContribution {
    pub id: String,                                    // 带命名空间，如 io.dbx.ssh.tasks
    pub label: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connection_providers: Vec<String>,             // 依赖的 connection provider id
    #[serde(default)]
    pub capabilities: Vec<PluginTaskCapability>,       // 声明能力，Runtime 强制
    #[serde(default)]
    pub triggers: Vec<PluginTaskTriggerContribution>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskCapability { Run, Resident, Cancel, Logs, Progress, Artifacts }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginTaskTriggerContribution {
    pub id: String,                                    // provider 内唯一，如 "execute"
    pub label: String,
    pub mode: PluginTaskMode,                          // "run" | "resident"
    #[serde(default)]
    pub risk: PluginTaskRisk,                          // "low" | "medium" | "high"
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<PluginFormFieldDefinition>,        // 复用现有 form field 体系，禁止第二套 DSL
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskMode { Run, Resident }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskRisk { Low, Medium, High }
```

- **表单字段复用** `PluginFormFieldDefinition`（text/password/number/boolean/select/textarea、`binding`、`options`、`visible_when` / `required_when`、`options_action`、`picker`），不新增字段类型。
- **Risk UI 策略（冻结）**：Low 无额外提示；Medium 保存时提示；High 创建/修改时明确确认。任务保存启用后，自动执行**不得**每次再要人工确认。
- Manifest 校验规则：未知 capability 拒绝；resident trigger 必须声明 `resident` capability、run trigger 必须声明 `run` capability；不支持 `task-provider` 的旧 host 按现有 contribution 兼容策略处理（新 contribution 对旧 host 不可读，属预期）。

### 6.2 固定 RPC（只允许这 5 个方法；禁止任意 `task/<custom>` RPC）

复用现有 sidecar JSON-RPC 通道与超时机制（`invoke_with_timeout`），遵循 `connection/*`、`filesystem/*` 的“固定方法 + declared capability”模式：

| 方法 | 能力要求 | 请求 → 响应 |
|---|---|---|
| `task/validate` | — | `{ task: {providerId, triggerId, connectionId, configVersion, config}, connection, runtime }` → `{ valid, errors[], warnings[], fieldValues?, options? }` |
| `task/execute` | `run` | `{ task: {taskId, runId, triggerId, connectionId, configVersion, config}, run: {runId, attempt}, connection, runtime }` → `{ success, exitCode?, message?, artifacts[] }` |
| `task/start` | `resident` | 同 execute 请求 → `{ sessionId, state }` |
| `task/stop` | `cancel` 或 `resident` | `{ taskId, runId, sessionId, reason }` → `{}` |
| `task/status` | `resident` | `{ taskId, runId, sessionId }` → `{ state, heartbeatAt, restartCount }` |

- `connection` payload 由 host 从 connection lifecycle 解析后注入；**其中只含 host 决定暴露的字段，secret 只出现在 backend lifecycle request 的受控位置**（§10）。
- `task/execute` / `task/start` / `task/stop` 必须能在超时与取消下返回或中断；Runtime 必须校验请求方法与 manifest capability 匹配，未声明能力调用直接拒绝。
- 兼容性：现有 `connection/test|connect|disconnect|action` 语义与行为**不得改变**。

### 6.3 固定事件（复用现有 plugin event channel，不新造 WebSocket 通道）

| 事件 | payload |
|---|---|
| `task/log` | `{ event, taskId, runId, seq, stream, level, message, timestamp? }` |
| `task/progress` | `{ event, taskId, runId, percent, current?, completed?, total? }` |
| `task/state` | `{ event, taskId, runId, state }` |
| `task/artifact` | `{ event, taskId, runId, artifact: { name, uri, size? } }` |

- 每个事件必须能关联 `taskId + runId`；`task/log` 必须含 `seq / stream / level / message`。
- Host 收到事件后：log → `TaskLogger.append()`（持久化）+ EventBus 广播；progress → 标准化为 `TaskProgress { percent, current, completed, total }` 更新 run；artifact → 持久化到 `task_artifacts`。**事件本身不持久化，持久化由 host 侧完成。**

### 6.4 Host API 与权限

- `SUPPORTED_PLUGIN_PERMISSIONS` 与 `plugins/manifest.schema.json` 的 permission enum **同时**新增 `host.scheduler`（仓库现状是 Rust 白名单 + schema enum 双处登记，两处必须一致）。
- 第一版 Host API 只加一个方法：`host.openScheduler({ providerId, triggerId, connectionId, mode: "create" })`，语义 = 打开 Scheduler UI 并预填新建任务表单。
- `host.scheduler` 第一版**只**授权打开 UI；**禁止**插件静默创建 / 启用 / 修改任务。未来再考虑 `host.scheduler:write`。
- 插件签名验证 ≠ OS sandbox；secret 边界靠 §10 的数据流约束，不靠签名。

---

## 7. Scheduler API（冻结路由与语义）

### 7.1 Web 路由（axum，`crates/dbx-web/src/routes/scheduler.rs`）

```
GET    /api/scheduler/tasks
POST   /api/scheduler/tasks
GET    /api/scheduler/tasks/:id
PUT    /api/scheduler/tasks/:id            （带 version；冲突 409）
DELETE /api/scheduler/tasks/:id
POST   /api/scheduler/tasks/:id/run        （手动触发）
POST   /api/scheduler/tasks/:id/cancel     （取消 run，body 带 runId）
POST   /api/scheduler/tasks/:id/enable
POST   /api/scheduler/tasks/:id/disable
GET    /api/scheduler/runs                 （查询参数：taskId、status、limit、before/after 游标）
GET    /api/scheduler/runs/:id
GET    /api/scheduler/runs/:id/logs        （查询参数见 §7.3）
GET    /api/scheduler/runs/:id/artifacts
GET    /api/scheduler/resident             （active session 列表）
POST   /api/scheduler/resident/:sessionId/start | stop | restart
GET    /api/scheduler/events               （SSE，见 §7.4）
```

### 7.2 Desktop 命令（Tauri，`src-tauri/src/commands/scheduler.rs`）

`schedulerListTasks / schedulerGetTask / schedulerSaveTask / schedulerDeleteTask / schedulerRunTask / schedulerCancelRun / schedulerEnableTask / schedulerDisableTask / schedulerListRuns / schedulerGetRun / schedulerGetRunLogs / schedulerListArtifacts / schedulerResidentAction`，沿用现有 `api.ts` 风格。

**禁止**再新增 `databaseBackupCommand` / `sshTaskCommand` / `filesTaskCommand` 之类业务特化 scheduler endpoint；backup 迁移期旧命令保留兼容但不扩展。

### 7.3 日志查询（冻结）

查询参数：`afterSeq`（默认 0）、`limit`（默认 500，服务端可设上限）、`level`（可选过滤）、`stream`（可选过滤）。响应：

```json
{ "entries": [ { "seq": 1, "timestamp": "...", "level": "info", "stream": "stdout", "message": "..." } ],
  "nextSeq": 1025, "eof": false }
```

前端 tail 模式：snapshot → render → 订阅事件 append；`eof=true` 且无新事件时才轮询。**禁止**每秒重拉全量日志。

### 7.4 事件流

- Desktop：Tauri 事件 `dbx-scheduler-event`，payload `{ type, taskId, runId, ... }`，`type ∈ task-changed | run-created | run-state | run-progress | run-log | resident-state`。
- Web：`GET /api/scheduler/events` 用 **SSE**（第一版不用 WebSocket；WebSocket 留给未来 interactive resident stdin）。
- 事件为通知用途，客户端必须能从 API 重建完整状态（事件允许丢失，状态不允许）。

### 7.5 错误码 → HTTP 映射（冻结）

| code | HTTP | 语义 |
|---|---|---|
| `task_not_found` | 404 | |
| `run_not_found` | 404 | |
| `provider_not_found` | 404 | provider id 未注册（manifest / builtin 均无） |
| `provider_unavailable` | 503 | 插件未安装/未运行/启动失败 |
| `invalid_config` | 400 | config 校验失败（validate/execute 前置） |
| `invalid_trigger` | 400 | trigger 不存在或不可解析 |
| `version_conflict` | 409 | optimistic locking 冲突 |
| `run_already_active` | 409 | 与 concurrency=forbid 等冲突 |
| `permission_denied` | 403 | |
| `scheduler_unavailable` | 503 | store/engine 未初始化或不可用 |

- Web 错误响应沿用 `dbx-web/src/error.rs::AppError` 体系：状态码 + JSON body 携带 `code` 字段（机器码用上表值），**不得**把以上情况统一映射成 500。
- Desktop 命令返回 `Err(String)`，错误字符串以同样机器码为前缀（如 `"task_not_found: ..."`），沿用仓库 `Result<_, String>` 风格。
- API Security：所有 scheduler API 必须校验 task 归属、connection 存在、plugin 存在、provider capability；**不得**仅信任 `task.providerId`。

---

## 8. Database Backup 迁移契约（冻结）

1. **不重写 backup 逻辑**：新增 `DatabaseBackupTaskExecutor { service: BackupService }` 实现 `TaskExecutor`，链路 `TaskRun → executor → 现有 BackupService → export → artifact → TaskExecutionResult`。
2. **字段映射**（`DatabaseBackupSchedule` → `TaskDefinition`）：
   - `name → name`；`connectionId → target.connectionId`；`id → id`（**保留旧 ID**）。
   - `frequency/intervalHours/timeOfDay/weekday/timeZone → TaskTrigger`（hourly→interval；daily/weekly→cron；`timeOfDay HH:mm` → cron `m h * * *` / `m h * * <weekday>`，`timeZone` 原样带 IANA 值）。
   - `includeStructure/includeData/includeObjects/dropTableIfExists/tableFilterMode/tablePatterns/databases/destinationDirectory/outputCompression/fileNamePattern/runDirectoryPattern/retentionCount → config`（`config_version = 1`）。
   - 旧 `BackupRun` → `TaskRun`：`id/schedule_id→task_id/status/started_at/completed_at/progress_percent/error→error_message` 逐字段保留（**保留旧 run ID**）；`running` 状态的旧 run 迁移时置 `failed` + `error_code = "worker_interrupted"`（沿用现有 `BackupStore::migrate` 行为）。
3. **迁移为独立 `SchedulerMigration`，幂等 + 原子 + restart-safe**：
   - 事务内：检查迁移标记 → 读 legacy → transform → insert task/run → 写标记 → COMMIT；任何失败 ROLLBACK，**不得**先写标记后插数据；失败后下次启动可完整重试。
   - 幂等：标记存在直接返回；insert 用 `INSERT OR IGNORE`（沿用现状）保证重复执行无副作用。
   - **失败不标 migrated；legacy 数据迁移成功后仍保留**（作为回滚 / 审计依据），第一阶段不删除 legacy 表与旧 UI；旧 UI 作为 compatibility adapter。
   - 迁移期间与迁移后现有 backup 行为（schedule / one-shot / scope / retention / cancel / progress / history / background）不得退化；现有 scheduled_backup 测试全部保留。
4. 迁移受 feature flag `scheduler.generic.enabled` 保护，双轨并存（见 §12）。

---

## 9. Export / Import / Copy / Config 约定（冻结）

- **Provider / Trigger ID 命名空间**见 §2.2；任务逻辑 identity = `providerId + triggerId + connectionId`。
- **Export JSON**：`{ "schemaVersion": 1, "task": { "name", "providerId", "trigger", "execution", "config", "connectionId" } }`；**绝不含 secret**。
- **Import**：parse → validate（provider 存在、trigger 存在、form 字段校验）→ connection binding → **保存为 `enabled = false`**。校验失败整体拒绝，不落半份。
- **Copy**：新 UUID + `name + " Copy"` + `enabled = false`。
- Config 内可含 provider 自定义键，但不得含 secret（§10）与 `configVersion` 键（§2.1）。

---

## 10. Secret 红线（冻结，最高优先级）

1. TaskDefinition / TaskRun / config / payload / log / event / artifact metadata / export / 数据库中**绝对不得出现** password、token、privateKey、authorization、session key 等凭据明文。
2. 任务只保存 `connectionId`（及 provider 声明的 `secretRef` 类字段引用）；凭据解析链路：Task → Connection Resolver → Secret Store → Plugin lifecycle payload，**只有 backend lifecycle request 的受控位置拿到 hydrated secrets**。
3. Manifest 中 `binding: "secret"` 的表单字段值（含 password 默认 binding，见 `PluginFormFieldDefinition`）按现有 secret 存储通道处理，不入 task config。
4. 日志/事件写出前必须做 secret redaction（至少对已知凭据字段名）；QA（A9）做全链路 grep 审计。
5. 大文件本体不得进入 SQLite / 事件（artifact 只存 metadata + uri）。

---

## 11. Background Worker（契约级约定，A8 实现）

- `src-tauri/src/background_backup.rs` 泛化为 `background_scheduler.rs`；`BackupService` 换成 `SchedulerEngine`。worker 启动参数 `--scheduler-worker`（或 `DBX_PROCESS_ROLE`）；迁移期 `--ui-backup-worker` 不删。
- 沿用现有机制：当前 executable + 参数 spawn child process、restart with backoff（有界）、OS startup 注册、worker log、graceful shutdown。
- UI close 不得停止 enabled 任务；worker 崩溃由 supervisor 检测并重启；worker 失败不得拖垮主 UI。
- Shutdown 顺序：cancel scheduler → stop active work → persist → release lease → exit；resident shutdown 行为遵循其 restart policy，正常关闭不产生无限 restart。
- Web/Docker：容器启动 main server + scheduler worker，不依赖浏览器会话。

---

## 12. Feature Flags 与发布节奏（冻结）

- Flags：`scheduler.generic.enabled`、`scheduler.background.enabled`、`scheduler.plugin_tasks.enabled`；迁移期 generic scheduler 与 legacy backup scheduler 并存。
- 发布节奏：Release N 双轨并存 → N+1 Scheduler owns backup（legacy API = adapter）→ N+2 删旧 UI → N+3 移除 legacy writes。

---

## 13. Agent 文件边界与依赖顺序（冻结）

Merge 顺序（严格）：**A0 → A1 → A2 → A3 / A4 / A5（可并行，均依赖 A1+A2）→ A8 → A6 → A7 → A9 → A10**。

| Agent | 允许修改 | 禁止修改 | 上游依赖 |
|---|---|---|---|
| A0 契约 | `docs/**` | 一切代码 | — |
| A1 Scheduler Core | `crates/dbx-core/src/scheduler/**`、`crates/dbx-core/tests/**`（scheduler 集成测试） | `apps/desktop`、`src-tauri`、`plugins/**`、`dbx-plugin-runtime`、backup export 算法 | 本 ADR |
| A2 Plugin Contract | `plugins/manifest.schema.json`、`crates/dbx-plugin-runtime/src/plugins/{manifest.rs,task.rs}`、`plugins/sdk/**`、contract tests | `dbx-core/src/scheduler/**`、`apps/desktop`、`src-tauri`、SSH/Files 业务 | 本 ADR（A1 合并后 rebase） |
| A3 API | `src-tauri/src/commands/scheduler.rs`、`crates/dbx-web/src/routes/scheduler.rs`、`apps/desktop/src/lib/backend/**` | `apps/desktop/src/components/scheduler/**`、`dbx-core/src/scheduler/**`、直连 SQLite | A1 + A2 |
| A4 Backup Adapter/Migration | `crates/dbx-core/src/scheduler/providers/database_backup.rs`、`crates/dbx-core/src/scheduler/migration.rs`、最小 legacy 集成点 | BackupService / export 算法重写 | A1 |
| A5 UI | `apps/desktop/src/components/scheduler/**`、`apps/desktop/src/lib/scheduler/**`、`router/**` | 任何 crate、第二个 scheduler 数据模型 | A1 + A2 + A3 |
| A8 Background Worker | `src-tauri/src/background_scheduler.rs`（新）、`src-tauri/src/lib.rs` 接线 | 复制独立 scheduler 实现 | A1（+A3 接线） |
| A6 SSH | SSH plugin 源码位置（开工前确认，不得猜） | `dbx-core/src/scheduler/**` | A1 + A2 + A8 |
| A7 Files | Files plugin 源码位置（开工前确认） | `dbx-core/src/scheduler/**`；**禁止**用 filesystem RPC list→read→write 拼同步 | A1 + A2 + A8 |
| A9 QA | 测试、`docs/scheduler-integration-report.md` | 无关重构 | 全部 |
| A10 整合 | 合并、`docs/adr/scheduler-final-architecture.md` | — | 全部 |

每个 Agent 独立 git worktree；1 concern = 1 commit。TS 类型先手工维护（`apps/desktop/src/lib/scheduler/schedulerTypes.ts`），API 稳定后生成 `generated.ts`。

---

## 14. 与 implementation-plan 的偏差记录（均已定稿，后续 Agent 按本节为准）

| # | 偏差 | 理由 |
|---|---|---|
| D1 | Executor trait 用 `#[async_trait]` 宏，不用 plan §17 的 RPITIT（`impl Future`）写法 | 仓库 `dbx-core` 现有 async trait 全部为 `#[async_trait]`（`admin/mq/port.rs`、`admin/nacos/port.rs`、`host/external/traits.rs`）；plan 自身也要求“不要引入第二套异步抽象” |
| D2 | `config_version` 是 TaskDefinition 一等字段 + `task_definitions.config_version` 列；`config` JSON 内不再嵌 `configVersion` 键（plan §70/§106 例为内嵌） | agent-prompts（A0 指令）把 `config_version` 列为 TaskDefinition 字段；一等字段可做列级约束与未来 schema 迁移，单一事实来源避免双写漂移 |
| D3 | `TaskMisfirePolicy::FireOnce` 的 JSON 值冻结为 `"fire-once"`（kebab-case） | plan §7–11 注明该枚举组 serde 为 kebab-case；agent-prompts 中 `fire_once` 文本是笔误 |
| D4 | `task_log_index` 主键改为 `(run_id, segment)` 而非 `run_id` 单列 | plan §16 自身要求按大小 rotation 产生 `000001.log` 多段文件，单列主键与 rotation 矛盾 |
| D5 | `TaskExecutor` 与 `ResidentExecutor` 保持两个 trait，不采纳 plan §18 “合并为单一 trait”的建议 | agent-prompts A1 明确 “Resident 另需 start/stop/status”；两个 trait 让 registry 能按 capability 精确分发，避免 TaskEngine 感知 plugin session 细节 |
| D6 | Recovery 时 `starting` 状态的 run 回到 `queued`（plan §21 只写了 running → failed） | 配合 §3.3 “先置 running 再调 executor” 的 dispatch 不变量，`starting` 保证 executor 未启动，重排安全且不消耗 attempt |
| D7 | API 错误响应绑定仓库现有 `AppError`（状态码 + JSON body 含 `code`）而非 plan 未指定的新格式 | 沿用 `crates/dbx-web/src/error.rs` 现状，避免引入第二套错误封装 |
| D8 | `Once` 触发后清除 `next_run_at`、任务保留（plan 未定义） | 补齐状态机闭环；与 “任务不自动删除” 原则一致 |

---

## 15. 后续 Agent 不得自行发明的内容清单

以下内容已冻结，任何 Agent **不得**重新设计、改名、另起炉灶；发现无法满足时必须回报 Agent 0 修订本 ADR：

1. **Domain 类型与字段**：`TaskDefinition / TaskProviderType / TaskTarget / TaskTrigger / TaskExecutionPolicy（mode/timeout/concurrency/retry/misfire/restart）/ TaskRun / TaskRunStatus / TaskRunTrigger / ResidentSession 状态集 / Health 状态集 / TaskExecutionContext / TaskExecutionResult / TaskArtifact / TaskError(TaskErrorKind)`。
2. **存储**：`<data-dir>/scheduler/state.db` 七张表的表名、列语义、状态字符串字面值；`BEGIN IMMEDIATE` claim / lease / recovery 语义；“先 running 后 execute” dispatch 不变量。
3. **异步风格**：`#[async_trait]`；`tokio_util::sync::CancellationToken`；UTC RFC3339 存储；`chrono-tz` IANA 时区；DST 语义（ambiguous→first、nonexistent→gap 后首个有效时刻）。
4. **Plugin 协议**：`task-provider` contribution 结构与字段；capability 词表；固定 RPC `task/validate|execute|start|stop|status` 的请求/响应形状；事件 `task/log|progress|state|artifact` 的 payload 形状；`host.scheduler` 权限语义；任意 RPC 与第二套 form DSL 均被禁止。
5. **API**：`/api/scheduler/*` 路由清单、日志查询参数与响应形状、SSE / `dbx-scheduler-event` 事件类型、错误码词表与 HTTP 映射、optimistic locking（409）。
6. **迁移契约**：幂等 / 原子 / 保留旧 ID / 失败不标 migrated / legacy 不删（§8）。
7. **命名**：provider / trigger ID 命名空间；DB 文件路径；日志文件布局与 JSONL 行格式。
8. **Secret 红线**（§10）与 Feature Flags（§12）。
9. **范围红线**：第一版禁止分布式 scheduler、外部队列、workflow DAG、任务依赖、condition engine、业务特化 endpoint、UI 自建定时器、第二套 Scheduler。

允许自行决定（实现自由度）：模块文件划分、内部函数签名细节、poll interval 注入方式、测试组织、错误 message 文案（code 不得改）。

---

## 16. 验收锚点（引用 implementation-plan §112–§131）

最终架构验收十五问（全部 YES 才算通过）与主控十五条军规以 plan §124–§131 为准，本 ADR 不重复。Agent 提交前自检：`cargo fmt --all -- --check`、对应 crate 测试、`git diff --check`。
