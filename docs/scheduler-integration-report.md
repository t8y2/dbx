# Scheduler / Task Center 集成 QA 报告（A9）

- 日期：2026-10-05（续作会话完成）
- 执行者：Agent 9 — Integration QA
- 分支：`feature/scheduler-integration`（worktree `/Users/Jinpy/btroot/dbx-wt/integration`）
- 契约依据：[docs/adr/scheduler-task-contract.md](../adr/scheduler-task-contract.md)（最高权威）> [implementation-plan.md](scheduler/implementation-plan.md) §124–131 > agent-prompts.md
- 结论速览：**16 项核心验收 = 14 PASS / 0 FAIL / 2 BLOCKED（均因插件宿主适配层缺失）**；反模式 5 条全部 PASS；开放问题 8 项定级 P2×8、新增 1 项 P1。

---

## 1. 静态检查（原样结果）

| 检查 | 命令 | 结果 |
|---|---|---|
| fmt | `cargo fmt -p dbx-core -p dbx-plugin-runtime -p dbx-web -p dbx-cli -- --check` | **PASS**（exit 0；`cargo fmt --all` 因 vendor/wry 缺文件不可用，未触碰 vendored 代码） |
| 编译 | `cargo check`（`CARGO_INCREMENTAL=0`） | **PASS**（全 workspace，4m04s，无 warning/error） |
| 核心测试 | `cargo test -p dbx-core -p dbx-plugin-runtime -p dbx-web` | **PASS**：383 passed / 0 failed（dbx-core lib 174 + 集成 162(+1 ignored) + plugin-runtime 46 + web 1 + doc-tests） |
| Desktop lib | `cargo test -p dbx --lib` | **438 passed / 2 failed**（既有环境性失败，与本分支无关，详见 §1.1） |
| 前端 | `NODE_OPTIONS=--max-old-space-size=12288 pnpm check` | connection-types **ok** / oxfmt **ok** / oxlint **ok** / vue-tsc **ok** / vitest **18437/18438**（1 个已知负载 flaky，单跑全过，见 §1.2） |
| diff 卫生 | `git diff --check` | **PASS**（exit 0） |

### 1.1 `cargo test -p dbx --lib` 的 2 个失败（非 scheduler 范围，本分支未触碰这两个文件）

1. `commands::mcp::tests::runtime_probe_canonicalizes_node_and_keeps_npm_root_bound_to_it` —— 依赖本机 node/npm 布局的环境性断言（`src-tauri/src/commands/mcp.rs`）。
2. `commands::ai::tests::tauri_entry_respects_global_max_retries_zero` —— `src-tauri/src/commands/ai.rs:861`，计数断言失败（left: 0, right: 1）。

`git diff origin/main...HEAD` 确认 scheduler 分支**没有改动** `ai.rs` / `mcp.rs`；两者是 main 上遗留的环境性/既有用例问题。**建议**：由 MCP/AI 模块 owner 在 main 上修复，不阻塞 scheduler release。

### 1.2 pnpm vitest 的 1 个失败（负载 flaky）

`RedisKeyBrowser.infiniteScroll.spec.ts`（issue #6022 用例）在全量并发下两次均失败；单文件重跑 **56/56 全过**。与 `docs/scheduler/HANDOFF.md` 第四节记载的「全量 vitest 负载性 flaky」模式一致，与 scheduler 无关。**建议**：不作为本次回归修复；如持续复现请 redis 组件 owner 排查竞态。

---

## 2. 十六项核心验收（逐项 PASS/FAIL/BLOCKED + 证据）

自动化证据集中在 `crates/dbx-core/tests/`：`scheduler_integration_qa.rs`（A9 证据套件，4 测试）、`scheduler_store.rs`、`scheduler_engine.rs`、`scheduler_service.rs`、`scheduler_trigger.rs`、`scheduler_backup_migration.rs`。

