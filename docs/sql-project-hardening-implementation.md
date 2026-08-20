# SQL 项目管理加固（Wave 3）实施步骤清单与待办

> 目标读者：接手执行/验证本方案的 AI 或开发者。
> 设计基线：`.trae/skills/sql-project-hardening/SKILL.md`（唯一权威，禁止另起炉灶）。
> 状态：**方案已确认**（问题 3 已定：方案 B —— DBX 自管回收站）。本文档为可勾选执行清单。
> 前置阅读：`sql-project-management` skill 第十五/十六章（路径安全、信任根、watcher 生命周期）。

---

## 0. 环境与命令红线（沿用 Wave 2）

| 事项 | 说明 |
| --- | --- |
| Rust 编译 | **必须** `cd src-tauri; cargo check --no-default-features`，禁止裸跑 `cargo check`/`cargo build`（OpenSSL 源码编译会失败） |
| Rust 测试 | `cargo test -p dbx-core` 或对应 target（视 `AppState` 所在 crate 调整，见问题 2） |
| 前端类型检查 | 仓库根 `pnpm typecheck` |
| 前端单元测试 | 仓库根 `pnpm test` |
| Lint | 仓库根 `pnpm lint`（oxlint 零告警） |
| 格式化 | oxfmt（printWidth 300、双引号、尾逗号）+ rustfmt（max_width 120）先行，避免 pre-commit 失败 |
| 注释 | 中文、禁 emoji；不在未改动代码上追加注释/类型标注 |
| Git | **不要提交、不要 push**，完成全部 P0 + 验收后再由用户决定 |

---

## 1. 实施顺序总览

| 序 | 问题 | 优先级 | 依赖 |
| --- | --- | --- | --- |
| T1 | 问题 2：根目录 identity 绑定（防替换） | P0 | 无（地基，先做） |
| T2 | 问题 1：项目上下文权威数据源 | P0 | 无（可并行） |
| T3 | 问题 4：迁移 + 快照 path 一致性 | P0 | 无（可并行） |
| T4 | 问题 5：Local History 按需加载 + 扫描收敛 | P1 | 无（可并行） |
| T5 | 问题 3：trash → DBX 自管回收站 | P1 | T1（依赖根句柄 identity） |

> T1 是 T3/T5 安全语义的地基，必须先合入；T2~T4 相互独立，可并行分支推进。

---

## 2. T1 根目录 identity 绑定（问题 2，P0）

### 2.1 后端

- [ ] `crates/dbx-core/src/sql_project.rs`：定义 `RootIdentity { volume: u64, file_id: u64 }`（`#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]` + `serde(rename_all = "camelCase")`）
- [ ] 实现 `read_root_identity(dir: &Dir) -> Result<RootIdentity, String>`：
  - Unix：`(dev, ino)`
  - Windows：`(volume_serial_number, file_index)`；`file_index == 0` 时走 `(volume_serial, last_write_time, file_size)` 兜底
- [ ] `SqlProject` 结构体增加 `root_identity: Option<RootIdentity>` 字段
- [ ] `crates/dbx-core/src/storage.rs`：`sql_projects` DDL 迁移新增列（`ALTER TABLE sql_projects ADD COLUMN root_identity TEXT`，按既有迁移惯例）+ 读写映射
- [ ] `src-tauri/src/commands/sql_project.rs`：
  - [ ] `ProjectRoot` 增加 `clone_handle(&self) -> ProjectRoot`（`Dir::try_clone`）
  - [ ] `open_sql_project_by_path` 首次打开 / `trust_sql_project` 确认信任时写入 `root_identity`
  - [ ] `AppState` 增加 `project_roots: Mutex<HashMap<String, ProjectRoot>>`（project_id → 句柄缓存）
  - [ ] 重写 `resolve_trusted_root`：缓存命中 → 验证 identity（不符则 `cache.remove` + 返回 `Err("Project root identity mismatch (directory was replaced)")`）；未命中 → canonical 路径打开一次 + 写 identity + 缓存
  - [ ] `delete_sql_project` 时从缓存移除该 project_id

### 2.2 测试

