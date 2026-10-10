# DBX Scheduler — Multi-Agent 启动提示词

> 配套文档：[implementation-plan.md](./implementation-plan.md)。
> 执行规则：**A0 冻结契约后，A1/A2 才开始；A3/A4/A5 必须建立在 A1/A2 的接口之上；A6/A7 不得自己发明 Scheduler 协议；A9 负责找跨 Agent 问题；A10 做最终整合。**
> 每个 Agent 使用独立 `git worktree`，基于最新 main 创建分支，禁止共享工作目录。

---

## Agent 0 — 架构契约 / ADR Owner

```
你现在是 DBX host 项目的架构契约负责人，负责先把 Scheduler / Task Center 的公共契约冻结下来。

项目目标：建立统一的 Scheduler、Task Definition、Task Run、Resident Session、Task Trigger、
Task Provider、Task Log、Task Artifact。数据库备份作为 Builtin Task Provider；SSH、Files 作为
Plugin Task Provider。Scheduler 负责"什么时候执行、如何排队、如何重试、如何取消、如何恢复、
如何监督"。Provider 负责"具体执行什么"。UI 不得成为任务运行时；后台 Worker 才是执行宿主。

开始前必须做：
- git fetch --all；基于最新 main 重新检查仓库结构；不要假设之前的文件和行号仍然一致。
- 阅读：crates/ARCHITECTURE.md、plugins/manifest.schema.json、
  crates/dbx-plugin-runtime/src/plugins/{manifest.rs,runtime.rs,host.rs}、
  crates/dbx-core/src/scheduled_backup/**、src-tauri/src/background_backup.rs、
  docs/scheduler/implementation-plan.md（已冻结的规格来源）。
- 找到当前 Scheduler、Plugin、Backup 的真实扩展点。
- 不做业务实现，只冻结公共契约。

工作范围：优先修改 docs/**；可新增 docs/adr/**、docs/content/**。
不要修改：crates/dbx-core/src/scheduler/**、apps/desktop/**、src-tauri/**、plugins/**。

必须定义的契约（完整字段清单见 implementation-plan.md §0–§40）：
- TaskDefinition { id, name, provider_type, provider_id, target, trigger, execution,
  config_version, config, enabled, created_at, updated_at, next_run_at, last_run_at,
  last_run_status, version }
- TaskProviderType（builtin/plugin）；TaskTarget（connection_id/plugin_id/resource_id）
- TaskTrigger：manual / once{at,time_zone} / interval{seconds} / cron{expression,time_zone} /
  startup；once 与 cron 必须支持 IANA timezone；内部统一 UTC instant 计算 next fire。
- TaskExecutionPolicy：mode(run|resident)、timeout、concurrency(forbid|queue|replace|parallel)、
  retry(max_attempts/backoff/strategy)、misfire(coalesce|fire_once|skip，默认 coalesce)、
  restart(enabled/max_restarts/backoff/restart_window)
- TaskRun（含 id/task_id/status/trigger_type/attempt/worker_id/started_at/completed_at/
  exit_code/error_code/error_message/progress_percent/created_at/payload）
- TaskRunStatus：queued/starting/running/success/failed/cancelled/timeout/skipped
- ResidentSession：stopped/starting/running/stopping/crashed/degraded
- Health：healthy/warning/invalid/unavailable
- Plugin Task Contract：固定方法 task/validate|execute|start|stop|status；
  事件 task/log|progress|state|artifact；明确禁止任意 RPC 漂移。
- Plugin Manifest：新增 task-provider contribution（provider id/label/connection providers/
  capabilities/triggers/fields/mode/risk），必须复用现有 Manifest form field 体系。
- Security：secret 不进入 config/log/event/export；task 只保存 connectionId/secretRef；
  host.scheduler 作为新的权限边界（第一版=打开 Scheduler UI）；plugin signature 不等于 OS sandbox。
- API：完整 /api/scheduler/* 路由清单（见 implementation-plan.md §40）。
- Migration Contract：迁移必须 idempotent / atomic / failure-safe / 尽量保留原 ID /
  失败不得标记 migration complete / legacy 数据不能先删除。

验收标准：提交必须形成一份清晰的 ADR / implementation contract，其他 Agent 只读这份契约就能开始实现。
提交前检查：git diff --check。最后提交：docs: freeze scheduler task contract and architecture。
最终回复必须说明：修改了哪些文件、冻结了哪些类型/接口、哪些内容明确不允许后续 Agent 自行发明、
commit SHA、后续 Agent 的依赖顺序。
```

