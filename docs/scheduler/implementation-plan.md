# DBX Scheduler 统一任务中心 — 完整实施规格

> 来源：外部方案评审（ChatGPT 分享会话，2026-10-05 落盘）。
> 适用仓库：本仓库（DBX host 主仓库）。
> 状态：待实施。Wave 1 启动前，本文件即冻结契约的唯一来源；实现与本文冲突时，先修订本文。

---

## 0. 总任务

在本仓库实现统一的 **Scheduler / Task Center / Task Runtime**：

- 新增独立一级入口「计划任务」。
- 统一管理 Database Backup、SSH Task、Files Task。
- 触发方式：`manual` / `once` / `interval` / `cron` / `startup`。
- 执行能力：queue、cancel、timeout、retry、concurrency policy、misfire policy、realtime progress、realtime logs、historical logs、artifacts。
- 插件可以通过 Manifest 声明 **Task Provider**，提供：配置表单、命令执行、常驻任务、stop/restart、日志、progress、artifact。
- 现有 Scheduled Database Backup 完整迁移到 Scheduler。
- 现有 background backup worker 升级为 generic background scheduler worker。
- Desktop / Web / Docker 共用同一个 scheduler domain model。
- **不允许为 SSH/files 再造第二套 scheduler。**

现有 `scheduled_backup` 已具备 queue/claim/heartbeat/worker lock/migration/cancel/retry-like execution 基础；插件运行时已有 `connection/*`、filesystem、event、Sidecar、persistent plugin-data 和权限模型；Tauri 的 `database_backup_command/background` 仍是单独入口。

架构规则：`dbx-plugin-runtime` **不得**反向依赖 `dbx-core`；跨层测试放 `dbx-core/tests`。Scheduler 对插件的适配放 Core 一侧（`dbx-core/src/scheduler/providers/plugin.rs`）。

## 1. 总体架构

```
UI
│  Task CRUD / Run / Cancel / Logs
▼
Scheduler Service
├── Trigger Engine
├── Queue
├── Lease
├── Retry
├── Concurrency
├── Resident Supervisor
├── Log Store
└── Artifact Store
│
├───────────────┬───────────────────┐
▼               ▼                   ▼
Builtin       Plugin Provider    Plugin Resident Provider
Task Provider
│               │                   │
Backup          SSH                SSH Resident
                Files Watcher      ▼ S3 ...
                          DBX Core Sidecar
```

关键原则：`Scheduler != business executor`。

- Scheduler 只负责：**when / where / how many times / timeout / retry / cancel / log / persistence / process lifetime**。
- Provider 负责：**what to do**。

## 2. 仓库代码归属

```
crates/dbx-core/src/scheduler/
├── mod.rs models.rs store.rs engine.rs trigger.rs policy.rs
├── executor.rs logs.rs artifacts.rs resident.rs migration.rs
└── providers/
    ├── mod.rs
    ├── database_backup.rs
    └── plugin.rs

crates/dbx-plugin-runtime/src/plugins/
├── manifest.rs host.rs runtime.rs
└── task.rs            ← 新增

plugins/manifest.schema.json
plugins/sdk/rust/dbx-plugin-sdk/  plugins/sdk/go/dbx-plugin-sdk/  plugins/sdk/cli/

apps/desktop/src/components/scheduler/
├── SchedulerPage.vue SchedulerTaskList.vue SchedulerTaskEditor.vue
├── SchedulerTaskForm.vue SchedulerRunList.vue SchedulerRunDetail.vue
├── SchedulerLogViewer.vue SchedulerResidentList.vue
apps/desktop/src/lib/scheduler/
├── schedulerTypes.ts schedulerApi.ts schedulerEvents.ts schedulerStore.ts

src-tauri/src/
├── background_scheduler.rs        ← 由 background_backup.rs 泛化
└── commands/scheduler.rs

crates/dbx-web/src/routes/scheduler.rs
```

最终删除/废弃（**不是第一阶段**）：`background_backup.rs`、scheduled_backup UI、scheduled_backup 专用 API。

## 3. 依赖方向（严格）

