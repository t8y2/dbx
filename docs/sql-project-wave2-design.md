# SQL 项目管理 · 第二波功能（P0+P1）设计与执行方案

> 目标读者：接手执行/验证本方案的 AI 或开发者。
> 项目：DBX（Tauri 2.x + Rust 后端 + Vue 3 / Pinia 前端），桌面端类 DataGrip 的「SQL 文件项目」面板。
> 状态：**全部功能代码已写入工作区**。本文档描述设计契约 + 剩余验证任务。执行者只需做编译验证与修复，不要重复实现。

---

## 0. 环境与命令红线（必读）

| 事项 | 说明 |
| --- | --- |
| Rust 编译命令 | **必须** `cd src-tauri; cargo check --no-default-features`。本机未安装 Perl，默认 features（`duckdb-bundled`、`sqlite-sqlcipher` 等）会触发 `openssl-sys` 从源码编译 OpenSSL 而失败（`Command 'perl' not found`）。**禁止**裸跑 `cargo check` / `cargo build`。 |
| 前端类型检查 | `pnpm typecheck`（= `vue-tsc --noEmit --project apps/desktop/tsconfig.json`），在仓库根目录执行 |
| 前端单元测试 | `pnpm test`（vitest run） |
| Lint | `pnpm lint`（oxlint --vue-plugin apps/desktop/src） |
| 运行时冒烟 | `pnpm tauri dev -- -- --no-default-features`，前端地址 `http://localhost:1420/`（可选，需较长编译时间） |
| Git | **不要提交、不要 push**，仅做编译验证与必要的错误修复 |

---

## 1. 范围与语义决策

实现以下 4 项（P0 两项 + P1 两项）：

| # | 功能 | 优先级 |
| --- | --- | --- |
| ① | Local History 查看/恢复 UI | P0 |
| ② | 未保存状态上树（文件脏标记 `*`） | P0 |
| ③ | 文件系统监视增量刷新 | P1 |
| ④ | 单激活项目视图 + 顶部项目切换器（原「最近项目」需求） | P1 |

**第④项语义（已与用户确认）：**
- **不引入**「关闭项目」与「移除项目」的区分，维持现状：`removeProject` 直接删除 DB 记录（磁盘文件不删）。
- 面板改为**单激活项目视图**：树一次只渲染 `projectStore.activeProjectId` 对应的项目；`activeProjectId` 失效时回退到第一个项目。
- 工具栏下方新增**项目切换器行**：显示当前激活项目名，点击展开下拉列出全部项目（projectStore.projects 已按 `lastOpenedAt` 倒序，即"最近项目"顺序），可切换（`openProjectByPath(rootPath, {activate:true})`）、可移除（垃圾桶图标）、底部有「打开项目」入口。

---

## 2. 总体架构与数据流

```
Rust: src-tauri/src/commands/sql_project.rs   （tauri 命令层）
      src-tauri/src/storage.rs                （SQLite 持久化，已有快照表查询）
      crates/dbx-core/src/sql_project.rs      （SqlProject / SqlFileSnapshot 结构体，camelCase）
前端: apps/desktop/src/lib/backend/tauri.ts   （invoke 封装 + 类型）
      apps/desktop/src/lib/backend/api.ts     （forward() 双运行时分发）
      apps/desktop/src/lib/backend/http.ts    （Web 降级 stub）
      apps/desktop/src/stores/queryStore.ts   （tab 状态：脏判断、还原回写）
      apps/desktop/src/stores/projectStore.ts （项目列表/激活态）
      apps/desktop/src/components/layout/SqlFilePanel.vue       （树面板）
      apps/desktop/src/components/layout/SqlFileHistoryDialog.vue（本地历史对话框，新文件）
      apps/desktop/src/i18n/locales/*.ts      （8 语言）
```

双运行时：`isTauriRuntime()` 为 false（Web 模式）时，api.ts 分发到 http.ts 的 stub（抛 "SQL projects are only available in the desktop app"）；SqlFilePanel 的 watcher 也会因 `!isTauriRuntime()` 跳过。

---

## 3. 各功能设计细节

### ① Local History UI

**后端契约：**
- SQLite 表 `sql_file_snapshots` 已存在；每次保存前由 `snapshot_sql_file_before_save` 写入旧内容快照，每文件保留最近 20 份（`MAX_SQL_FILE_SNAPSHOTS_PER_FILE`）。
- 新增命令 `list_sql_file_snapshots(project_id, path, limit) -> Vec<SqlFileSnapshot>`（按 `saved_at` 倒序），委托 `storage.list_sql_file_snapshots`。
- `SqlFileSnapshot` 字段（camelCase）：`id, projectId, path, content, encoding, savedAt`。**注意：快照不记录换行符**。