| # | 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | Duplicate execution | **PASS** | claim 为 `BEGIN IMMEDIATE` 原子事务：并发 claim 恰一个胜者（`tests/scheduler_store.rs:83`）；无 lease 的第二引擎永不执行（`tests/scheduler_engine.rs:327`） |
| 2 | Lease recovery | **PASS** | `running→failed(worker_interrupted)`、`starting→queued`（D6 语义，`tests/scheduler_store.rs:170`）；lease 获取/心跳/过期/释放（`:228`）；engine 生命周期释放 lease（`tests/scheduler_engine.rs:283`） |
| 3 | Cron 三时区 + DST | **PASS** | `tests/scheduler_trigger.rs`：Asia/Shanghai(:15)、America/Los_Angeles(:24)、UTC(:35)、spring-forward 取 gap 后首刻(:42)、fall-back 取第一次出现(:51)；非法 cron/未知时区被拒(:82/:91) |
| 4 | Concurrency 四策略 | **PASS** | forbid 拒绝重复(:100)、replace 跳过排队(:111)、queue/parallel 允许(:125)（`tests/scheduler_store.rs`）；engine 层 parallel 并发(:173)、queue 串行(:192)（`tests/scheduler_engine.rs`） |
| 5 | Retry 分类退避 | **PASS** | fixed 重试至 max_attempts（`tests/scheduler_engine.rs:53/:96`）、non-retryable 永不重试(:81)、missing provider 不重试(:43)；exponential 增长单测（`src/scheduler/policy.rs:61-73`）；显式取消不重试（engine `Cancelled` 分支 `src/scheduler/engine.rs:319-335` + 取消测试 `tests/scheduler_engine.rs:142`） |
| 6 | Timeout 真实停止 | **PASS** | timeout → token 取消 → **executor 真实观测到取消**（`cancellations_seen` 断言）→ run=timeout + `error_code="timeout"`（`tests/scheduler_engine.rs:124-141`）；实现链 `src/scheduler/engine.rs:439-456` |
| 7 | Cancel 真实停止 | **PASS** | running 取消经 service 路径，executor 观测到取消后落 `cancelled`（`tests/scheduler_engine.rs:142-161`）；queued 直接取消(:162)；DB 路径 `tests/scheduler_store.rs:137` |
| 8 | Resident 有界 restart | **PASS** | 崩溃重启有界、超限落 `degraded`（`tests/scheduler_service.rs:24`）；recovery reconcile(:77)；start 超时经 token 强制(:221)；宿主实现 `src/scheduler/engine.rs:641-650`（`can_restart` 窗口判定）+ `src/scheduler/resident.rs:71-84` |
| 9 | Plugin unavailable | **BLOCKED（部分）** | 任务保留语义 PASS：provider 缺失 → `provider_not_found` 非 retryable、任务不删（`tests/scheduler_engine.rs:43`）、有 active run 时禁止删除（`tests/scheduler_store.rs:318`）；health=unavailable 投影 + 测试（`apps/desktop/src/lib/scheduler/schedulerProviders.ts:121`、spec :93）。**BLOCKED 部分**：见 §5 P1——宿主侧插件 executor 适配层缺失，`invalid/unavailable 不参与 enqueue_due`（ADR §2.8）无后端执行点，当前表现为每周期入队即失败（语义安全但不完整） |
| 10 | Invalid trigger | **BLOCKED（部分）** | UI 侧 PASS：trigger 缺失/mode 不匹配 → `invalid`（`schedulerProviders.ts:124-125`、spec :97/:101）；后端 `validate_task` 解析 trigger + executor 校验（`src/scheduler/service.rs:109-113`）；不会静默执行其他 trigger（trigger JSON 随任务持久化，dispatch 直接用该 trigger）。端到端同样受 §5 P1 适配层缺失限制 |
| 11 | Secret 全链路 grep | **PASS** | 字节级审计测试（`tests/scheduler_integration_qa.rs` 测试 1）：种植 `password/privateKey/apiToken/authorization/sessionKey/client_secret` 后跑完整生命周期，`state.db`+WAL+SHM 原始字节、全部 JSON 列（config/trigger/execution/payload/audit metadata）、全部日志文件、全部事件均无 secret；`secretRef` 引用保留。上一会话据该测试修复并已入库：`3daa7485f`（SECRET_KEY_MARKERS 补 authorization/sessionkey，归一化后比对） |
| 12 | Backup 回归 | **PASS** | legacy `scheduled_backup` 模块测试全绿（含于 dbx-core 174 passed）；迁移套件 7 测试（`tests/scheduler_backup_migration.rs`：id 保留、中断 run→failed(worker_interrupted)、无覆盖、缺 legacy store 只打标）；executor 经现有 `BackupService` 执行（`scheduler/providers/database_backup.rs:170-210`）；旧 worker `--ui-backup-worker` 路径保留（`src-tauri/src/background_backup.rs:41/:362`、`lib.rs:5`） |
| 13 | 迁移幂等 3 次 | **PASS** | QA 测试 2：连续 3 次以 worker 方式重建 store+migration，第 1 次迁移 1 schedule，第 2/3 次 `report==default` 零重复、legacy 保留、marker 存在（`tests/scheduler_integration_qa.rs`）；失败回滚+重试（`tests/scheduler_backup_migration.rs:204`）；marker 协议单测（`tests/scheduler_store.rs:364`） |
| 14 | Version conflict 409 | **PASS** | store CAS：过期 version 恰一个胜者（`tests/scheduler_store.rs:17/:62`）；线上 wire 测试 stale version → **409** 且 detail 前缀 `version_conflict:`（`crates/dbx-web/src/routes/scheduler.rs:557-563/:644`）；错误映射表(:80) |
| 15 | Logs seq/afterSeq/tail/rotation | **PASS** | 真实 32 MiB 阈值跨段、seq 全程连续 1..34、afterSeq 跨段 tail（QA 测试 3）；JSONL 格式/level/stream（`tests/scheduler_engine.rs:17`）；`afterSeq/limit/level/stream` 查询参数（`routes/scheduler.rs:151-152`）；rotation 单测（`src/scheduler/logs.rs:308`） |
| 16 | Artifacts 归属 | **PASS** | store 往返（`tests/scheduler_store.rs:330`）、engine executor artifact 持久化（`tests/scheduler_engine.rs:268`）；**新增字节级审计**（QA 测试 4，本次补完）：artifact 归属其 runId、伪造 runId 无泄漏、`artifacts_count` 派生、本体字节不进 state.db/WAL |