```
dbx-plugin-runtime
        ↑
      dbx-core
        ↑
  src-tauri / dbx-web
```

禁止 `dbx-plugin-runtime -> dbx-core`。Scheduler 对插件的适配放 `dbx-core/src/scheduler/providers/plugin.rs`。

## 4. Domain Model

### 4.1 TaskDefinition

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub id: String,
    pub name: String,
    pub provider_type: TaskProviderType,
    pub provider_id: String,
    pub target: TaskTarget,
    pub trigger: TaskTrigger,
    pub execution: TaskExecutionPolicy,
    pub config: serde_json::Value,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_run_status: Option<TaskRunStatus>,
    pub version: i64,   // optimistic locking
}
```

### 4.2 Provider Type

```rust
pub enum TaskProviderType { Builtin, Plugin }   // serde kebab-case
```

### 4.3 Target

```rust
pub struct TaskTarget {
    pub connection_id: Option<String>,
    pub plugin_id: Option<String>,
    pub resource_id: Option<String>,
}
```

第一版主要用 `connection_id`；未来可扩展 workspace / resource / cluster。

## 5. Trigger Model

```rust
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TaskTrigger {
    Manual,
    Once { at: String, time_zone: String },
    Interval { seconds: u64 },
    Cron { expression: String, time_zone: String },
    Startup,
}
```

内部统一转成 `NextFireTime { at: DateTime<Utc> }`。不要让 Engine 到处判断 backup-specific 的 `if daily {} if weekly {}` 旧分支。

## 6. Cron

- 第一版支持标准 5-field：`minute hour day-of-month month day-of-week`。
- `time_zone` 必须进入 TaskDefinition（IANA timezone），不能放 UI 本地状态。
- 计算入口：`trigger.next_after(last_fire)` → 输出 UTC Instant；存储 UTC；显示时用 `task.time_zone`。
- 禁止用本地 `Date.setHours()` 处理 cron。
- DST 必须测试（`02:30` 不能假定永远存在）。

## 7–11. Execution Policy

```rust
pub struct TaskExecutionPolicy {
    pub mode: TaskExecutionMode,
    pub timeout_seconds: Option<u64>,
    pub concurrency: TaskConcurrencyPolicy,
    pub retry: TaskRetryPolicy,
    pub misfire: TaskMisfirePolicy,
    pub restart: Option<TaskRestartPolicy>,
}

pub enum TaskExecutionMode { Run, Resident }            // kebab-case
pub enum TaskConcurrencyPolicy { Forbid, Queue, Replace, Parallel }  // kebab-case
pub struct TaskRetryPolicy { pub max_attempts: u32, pub backoff_seconds: u64, pub backoff_strategy: TaskBackoffStrategy }
pub enum TaskBackoffStrategy { Fixed, Exponential }     // kebab-case
pub enum TaskMisfirePolicy { Coalesce, FireOnce, Skip } // 默认 Coalesce
```

默认并发策略：Database Backup → Forbid；SSH Execute → Forbid；Files Sync → Forbid；Resident → Replace。

Misfire：DBX 离线 6 小时后恢复，不重复执行 5 次；第一版默认 `Coalesce`。

## 12–14. TaskRun

```rust
pub enum TaskRunStatus { Queued, Starting, Running, Success, Failed, Cancelled, Timeout, Skipped } // lowercase
// 状态机：Queued → Starting → Running → { Success | Failed | Cancelled | Timeout }

pub struct TaskRun {
    pub id: String, pub task_id: String, pub status: TaskRunStatus,
    pub trigger: TaskRunTrigger, pub attempt: u32,
    pub worker_id: Option<String>,
    pub started_at: Option<String>, pub completed_at: Option<String>,
    pub exit_code: Option<i32>, pub error_code: Option<String>,
    pub error_message: Option<String>, pub progress_percent: Option<f64>,
    pub artifacts_count: u32,
}