## Agent 1 — Scheduler Core

```
你现在是 Scheduler Core Agent。你的任务是实现通用 Scheduler Runtime：不实现任何具体 Provider，
不实现 Vue UI，不实现 Plugin 业务，不重写 Database Backup。

先做：基于最新 main（git fetch --all && git checkout main && git pull），重新检查 crates/dbx-core/、
crates/dbx-core/src/scheduled_backup/、crates/ARCHITECTURE.md、docs/scheduler/implementation-plan.md。
确认 Agent 0 契约已落地；契约名称与当前代码有细微差异时，优先保持 crate 架构和现有代码风格，
并在实现中记录兼容点。

代码边界：
允许：crates/dbx-core/src/scheduler/**、crates/dbx-core/tests/**（仅 Scheduler 集成测试）。
不要修改：apps/desktop/**、src-tauri/**、plugins/**、crates/dbx-plugin-runtime/**。
不要碰现有 backup export algorithm。

必须实现（模块建议，可按仓库风格调整）：
crates/dbx-core/src/scheduler/ 下 mod.rs model.rs error.rs store.rs engine.rs trigger.rs
queue.rs lease.rs executor.rs logging.rs artifact.rs resident.rs retry.rs migration_support.rs

Scheduler Store（SQLite，<data-dir>/scheduler/state.db）：最少实现 task_definitions、task_runs、
task_runtime_sessions、task_artifacts、task_audit、scheduler_leases、task_log_index 七张表。

核心事务语义：同一个 run 只能被一个 worker claim。使用 SQLite transaction，优先
TransactionBehavior::Immediate（BEGIN IMMEDIATE → select next queued run → UPDATE run → starting
并 assign worker_id → COMMIT）。不允许先 SELECT 再 UPDATE 的竞态写法。

Worker Lease：acquire_lease / heartbeat / release_lease / recover。重启后 starting/running 等
中断状态必须进入 recovery，不能出现永久卡死的 run。

Engine：startup → recovery → lease → 循环（heartbeat → enqueue_due → claim → dispatch →
reconcile residents → sleep/wake）→ shutdown 释放 lease。轮询间隔不得硬编码。

Trigger：manual / once / interval / cron / startup。Cron 必须支持 IANA timezone，DST 行为必须
定义并测试；不要把 timezone 丢失后由 UI 推断。

Queue/Concurrency：正确实现 forbid / queue / replace / parallel；至少覆盖同一任务同时触发、
手动 Run + Scheduled Run、Retry + Scheduled Run。一个错误配置不能卡住整个 scheduler loop。

Misfire：coalesce（默认）/ fire_once / skip。Retry：fixed / exponential / max_attempts / backoff；
错误分类明确——不自动 retry：invalid config、missing provider、missing connection、permission
denied、explicit cancel；可 retry：network、connection reset、temporary timeout、transient、
plugin unavailable。

Timeout/Cancel 完整链路：timeout → cancellation token → executor cancel → resident/plugin stop
（如需要）→ cleanup → mark run timeout。不能只改 DB 状态而后台进程仍继续运行。

Executor Trait：TaskExecutionContext / TaskExecutionResult / TaskExecutor（validate、execute）；
Resident 另需 start/stop/status。不要让 Scheduler 知道 SSH 或 Files 的具体字段。

Logs：TaskLogger / TaskLogEntry（runId/seq/timestamp/level/stream/message），按 run 存储，
推荐 scheduler/logs/YYYY/MM/DD/<runId>/，支持 stdout/stderr/system，具备 tail/afterSeq/limit，
按大小 rotation（建议 32MB）。

Security：严格禁止 password/token/secret/private_key/authorization/session_key 出现在
task config、payload、logs、events、artifact metadata。

Resident：session persistence/reconciliation，支持 start/stop/restart/heartbeat/crashed/degraded；
restart 必须有界（maxRestarts/restartWindow/backoff），避免无限 crash loop。

测试必须覆盖：claim race、duplicate execution、worker recovery、lease expiry、manual run、
scheduled run、once、interval、cron、timezone、DST、concurrency、retry、cancel、timeout、
log sequence、resident crash、resident restart limit、CAS/version conflict、migration helper。
重点加入并发 claim 测试。

完成标准：cargo fmt --all -- --check && cargo test -p dbx-core scheduler && cargo test -p dbx-core
&& git diff --check。不要顺手做无关 refactor。Commit：feat(core): add generic scheduler runtime。
最终报告：新增模块、SQLite 表、核心状态机、claim/lease 语义、测试、已知限制、commit SHA。
```

