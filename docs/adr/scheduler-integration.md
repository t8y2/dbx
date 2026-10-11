# ADR: Scheduler / Task Center 集成架构记录（A10 收官）

- 状态：Accepted（Wave 1–3 + 集成 QA 全部完成后的架构定格）
- 日期：2026-10-06
- 决策人：Lead Integrator（A10，Mac 接管会话）
- 上游契约：[scheduler-task-contract.md](./scheduler-task-contract.md)（782 行，仍是最高权威；本文只记录集成结果，不修改任何冻结契约）
- 验收依据：[docs/scheduler-integration-report.md](../scheduler-integration-report.md)（A9，14 PASS / 0 FAIL / 2 BLOCKED、反模式 5/5、八项开放问题全 P2）
- 集成线：host 仓库 `feature/scheduler-integration`（头 `566712bf2`）；ssh 插件 main `6af0e41e`；files 插件 main `16b9e613`

---

## 1. 落地架构（对照契约逐层）

| 层 | 交付 | 关键事实 |
|---|---|---|
| Domain / Store（A1） | `dbx-core/src/scheduler/`（15 模块 + events） | 七表 SQLite（`<data-dir>/scheduler/state.db`）、BEGIN IMMEDIATE claim/lease/recovery、`#[async_trait]` + CancellationToken + chrono-tz DST；lib 3056 测试 |
| Plugin 协议（A2） | `dbx-plugin-runtime/src/plugins/task.rs` + manifest contribution + 三语言 SDK | 固定 5 个 `task/*` RPC、4 个事件、`host.scheduler` 权限门禁；capability 由 Runtime 强制 |
| API（A3） | `dbx-web/src/routes/scheduler.rs`（15 路由 + SSE）+ `src-tauri/src/commands/scheduler.rs`（14 command）+ api.ts 双传输 | 全部经 `SchedulerService`，零直连 SQLite；§7.5 错误码逐码映射（409/503/404/400/403） |
| Backup 迁移（A4） | `scheduler/providers/database_backup.rs` + `scheduler/migration.rs` | 纯 Adapter（`export_job` 等仅可见性级改动），marker 协议幂等/原子/restart-safe，旧 ID 全保留 |
| UI（A5） | `apps/desktop/src/components/scheduler/**` + `lib/scheduler/**` | 全动态表单（复用 PluginFormField 体系）、按 manifest discovery、无 provider 硬编码；旧备份页保留为兼容入口 |
| Worker（A8） | `src-tauri/src/background_scheduler.rs`（767 行）+ core 事件 sink | `--scheduler-worker` 分流、脱离进程组、有界重启、优雅停机（租约释放验证）；engine 事件经 add-only sink 广播 |
| 插件 Provider（A6/A7） | ssh `io.dbx.ssh.tasks`（execute + resident）；files `io.dbx.files.tasks`（sync/copy） | 均复用既有引擎（ssh 传输链 / rclone），仅固定 RPC，真容器/rcd 冒烟全绿 |

## 2. 架构不变量验证结论（A9 实证）

1. 只有一个 Scheduler；core 无任何 provider 业务分支（grep 0 命中）。
2. 依赖单向：`dbx-plugin-runtime` 的 Cargo.toml 无 `dbx-core` 依赖。
3. API/UI 不拥有生命周期：API 只调 Service；UI 事件仅作通知、状态一律从 API 重建。
4. Secret 红线：state.db+WAL+全部 JSON 列+日志+事件做了字节级审计（QA 补了 `3daa7485f` 脱敏修复与 `2ef7b769b` 审计测试）。
5. Manifest 声明能力：插件侧未声明的 RPC 被 Runtime 拒绝（A2 门禁测试）。

## 3. 与原计划的偏差（全部已文档化，无一违反冻结契约）

- A1 修复 2（fire 边界语义、`RUST_MIN_STACK` 基线）；A8 披露 1 行越界类型修复（A3 测试签名，基线即阻塞全量编译）；A8 发现并修复迁移租约未释放的真 bug（`022fabf04`）。
- 门禁口径：`cargo fmt --all` 因 vendored wry 不可运行 → scoped fmt；pnpm typecheck 需 12G node 堆；vitest 全量含已知负载 flaky。

## 4. 遗留（发布决策输入）

- **P1**：插件宿主适配器 `providers/plugin.rs` 未实现（原计划缺口）——插件任务端到端执行需先补此层 + `scheduler.plugin_tasks.enabled` 接线。flags 默认 OFF，默认安装零行为变化。
- **P2×8**：见 HANDOFF.md §四 / 集成报告；建议按集成报告处置建议排期。
- 发布节奏遵循契约 §12：Release N 双轨并存（本状态）→ N+1 Scheduler owns backup → N+2 删旧 UI → N+3 移除 legacy writes。
