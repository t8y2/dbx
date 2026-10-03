# feat(postgres): 支持 PostgreSQL FDW 体系浏览（Foreign Data Wrapper / Foreign Server / User Mapping）

## 变更说明

为 dbx PostgreSQL 连接新增三种数据库级对象的浏览支持：**外部数据包装器**（Foreign Data Wrapper）、**外部服务器**（Foreign Server）、**用户映射**（User Mapping）。三者构成 PostgreSQL FDW 体系的完整管理链，此前 dbx 对此不可见。

实现沿用 Extensions / Event Triggers 已确立的全链路架构模式（driver query → core retry+fallback → web route → tauri command → frontend store/tree/dialog），并在 `ConnectionTree` 数据库节点下新增三个 group 节点。

**后端**：

- 新增 Rust 类型 `ForeignDataWrapperInfo`、`ForeignServerInfo`、`UserMappingInfo`（`crates/dbx-types/src/types.rs`）
- PostgreSQL driver 新增 3 条 catalog 查询 SQL + `parse_pg_options` 辅助函数（`crates/dbx-driver-postgres/src/postgres.rs`）
- Core 层新增 3 个 `_core` 函数，含 retry + Kingbase agent fallback + 原生回退（`crates/dbx-core/src/schema/mod.rs`）
- Kingbase agent 新增 sys/pg catalog 双前缀 fallback 及 options 解析（`crates/dbx-core/src/schema/kingbase.rs`）
- 附带修复：Kingbase event trigger `evttags` 列改为 `COALESCE(array_to_string(e.evttags, ','), '')`
- Web route 新增 3 个端点（`crates/dbx-web/src/routes/schema.rs`、`crates/dbx-web/src/main.rs`）
- Tauri command 新增 3 个命令（`crates/dbx-tauri-schema/src/commands.rs`、`crates/dbx-tauri-schema/src/lib.rs`）

**前端**：

- TypeScript 类型新增 3 个 interface + `TreeNodeType` 新增 6 个变体 + `TreeNode.meta` union 扩展（`apps/desktop/src/types/database.ts`）
- API 层新增 3 组 forward + http + tauri（`apps/desktop/src/lib/backend/*.ts`）
- connectionStore 新增 3 个 build + 3 个 load + 2 处 dispatch（`apps/desktop/src/stores/connectionStore.ts`）
- 侧边栏 tree：图标、group、loaded marker、action、context menu（`treeNodeIcon.ts`、`treeNodeGroup.ts`、`treeLoadedChildrenMarker.ts`、`SidebarTreeRuntimeHost.vue`）
- 3 个详情对话框 + DDL 预览（`apps/desktop/src/components/objects/ForeignDataWrapperDetailsDialog.vue`、`ForeignServerDetailsDialog.vue`、`UserMappingDetailsDialog.vue`）
- i18n：全部 11 locale 新增 6 个 key

**文件统计**：33 文件（30 修改 + 3 新增），+1241 / −12 行。

## 变更类型

- [x] 新功能
- [ ] Bug 修复
- [ ] 性能优化
- [ ] 代码重构
- [ ] 文档更新
- [ ] CI / 构建
- [x] 涉及前端

- [ ] 本 PR 为纯 Rust 后端改动，不涉及前端。
- [x] 本 PR 涉及前端改动，已附截图/录屏（见下方）

## 截图

> 截图占位（待手工测试补齐）：

- [ ] 侧边栏：数据库节点下展开，"Foreign Data Wrappers" / "Foreign Servers" / "User Mappings" 三个 group
- [ ] FDW 列表展开（含 `postgres_fdw`），点击弹出详情对话框
- [ ] Foreign Server 列表展开，点击弹出详情对话框
- [ ] User Mapping 列表展开（格式 `"user" (server)`），点击弹出详情对话框
- [ ] FDW 详情对话框：name/owner/handler/validator/options/comment + DDL 预览
- [ ] Foreign Server 详情对话框：name/owner/FDW/type/version/options/comment + DDL 预览
- [ ] User Mapping 详情对话框：user/server/options + DDL 预览
- [ ] Kingbase agent fallback 路径下三个 group 正常加载

## 验证

- `cargo check`（4 crates）：**0 errors**
- `cargo test --lib -p dbx-types`：**175 passed, 0 failed**
- `cargo fmt --check`：**0 diffs**
- `pnpm typecheck`（vue-tsc）：**0 errors**

- [x] `cargo check` 通过
- [x] 相关测试通过（dbx-types 175 用例）
- [x] `pnpm typecheck` 通过

## 关联 Issue

Closes #<待填>