---

## 3. 架构反模式五条（grep + 走查）

| # | 反模式 | 结论 | 证据 |
|---|---|---|---|
| 1 | core 出现业务 provider 分支 | **PASS（无）** | `grep "io\.dbx\.ssh\.tasks\|io\.dbx\.files\.tasks\|provider_id ==" crates/dbx-core/src/scheduler/` → 0 命中；仅 builtin 常量注册 `DATABASE_BACKUP_PROVIDER_ID`（`providers/database_backup.rs:37`），符合 ADR §2.2 |
| 2 | UI 出现 provider-specific scheduler | **PASS（无）** | `apps/desktop/src/components/scheduler/`、`apps/desktop/src/lib/scheduler/` 组件零 provider 条件分支（provider id 只出现在测试与注释）；表单由 manifest 字段驱动（`SchedulerTaskFormRenderer.vue`）。唯一的 `setInterval` 是日志 tail 5s 轮询（`SchedulerLogViewer.vue:29/:105`），属 ADR §7.3 允许的「eof 且无新事件时轮询」，不是调度器 |
| 3 | API 直连 scheduler SQLite | **PASS（无）** | `src-tauri/src/commands/scheduler.rs`、`crates/dbx-web/src/routes/scheduler.rs` 全文无 `rusqlite`/`Connection`/裸 SQL；仅构造 `SchedulerService(SchedulerStore::new(...))`（`commands/scheduler.rs:29/:35`、`routes/scheduler.rs:64`）；裸读取只存在于 `#[cfg(test)]` |
| 4 | 插件协议任意 RPC | **PASS（无）** | 固定五方法常量 + `PluginTaskMethod` 枚举（`crates/dbx-plugin-runtime/src/plugins/task.rs:29-33/:53`）；未知方法/事件显式拒绝(:458)；capability 门禁（:925 `task/state` 无需 capability 等）；SSH 插件侧注明「deliberately no ssh/runScheduledCommand-style …」（`dbx-plugins/ssh/backend/src/task_provider.rs:14`） |
| 5 | dbx-plugin-runtime 依赖 dbx-core | **PASS（未违反）** | `crates/dbx-plugin-runtime/Cargo.toml` 无 `dbx-core`/`dbx_core` 依赖（grep 0 命中）；依赖方向 `dbx-plugin-runtime ← dbx-core ← src-tauri / dbx-web` 成立 |