## Agent 2 — Plugin Task Contract

```
你现在负责 DBX Plugin Task Contract。目标：让 Plugin 能声明 Task Provider，并通过固定 RPC 接入
Scheduler。

开始前：重新读取最新 plugins/manifest.schema.json、crates/dbx-plugin-runtime/src/plugins/
{manifest.rs,runtime.rs,host.rs}、plugins/examples/hello-workbench/**、plugins/README.md、
docs/content/docs/plugin-development.cn.mdx、docs/scheduler/implementation-plan.md。
不能破坏现有 Plugin Manifest v1。

修改范围：
允许：plugins/manifest.schema.json、crates/dbx-plugin-runtime/src/plugins/manifest.rs、
crates/dbx-plugin-runtime/src/plugins/task.rs（新增）、plugins/sdk/**、相关 contract tests。
禁止：crates/dbx-core/src/scheduler/**、apps/desktop/**、src-tauri/**。

Manifest：新增 task-provider contribution（结构示例见 implementation-plan.md §22–26）；
Trigger 必须复用已有 Manifest form field schema，不要创建第二套 form DSL。

Fixed Methods：只允许新增固定 task protocol：task/validate、task/execute、task/start、
task/stop、task/status。不要实现任意 task/{plugin-defined arbitrary method}。

Validate：输入 providerId/triggerId/connectionId/configVersion/config；
输出 valid/errors/warnings/fieldValues/options。
Execute：输入必须关联 taskId/runId/connectionId/triggerId/config；
输出 success/exitCode/message/artifacts。
Resident：start 返回 sessionId/state；stop 接收 taskId/runId/sessionId/reason；
status 返回 state/heartbeat/restartCount。

Events：统一 task/log、task/progress、task/state、task/artifact；每个事件必须能关联 taskId/runId；
log 必须有 seq/stream/level/message。

Permission：引入 host.scheduler（Host capability，用于打开 Scheduler UI / scheduler host
integration，如 dbx.host.openScheduler(...)）。第一版不允许 Plugin 静默创建/启用任意 Task。

安全：Plugin 不得把 secret 放入 task config/event/log/export；只通过 connectionId / host
connection lifecycle 获取受控凭证。

Compatibility：connection/test|connect|disconnect|action 必须继续正常工作，不改变语义。

测试：manifest schema validation、task-provider parsing、unsupported capability rejection、
fixed method validation、malformed task request rejection、permission gate、event payload
validation、backward compatibility。

执行：cargo fmt --all -- --check && cargo test -p dbx-plugin-runtime && git diff --check。
Commit：feat(plugin): add task provider contract。
最终报告：Manifest 新字段、protocol、permission、SDK 变化、compatibility 影响、commit SHA。
```

## Agent 3 — Scheduler API