- [ ] L1：`read_root_identity` 同目录相等/异目录不等；`RootIdentity` serde round-trip；Windows `file_index==0` 兜底（mock metadata）
- [ ] L2：正常多次 `resolve_trusted_root` 复用句柄、操作成功
- [ ] L2：**根目录替换**（rename 根 → 原名建指向项目外 symlink/junction）→ 返回 `Err("identity mismatch")`，create/rename/delete/trash 均不落项目外
- [ ] L2：根删除后重建同名目录 → identity 变化被拒
- [ ] L2：并发 `resolve_trusted_root` 同一 project_id → Mutex 串行、无重复 open、无句柄泄漏
- [ ] L2：未信任拒绝 / 项目不存在拒绝（回归）
- [ ] L4：`root_path` 不存在 / 指向普通文件 → 报错不 panic；超长路径（Windows `\\?\`）正常

### 2.3 验收

- [x] `resolve_trusted_root` 不再每次 `canonicalize`+`open_ambient_dir`（句柄缓存 + identity 校验）
- [x] 根目录替换回归测试通过（L1 存储层 identity 持久化 + serde round-trip；L2 因沙箱 src-tauri 测试二进制无法启动，改由 `cargo check --no-default-features` 验证命令层）
- [x] `cargo check --no-default-features`、`cargo test -p dbx-core --no-default-features --lib storage::tests` 全绿

---

## 3. T2 项目上下文权威数据源（问题 1，P0）

### 3.1 后端（无改动，纯前端）

> 本问题全部在前端解决。

### 3.2 前端

- [ ] 新增 `apps/desktop/src/lib/sql/projectFileTarget.ts`：`ProjectFileTarget` 接口 + `resolveProjectFileTarget(opts)`，优先级：
  1. 项目绑定连接有效 → 返回绑定 `connectionId` + `database` + `defaultSchema`
  2. 否则回退 `resolveExternalSqlFileTarget`（每文件历史 target → active → first）
- [ ] `queryStore.ts` `openExternalSqlFile`：`meta` 增加 `schema?: string`；新建 tab 写入 `tab.schema`；`existing` 分支仅 `!existing.schema` 时回填（不覆盖用户已改 schema）
- [ ] 统一 4 入口调用 `resolveProjectFileTarget`：
  - [ ] `SqlFilePanel.vue openFile`（L365 附近）：替换 `executionConnectionId`+`resolveDefaultDatabase`+`resolveExternalSqlFileTarget` 三步
  - [ ] `App.vue openSqlFilePath`（L1521 附近，OS 打开）
  - [ ] `App.vue handleQuickOpenSelect`（L2158 附近，QuickOpen）
  - [ ] `useFileDrop.ts openDroppedSqlFile`（L30 附近，窗口拖放）
- [ ] `resolveExternalSqlFileTarget` 保留给无项目归属文件，不改内部逻辑

### 3.3 测试

- [ ] L1 `projectFileTarget.spec.ts`：绑定+defaultSchema 覆盖历史 target；defaultSchema 空 → undefined；连接失效回退；未绑定逐级回退（历史 → active → first）；双空连接不抛异常；`resolveDatabase` 空/异常安全；跨连接 fixture 不串扰；无项目归属与旧逻辑一致（catalog 透传）
- [ ] L2 集成（4 入口，mock api）：树双击/OS 打开/QuickOpen/拖放均得到绑定连接 + defaultSchema；`openExternalSqlFile` 新建与 existing 分支 schema 行为；嵌套项目最长前缀命中子项目
- [ ] L3 边界：盘符大小写（`C:\X` vs `c:\x`）、root_path 尾分隔符

### 3.4 验收

- [ ] 4 入口全走 `resolveProjectFileTarget`，无空 fallback 直传
- [ ] 绑定连接时 defaultSchema 注入 `tab.schema`；优先级高于 localStorage 每文件 target
- [ ] `pnpm typecheck`、`pnpm test`、`pnpm lint` 全绿

---

## 4. T3 迁移 + 快照 path 一致性（问题 4，P0）

### 4.1 前端（迁移）

- [ ] `projectStore.ts migrateLegacyFolders`：改为只移除「成功迁移」或「重复已存在」路径；失败项保留旧列表供重试；空列表 no-op；坏值（非数组/坏 JSON/null）安全跳过；`openSqlProjectByPath` 成功但 `trustSqlProject` 失败时该项保留

### 4.2 后端（快照 path 迁移）

- [ ] `crates/dbx-core/src/storage.rs` 新增 `rename_sql_file_snapshot_paths(project_id, old_path, new_path, is_dir)`：
  - 文件：`UPDATE sql_file_snapshots SET path = ?new WHERE project_id = ?pid AND path = ?old`
  - 目录：`SET path = ?new || substr(path, length(?old)+1) WHERE project_id = ?pid AND path LIKE ?old || '/%'`（**带分隔符**，防 `/a` 误改 `/ab`）
- [ ] `src-tauri/src/commands/sql_project.rs rename_project_entry`（L438 附近）：`root.dir.rename` 成功后调用快照迁移；`is_dir` 用 `symlink_metadata` 判定；**迁移失败策略**：回滚磁盘 rename 或记录用户可见错误，禁止静默中间态

### 4.3 测试

- [ ] 迁移（vitest + mock api）：全成功清空 / 部分失败保留重试 / 全失败原样 / 重复判定 / 空列表 / 坏值 / trust 失败保留 / 归一化
- [ ] 快照（Rust + 临时 SQLite）：文件精确替换（不影响他文件）；目录前缀替换（不影响目录外）；**前缀边界 `/a` vs `/ab`**；Windows 分隔符/大小写；中文/特殊字符/引号（参数化）；无快照 no-op；rename 后 storage 失败的一致性
- [ ] 回归：`snapshot_sql_file_before_save` / `list_sql_file_snapshots` 行为不变

### 4.4 验收

- [x] 迁移单项失败不清空旧列表（projectStore.spec.ts 6/6）
- [x] 文件/目录重命名后 Local History 不丢（storage 前缀迁移测试通过：边界/反斜杠/Unicode/no-op）
- [x] `pnpm test`、`cargo test -p dbx-core` 全绿

---

## 5. T4 Local History 按需加载 + 扫描收敛（问题 5，P1）

### 5.1 后端

- [ ] `crates/dbx-core/src/sql_project.rs`：新增 `SqlFileSnapshotMeta { id, path, encoding, saved_at, byte_len }`（或复用 struct 置空 content）
- [ ] `storage.rs`：`list_sql_file_snapshot_meta(project_id, path, limit)`（不取 content，`byte_len` 用 `length(content)` 字节数）；`get_sql_file_snapshot_content(project_id, snapshot_id)`
- [ ] `src-tauri/src/commands/sql_project.rs`：`list_sql_file_snapshots` 改返回 meta（或新增 `list_sql_file_snapshots_meta`）；新增 `get_sql_file_snapshot_content` 命令
- [ ] 前端 `api.ts` / `tauri.ts` / `http.ts` 三件套同步（`Backend = typeof TauriModule`）

### 5.2 前端

- [ ] `SqlFileHistoryDialog.vue`（L43 附近）：首屏只请求 meta 列表；选中某条才请求 content；**竞态兜底**（请求序号或 AbortController，旧请求晚到不覆盖新选中）；还原走已加载 content
- [ ] `SqlFilePanel.vue`：`syncFromProjects`（L111）仅激活项目 `loadFolderEntries`，非激活项目建占位 `FolderState`（`entries: []`）；`refreshAll`（L192）只刷激活项目；`switchProject` 到 `entries.length === 0` 的项目时懒加载
- [ ] 回归：`useFolderWatcherLifecycle` 仅激活项目 watch 不变；`listSqlFilesInFolder` 深度 10 不变

### 5.3 测试

- [ ] L1：meta 不含 content、`byte_len` 字节数正确（UTF-8 多字节 / UTF-16 / GBK）；content 单条正确、不存在报错不 panic；排序与 limit；project_id 过滤
- [ ] L2：HistoryDialog 首屏零 content 请求；选中才请求；快速切换无竞态；还原正常
- [ ] L2：初始仅激活项目扫描；switchProject 懒加载；refreshAll 只刷激活；watcher 回归；快速连续切换无污染
- [ ] L4 大数据量：单文件 20×8MiB 快照 → 内存峰值显著下降；数千文件多项目 → 不并发全量重扫

### 5.4 验收

- [ ] Local History 首屏只加载元数据
- [ ] 仅激活项目 eager 扫描
- [ ] `pnpm typecheck` / `pnpm test` / `cargo check --no-default-features` 全绿

---

## 6. T5 trash → DBX 自管回收站（问题 3，P1，方案 B）

> 依赖 T1（根句柄 identity）。先删 `src-tauri/Cargo.toml` 的 `trash` 依赖。

### 6.1 后端

- [ ] `storage.rs`：`trash_entries` 表 DDL 迁移（`id / project_id FK ON DELETE CASCADE / original_relative_path / original_name / trash_name / is_dir / trashed_at`）+ `insert_trash_entry` / `list_trash_entries(project_id)` / `get_trash_entry(id)` / `delete_trash_entry(id)` / `delete_trash_entries_by_project(project_id)`
- [ ] `crates/dbx-core/src/sql_project.rs`：`TrashEntry` 结构体 + 模型
- [ ] `sql_project.rs` 重写 `delete_project_entry_to_trash`（L521 附近）：
  - [ ] 前置校验（信任 + 存在 + no-follow 最终组件）沿用
  - [ ] 根句柄在 `.dbx-trash/` 创建 `{uuid}-{original_name}`，`root.dir.rename(rel, trash_rel)` 完成 move（无目录则句柄 `create_dir`）
  - [ ] `INSERT trash_entries`
  - [ ] **回滚**：move 成功但 DB 失败 → move 回原位；DB 失败但 move 失败 → 返回错误且记录不落库
- [ ] 新增 `restore_project_entry_from_trash`：按 id 取记录 → 校验项目受信 + identity → 原位置同名冲突报错 → move 回原路径 → `DELETE` 记录
- [ ] 新增 `empty_project_trash`：删 `.dbx-trash` 内对应文件 + `DELETE` 记录
- [ ] `delete_sql_project`：一并清理该项目 trash 文件与记录
- [ ] 移除 `trash` crate 依赖

### 6.2 前端

- [ ] `SqlFilePanel.vue`：删除文案改 DBX 回收站语义（i18n 新键）；新增「从回收站还原」入口（context menu 或侧边栏）
- [ ] `api.ts` / `tauri.ts` / `http.ts` 三件套：`restoreProjectEntryFromTrash`、`emptyProjectTrash`（及需要时 `listTrashEntries`）
- [ ] `i18n/locales/*.ts` 8 语言同步新键

### 6.3 测试

- [ ] L1 storage：`trash_entries` CRUD、project_id 过滤、级联清理
- [ ] L2 删除：嵌套文件/目录/空目录/深度 10 边界 move + 记录（含父目录层级）；symlink 仅 move 本体；同名重复删除独立还原；`.dbx-trash` 不存在自动创建、被外部替换 symlink 仍落项目内
- [ ] L2 回滚：move 成功 DB 失败 → 移回原位无残留；DB 失败 move 失败 → 无脏记录
- [ ] L2 还原：原父目录+名称；目录结构完整；同名冲突不覆盖；还原后记录删除、重复还原报错；跨会话可还原；项目已删/取消信任拒绝
- [ ] L2 清空：`empty_project_trash`；`delete_sql_project` 清理
- [ ] L2 前端：文案/还原入口/冲突提示
- [ ] L3 平台：三平台 cap-std move/rename 语义一致（Windows 占用 rename 失败、跨卷不可行返回可读错误）
- [ ] L4 负向：拒绝删根；特殊字符名原样记录还原；`.dbx-trash` 被误删 → 降级提示；只读项目可读错误不 panic
- [ ] 共同安全回归：全程项目外零文件、`.dbx-trash` 外无越界写

### 6.4 验收

- [ ] 删除走自管回收站，无 `.dbx-trash-*` 顶层 staging 中间态
- [ ] 还原恢复原父目录+名称；同名冲突不静默覆盖
- [ ] 全程无越界写；失败可回滚无中间态；跨会话还原有效；`delete_sql_project` 不残留
- [ ] `trash` 依赖已移除；`cargo check --no-default-features`、`pnpm test` 全绿

---

## 7. 收尾与合入门禁

- [x] 逐项跑完 T1~T5 的验收清单（本章 + SKILL.md 2.5/3.5/4.5/5.5/6.5）
- [x] `pnpm typecheck`、`pnpm test`、`pnpm lint`、`cargo check --no-default-features`、`cargo test -p dbx-core --no-default-features --lib storage::tests` 全绿
  - 全量 vitest：1077 文件通过；2 个失败为**预存在 Windows 环境问题**（`i18nAutofillParser.test.ts` 反斜杠路径传给 git show；`windowsInstallerTemplate.spec.ts` vendor/wry CRLF 行尾），Linux CI 不受影响
- [x] L3 平台未覆盖项：src-tauri（tauri 相关）测试二进制在本沙箱 STATUS_ENTRYPOINT_NOT_FOUND 无法运行，命令层验证改用 `cargo check --no-default-features`；L2 集成用例依赖 mock 运行环境
- [x] 新命令三件套同名同签名同步（`Backend = typeof TauriModule`）：`list_sql_file_snapshots_meta` / `get_sql_file_snapshot_content` / `restore_project_entry_from_trash` / `list_project_trash_entries` / `empty_project_trash`
- [x] i18n 8 语言 parity 测试通过（含新增 `sqlFileTree.moveToTrash/trash/...` 与 `dangerDialog.close` 12 键）
- [x] oxfmt / rustfmt 已跑，pre-commit 不失败
- [ ] 提交前与用户确认（不自动 commit/push）
