# DBX Scheduler 交接快照（2026-10-06，Mac 接管会话）

> 本文档是会话交接的状态快照。接力会话从这里继续，所有上下文以本文 + `docs/scheduler/` + `docs/adr/scheduler-task-contract.md` 为准。
> 上一版快照（2026-10-05，Windows 会话）的内容已全部落实，历史细节见 git 历史与 `docs/scheduler-integration-report.md`。

## 〇、2026-10-07 会话增补（已提交：d59da28c6..e392b8d95，共 5 笔）

1. **多连接执行补全（原「已知未解决 #3」）**：`PluginTaskExecutor` 此前只消费 `target.connectionId`，`additionalConnectionIds` 无人读取（多选 chip 存了但执行端静默忽略）。现由宿主遍历：`dispatch_targets`（主连接在前、去重、`allow_multiple_connections` 门控）+ 每连接一次 `task/execute` + `combine_results` 聚合（单连接逐字透传；批次给失败连接点名、首个非零 exit code 胜出、artifacts 拼接）。dispatch 级错误（传输/连接打不开）快速中止批次并 abort 事件泵；provider 报告的失败不中断其余连接。`validate` 现在打开全部绑定连接。插件契约未动（`task/execute` 仍是单 `connectionId`），**无需重打包 .dbxp**。
2. **worker 卡排队提示（原 #4）**：新增 `BackgroundScheduler::worker_status()` + Tauri 命令 `scheduler_worker_status`（pid 文件存活 + env 开关，web 通道返回 null）。前端在「存在排队/启动中超 20 秒的运行」且 worker 不健康时显示琥珀横幅（`scheduler.workerBanner.*` 三语言），判定纯函数在 `schedulerDraft.ts`（`hasStaleQueuedRun` / `workerNeedsAttention`）。
3. **高风险确认会话级记忆（原 #5）**：保存成功的高风险任务按 id 记入模块级 Set（`isHighRiskAcknowledged` / `rememberHighRiskAcknowledgement`），本次应用运行内再次编辑不再重勾；重启即复位，安全语义保留。
4. **i18n 收尾（接上一会话的未提交改动）**：trigger 摘要与 resident/风险徽标走 `t()`（`scheduler.triggerSummary.*` / `scheduler.trigger.badges.*`），时区后缀由列表行单独渲染。
5. **磁盘注意**：本会话两次撞 ENOSPC（926G 盘 100% 满）；已删 `host/target/debug/incremental` 与 `ssh/backend/target/debug/incremental` 解困（可再生）。用户盘仍 ~99% 满，接力会话构建前先 `df -h`。

验证：`cargo test -p dbx-core` 全绿；`cargo test -p dbx --lib` 444 过 + 2 个既有环境失败（基线）；调度器 vitest 10 文件 63 用例全绿；`vue-tsc --noEmit` 干净。