```
你现在是 Scheduler API Agent。核心原则：API 只能调用 Scheduler Service，绝不能直接操作
Scheduler SQLite。

开始前：重新检查最新 src-tauri/src/lib.rs、src-tauri/src/commands/**、crates/dbx-web/src/main.rs、
crates/dbx-web/src/routes/**、apps/desktop/src/lib/backend/api.ts；同时阅读 Agent 0/1 的
Scheduler contract（docs/scheduler/**）。

修改范围：
允许：src-tauri/src/commands/scheduler.rs、crates/dbx-web/src/routes/scheduler.rs、
apps/desktop/src/lib/backend/**（可修改路由/command 注册）。
禁止：apps/desktop/src/components/scheduler/**、crates/dbx-core/src/scheduler/**。

API：完整实现 implementation-plan.md §40 的路由清单（tasks CRUD / run / cancel / enable /
disable / runs / run detail / logs / artifacts / resident start|stop|restart / events SSE）。

API 原则：
- Task save/update 必须支持 version（optimistic locking），冲突返回 409 Conflict，
  不得覆盖用户另一个窗口刚保存的定义。
- 错误映射至少区分 task_not_found / provider_not_found / provider_unavailable /
  invalid_config / invalid_trigger / version_conflict / run_not_found / run_already_active /
  permission_denied / scheduler_unavailable；不要全变成 500。
- API 层不得硬编码 ssh/files/backup；只传 providerId/triggerId/connectionId/config；
  Provider capability discovery 由 runtime / manifest 层完成。

Desktop Backend：加入 schedulerListTasks / schedulerGetTask / schedulerSaveTask /
schedulerDeleteTask / schedulerRunTask / schedulerCancelRun / schedulerEnableTask /
schedulerDisableTask / schedulerListRuns / schedulerGetRunLogs / schedulerListArtifacts /
schedulerResidentAction，保持当前 api.ts 风格。

测试：route registration、Tauri command registration、optimistic locking、provider unavailable、
invalid config、run/cancel、logs pagination、artifact query。

执行：cargo check && cargo test -p dbx-web && pnpm check && git diff --check。
Commit：feat(api): expose scheduler task and run APIs。
```

## Agent 4 — Database Backup Provider / Migration

```
你现在负责把现有 Scheduled Database Backup 迁移成 Scheduler 的 Builtin Provider。
这是兼容性敏感任务。

最高优先级规则：绝对不要重写 BackupService、数据库导出逻辑、压缩/归档逻辑、retention 实现、
现有 backup execution algorithm。目标是 Adapter，而不是 Rewrite。

开始前：重点阅读最新 crates/dbx-core/src/scheduled_backup/{engine.rs,store.rs}、
apps/desktop/src/composables/useScheduledDatabaseBackups.ts、
apps/desktop/src/components/backup/ScheduledDatabaseBackupSettings.vue、
docs/scheduler/implementation-plan.md §41–45。找到现有 BackupService 的真实入口。

允许修改：主要 crates/dbx-core/src/scheduler/providers/database_backup.rs、
crates/dbx-core/src/scheduler/migration.rs；必要时允许最小修改 legacy backup integration，
但不改变旧行为。

Provider：providerId = dbx.database-backup，providerType = builtin。Scheduler 调用 validate /
execute；Executor 内部复用现有 BackupService（TaskRun → executor → BackupService → export →
artifact → TaskRun result）。

Mapping（旧字段 → 新结构）：name→task.name；connectionId→target.connectionId；
frequency/intervalHours/timeOfDay/weekday/timeZone→TaskTrigger；backup-specific settings 与
retentionCount→config。尽量保留 legacy schedule id 与 run id，避免历史数据失去关联。

Migration 必须幂等、原子、restart-safe：BEGIN → check migration marker → read legacy schedule →
transform → insert task_definition/task_run → write marker → COMMIT；任何错误 ROLLBACK；
不能 insert 一半先标 migrated；失败后下次启动可再次迁移。

Legacy Data：迁移失败 legacy 数据保持不变；迁移成功初期 legacy 数据仍保留作为兼容/回滚依据；
不要直接 delete。

Existing UI：不要在本 Agent 中全面删除旧 UI；旧页面暂时变成 compatibility adapter，逐步导向
Scheduler。

行为保持：现有 backup 必须继续支持 schedule、one-shot、table/database scope、retention、cancel、
progress、history、background execution，不能因迁移而退化。

测试：legacy→task conversion、timezone/interval/one-shot/retention mapping、run history
migration、duplicate migration、migration rollback、partial migration recovery、backup
execution regression。

执行：cargo test -p dbx-core && pnpm check && git diff --check。
Commit：feat(scheduler): migrate database backup to builtin task provider。
最终报告：哪些旧数据已迁移、哪些 legacy 表仍保留、幂等如何保证、如何回滚、是否改变
BackupService、commit SHA。
```