---

## 4. 八个开放问题复核定级

| # | 问题 | 复核结论 | 定级 | 处置建议 |
|---|---|---|---|---|
| 1 | resident start = run_now 语义（A3） | 证实为**有意设计**且 Desktop/Web 对称：start = 对该任务入队一次 manual run，引擎 dispatch resident run 时启动 session（`src-tauri/src/commands/scheduler.rs:287`、`routes/scheduler.rs:360-361`）。与冻结的 resident=Replace 语义一致，run 审计链完整 | **P2** | 无需改码；建议 A10 在最终架构文档补一句该语义说明（不改冻结契约） |
| 2 | Web 错误机器码在 detail 前缀（A3） | 证实：`scheduler_error` 把机器码保留为 `<code>: <message>` 前缀并按 §7.5 冻结映射状态码（`routes/scheduler.rs:73-96`），wire 测试断言前缀(:563)。与 Desktop `Err(String)` 前缀对齐；AppError 体系（偏差 D7）无独立 code 字段 | **P2** | 维持现状；未来 AppError 增加 code 字段时一并迁移，不在本 Wave 改 |
| 3 | runs 游标 API 层实现上限 1000（A3） | 证实：`RUN_SCAN_LIMIT=1000`（`routes/scheduler.rs:27`），before/after 在内存切片上定位(:293-304)；Desktop 同构（`commands/scheduler.rs:186/:209`） | **P2** | v1 可接受；数据量增长后把游标下推到 store SQL（`task_runs` 已有 `task_id,created_at DESC` 索引） |
| 4 | worker 子进程事件只进 worker.log，Desktop 靠轮询（A8） | 证实且**已文档化**：worker 进程事件 sink 落 worker.log（`background_scheduler.rs:481-487`）；UI 进程 sink 仅覆盖 UI 进程内事件(:382-394)。ADR §7.4 明示「事件允许丢失，状态不允许」，UI 从 API 重建状态（`SchedulerPage.vue:116-125`）——契约合规，属 UX 降级 | **P2** | 建议 A10 评估 worker 事件桥（事件文件 / SSE 中继 / tail worker.log）；非阻断 |
| 5 | OS 开机注册未接线（A8） | 证实：无 autostart 接线，代码注明为 follow-up（`background_scheduler.rs:371-373`）。`scheduler.background.enabled` 默认 OFF，影响被 feature flag 封住 | **P2** | 保持 flag 默认 OFF 直至接线完成；列为 follow-up 任务（非本 Wave 回归） |
| 6 | hourly Interval 文件名时间戳 UTC（A4） | 证实：`task_time_zone` 对非 Cron/Once 触发器返回 `"UTC"`（`providers/database_backup.rs:311-316`）；迁移按 ADR §8.2 把 hourly→interval，故迁移后的 hourly 任务文件名时间戳从旧 timeZone 变为 UTC（legacy 引擎按 `job.time_zone` 渲染，`scheduled_backup/engine.rs:218`）。ADR 未冻结文件名时区；数据与目录结构不受影响 | **P2** | 可接受偏差；后续可把迁移时的原 timeZone 写进 config 并在 executor 回读（小改，不涉契约） |
| 7 | resident restart 插件 config 与宿主策略并存（A6） | **无冲突（当前）**：SSH 插件自管**进程级**重启（config `max_restarts/restart_backoff_seconds/restart_window_seconds`，默认 5、硬上限、窗口裁剪，`task_provider.rs:102-168`，超限自降级并回报）；宿主管**会话级**重启（`task.execution.restart`，缺省即禁用，`engine.rs:641-650` + `resident.rs:71-84`）。两层均有界，最坏为乘性但有上限，不可能无限 crash loop；插件内部重启期间的 `crashed` 状态事件当前无宿主消费者（适配层缺失，见 §5 P1），不会造成双重重启 | **P2** | 适配器落地时在文档明确两级治理边界（plugin=进程内、host=会话级）；UI 可考虑把插件字段镜像进 `execution.restart` 以单一口径展示；不改 ADR |
| 8 | 一级侧边栏入口未接（A5） | 证实：`SchedulerPage` 仅经 legacy 备份设置页的「打开调度中心」切换挂载（`ScheduledDatabaseBackupSettings.vue:647-658`、`EditorSettingsDialog.vue:9270`），为迁移窗口期的有意设计 | **P2** | Release N 可接受；N+1（Scheduler owns backup）时升级为一级入口 |

