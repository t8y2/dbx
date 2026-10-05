# DBX Scheduler 交接快照（2026-10-06，Mac 接管会话）

> 本文档是会话交接的状态快照。接力会话从这里继续，所有上下文以本文 + `docs/scheduler/` + `docs/adr/scheduler-task-contract.md` 为准。
> 上一版快照（2026-10-05，Windows 会话）的内容已全部落实，历史细节见 git 历史与 `docs/scheduler-integration-report.md`。

## 一、总体进度（对照 docs/scheduler/README.md 的波次计划）——全部波次已完成

| 阶段 | 状态 | 落点 |
|---|---|---|
| A0 契约/ADR | ✅ | main（`docs/adr/scheduler-task-contract.md`，最高权威） |
| A1 Scheduler Core | ✅ **已合入** | 集成线 `5e8f0b94e`；分支 `feature/scheduler-core` 头 `8d996801f`（WIP `7ceb03a66` + 2 个修复提交） |
| A2 Plugin Contract | ✅ **已合入** | 集成线 `32482b205`；分支头 `04c4fefde`（4 commits 原样） |
| A3 Scheduler API | ✅ **已合入** | 集成线 **fast-forward**，线头 `69c328956`；分支头 3 commits（web 路由 15 条 + Tauri command 14 个 + api.ts） |
| A4 Backup 迁移 | ✅ **已合入** | 集成线 `f2451230f`；分支头 2 commits（executor + 迁移，零算法改动） |
| A5 Desktop UI | ✅ **已合入** | 集成线 `cdbdf2941`；分支头 3 commits（任务中心 + 动态表单 + 备份入口） |
| A8 Background Worker | ✅ **已合入** | 集成线 **fast-forward**，收线 `022fabf04`；分支头 5 commits（worker + 事件 sink + 事件桥 + 2 个真 bug 修复） |
| A6 SSH 插件 | ✅ **已合入插件仓库 main** | jinpy666/dbx-plugin-ssh main = `6af0e41e`（io.dbx.ssh.tasks，1218 测试 + 真容器冒烟全绿） |
| A7 Files 插件 | ✅ **已合入插件仓库 main** | jinpy666/dbx-plugin-files main = `16b9e613`（io.dbx.files.tasks，548 测试含 rcd 实况全绿） |
| A9 集成 QA | ✅ **报告已入库** | `docs/scheduler-integration-report.md`（commit `566712bf2`）：14 PASS / 0 FAIL / 2 BLOCKED（同根因 P1）、反模式 5/5、开放问题 8×P2、**release ready（flags 默认 OFF 双轨形态）** |
| A10 整合 | ✅ 本文档 + `docs/adr/scheduler-integration.md` | 集成线文档提交 |

## 二、本次会话（Mac 端）完成的关键工作

1. **跨机接管**：9 个分支从 origin fetch；本机 `main` 与 origin/main 分叉（本机产品线领先 232 提交未推送），故集成工作全部落在 `feature/scheduler-integration` 集成线（与 origin/main 同源，可整体快进），**本机 main 未被触碰**。
2. **A1 跑绿**：`11f5cbff4` 修复 `count_missed_fires` 边界 off-by-one（恰好到期的 fire 不算错过）；`8d996801f` 在 `.cargo/config.toml [env]` 加 `RUST_MIN_STACK=32MiB`（根治 macOS debug 深调用栈溢出，仓库本有 Windows `/STACK` 同类先例）。
3. **合并序列**（每轮门禁全绿）：A1 → A2 → A3 → A4 → A5 → A8；门禁 = scoped fmt + cargo check + 三包全量测试 + git diff --check（A5 另加 pnpm check，typecheck 需 `NODE_OPTIONS=--max-old-space-size=12288`，否则 node 堆 OOM）。
4. **后台 Agent 编排**：Wave 2（A3/A4/A5）与 Wave 3（A8/A6/A7）共 6 个开发 Agent + A9 QA（因速率限制中断一次，续作 Agent 接续完成）。全部零契约偏差交付。
5. **QA 落库 3 个提交**：`3daa7485f`（补 authorization/session-key 配置键脱敏）、`2ef7b769b`（artifact 归属字节级审计测试）、`566712bf2`（集成报告）。

## 三、环境须知（Mac 端）

- cargo 1.98 / node v22（nvm）/ pnpm 可用；**无需** Windows 的 perl PATH hack。
- `cargo fmt --all` 因 vendor/wry 缺 examples 文件不可运行（基线状况），门禁用按包 scoped fmt。
- 磁盘是主要约束：全量 `cargo test -p dbx-core` 的 target 约 30–50Gi。并行多 worktree 构建会把盘打满（本会话两次撞墙）；纪律 = 构建前 `df -h`、`CARGO_INCREMENTAL=0`、Agent 只跑 scoped 构建、完工即清 target。
- vitest 全量有负载性 flaky（`RedisKeyBrowser.infiniteScroll.spec.ts` 等，单文件重跑必过）；`cargo test -p dbx --lib` 有 2 个**既有**环境性失败（`runtime_probe_canonicalizes_node`、`tauri_entry_respects_global_max_retries_zero`），均与 scheduler 无关（`git diff origin/main...HEAD` 证实未触碰）。

## 四、遗留问题（按优先级）

- **P1（唯一，首要 follow-up）**：ADR §5.2 指定的插件宿主适配器 `crates/dbx-core/src/scheduler/providers/plugin.rs` **尚未实现**——原波次计划没有为它安排 Agent（计划缺口，非实现缺陷）。现状：A2 协议层与 SSH/Files 插件侧已完备，宿主只注册了 backup builtin executor，插件任务无法端到端执行；`scheduler.plugin_tasks.enabled` flag 也未接线。缓解：全部 scheduler 行为由默认 OFF 的 flag 门控，默认安装零行为变化。**建议下一个会话用一个 Agent 量实现并补 QA。**
- **P2×8**（详见集成报告 §开放问题）：resident start=run_now 语义、Web 错误码 detail 前缀载体、runs 游标 API 层上限 1000、worker 跨进程事件只进 worker.log、OS 开机注册未接线、hourly Interval 文件名时间戳 UTC、插件/宿主 restart 策略双源并存、一级侧边栏入口未接。
- 未覆盖项：SSH/Files 真实端到端执行（依赖上述 P1）、Web/Docker 容器 worker 形态、2 个既有 lib 环境性失败转交 owner。

## 五、分支/仓库清单（本会话结束态，全部未 push）

- host 仓库：`feature/scheduler-integration`（集成线头 `566712bf2`，含 A0–A9 全部成果）；`feature/scheduler-core` / `plugin-task-contract` / `scheduler-api` / `scheduler-backup-provider` / `scheduler-ui` / `background-scheduler`（各自头即合并时点）；本机 `main` 保持产品线未动。
- ssh 插件仓库：main = `6af0e41e`（含 task provider）。
- files 插件仓库：main = `16b9e613`（含 task provider）。
- worktree 全部挂在 `/Users/Jinpy/btroot/dbx-wt/`（host 侧 7 个）与插件仓库自己的 worktree 注册（plugin-ssh-task / plugin-files-task）。

## 六、下一会话的第一件事

1. 实现 P1 插件适配器（`providers/plugin.rs` + `scheduler.plugin_tasks.enabled` 接线 + 端到端测试），以 ADR §5.2/§6 为契约。
2. 处置 P2 清单中需要动手的项（侧边栏入口、OS 注册等），逐项 1 concern = 1 commit。
3. push 与发布节奏由用户决策（本会话铁律：不 push）。