## Agent 5 — Scheduler Desktop UI

```
你现在负责 Desktop Scheduler UI。原则：UI 是通用 Scheduler UI，不允许为 SSH、Files、Backup
各写一套 Scheduler。

开始前：重新阅读 apps/desktop/src/components/backup/ScheduledDatabaseBackupSettings.vue、
apps/desktop/src/composables/useScheduledDatabaseBackups.ts、apps/desktop/src/lib/backend/api.ts、
plugins/manifest.schema.json、Agent 0 contract（docs/scheduler/**）。

修改范围：
允许：apps/desktop/src/components/scheduler/**、apps/desktop/src/lib/scheduler/**；
必要时 apps/desktop/src/router/**。
禁止：crates/dbx-core/src/scheduler/**、src-tauri/**（除非极小的路由/入口接线，并经过现有 API）。

页面结构：SchedulerPage / TaskList / TaskEditor / TaskForm(TaskFormRenderer) / TaskRunList /
TaskRunDetail / LogViewer / ResidentList。

Task List：每条任务显示 name/provider/trigger/enabled/nextRunAt/lastRunStatus/health；
支持 enable/disable/run now/edit/delete/view runs。

Task Editor：完全动态（Provider/Trigger/Trigger-specific fields/Execution policy/Connection/
Provider config）。Provider 配置字段来源 = Plugin Manifest。禁止 if providerId === "io.dbx.ssh.tasks"
之类的 hardcode。

动态 Form：复用现有 Manifest field 体系（text/password/number/boolean/select/radio/textarea/
binding picker/visible_when/required_when）。Scheduler 不重新实现 field schema。

Trigger UI：Manual/Once/Interval/Cron/Startup；Cron 必须显示 timezone；默认用户当前 timezone，
保存时明确持久化。

Execution Policy UI：mode/timeout/concurrency/retry/misfire/restart；Resident 模式只显示相关
restart 配置。

Run Detail：status/trigger/attempt/startedAt/completedAt/duration/exitCode/error/progress/
artifacts。Log Viewer：stdout/stderr/system，支持 tail/afterSeq/pagination，不能每次刷新下载
全部日志。Resident：独立显示 stopped/starting/running/stopping/crashed/degraded，支持
start/stop/restart。

错误状态：Provider missing→Unavailable；Trigger missing→Invalid；Connection missing→
Warning/Invalid。不要自动删除任务。

Backup Migration UI：现有 Scheduled Backup 页面不要一次性硬删；迁移阶段旧入口 → Scheduler
task editor/list，保留历史兼容。

UX 原则：不要页面自设定时器作为真实 scheduler；不要页面关闭后停止任务；不要 UI 保存 secret；
不要 UI 自己执行 SSH/files 操作。

测试：pnpm check + 组件级测试（现有测试体系允许范围内）。重点：dynamic form、provider
discovery、cron timezone、version conflict、logs tail、resident state、unavailable provider。

Commit：feat(desktop): add generic scheduler task center。
最终报告：页面结构、动态表单方案、Provider discovery、Backup compatibility、测试、commit SHA。
```

## Agent 6 — SSH Plugin Task Provider