**前端契约：**
- `tauri.ts`：`SqlFileSnapshot` 接口 + `listSqlFileSnapshots(projectId, path, limit)`；`api.ts` 增加 `forward`；`http.ts` stub。
- `queryStore` 新增并导出 `reloadExternalSqlFileContent(path, sql, version, encoding?, lineEnding?): boolean`——还原成功后回写已打开 tab：设置 `sql/originalSql`、`externalSqlFileVersion`、清 `externalSqlIgnoredFileVersion/externalSqlFileMissing`，可选更新编码/换行符，刷新标题；返回是否命中已打开 tab。
- `SqlFileHistoryDialog.vue`（props: `project`, `path`；`defineModel("open")`）：
  - 左侧时间线列表（时间 + 编码标签），右侧只读预览 textarea。
  - **还原流程**：
    1. `snapshotSqlFileBeforeSave(projectId, path)`——先把磁盘当前内容记快照，保证还原本身可回退（失败不阻断）；
    2. 读取磁盘当前文件换行符（`readExternalSqlFileSnapshot(path).lineEnding`），失败/文件不存在/过大时默认 `lf`；
    3. 用快照记录的原始编码写回：`writeExternalSqlFile(path, snapshot.content, { encoding, lineEnding })`；
    4. `result.kind !== "written"` → 提示 `localHistoryConflict`（防御分支；实际上不传 `expectedContentHash` 且 `expectedMissing=false` 时后端不会返回 conflict/missing，文件不存在会直接重建）；
    5. 成功 → `queryStore.reloadExternalSqlFileContent(...)` 回写 tab，toast `localHistoryRestored`，关闭对话框。
- 入口：树文件右键菜单新增「本地历史」项（`icon: History`）。

### ② 未保存状态上树（脏标记）

- `SqlFilePanel.vue` 新增 `dirtyExternalPaths` computed：遍历 `queryStore.tabs`，`mode === "query"` 且有 `externalSqlPath` 且 `queryStore.isTabDirty(tab)` 的路径，归一化（`normalizeSqlPath` + 小写）入 Set。
- `isEntryDirty(path)` 查集合；文件行模板在文件名后渲染橙色 `*`（重命名输入框显示时不渲染），`title` 用 `sqlFileTree.unsavedChanges`。
- 脏状态来自 tab，保存后 `isTabDirty` 变 false，星号自动消失（响应式）。

### ③ 文件系统监视增量刷新

- 使用 `@tauri-apps/plugin-fs`（已安装 v2.5.1）的 `watch(folderPath, cb, { recursive: true, delayMs: 400 })`，插件自带防抖。
- `SqlFilePanel.vue`：`folderWatchers: Map<folderPath, UnwatchFn>`；
  - `ensureFolderWatcher`：懒加载 import 插件模块；回调里 `void loadFolderEntries(folderPath, { silent: true })`（静默重扫，不弹 toast）；watch 失败静默降级（退回窗口聚焦刷新）。
  - `dropFolderWatcher` / `stopAllFolderWatchers`；`syncFromProjects` 里随项目增删维护 watcher；`onBeforeUnmount` 停止全部。
- 无需抑制自身写入回显：保存触发的重扫是只读操作，不会再次写盘，无循环。
- 权限：`src-tauri/capabilities/default.json` 已加 `fs:allow-watch`、`fs:allow-unwatch`。`tauri.conf.json` 无额外 fs scope 限制。

### ④ 单激活项目视图 + 切换器

- `activeFolder` computed：`folders.find(f => f.project.id === projectStore.activeProjectId) ?? folders[0] ?? null`。
- `visibleFolders` computed：`activeFolder ? [activeFolder] : []`。
- 模板：空状态判断与树渲染循环**均由 `folders` 改为 `visibleFolders`**（folders 仍保留全量状态供 watcher/findFolderForPath 等使用）。
- 切换器行（工具栏与树之间）：`v-if="folders.length > 0"`；按钮显示 `activeFolder?.project.name`；下拉面板遍历 `projectStore.projects`，激活项高亮，点击 `switchProject`（`openProjectByPath(rootPath, {activate:true})`），垃圾桶 `requestRemoveProjectByProject`（复用既有确认对话框），底部「打开项目」调 `pickFolder()`；fixed 遮罩点击关闭。

---

