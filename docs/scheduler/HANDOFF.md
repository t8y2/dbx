# DBX Scheduler 交接快照（2026-10-05）

> 本文档是会话交接的状态快照。接力会话从这里继续，所有上下文以本文 + `docs/scheduler/` + `docs/adr/scheduler-task-contract.md` 为准。

## 一、总体进度（对照 docs/scheduler/README.md 的波次计划）

| 阶段 | 状态 | 位置 |
|---|---|---|
| 前期准备（方案落盘、worktree、环境） | ✅ 完成 | main |
| A0 契约/ADR | ✅ **已合入 main**（merge `d0f13e787`） | `docs/adr/scheduler-task-contract.md`（782 行，契约最高权威）+ `docs/scheduler/`（规格/提示词/索引） |
| A2 Plugin Contract | ✅ **交付完成，未合入**（与 main 预检 0 冲突，162 测试全过，四条架构铁律已抽查验证） | 分支 `feature/plugin-task-contract`，4 commits：`04f0d5631`（manifest）/`7624b6c21`（task/* 协议）/`bed237852`（host.scheduler gate）/`04c4fefde`（SDK） |
| A1 Scheduler Core | 🟡 **实现+测试代码全部写完，已固化 WIP 提交 `7ceb03a66`**。53 个测试（trigger 12/store 20/engine 16/service 5）逐文件验证通过；**全量 `cargo test -p dbx-core` 尚未完整跑绿**（中断于 rlib 元数据并发编译竞争 E0786/E0463，属增量缓存问题非代码错误） | 分支 `feature/scheduler-core`（worktree `E:/dbx-wt/scheduler-core`），15 个模块已挂载 lib.rs |
| Wave 2（A3 API / A4 Backup Adapter / A5 UI） | ⏳ 未开始；分支+worktree+文档全部就绪 | `feature/scheduler-api`→`E:/dbx-wt/scheduler-api`、`feature/scheduler-backup-provider`→`E:/dbx-wt/scheduler-backup`、`feature/scheduler-ui`→`E:/dbx-wt/scheduler-ui` |
| Wave 3（A8 Background Worker / A6 SSH / A7 Files） | ⏳ 未开始；A8 分支+worktree 就绪 | `feature/background-scheduler`→`E:/dbx-wt/background-scheduler`；A6/A7 属插件仓库 |
| 集成 | ⏳ 分支已建并同步 main | `feature/scheduler-integration` |

## 二、接力会话的第一件事（按序）

1. **跑绿 A1 全量测试**：`cd /e/dbx-wt/scheduler-core && export PATH="/e/env/perl/perl/bin:$PATH" && cargo test -p dbx-core`。若遇 E0786/E0463，`cargo clean -p dbx-core` 或删 `target/debug/incremental` 后重跑（连续两次验证过是缓存竞争）。修复任何失败 → `cargo fmt --all -- --check` → `git diff --check` → 可按逻辑把 WIP 拆成规范 commit（1 concern=1 commit，参考 `docs/scheduler/agent-prompts.md` §122），或保留 WIP 单提交。
2. **合并 A1 → main**，随后**合并 A2 → main**（顺序不可换；A2 分支不用 rebase，直接 3-way merge）。每步合并后 `cargo check` + `cargo test -p dbx-core -p dbx-plugin-runtime`。
3. **启动 Wave 2**：三个后台 Agent 分别在三个 worktree，提示词直接用 `docs/scheduler/agent-prompts.md` 中 Agent 3/4/5 段落，外加：以 ADR（`docs/adr/scheduler-task-contract.md`）为契约最高权威；cargo 前 `export PATH="/e/env/perl/perl/bin:$PATH"`；1 concern=1 commit；不 push。
4. Wave 2 完成后按 README 合并顺序推进 A8 → A6/A7 → A9 QA → A10 整合。

## 三、环境须知（Windows 本机）

- **cargo 必须先 `export PATH="/e/env/perl/perl/bin:$PATH"`**（Strawberry Perl 便携版；PATH 默认的 cygwin perl 会让 openssl-sys vendored 构建失败）。
- Node v24.21.0 LTS 装在 `E:/env/node/node-v24.21.0-win-x64`，已加入用户 PATH；`pnpm check`（oxfmt/oxlint/vue-tsc/vitest，约 5 分钟）可用。全量 vitest 有**负载性 flaky**（时序类测试全量并发偶发超时，单文件重跑必过，勿当回归修）。
- 本仓库是 `E:\dbx-plugins` 超项目的 git 子模块；所有 Agent worktree 在 `E:/dbx-wt/<name>`。
- husky pre-commit 需要 node 在 PATH。
- 已知基线修复（main 上）：`03ec6e022`（三个环境依赖测试）、`f3e0e3bd6`（Cargo.lock 版本漂移）。

## 四、后台 Agent 管理经验（本项目踩过的坑）

- 后台 Agent 可能**静默失联**（无完成通知、SendMessage 返回 "No active local_agent task found"）。应对：检查 worktree 文件 mtime / target 活动判断生死；失联即起「续作 Agent」，提示词中明确"先通读现有产出、保持设计一致、与 ADR 冲突以 ADR 为准"，**不要推倒重来**。
- 交接/中断前务必把 worktree 未提交成果先 `git add+commit` 固化（本次 A1 即如此保全）。
- 给 Agent 的提示词必须包含：绝对路径工作目录、分支名、必读文档、允许/禁止文件边界、Windows perl PATH、1 concern=1 commit、不 push、最终报告格式。
- Agent 可能产生越界改动（如 A2 曾带出 `vendor/tauri-plugin-updater` 自动生成文件），合并前必查 `git status` 与 diff --stat。

## 五、未决定事项（留给用户/接力会话）

- 全部分支（main + 8 个 feature 分支）已于交接时提交并推送到 `origin`（github.com:jinpy666/dbx），已设置 upstream 跟踪。
- `deploy/docker-compose.local.yml`（main 未跟踪）是用户自己的文件，未纳入任何提交。
- SSH / Files 插件的仓库位置未确认（A6/A7 开工前先找 `io.dbx.ssh.connection` 的真实源码，方案 §98 有说明）。