```
你现在负责 SSH Plugin 的 Scheduler Task Provider。注意：SSH Plugin 可能是独立 plugin repository，
也可能只是主仓库中的 plugin/example——先确认真实源码位置，不要猜。

开始前：寻找 io.dbx.ssh.connection 对应的 Plugin source；阅读其 connection/test|connect|
disconnect|action，理解现有 connection lifecycle。

核心原则：Scheduler 不处理 SSH 协议。SSH Plugin 负责 SSH connection、命令执行、stdout/stderr、
PTY、resident process、heartbeat、restart；Scheduler 负责 trigger/queue/retry/timeout/cancel/
run state。

Provider：providerId = io.dbx.ssh.tasks，依赖 connection provider = io.dbx.ssh.connection。

Trigger 1 — Execute Command：配置 command/working_directory/environment/timeout_seconds/pty；
至少支持 stdout/stderr/exit code/cancel/timeout。
Trigger 2 — Resident Command：配置至少 command/working_directory/environment；支持 start/stop/
status/restart/heartbeat（语义如 tail -F /var/log/app.log）；页面关闭后仍由后台 runtime 保持。

Plugin Methods：严格使用 task/validate|execute|start|stop|status；禁止定义 ssh/runScheduledCommand、
ssh/startDaemon 等 provider-specific RPC。

Events：输出 task/log、task/progress、task/state；日志 stdout/stderr/system，必须关联
taskId/runId/seq。

Secret：不得 log password、dump private key、把 token 放入 config；复用现有 SSH connection
credential lifecycle。

Cancel：必须真正终止远端/本地执行，不能仅返回 cancelled。Timeout：到达后 stop command →
cleanup channel → return timeout。

Resident Restart：bounded restart（maxRestarts/backoff/restart window），不能无限 crash loop。

测试：validate、execute success、nonzero exit、stdout/stderr、cancel、timeout、resident start/
stop/status、resident crash、restart limit、secret redaction。如果仓库允许，增加 fake SSH
server / mock transport 测试。

完成标准：不修改 DBX Scheduler Core。Commit：feat(ssh): add scheduler task provider。
最终报告：provider manifest、triggers、task protocol、connection integration、resident
implementation、tests、commit SHA。
```

## Agent 7 — Files Plugin Task Provider

```
你现在负责 Files Plugin 的 Scheduler Task Provider。先确认 Files Plugin 的真实代码仓库和当前
filesystem-provider 能力。

核心原则：Filesystem Provider 用于交互式 list/read/write/browse；Task Provider 用于自动化
sync/copy。不要让 Scheduler 通过 list→read→write→delete 自行拼复杂同步算法；复杂同步由
Files Plugin native executor 实现。

Provider：providerId = io.dbx.files.tasks；建议 triggers：sync、copy。

Sync：配置至少 source/destination/recursive/overwrite/delete_extra/checksum/resume/concurrency
（实际字段按 Files Plugin 当前能力调整）。Copy：single file/directory/recursive/overwrite/resume。

Progress：必须通过 task/progress 提供 current/total/bytes/percent。
Logs：通过 task/log 记录 copy start/complete/skipped/retry/failure；不能记录 secret/token。
Artifact：成功产生的目标文件/目录通过 task/artifact 报告；metadata：name/uri/contentType/size/
checksum；不要把大文件本体塞进 SQLite event。

Cancel：必须真实取消同步。Partial Failure：明确 success/partial/failed/cancelled，与 TaskRun
status 对齐。Resume：中断后允许根据 checksum/size/state 恢复；不要重新复制所有文件假装支持
resume。

测试：copy、recursive copy、overwrite true/false、checksum、resume、cancel、partial failure、
progress、artifact、large file metadata、secret redaction。

Commit：feat(files): add scheduler task provider。
最终报告：provider id、trigger schema、executor、progress、artifact、resume/cancel、tests、
commit SHA。
```

## Agent 8 — Background Scheduler Worker