## 4. 已落盘改动清单（不要重复实现，只做核对）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/commands/sql_project.rs` | 新增 `list_sql_file_snapshots` 命令 |
| `src-tauri/src/lib.rs` | 注册 `commands::sql_project::list_sql_file_snapshots` |
| `src-tauri/capabilities/default.json` | 新增 `fs:allow-watch`、`fs:allow-unwatch` |
| `apps/desktop/src/lib/backend/tauri.ts` | `SqlFileSnapshot` 接口 + `listSqlFileSnapshots()` |
| `apps/desktop/src/lib/backend/api.ts` | `forward("listSqlFileSnapshots")` |
| `apps/desktop/src/lib/backend/http.ts` | `listSqlFileSnapshots` 降级 stub（抛错） |
| `apps/desktop/src/stores/queryStore.ts` | `reloadExternalSqlFileContent()` 并导出 |
| `apps/desktop/src/components/layout/SqlFileHistoryDialog.vue` | 新文件（时间线 + 预览 + 还原） |
| `apps/desktop/src/components/layout/SqlFilePanel.vue` | 单激活视图、切换器、脏标记、历史入口、watcher |
| `apps/desktop/src/i18n/locales/*.ts` | 8 语言 `sqlFileTree` 新增 9 键：`unsavedChanges`、`localHistory`、`localHistoryEmpty`、`localHistorySelect`、`localHistoryRestore`、`localHistoryRestoreConfirm`、`localHistoryRestored`、`localHistoryRestoreFailed`、`localHistoryConflict` |

---

## 5. 执行任务清单（按顺序）

1. **Rust 编译验证**：
   ```powershell
   cd c:\Users\10259\Desktop\dbx\src-tauri
   cargo check --no-default-features
   ```
   - 若报错，按报错修复（最可能出现在 `commands/sql_project.rs` 新命令的参数命名/类型、`lib.rs` 注册处）。
   - **再次强调：不要使用默认 features。**

2. **前端类型检查**：
   ```powershell
   cd c:\Users\10259\Desktop\dbx
   pnpm typecheck
   ```
   - 本轮实现后已跑过一次并通过（exit 0）；若执行期间有文件变动导致报错，按 vue-tsc 输出修复。

3. **前端单元测试**：
   ```powershell
   pnpm test
   ```
   - 关注 i18n 相关 spec（`executionNamespaceParity`、`typeHelpOverrides`、`sqliteRebuildNotice` 等）与 queryStore 相关测试。若因新增键/方法导致断言失败，按测试意图修复（不要为绕过测试而删键）。

4. **（可选）lint**：`pnpm lint`，仅修复本次改动文件的告警。

5. **（可选，耗时）运行时冒烟**：`pnpm tauri dev -- -- --no-default-features`，按第 6 节验收清单人工/半自动验证。

6. **产出报告**：列出每步命令、结果（通过/失败）、所做修复的文件与内容摘要。**不要 git commit。**

---

## 6. 验收清单

- **④ 单激活视图**：打开多个项目 → 树只显示激活项目；切换器下拉按最近使用排序；切换后树刷新为目标项目；移除激活项目后自动回退显示第一个项目。
- **② 脏标记**：从树打开文件 → 修改不保存 → 文件行出现橙色 `*`；保存后消失；重命名输入框显示时不出现星号。
- **① Local History**：对文件做多次保存（产生快照）→ 右键「本地历史」→ 时间线倒序列出快照 → 选中可预览 → 还原后磁盘与已打开 tab 内容一致；还原前的最新内容也在列表中（可回退）；无快照时显示空态文案。
- **③ 文件监视**：在资源管理器中对项目目录新增/删除/改名 .sql 文件 → 约 0.5s 内树自动更新，无需手动刷新；保存已打开文件也会触发树刷新且不弹错误 toast。

## 7. 已知风险点（审查时重点看）

1. `list_sql_file_snapshots` 命令的 serde 参数名与前端 invoke 的 `{ projectId, path, limit }` 必须一致（Rust 侧 snake_case 自动映射）。
2. watcher 在 Windows 大目录递归下的资源占用——`delayMs: 400` 已防抖；若面板关闭/项目移除未正确 unwatch 会泄漏，已通过 `syncFromProjects` + `onBeforeUnmount` 覆盖。
3. 还原写回使用快照编码；若快照 encoding 字段为非法值，`(snapshot.encoding as SqlFileEncoding) || "utf-8"` 兜底。
4. Web 模式（http.ts）下所有项目功能为 stub 抛错，属预期行为。