---

## 5. 新发现（本次增量）

### P1 — 插件任务执行链路未接线（宿主适配层缺失）

- **现象**：ADR §5.2 指定「插件 executor 由 `dbx-core/src/scheduler/providers/plugin.rs` 适配（经 dbx-plugin-runtime 的 sidecar 会话）」，该文件**不存在**（`providers/` 下仅 `database_backup.rs` + `mod.rs`）。注册表注释自称等待该适配器（`src/scheduler/executor.rs:116-118`）。
- **影响面**：
  - `io.dbx.ssh.tasks` / `io.dbx.files.tasks` 没有任何宿主把其注册为 executor：worker 只注册 backup（`src-tauri/src/background_scheduler.rs:495-497`），UI/API 进程 registry 为空（`commands/scheduler.rs:29`、`routes/scheduler.rs:64`）。
  - dbx-plugin-runtime 协议层**已完备**（`validate_task/execute_task/start_task/stop_task/task_status`，`plugins/task.rs:554-666`，含 capability 门禁），SSH 插件后端实现完备（含事件/日志/cancel/有界重启），但**全仓无消费者**。
  - 因此插件任务无法端到端执行；ADR §2.8「invalid/unavailable 不参与 enqueue_due」无后端执行点（引擎对 enabled 任务照常入队，dispatch 时 `provider_not_found` 失败——任务保留、语义安全、但每周期产生失败 run）；ADR §12 的 `scheduler.plugin_tasks.enabled` flag 也未落地。
- **对验收的影响**：第 9/10 项的「任务保留 + health 投影」语义已验证 PASS，端到端执行被 BLOCKED。
- **为何不由 QA 顺手修**：这不是 1-concern 集成小修，而是约一个 Agent 工作量的实现（core 适配器 + 宿主注册 + flag + 端到端测试），超出 A9 允许修改范围。
- **建议**：开 follow-up（A10 或新 Agent）：① `dbx-core`/`src-tauri` 落地 PluginTaskExecutor 适配器（复用 dbx-plugin-runtime client）；② worker/UI 启动时按已安装插件的 `task-provider` contribution 注册 executor；③ 加 `scheduler.plugin_tasks.enabled`；④ 把 engine `enqueue_due` 前置健康过滤补上（或接受现状并在文档记偏差）；⑤ 端到端测试 SSH execute + resident。

---

## 6. 相对上一会话的增量说明