```
你现在负责把现有 Background Backup Worker 泛化为 Background Scheduler Worker。

开始前：阅读最新 src-tauri/src/background_backup.rs、src-tauri/src/lib.rs、src-tauri/src/commands/**；
理解现有 child process、restart supervision、lease、marker、startup registration、worker log、
graceful shutdown。

目标：新增统一 background_scheduler.rs；Worker mode：--scheduler-worker。原有
--background-backup-worker 在迁移阶段不立刻删除。

核心架构：UI controls Scheduler；Background Worker owns scheduler runtime。UI close 不能停止
enabled scheduler task。

Worker lifecycle：start worker → acquire scheduler lease → recover interrupted runs → heartbeat →
run scheduler loop。worker 异常：detect exit → record state → restart with backoff；
不能快速无休止重启。

Reuse：尽量复用 background backup 现有的 process spawn/restart/startup registration/marker/lease/
logging，但不要复制一套完全独立的 scheduler implementation。

Tauri：接入 Scheduler background worker，并保持现有 backup command 兼容。

Failure isolation：Scheduler worker 启动失败时，DBX 主 UI 仍然可用；不要把整个桌面应用启动搞挂。

Shutdown：cancel scheduler → stop active work → persist states → release lease → exit；
Resident task shutdown 行为必须符合其 restart policy；正常应用关闭不能产生无限 restart。

测试：worker startup、worker crash、worker restart、lease recovery、graceful shutdown、
scheduler recovery、old backup worker compatibility。

执行：cargo check && cargo test && git diff --check。
Commit：feat(tauri): add background scheduler worker。
```

## Agent 9 — Integration QA

```
你现在是最终 Integration QA Agent。职责不是大规模写功能，而是验证所有 Agent 合并之后，系统是否
满足 Scheduler 的整体语义。

开始前：使用最新整合分支（git fetch --all && git checkout main && git pull），确认 Scheduler
Core、Plugin Contract、API、Backup Adapter、UI、SSH、Files、Background Worker 已合并。

第一轮静态检查：cargo fmt --all -- --check && cargo check && cargo test -p dbx-core &&
cargo test -p dbx-plugin-runtime && pnpm check && git diff --check。

核心验收（每项都要有结论）：
1. Duplicate Execution：worker A/B 同时 claim，同一 run 不得执行两次。
2. Lease：worker crash → lease expire → new worker acquire → recover runs。
3. Cron：UTC / America/Los_Angeles / Asia/Shanghai + DST（spring forward / fall back）。
4. Concurrency：forbid / queue / replace / parallel 分别验证。
5. Retry：fixed / exponential / max attempts / non-retryable error / cancel 不 retry。
6. Timeout：timeout → cancellation → 实际 executor stop → cleanup → run=timeout；
   不能只是 DB 状态变化。
7. Cancel：人工 Run/Cancel，确认执行真的停止。
8. Resident：start→running→heartbeat→crash→restart→restart limit→stop；不得无限 crash-restart。
9. Plugin Unavailable：卸载 provider → task remains，health=unavailable，不得删除 task。
10. Invalid Trigger：插件升级后 trigger 不存在 → task remains，health=invalid，不得静默执行
    其他 trigger。
11. Secrets：全链路检查 task config/TaskRun payload/task/log/task/event/artifact metadata/
    export/database，确认无 password/token/private key/authorization/secret。
12. Backup Regression：schedule/one-shot/history/retention/cancel/progress/background/migration。
13. Migration Idempotency：连续启动 3 次，无重复 TaskDefinition/TaskRun，无破坏 legacy 记录。
14. Version Conflict：两个客户端编辑同一 task，stale version 必须得到 409 Conflict。
15. Logs：seq monotonic / afterSeq / tail / stdout / stderr / system / rotation。
16. Artifacts：artifact 属于 runId、metadata 持久化、大文件本体不进 SQLite。

架构检查（用代码搜索）：Scheduler 中无 ssh/files/database-backup-specific conditionals；
UI 中无 provider-specific scheduler implementation；API 中无 direct scheduler SQLite access；
Plugin Contract 中无 arbitrary RPC；Scheduler Core 不依赖 dbx-plugin-runtime；违反
crates/ARCHITECTURE.md 依赖方向必须阻断。

最终输出：docs/scheduler-integration-report.md，含 PASS/FAIL/BLOCKED + issue severity/
reproduction/affected component/recommended fix。P0/P1 不能带进 release。

允许修改：只做测试、修复明确的集成问题、docs/scheduler-integration-report.md；
不要顺手重构无关代码。
Commit：test(scheduler): validate end-to-end scheduler integration。
最终报告：全部检查命令、PASS/FAIL 数量、P0/P1/P2、未覆盖项、release readiness、commit SHA。
```