pub enum TaskRunTrigger { Manual, Scheduled, Startup, Retry, Restart }
```

## 15. SQLite Schema

新建 `<data-dir>/scheduler/state.db`，**不要**继续写进 `database-backups/state.db`。

```sql
CREATE TABLE IF NOT EXISTS task_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
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
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
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
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  heartbeat_at TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  checksum TEXT,
  created_at TEXT NOT NULL
);
```

## 16. Log Store

- 不要用 `worker.log` 作为核心历史。
- 文件布局：`scheduler/logs/YYYY/MM/DD/<run-id>/000001.log`，按大小切分（建议 32MB rotation）。
- 索引表：

```sql
CREATE TABLE IF NOT EXISTS task_log_index (
  run_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- 日志行格式（JSONL）：`{ "seq": 1024, "timestamp": "2026-10-05T02:01:02Z", "level": "info", "stream": "stdout", "message": "backup started" }`。

## 17. Task Executor Trait（Core 最核心抽象）

```rust
#[derive(Debug, Clone)]
pub struct TaskExecutionContext {
    pub task: TaskDefinition,
    pub run: TaskRun,
    pub cancellation: CancellationToken,
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

pub trait TaskExecutor: Send + Sync {
    fn validate(&self, task: &TaskDefinition) -> impl Future<Output = Result<(), TaskError>> + Send;
    fn execute(&self, context: TaskExecutionContext) -> impl Future<Output = Result<TaskExecutionResult, TaskError>> + Send;
}
```

若 RPITIT 与当前 workspace 约束不合，用 `BoxFuture<'static, ...>` 或仓库已有 async trait pattern；**不要引入第二套异步抽象**。

## 18. Resident Executor

```rust
pub trait ResidentExecutor: Send + Sync {
    fn start(&self, context: TaskExecutionContext) -> impl Future<Output = Result<ResidentSession, TaskError>> + Send;
    fn stop(&self, session: &ResidentSession) -> impl Future<Output = Result<(), TaskError>> + Send;
    fn status(&self, session: &ResidentSession) -> impl Future<Output = Result<ResidentStatus, TaskError>> + Send;
}
```

推荐合并为 `TaskExecutor { run_mode(); resident_mode(); }`，避免 TaskEngine 知道所有 plugin session 细节。

## 19. Scheduler Engine

```
startup → load store → recover interrupted runs → acquire scheduler lease
loop: heartbeat → enqueue_due → claim → dispatch → reap
shutdown: release lease
```

```rust
pub struct SchedulerEngine {
    store: SchedulerStore,
    registry: Arc<TaskExecutorRegistry>,
    worker_id: String,
}
```

第一版不做复杂 priority queue；SQLite 的 `next_run_at / state / created_at` 已够。轮询间隔不得硬编码在业务逻辑中。

## 20. Claim 事务（必须原子）

禁止 `SELECT` 然后 `UPDATE`（竞态）。目标：

```sql
BEGIN IMMEDIATE;
SELECT id FROM task_runs WHERE status = 'queued' ORDER BY created_at LIMIT 1;
UPDATE task_runs SET status = 'starting', worker_id = ? WHERE id = ?;
COMMIT;
```

未来多 worker 也不会拿到同一个 run。优先 `TransactionBehavior::Immediate`。

## 21. Recovery

启动时 `starting` / `running` 的 Run 必须进入 recovery，且必须区分 Run 与 Resident：

- `run_mode`: running → failed，`error_code = "worker_interrupted"`。
- `resident`: running → restart / reconcile。

不允许出现永久卡死的 run。

## 22–26. Plugin Task Manifest

Manifest 新增 contribution 类型：

```json
{
  "type": "task-provider",
  "id": "io.dbx.ssh.tasks",
  "label": "SSH Tasks",
  "connection_providers": ["io.dbx.ssh.connection"],
  "capabilities": ["run", "resident", "cancel", "logs", "progress", "artifacts"],
  "triggers": [
    {
      "id": "execute", "label": "Execute Command", "mode": "run", "risk": "high",
      "fields": [
        { "key": "command", "label": "Command", "type": "textarea", "required": true },
        { "key": "working_directory", "label": "Working Directory", "type": "text" },
        { "key": "timeout_seconds", "label": "Timeout", "type": "number", "default": 300 }
      ]
    },
    {
      "id": "resident", "label": "Resident Command", "mode": "resident",
      "fields": [
        { "key": "command", "label": "Command", "type": "textarea", "required": true }
      ]
    }
  ]
}
```

Rust 类型：

```rust
pub struct PluginTaskProviderContribution {
    pub contribution_type: String,
    pub id: String,
    pub label: String,
    pub connection_providers: Vec<String>,
    pub capabilities: Vec<PluginTaskCapability>,
    pub triggers: Vec<PluginTaskTriggerContribution>,
}
pub enum PluginTaskCapability { Run, Resident, Cancel, Logs, Progress, Artifacts }
pub struct PluginTaskTriggerContribution {
    pub id: String, pub label: String,
    pub mode: PluginTaskMode,      // Run | Resident
    pub risk: PluginTaskRisk,      // Low | Medium | High
    pub fields: Vec<PluginFormFieldDefinition>,   // 复用现有 form field 体系
}
```

Risk UI 策略：Low 无额外提示；Medium 保存时提示；High 创建/修改时明确确认。任务一旦保存启用，后续自动执行不得每次要求人工确认。

## 27–36. Plugin 固定 RPC / 事件

遵循「固定方法 + declared capability」模式（同 `connection/*`、`filesystem/*`）。新增固定 RPC：

| 方法 | 用途 |
|---|---|
| `task/validate` | 连接/参数/环境检查、动态补全。Req: `{task, connection, runtime, config}` → Res: `{valid, errors, warnings, fieldValues, options}` |
| `task/execute` | Run 模式。Req: `{task, run, connection, runtime, config}` → Res: `{success, exitCode, message, artifacts}` |
| `task/start` | Resident 启动 → `{sessionId, state}` |
| `task/stop` | `{taskId, runId, sessionId, reason}` |
| `task/status` | → `{state, heartbeatAt, restartCount}` |

事件（复用现有 plugin event channel，不新造 WebSocket 通道）：

- `task/log`：`{event, runId, seq, stream, level, message}`
- `task/progress`：`{event, runId, completed, total, percent, current}`，内部标准化为 `TaskProgress { percent, current, completed, total }`
- `task/state`
- `task/artifact`：`{event, runId, artifact: {name, uri, size}}` → Scheduler 持久化

日志桥：Plugin Event → `TaskLogger.append()` + `EventBus.broadcast()`（Desktop + Web）。UI 关闭后日志继续持久化；UI 重开 = snapshot + tail。

## 37. Secret Injection

- TaskDefinition 只保存 `connectionId` / `secretRef`；**绝对不保存** password/token/privateKey。
- 执行前：Task → Connection Resolver → Secret Store → Plugin lifecycle payload（只给 backend lifecycle request hydrated secrets）。
- Secret 禁止出现在：task config、payload、logs、events、artifact metadata、export、database。

## 38–39. Host API 与权限

- 第一阶段 Host API 只加 `host.openScheduler({providerId, triggerId, connectionId, mode: "create"})`。
- Manifest 权限新增 `host.scheduler`，第一版语义 = 允许打开 Scheduler UI；**不允许插件静默创建/启用任务**。未来可加 `host.scheduler:write`。

## 40. Scheduler APIs

Web：

```
GET  /api/scheduler/tasks          POST /api/scheduler/tasks
GET  /api/scheduler/tasks/:id      PUT  /api/scheduler/tasks/:id    DELETE /api/scheduler/tasks/:id
POST /api/scheduler/tasks/:id/run      POST /api/scheduler/tasks/:id/cancel
POST /api/scheduler/tasks/:id/enable   POST /api/scheduler/tasks/:id/disable
GET  /api/scheduler/runs           GET  /api/scheduler/runs/:id
GET  /api/scheduler/runs/:id/logs  GET  /api/scheduler/runs/:id/artifacts
GET  /api/scheduler/resident       POST /api/scheduler/resident/:id/start
POST /api/scheduler/resident/:id/stop  POST /api/scheduler/resident/:id/restart
GET  /api/scheduler/events         (SSE)
```

Desktop API：`scheduler.listTasks() / saveTask() / deleteTask() / runTask() / cancelRun() / listRuns() / getLogs()` 等。

**禁止**再新增 `databaseBackupCommand / sshTaskCommand / filesTaskCommand` 之类业务特化 endpoint。

其他 API 原则：

- Update 采用 optimistic locking（`version`），冲突返回 **409 Conflict**。
- 错误映射至少区分：`task_not_found / provider_not_found / provider_unavailable / invalid_config / invalid_trigger / version_conflict / run_not_found / run_already_active / permission_denied / scheduler_unavailable`，不要全是 500。
- 所有 API 只调用 `SchedulerService`，**绝不直接操作 SQLite**。
- 日志查询必须支持 `afterSeq / limit / level / stream`，响应 `{entries, nextSeq, eof}`，前端可 tail -f。

## 41–45. Database Backup Adapter 与迁移

- **不要重写 backup export 逻辑**。新增 `DatabaseBackupTaskExecutor { service: BackupService }` 实现 `TaskExecutor`，流程：TaskRun → executor → 现有 BackupService → export → artifact → TaskRun result。
- 旧 `DatabaseBackupSchedule` → `TaskDefinition` 字段映射：name→task.name；connectionId→target.connectionId；frequency/intervalHours/timeOfDay/weekday/timeZone→trigger；includeStructure/includeData/includeObjects/tableFilterMode/tablePatterns/selectedTables/destinationDirectory/outputCompression/fileNamePattern/retentionCount→config。
- Migration 为独立 `SchedulerMigration`：幂等（`migrated` 标记）、原子（事务 + 失败 ROLLBACK、失败不标 migrated）、保留旧 ID（`task.id = old schedule.id`，`run.id = old run.id`）、legacy 数据迁移成功后仍保留作为回滚依据。
- 旧 UI（`ScheduledDatabaseBackupSettings.vue`）迁移期作为 compatibility adapter，不一次性硬删；backup 专用 `DatabaseBackupConfigFields.vue` 继续复用。

## 46–50. Scheduler UI

- 页面：SchedulerPage（全部/运行中/失败/常驻 过滤 + 新建任务）、TaskList、TaskEditor（基本信息 → Provider → Target → Action → Action Config → Trigger → Execution Policy → Logging/Retention）、TaskFormRenderer（复用现有 Plugin Form Field renderer，**不要单独做 SSHFormRenderer**）、RunList、RunDetail、LogViewer、ResidentList。
- Provider Picker：`installedPlugins.flatMap(readTaskProviders)`，禁止 `if (plugin.id === "ssh")`。
- Trigger UI 支持 Manual/Once/Interval/Cron/Startup；Cron 必须显示并持久化 timezone。
- 日志加载：snapshot → render → subscribe event → append live；不要每秒重拉全量。
- 错误状态：Provider missing → Unavailable；Trigger missing → Invalid；Connection missing → Warning/Invalid；任务不自动删除。

## 51–55. SSH / Files Plugin MVP

- SSH 第一阶段只做 **Execute Command**（command/working_directory/environment/timeout/pty → stdout/stderr/exit code）；第二阶段做 Resident Command（start/stop/restart/heartbeat/auto restart，如 `tail -F`）。复用现有 `io.dbx.ssh.connection` 连接生命周期，**不重做 SSH connection profile**。
- Files 优先 **Sync Directory**（source/destination/recursive/overwrite/delete_extra/checksum/resume/concurrency）。
- **Files 同步不得通过 filesystem RPC 拼装**（list→read→write 循环），必须 `scheduler → task/execute → files plugin native sync engine`（性能、resume、checksum、原子性、协议优化）。filesystem provider 保留给交互式浏览。

## 56–62. Background Worker / Resident

- `background_backup.rs` → `background_scheduler.rs`，保留 child process / worker lease / restart / OS startup registration / worker log，把 `BackupService` 换成 `SchedulerEngine`。
- Worker 模式：`dbx --scheduler-worker`（或 `DBX_PROCESS_ROLE`），沿用现有「当前 executable + 参数启动 child process」机制。
- Web/Docker：容器启动 main server + scheduler worker，不依赖浏览器打开页面。
- Resident Supervisor：每个 TaskDefinition 最多 1 active session；`ResidentSession` 状态：stopped/starting/running/stopping/crashed/degraded。
- Restart policy：`{enabled, max_restarts, backoff_seconds, restart_window}`，restart 必须有界，禁止无限 crash loop；到上限后 degraded。
- Lease 表（多 worker 预留）：`scheduler_leases(name, worker_id, lease_until, heartbeat_at)`；claim 用 `BEGIN IMMEDIATE` + compare lease + update；第一版 Desktop 单 worker 即可。

## 63–66. 事件流

- Desktop 事件：`dbx-scheduler-event`，类型：`task-changed / run-created / run-state / run-progress / run-log / resident-state`。
- Web 第一版用 **SSE**（`GET /api/scheduler/events`），不用 WebSocket；WebSocket 以后为 interactive resident stdin 再加。
- UI 日志：load snapshot → render → subscribe → append；绝不每 1 秒重拉全量日志。

## 67–69. Store / Service / Registry

- `SchedulerStore`（只负责 persistence，不执行插件）：`list_tasks / get_task / save_task / delete_task / enqueue_manual / enqueue_due / claim / update_run / finish_run / append_log / list_logs / save_artifact / recover / acquire_lease / heartbeat / release_lease`。
- `SchedulerService { store, registry }`：create/update/delete、manual run、cancel、validation、provider dispatch。
- `TaskExecutorRegistry { builtins: HashMap<String, Arc<dyn TaskExecutor>>, plugins: PluginTaskExecutorRegistry }`。

## 70–77. ID / Config / Export / Import / Copy

- Provider ID 必须稳定且带命名空间：`dbx.database-backup`、`io.dbx.ssh.tasks`、`io.dbx.files.tasks`；禁止裸 `ssh`/`files`/`backup`。
- Trigger ID：`io.dbx.ssh.tasks/execute`、`io.dbx.files.tasks/sync` 等。
- Task 逻辑 identity：`providerId + triggerId + connectionId`（供 UI 默认命名，如「SSH Execute · prod-web-01」）。
- Config 必须含 `config_version`（如 `{"configVersion": 1, ...}`）；`task/migrate` 第一版不做，字段先存在。
- Export JSON：`{schemaVersion, task:{name, providerId, trigger, execution, config, connectionId}}`，**不含任何 secret**。
- Import：parse → validate provider/trigger/form → connection binding → **保存为 disabled**。
- Copy Task：new UUID + name + " Copy" + `enabled=false`。

## 78–83. Audit / Security / Health / Metrics

- `task_audit` 表：`{id, task_id, action, actor_type, actor_id, metadata_json, created_at}`；记录 create/update/delete/run/cancel/enable/disable/resident start-stop-restart。
- API Security：所有 scheduler API 必须校验 task ownership、connection 存在、plugin 存在、provider capability；不能仅信任 `task.providerId`。
- Plugin 被卸载：Task 保留，状态 `unavailable`，UI 提示安装插件；插件升级后 trigger 不存在 → `invalid`；均不自动删除。
- Task Health：`healthy / warning / invalid / unavailable`。
- Metrics 第一版：total tasks、enabled tasks、running runs、failed runs (24h)、resident sessions。

## 84–90. 测试矩阵

- Scheduler Core：manual/once/interval/cron/startup、forbid/queue/parallel、retry、timeout、cancel、coalesce/skip、lease、claim race（并发 claim 必测）、recovery。
- Trigger：cron × 时区（Asia/Shanghai、America/Los_Angeles、UTC）× DST（spring forward / fall back）。
- Store：CAS update、concurrent save、claim race、delete active task、cancel running task、log sequence、artifact insert、migration idempotency。
- Plugin：manifest task-provider 接受/非法 trigger 拒绝/缺 capability 拒绝、task/validate|execute|start|stop|status|log|progress、固定方法校验、权限 gate、向后兼容。
- SSH：connection 成败、命令成败、non-zero exit、timeout、cancel、stdout/stderr、resident crash/restart limit、secret redaction。
- Files：copy/sync/checksum/overwrite/delete_extra/cancel/retry/partial failure/progress/artifact。
- Backup Regression：现有 scheduled_backup 全套 Rust/前端测试不得删除；改造成 adapter-level + scheduler-level 双层测试。

## 91–105. Multi-Agent DAG / Merge 顺序

```
Agent 0 (Contract/ADR)
├── Agent 1 Scheduler Core
├── Agent 2 Plugin Contract
        ↓
Agent 3 API | Agent 4 Backup Adapter | Agent 5 UI
        ↓
Agent 8 Background Worker
        ↓
Agent 6 SSH | Agent 7 Files
        ↓
Agent 9 Integration QA
        ↓
Agent 10 Lead Integrator
```

- 每个 Agent 独立 `git worktree`，不共享工作目录。
- Merge 顺序（严格）：A0 contract → A1 scheduler core → A2 plugin contract → A3 API → A4 backup adapter → A5 UI → A8 background worker → A6 SSH → A7 Files → A9 QA。
- Wave 1（A0/A1/A2）完成后**冻结 domain contract**；Wave 2 起不允许随意改 `TaskDefinition / TaskRun / TaskTrigger / TaskExecutionPolicy`（除非 Agent 0 审核）。
- TS 类型先手工维护，API 稳定后生成到 `apps/desktop/src/lib/scheduler/generated.ts`。
- Commit 规范：1 concern = 1 commit（如 `feat(scheduler): add sqlite store`），便于 cherry-pick/rebase。
- Feature Flags（迁移期并存）：`scheduler.generic.enabled`、`scheduler.background.enabled`、`scheduler.plugin_tasks.enabled`。
- 发布节奏：Release N 双轨并存 → N+1 Scheduler owns backup、legacy API=adapter → N+2 删旧 UI → N+3 移除 legacy writes。

## 106–109. JSON API Contract 示例

Task（Backup）：

```json
{
  "id": "task-1", "name": "prod backup", "providerType": "builtin",
  "providerId": "dbx.database-backup",
  "target": { "connectionId": "conn-prod" },
  "trigger": { "type": "cron", "expression": "0 2 * * *", "timeZone": "Asia/Shanghai" },
  "execution": {
    "mode": "run", "timeoutSeconds": 7200, "concurrency": "forbid",
    "retry": { "maxAttempts": 3, "backoffSeconds": 60, "backoffStrategy": "exponential" },
    "misfire": "coalesce"
  },
  "config": {}, "enabled": true
}
```

SSH Execute：

```json
{
  "id": "ssh-prod-check", "name": "检查 nginx", "providerType": "plugin",
  "providerId": "io.dbx.ssh.tasks", "target": { "connectionId": "ssh-prod" },
  "trigger": { "type": "cron", "expression": "*/5 * * * *", "timeZone": "Asia/Shanghai" },
  "execution": {
    "mode": "run", "timeoutSeconds": 60, "concurrency": "forbid",
    "retry": { "maxAttempts": 2, "backoffSeconds": 10, "backoffStrategy": "fixed" },
    "misfire": "coalesce"
  },
  "config": { "configVersion": 1, "command": "systemctl is-active nginx" }, "enabled": true
}
```

SSH Resident：

```json
{
  "name": "生产日志采集", "providerType": "plugin", "providerId": "io.dbx.ssh.tasks",
  "execution": { "mode": "resident", "restart": { "enabled": true, "maxRestarts": 20, "backoffSeconds": 5 } },
  "config": { "configVersion": 1, "command": "tail -F /var/log/app.log" }
}
```

## 110–111. 范围控制

第一版**禁止**做：分布式/K8s scheduler、Redis/RabbitMQ queue、Quartz/Temporal/Airflow、任意 plugin RPC、cron UI DSL、RBAC overhaul、secrets manager overhaul、workflow DAG、task dependency graph、condition engine。

第一版只做：Task / Trigger / Execution / Plugin / Run / Logs / Resident。

第二版再说：Event Trigger、Webhook、任务依赖 DAG、失败通知（Email/Webhook/Slack/Lark）、Metrics Dashboard、任务模板、AI 建任务。

## 112. 各 Agent 禁止修改区

- Scheduler Core Agent：DO NOT modify `apps/desktop`、`src-tauri`、plugin manifests、SSH/files plugin。
- Plugin Contract Agent：DO NOT modify scheduler engine、backup、frontend、SSH business logic。
- API Agent：DO NOT access SQLite directly；不加业务特化 scheduler 逻辑。
- UI Agent：DO NOT define a second scheduler data model；只用 API contract。

## 124–128. 里程碑与验收

里程碑：

1. **MVP**：Generic Scheduler + Database Backup（创建/Cron/Enable/Disable/Run Now/Cancel/History/Logs，UI 关闭后 worker 继续执行）。
2. SSH Execute（验证 Plugin Task Contract：两种 Provider 共用同一 Task Editor / TaskRun / Log Viewer / Scheduler）。
3. SSH Resident（验证 resident session/restart/heartbeat/logs，Scheduler 从 cron 升级为真正 Task Runtime）。
4. Files Sync（验证 artifact/progress/large job/retry/cancel；三种执行类型齐全）。

最终架构验收必须全 YES：

```
新增 S3 插件：只需添加 Task Provider？          YES
新增 Kubernetes 插件：Scheduler 不需要改？      YES
新增 HTTP Job：不需要新增 scheduler_http_* API？ YES
卸载 SSH plugin：已有任务仍保留？               YES
关闭 UI：SSH resident 继续？                    YES
修改 task：有 version/optimistic locking？      YES
两个 worker：可能重复执行同一个 Run？           NO
日志：UI 关闭后继续积累？                       YES
Backup：已变成普通 Provider？                   YES
```

## 131. 主控 Agent 十五条军规

1. 先以 TaskDefinition / TaskRun 为中心设计。
2. 不允许出现第二种 Scheduler。
3. Backup 是 builtin provider。
4. SSH / Files 是 plugin task provider。
5. UI 不拥有任务生命周期。
6. Worker 不依赖 UI。
7. Plugin 不直接管理 scheduler SQLite。
8. Scheduler 不知道 SSH/files 业务。
9. Secret 永远不进入 task config/log/event。
10. 所有长期任务必须可恢复。
11. 所有运行都必须有 run id。
12. 所有日志都必须归属 run id。
13. 所有插件执行必须经过固定 task RPC。
14. Manifest 声明能力，Runtime 强制能力。
15. 先完成 Backup → Plugin Execute → Resident 三个验证阶段。

## 132. 实施锚点（已在本仓库核对存在）

| 锚点 | 复用内容 |
|---|---|
| `crates/dbx-core/src/scheduled_backup/engine.rs` | worker loop、cancel、heartbeat、progress |
| `crates/dbx-core/src/scheduled_backup/store.rs` | SQLite persistence、transaction、claim/enqueue、migration |
| `src-tauri/src/background_backup.rs` | 后台 worker、lease、restart、OS startup |
| `apps/desktop/src/composables/useScheduledDatabaseBackups.ts` | 现有 backup API 生命周期 |
| `plugins/manifest.schema.json` | contribution/permission 定义 |
| `crates/dbx-plugin-runtime/src/plugins/manifest.rs` | Manifest Rust model、host API version/permission |
| `crates/dbx-plugin-runtime/src/plugins/runtime.rs` | Sidecar lifecycle/event/request |
| `plugins/examples/hello-workbench/backend/src/main.rs` | connection/filesystem/event/MCP 插件示例 |

注：`docs/adr/` 目录当前不存在，由 Agent 0 创建。

## 133. 最终目标

用户只看到一个「计划任务」中心（任务 / 运行记录 / 常驻任务 / 日志），底层只有一个 Scheduler Runtime。以后加任何插件 = Manifest + Task Provider + Executor，而不是「一个插件 + 一个 cron 页面 + 一个 worker + 一个 state db + 一套 API + 一套日志」。
