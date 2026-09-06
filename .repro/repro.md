# Issue #7905 复现记录

## 环境
- OS: Windows 10（issue 原文写明），实际用 windows-vm-bridge 跑的 UTM Windows guest（Windows 10.0.26200，Windows on ARM）
- App: DBX v0.6.1 官方 portable 版（arm64-portable.zip），非 dev 模式，真实桌面 GUI
- DB: 共享测试 PostgreSQL 16.14（114.66.55.245:20033），新建了 `issue7905_repro` 库（额外建的，测完可删）

## 最短复现步骤
1. 新建 PostgreSQL 连接 `issue7905_repro`，初始 Database 填 `dbx_test`，Save & Connect
2. 该连接下 New Query，打开一个查询 tab（tab 标题 `issue7905_repro@dbx_test`）
3. 右键连接 → Edit Connection，把 Database 字段从 `dbx_test` 改成 `issue7905_repro`，Save（保存成功，无报错）
4. **不关闭/不新开** 第 2 步那个已打开的查询 tab，直接在原 tab 里执行：
   ```sql
   SELECT current_database() AS database_name, current_schema() AS schema_name, current_user AS user_name;
   ```
5. 对照组：在同一个连接上另开一个全新的 New Query tab，执行同样的 SQL

## 现象（已复现，与 issue 描述一致）
- 第 4 步：已打开的旧 tab 结果仍是 `database_name = dbx_test`（应为 `issue7905_repro`），且 tab 标题、工具栏数据库选择器全部还显示 `dbx_test`
- 第 5 步（对照）：新开的 tab 正确显示/返回 `issue7905_repro`
- 结论：bug 范围比 issue 原文描述的更精确——**不是连接对象本身没更新**，而是**已经打开的查询执行器 tab 持有一份旧的 database 快照，编辑连接保存后不会刷新已存在的 tab**；新建的 tab 能拿到最新值。

## 补充线索（issue 评论区，@baicai77）
> `[mcp_servers.dbx.env] DBX_MCP_SCOPE_DATABASE = "testdb"` 是之前写死了这个 toml，导致切换 dbx 上边的设置，并不会生效。

这条评论指向 MCP 配置文件层面的另一个写死值，可能是同一类"编辑连接后旧配置没刷新"问题在 MCP 场景下的另一个表现，但和本次复现的桌面查询 tab 场景不一定是同一处代码。本次先聚焦已复现、有截图证据的"已打开查询 tab 不刷新 database"这一条。

## 失败用例
UI 交互类，暂无法写自动化用例，见 `.repro/` 下截图（BEFORE_*、CONTROL_*、STEP_*）

## 根因

- 每个 query tab 在创建时（`apps/desktop/src/stores/queryStore.ts` `createTab()`）把当时的 `connection.database` **快照**成 `tab.database` 字段，之后就是纯本地值，不再跟连接配置联动。
- `connectionStore.updateConnection()`（Edit Connection 的 Save 走的就是这个函数）只更新了 `connections` 数组和侧边栏相关缓存，**从未回写任何已打开 tab 的 `tab.database`**。
- 执行 SQL 时（`queryStore.ts` `executeTabSql`）在没有多库/多 catalog 上下文的普通情况下，直接读 `tab.database` 这个旧快照发给后端 `execute_query` IPC，后端是纯透传，没有自己的"当前库"状态——锅完全在前端。
- 新开的 tab 之所以是对的，是因为它是在编辑之后重新从 `connectionStore.getConfig(...).database` 现读一遍，不是走同一份快照。

代码里已有为类似"连接状态变了、旧 tab 要跟着刷新"场景准备的落地模式（`queryStore.updateDatabase(id, database)`，用于 tab 自己的库切换器），只是没有被 `connectionStore.updateConnection` 调用。

## 修复

- `apps/desktop/src/stores/queryStore.ts`：新增 `syncTabsDatabaseForConnectionEdit(connectionId, previousDatabase, nextDatabase)`，对所有 `connectionId` 匹配且 `database` 仍等于编辑前旧值的 tab，复用已有的 `updateDatabase()`（回滚事务、关闭旧 result session、清空缓存的结果/表结构，跟"新建一个指向新库的 tab"效果一致），把它们的 `database` 改成新值。**故意跳过** `database` 已经和连接默认值不同的 tab（多库场景下用户手动切换过的 tab），不动它们，避免误伤。
- `apps/desktop/src/stores/connectionStore.ts`：`updateConnection()` 在检测到 `runtimeConfigChanged` 后，动态 import `queryStore` 并调用上面这个新函数，传入编辑前后的 database 值。

## 测试

新增 `apps/desktop/src/stores/__tests__/connectionStore.updateConnectionDatabaseTabs.spec.ts`（行为级测试，非字符串断言）：
1. 已打开、仍在旧默认库上的 tab，编辑连接库后被正确改到新库，且旧的 `tableMeta` 缓存被清空。
2. 用户已手动切到另一个库的 tab 不受影响。
3. 编辑连接但 database 未变时，不触发任何 tab 改动。

`pnpm check`（connection-types + oxfmt + oxlint + vue-tsc + 全量 vitest 522+2 用例）全绿。

## 复现环境证据（Windows，issue 原文环境）
截图见本目录 `BEFORE_*`（Windows 10 UTM VM，DBX v0.6.1 官方 portable 版真实 GUI，连远程共享 PostgreSQL）、`CONTROL_*`（对照：新 tab 是对的）。

## 修复效果验证（同一套操作步骤，patch 后重放）
因 Windows 上无法本地起 Rust 工具链/Docker 编译完整安装包，AFTER 验证改用：patch 后的前端源码起 `dev:web`（隔离端口/隔离数据目录）+ 隔离 Rust 后端，都跑在 Mac 上，绑定到与 UTM 虚拟网卡同网段的地址（`192.168.64.1`），让 Windows VM 里真实的 Windows 版浏览器（Playwright remote channel 连的是 guest 里真实起的 Edge/Chromium）通过网络访问，操作步骤与 BEFORE 完全一致（同一个已打开 tab，不关闭不新开）。截图见本目录 `AFTER_FIX_*`：`同一个 tab` 编辑连接库并保存后，重新执行同一条 SQL，`database_name` 从编辑前的 `dbx_test` 正确变为编辑后的 `issue7905_repro`，tab 标题和工具栏数据库选择器也同步更新。