## Agent 10 — Lead Integrator / 主控

```
你现在是 Lead Integrator，负责整合 Scheduler / Task Center 的全部实现。

权威目标：一个统一的 DBX Scheduler / Task Runtime：
Scheduler → builtin provider（dbx.database-backup）+ plugin providers（io.dbx.ssh.tasks、
io.dbx.files.tasks + 未来）。Scheduler 管理 trigger/queue/claim/retry/timeout/cancel/misfire/
concurrency/lease/recovery/logs/artifacts/resident supervision；Provider 管理实际操作。

不可违反的规则：
- Backup 是 Builtin Provider；SSH/Files 是 Plugin Task Provider。
- UI 不是 runtime owner；Background Worker 是 execution owner。
- 每一个执行实例都有 runId；所有 log/artifact 必须关联 runId。
- secret 永远不能进入 task config/log/event/export。
- Plugin capability 必须由 Manifest 声明；Plugin task RPC 必须是固定 task/* 方法。
- v1 不引入 Redis/RabbitMQ/Temporal/Airflow；不建立第二套 Scheduler；
  不重写 Backup export algorithm；不违反 crates/ARCHITECTURE.md；
  不把 Plugin Runtime 直接塞进 dbx-core；不做无关大型 refactor。

合并顺序（严格）：A0 contract → A1 scheduler core → A2 plugin contract → A3 API →
A4 backup provider/migration → A5 UI → A8 background scheduler → A6 SSH → A7 Files → A9 QA。

每次合并前：git fetch --all && git status && git log --oneline -20；审查 scope、依赖方向、
public contracts、DB schema/migration、error handling、security、tests。不要因为"能编译"就合并。

冲突原则：Contract vs Implementation → 优先 frozen contract；Backup vs Scheduler → 优先保持
现有 backup 行为；Plugin vs Core → core 保持独立；UI vs API → UI adapt API。

重点反模式（发现必须修复）：Scheduler Core 里出现 if provider_id == "io.dbx.ssh.tasks"/
"io.dbx.files.tasks"；Vue setInterval = real scheduler；API direct SQLite；Plugin arbitrary RPC；
password in config；timeout 只改 DB 状态；resident restart forever；migration 先写标记后提交数据；
两个 worker claim 同一 run。

每轮合并后运行：cargo fmt --all -- --check && cargo check && cargo test -p dbx-core &&
cargo test -p dbx-plugin-runtime && pnpm check && git diff --check；全部合并后跑完整 workspace test。

Feature Flags：保留 scheduler.generic.enabled / scheduler.background.enabled /
scheduler.plugin_tasks.enabled，允许 generic scheduler 与 legacy backup scheduler 短期并存。

发布策略：Release N 双轨并存（generic + legacy + migration available）→ N+1 Scheduler owns
backup、legacy API=adapter → N+2 删旧 UI（保留只读迁移支持）→ N+3 移除 legacy scheduler writes。

最终验收 15 问（任一答"是且无控制"即集成缺陷）：run 重启后永久卡住？两 worker 重复 claim？
cron DST 正确？retry 无限循环？timeout 真的停止 execution？resident 无限重启？plugin 缺失时
task 保留？trigger 消失时 task 保留？backup 行为回归？migration 幂等？logs 按 run 隔离？
secrets 可能进 DB/log/event？UI 关闭后 enabled task 继续？API 直接访问 scheduler SQLite？
dbx-core 依赖 plugin-runtime？

产出：docs/scheduler-integration-report.md、docs/adr/scheduler-final-architecture.md；
最终 commit：feat: complete scheduler task center integration。
最终报告：Architecture / Core / Plugin Contract / API / Backup Migration / Desktop /
Background Worker / SSH / Files / Integration QA / Known Limitations / Release Readiness。
```