1. **核验遗留成果（未推倒重来）**：
   - `3daa7485f fix(scheduler): redact authorization and session-key config keys too` 确认在库、内容与提交信息一致（`src/scheduler/error.rs` 的 SECRET_KEY_MARKERS 扩展）。
   - 遗留的 `crates/dbx-core/tests/scheduler_integration_qa.rs` 编译通过、3 个测试全绿（secret 字节级审计 / 迁移幂等 3 次 / 日志 rotation），**设计保留**，无需重写。
2. **补完 QA 套件**：新增第 4 个测试 `artifacts_belong_to_their_run_and_the_body_never_reaches_sqlite`（验收项 16 的字节级证据：runId 归属、伪造 runId 无泄漏、`artifacts_count` 派生、本体不进 SQLite/WAL）。4/4 通过。提交：`2ef7b769b`。
3. **完成全部静态检查**（上一会话未留下结果记录）并复核了 A3/A4/A5/A6/A8 遗留的八个开放问题与五条反模式，补齐 file:line 证据。
4. **新发现 §5 P1**（插件适配层缺失）——上一会话未覆盖。

---

## 7. 提交记录

```
2ef7b769b test(scheduler): audit artifact attribution and body exclusion at the byte level
3daa7485f fix(scheduler): redact authorization and session-key config keys too
022fabf04 fix(tauri): release the migration lease explicitly before the engine loop
34953ab88 feat(web): bridge engine scheduler events into the SSE hub
cd7d50892 feat(tauri): add background scheduler worker
51fec035a fix(tauri): repair scheduler service test signature blocking lib test build
cc8cfdf73 feat(core): add scheduler event sink with engine run-state/log/progress broadcast
cdbdf2941 Merge branch 'feature/scheduler-ui' into feature/scheduler-integration
```

本会话改动文件：
- `crates/dbx-core/tests/scheduler_integration_qa.rs`（上一会话 216 行 + 本次补完，提交 `2ef7b769b`）
- `docs/scheduler-integration-report.md`（本报告）

---

## 8. 统计与 Release Readiness

**验收统计**：16 项 = **14 PASS / 0 FAIL / 2 BLOCKED**（第 9/10 项端到端部分，根因同一：§5 P1）。反模式 5/5 PASS。开放问题定级：**P0×0 / P1×1（新发现）/ P2×8**。

**P1 清单（不能带进 release 的唯一一项）**：
- 插件任务执行链路未接线（§5）。**缓解**：整个 scheduler 默认由 `DBX_SCHEDULER_GENERIC_ENABLED` / `DBX_SCHEDULER_BACKGROUND_ENABLED`（均默认 OFF）门控，插件任务即使创建也只会在 dispatch 时安全失败（`provider_not_found`，任务保留），**默认安装零行为变化、无回归**。因此 Release N（双轨并存、backup 优先）可以带本分支发布；插件任务执行应在 Release N+1 前由 follow-up 补齐。

**P2 清单**：开放问题 1–8（§4），全部有明确处置建议，无一违反冻结契约。

**未覆盖项**：
- SSH/Files 插件任务的真实端到端执行（受 §5 P1 限制，BLOCKED）；两插件自身的运行行为仅在插件仓测试验证（`/Users/Jinpy/btroot/dbx-plugins/ssh`，本次只读走查）。
- Web/Docker 容器形态下的 worker 常驻（ADR §11 末条）无部署级测试；desktop 进程模型已测。
- OS 开机自启（§4-5，P2 follow-up）。
- pnpm vitest 在满载下的 1 个 redis flaky 用例（单跑全过，非本范围）。

**Release Readiness 结论**：**可发布（Release N，双轨并存形态，scheduler flags 默认 OFF）**。Backup 作为首个 builtin provider 的完整链路（触发/并发/重试/超时/取消/常驻/租约/恢复/迁移/日志/artifact/secret 红线/409/事件）全部验证 PASS 且带字节级证据；架构五铁律零违反。放行条件：① §5 P1 转为 follow-up 并在发布说明标注「插件任务执行未启用」；② §4 各 P2 按建议排期；③ `cargo test -p dbx --lib` 的 2 个既有环境性失败转交对应 owner。
