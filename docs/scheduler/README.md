# Scheduler / Task Center — 执行索引

- [implementation-plan.md](./implementation-plan.md)：完整实施规格（架构、Domain Model、SQLite Schema、Plugin 协议、API、迁移、测试矩阵、里程碑）。
- [agent-prompts.md](./agent-prompts.md)：Agent 0–10 启动提示词，可直接复制到独立会话。

## 启动波次（Wave）

| Wave | Agent | 分支 | 允许范围 |
|---|---|---|---|
| 1 | A0 契约/ADR | `feature/scheduler-contract` | `docs/**` |
| 1 | A1 Scheduler Core | `feature/scheduler-core` | `crates/dbx-core/src/scheduler/**` + `crates/dbx-core/tests/**` |
| 1 | A2 Plugin Contract | `feature/plugin-task-contract` | `plugins/manifest.schema.json`、`crates/dbx-plugin-runtime/**`、`plugins/sdk/**` |
| 2 | A3 API | `feature/scheduler-api` | `src-tauri/src/commands/scheduler.rs`、`crates/dbx-web/src/routes/scheduler.rs`、`apps/desktop/src/lib/backend/**` |
| 2 | A4 Backup Adapter | `feature/scheduler-backup-provider` | `crates/dbx-core/src/scheduler/providers/database_backup.rs`、`migration.rs` |
| 2 | A5 UI | `feature/scheduler-ui` | `apps/desktop/src/components/scheduler/**`、`apps/desktop/src/lib/scheduler/**` |
| 3 | A8 Background Worker | `feature/background-scheduler` | `src-tauri/src/background_scheduler.rs` |
| 3 | A6 SSH | `feature/task-provider-ssh` | SSH 插件仓库 |
| 3 | A7 Files | `feature/task-provider-files` | Files 插件仓库 |
| 4 | A9 QA → A10 Integrator | `feature/scheduler-integration` | 集成分支 |

## Worktree 命令

```bash
git worktree add ../host-agent-contract  feature/scheduler-contract
git worktree add ../host-agent-core      feature/scheduler-core
git worktree add ../host-agent-plugin    feature/plugin-task-contract
git worktree add ../host-agent-api       feature/scheduler-api
git worktree add ../host-agent-backup    feature/scheduler-backup-provider
git worktree add ../host-agent-ui        feature/scheduler-ui
```

## 合并顺序

A0 → A1 → A2 → A3 → A4 → A5 → A8 → A6 → A7 → A9 → A10。
Wave 1 完成后冻结 `TaskDefinition / TaskRun / TaskTrigger / TaskExecutionPolicy`。

## 每轮合并后的检查命令

```bash
cargo fmt --all -- --check
cargo check
cargo test -p dbx-core
cargo test -p dbx-plugin-runtime
pnpm check
git diff --check
```

## Windows 本机环境注意事项

- **cargo 必须用 Strawberry Perl**：PATH 里的默认 perl 是 Git Bash 的 cygwin 版，会导致 openssl-sys vendored 构建失败。运行任何 cargo 命令前先执行：
  ```bash
  export PATH="/e/env/perl/perl/bin:$PATH"
  ```
- **本机没有 node**（只有 bun 1.4.0），`pnpm check`（oxfmt/oxlint/vue-tsc/vitest）暂不可执行；涉及前端的 Agent 跳过 pnpm 检查并在报告中注明，待安装 Node.js LTS 后补跑。
- Rust 全量构建约 10–15 分钟（target 已预热的 worktree 会快很多），Agent 需耐心等待构建完成，不要中途放弃。
- 本仓库是 `E:\dbx-plugins` 超项目的 git 子模块；worktree 统一放在 `E:/dbx-wt/<name>`。