6. **P2 处置（后台 agent 波次，均已复跑验证）**：「runs 游标上限」经核查 web 路由自首次提交即与桌面端对齐（`RUN_SCAN_LIMIT=1000`），真实缺口只是测试，已补钳制钉住测试（ee76702f5）；「hourly Interval 文件名时间戳 UTC」确认为迁移回退——hourly 映射为 interval 触发器时丢弃 legacy 行时区，`resolve_time_zone` 按 触发器 zone → 保留的 legacy schedule 行 zone → UTC 三级解析修复（87dc5ee0c）。
7. **P2 处置（第二波）**：「Web 错误码 detail 载体」审计确认为真实缺口——顶层 `code` 恒为目录码 `DBX-LEGACY-0001`（违约 ADR §7.5），且 `schedulerErrorCode` 对实际服务的 body 形状失配、web 通道 `version_conflict` 特判静默失效；修复为 `AppError` 可选 `errorCode` 仅在设置时注入（其他路由逐字节不变，v1 可选字段规则钉住测试）（3452f7c5d）。遗留：`schedulerApi.ts` 归一化器可再加 JSON.parse 兜底。「OS 开机注册未接线」以官方 `tauri-plugin-autostart`（纯 Rust 侧）接线：默认关断、对账式幂等、注册失败吞掉不阻塞启动、标志入 `DesktopSettings` 并排除出云同步（设备本地）（a914f887d）。
8. **P2 处置（第三波）**：`schedulerErrorCode` 已补 JSON body 回退（errorCode 优先 → §7.5 机器码形态的 code → detail 前缀；目录码不外泄、坏 JSON 原样 undefined，274c0a4cb），C 项遗留闭环。「一级侧边栏入口未接」调查结论为**非缺口**：AppSidebar 是纯连接树面板，无工具页槽位系设计使然，工具栏按钮即计划 §0 所指的「一级入口」（有 3 个 spec 钉住）；若未来仍要侧边栏入口，最小方案 = AppSidebar 新增 `open-scheduler-page` emit 透传到 `App.vue` 的 `openSchedulerPage`（未实施，需 UI 评审），建议把 P2 项改写为「侧边栏底部入口（低优先级）」。剩余两项维持开放：resident start=run_now 语义（需 owner 决策，不建议 agent 猜语义）、worker 跨进程事件只进 worker.log（已有 3 秒活动轮询兜底，影响仅限事件新鲜度）。
9. **locale 修复（72d471dec）**：任务中心曾把 registry 的本地化 contributions 丢弃（只留 `definition.plugin`，manifest 仍是原文案），提供方/触发器标签与**配置项字段**全按英文渲染；`withLocalizedContributions` 重新挂回本地化副本并随 `locale` 变化重发现。
10. **插件路径选择器 + 动态下拉（host `2d4e7323f` + files 插件 `4f68fed3`）**：任务表单字段可声明 `picker.source: "plugin"`（`action` + `connection_field` 回退链）与 `options_action`。路径选择器对话框经通用 invokePlugin 通道浏览插件存储树——宿主侧解析被引用连接（归属校验、secrets 不出进程），带面包屑/手输跳转/非目录重定向/对话框内重试；`options_action` 渲染下拉（`host/connections` 为宿主保留命名空间零 RPC，未前缀 action 携带 locale 调 sidecar，失败回退文本框）；可选下拉带空档位（empty_label 链）映射回未设置以省略持久化键。files 插件 manifest 已为 sync/copy 路径字段声明 picker、为连接字段声明 `host/connections`，并实现 `files/listDirs`（仅目录、先过滤后 2000 截断、非目录回父目录带 `resolved_path`）。验证：调度器+registry 126 用例、plugin-runtime 179、files 后端 5 个新测试、src-tauri/dbx-web cargo check 全绿；.dbxp 已重打包，**需在插件中心重装 io.dbx.files 后生效**。
11. **选择器全局化（94256ac04）**：按 files 前端 `DirectoryBrowser`（`wb-mount-*` 样式）重造并提升为全局组件 `components/plugins/PluginPathPickerDialog.vue`：ArrowUp 上级 + 面包屑（分隔符根位后起）、`browseSeq` 竞态守卫、`localeCompare` 排序、单击选中（accent + aria-current）/双击或 Enter 进入目录、页脚确认用选中路径兜底当前路径；i18n 迁至 `pluginPathPicker.*` 独立模块（三语言），RPC 契约不变，调度器渲染器为首个消费方。
12. **表单分组节 + 表单自管连接（host `63104e708` + files 插件 `0840953d`，含接手并行会话的未提交工作集）**：任务表单支持具名分组节（trigger `groups` + 字段 `group`，标题走 `…triggers.<id>.groups` 本地化，节间源→目标流程分隔线）；单个可见字段的分组不渲染标题（避免与字段前缀文案雷同）。`options_action` 下拉合并 manifest 声明静态选项（`local` 本机保留侧由此可选）。编辑器对「触发器含 required 的 `host/connections` 字段」的表单自管连接场景折叠独立绑定区，保存时 `target.connectionId` 自动派生为源连接（envelope 语义不变）。files manifest：去掉分组声明（标签自解释）、源连接必填（目标留空跟随源）、三语标签去 ID 化。验证：调度器 90、plugin-runtime 182、files 后端 555 全绿 + vue-tsc；.dbxp 重打包后需重装。
13. **设计复查——手动触发/取消延迟（体验/性能，`5b2a9ba25` + `acf7bc9f3`）**：手动触发曾等 worker 轮询（默认 10s，均值 5s），取消运行中的任务同样要等满一个轮询（`reap` 逐 tick 才轮询 cancel 标志）。新增 **wake 文件机制**：`run_now`、accepted cancel、resident restart 触碰 `<scheduler>/wake`，引擎内 250ms mtime watcher（`Notify` 接入主循环 select）立即 tick——手动触发亚秒级被认领，取消即时传播。要点：watcher 的 `last_seen` 必须 `None` 起始（消费当前 mtime 会吞掉与租约获取竞速的真实变更；stale 文件只多一次无害启动 tick）；稳态成本不变（10s 轮询仍是唯一周期性工作，watcher 仅 4 次 stat/s）；touch 失败静默降级到常规 tick。测试以 1h 轮询隔离运行（只有 wake 路径能推进）：`tests/scheduler_wake.rs` ×2 + dbx-core 全量 92 套件绿。UI 侧 run/cancel 点击后 1.2s 追赶刷新一次。复查其余结论：enable/disable/保存类配置变更保持 10s 级生效（合理，不动）；遗留三项不变（resident 语义、worker 事件面、restart 双源）。
14. **设计复查——运行历史无限增长（稳定性，`877110542`）**：`task_runs`/`task_artifacts`/`task_log_index` 与磁盘日志目录（`logs/YYYY/MM/DD/<runId>/`）此前只随删任务清理——常驻桌面 + 每小时类任务一年写近千条 run，永续增长。新增 `RunRetentionPolicy`（默认 30 天 / 每任务 500 条终态，策略可调参）与 `SchedulerStore::prune_finished_runs`：单事务删除超龄 + 超帽的**终态** run（活跃 run 永不触碰）并级联清 artifacts/log_index，提交后尽力移除对应日志目录（含清空的 %Y/%m/%d 父链）。引擎首个 tick 清一次、之后至多每小时一次，失败日志隔离。审计表有意不动（操作史非批量数据）。测试 `tests/scheduler_retention.rs` ×5（年龄/活跃豁免/上限/空跑/首 tick），dbx-core 全量绿（schema_cache_50k 性能门禁在全量并发下抖动为负载 flake，单跑过）。
13. **路径浏览支持保留别名（01c6fc4e9）**：选「本机路径」后路径选择器报「Connection 'local' was not found」——宿主浏览解析器要求 id 必须是已存储连接，而 `local` 是插件保留别名（files 引擎会合成绑定）。修复：已存储连接仍走归属校验+服务端开池；未知 id 原样转发由插件裁决（合成或拒绝），`task/*`/`host/*` 守卫不变。回归测试 ×2（别名转发、跨插件归属拒绝）。
14. **任务执行的连接解析补全（host `b787e3203` + `52c1b81d2`、files 插件 `d176c73a`）**：端到端跑通「本机路径 → 存储连接」的任务，修掉三层连环报错：(a) 执行器 `ensure_connection` 曾把任务连接一律当存储连接开池——插件保留别名 `local` 直接 connection_missing；现未存储 id 直通插件（browse 侧 13 已同型修复）；(b) files `TriggerConfig::parse` 只认工作台驼峰键，manifest 下划线键（`source_path` 等）全读不到 →「sourcePath is required」；现双拼写兼容（驼峰权威）；(c) 执行器只开 target 连接，config 引用侧（copy 的目标，`options_action: "host/connections"` 标记字段）从未 connect →「Connection is not connected」；现派发前按标记打开全部 config 引用连接（存储开池/别名直通），validate 同检（保存即暴露死连接）。测试：宿主执行器 12、files task_provider 16 全绿。**宿主侧需重启桌面端生效；.dbxp 无需重装（d176c73a 后并行会话 12:41 包已含其前置）。**

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
