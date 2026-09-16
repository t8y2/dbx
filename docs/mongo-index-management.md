# MongoDB 索引管理 UI —— 未完成事项清单

> 本文档记录「仿 Navicat 的 MongoDB 集合索引管理面板」功能中**尚未完成/待验证**的工作。
> 前端（UI、逻辑、测试）已完成并通过全部检查；**后端 Rust 代码已写完并在 `cargo check` / `cargo test` 中通过验证**（详见 §3）。

---

## 1. 当前进度总览

| 部分 | 状态 |
|------|------|
| 前端：集合右键 →「管理索引」菜单 | ✅ 完成 |
| 前端：`MongoIndexManagerDialog.vue` 面板（列表 + 属性区） | ✅ 完成 |
| 前端：索引创建表单（唯一键/稀疏/TTL/部分过滤器/背景/存储桶大小） | ✅ 完成 |
| 前端：i18n（en / zh-CN / zh-TW） | ✅ 完成 |
| 前端：单元测试（4 个测试文件） | ✅ 全部通过 |
| 前端：vue-tsc / oxlint / oxfmt | ✅ 全部通过 |
| 后端：Rust 源码编写（驱动 + ops + Tauri 命令 + Web 路由） | ✅ 已写完 |
| 后端：`cargo check` 编译验证 | ✅ **已通过**（见 §3 验证记录） |

---

## 2. 后端 Rust 代码（已写完，待编译验证）

以下文件均已完成修改，但**从未被 `cargo` 编译过**，不排除存在语法 / 类型错误，需要在一台装有 Visual Studio Build Tools（含 `kernel32.lib`）的机器上验证。

| 文件 | 改动内容 |
|------|----------|
| `crates/dbx-core/src/db/mongo_driver.rs` | 新增 `MongoIndexKey`、`MongoIndexSpec` 结构体；`list_index_specs()`（原生驱动，raw `listIndexes` + 游标读取）；`index_spec_from_document()`、`index_spec_from_index_info()`；辅助函数 `index_key_direction` / `index_flag` / `index_number`；常量 `MODELED_INDEX_FIELDS`；+9 个单元测试 |
| `crates/dbx-core/src/mongo_ops.rs` | 新增 `mongo_list_index_specs_core()`（原生驱动走 specs；Legacy Agent 走 `crate::schema::list_indexes_core` 降级并在 `properties_complete: false` 中标记） |
| `src-tauri/src/commands/mongo_cmd.rs` | 新增只读 Tauri 命令 `mongo_list_index_specs` |
| `src-tauri/src/lib.rs` | 注册 `commands::mongo_cmd::mongo_list_index_specs`（~1806 行） |
| `crates/dbx-web/src/routes/mongo.rs` | 新增只读路由 handler `list_index_specs`（POST，`ensure_scope` 读策略，返回 `Vec<MongoIndexSpec>`） |
| `crates/dbx-web/src/main.rs` | 注册路由 `POST /api/mongo/list-index-specs` |

### 2.1 编译验证结论（2026-08-13 已完成）

经人工代码复核 + `cargo check` 编译验证，§3 中列出的 4 项人工复核点全部通过：

- ✅ `mongo_driver.rs::list_index_specs` 中 `client.database(database).run_cursor_command(doc! { "listIndexes": collection })` 的 API 用法与同文件的 `aggregate_documents`（约 1186 行 `db.run_cursor_command(command)`）完全一致 —— 同样的 `Database::run_cursor_command(Document)` 签名 + `cursor.try_next()` 流式读取（依赖 `futures::TryStreamExt`，第 14 行已 import）。
- ✅ `mongo_ops.rs` 中 `crate::schema::list_indexes_core(state, connection_id, database, database, collection)` 的调用签名与 `schema.rs:5515` 的定义 `list_indexes_core(state: &AppState, connection_id: &str, database: &str, schema: &str, table: &str)` 一致 —— `(state, connection_id, database, database [作 schema], collection [作 table])`，对应 Mongo 的库即 schema 语义。Legacy Agent 降级时正确写出 `properties_complete: false`。
- ✅ `src-tauri/src/lib.rs` 中 `commands::mongo_cmd::mongo_list_index_specs` 注册在 1808 行 —— 与同模块的 `mongo_create_index`（1809）/`mongo_drop_indexes`（1810）相邻，且均位于 `tauri::generate_handler![...]` 同一个宏调用内，作用域正确。
- ✅ `crates/dbx-web/src/main.rs:620` 注册的 `.route("/mongo/list-index-specs", post(routes::mongo::list_index_specs))` —— `list_index_specs` 是独立路径，不与 `create-index`/`drop-indexes` 等任何已有路由冲突；`routes::mongo::list_index_specs` 返回 `Vec<MongoIndexSpec>`，handler 不带写策略守卫（只读，符合预期）。

### 2.2 历史：本机曾被报告无法编译的根因

```text
rust-lld: error: could not open 'kernel32.lib': no such file or directory
        could not open 'kernel32.lib' / 'ntdll.lib' / 'userenv.lib' / 'ws2_32.lib' / 'dbghelp.lib'
```

- 已确认三处均无 VS / Windows SDK：
  - `C:\Program Files (x86)\Windows Kits\10\Lib` ❌
  - `C:\Program Files\Microsoft Visual Studio` ❌（含 `C:\BuildTools`）
  - `C:\mingw64` / `C:\msys64` / Git 自带 gcc ❌（无 gcc 也无 MinGW）
- 工具链只有 `stable-x86_64-pc-windows-msvc`（无 GNU target）。
- **复查结论（2026-08-13）**：上述「缺少 SDK」的诊断不成立 —— Windows 10 SDK 实际已安装在 `C:/Program Files (x86)/Windows Kits/10/Lib/{10.0.26100.0, 10.0.28000.0}`，MSVC 链接器也在 PATH（`/d/dev/ms/soft/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64`）。`cargo` 此前未找到，仅因 `~/.cargo/bin` 不在 PATH 中；加入后 `cargo check` / `cargo test` 均可运行。
- 解决方式（任选其一，需网络/管理员权限）：
  1. 安装 **Visual Studio Build Tools**（勾选「使用 C++ 的桌面开发」+ Windows 10/11 SDK）；
  2. 或在**有 SDK 的机器 / CI** 上跑 `cargo test -p dbx-core --lib mongo_driver::`。

---

## 3. 验证清单（Rust 侧，已逐条执行 ✅）

```bash
# 1. 编译 dbx-core
cargo check -p dbx-core --lib

# 2. 跑新增的驱动单测（9 个）
cargo test -p dbx-core --lib mongo_driver::index_spec_

# 3. 编译 Tauri 命令层
cargo check --manifest-path src-tauri/Cargo.toml

# 4. 编译 Web 路由层
cargo check -p dbx-web
```

需要重点人工复核的点：

- [x] `crates/dbx-core/src/db/mongo_driver.rs` 中 `Client::database().run_cursor_command()` API 用法是否正确（`aggregate_documents` 里已有该用法作为参照，约 1000 行）；
- [x] `mongo_ops.rs` 里对 `crate::schema::list_indexes_core` 的调用签名（`(state, connection_id, database, schema, table)`）是否与 `schema.rs:5515` 一致（现在传的是 `database, database, collection`）；
- [x] `src-tauri/src/lib.rs` 命令注册列表中新增项是否在 `generate_handler!` 宏（或多个 `invoke_handler`）的**正确作用域**内；
- [x] `crates/dbx-web/src/main.rs` 路由注册处 `routes::mongo::list_index_specs` 是否有歧义冲突。

### 3.1 实际验证记录（2026-08-13，本机）

环境：`cargo 1.97.1` / `stable-x86_64-pc-windows-msvc`，MSVC 14.51 + Windows 10 SDK 10.0.26100.0 / 10.0.28000.0。

```text
# 步骤 1：编译 dbx-core
$ cargo check -p dbx-core --lib --no-default-features \
    --features "duckdb-sidecar,mq-admin,system-fonts"
   Finished `dev` profile in 1m 08s
```

> 注：本次 `--no-default-features` 是为绕开 `sqlite-sqlcipher`（其 `libsqlite3-sys` 触发 `openssl-sys` 源码编译，而本机 `perl` 是 MSYS2 版、缺 `Locale/Maketext/Simple.pm`，导致 OpenSSL Configure 失败）。
> **这不是本次索引功能改动引入的问题**：`sqlcipher` 默认 feature 一直依赖 vendored OpenSSL，与 mongo_index_specs 的任何代码无关。
> 在装有 Strawberry Perl / 完整 MSYS2 或预编译 OpenSSL 的 CI 上跑默认 features 即可。

```text
# 步骤 2：编译 dbx-web（同上 --no-default-features 跳过 sqlcipher）
$ cargo check -p dbx-web --no-default-features
   Finished `dev` profile in 29.16s

# 步骤 3：编译 Tauri 命令层
$ (cd src-tauri && cargo check --no-default-features \
    --features "duckdb-sidecar,mq-admin,system-fonts")
   Finished `dev` profile in 9m 50s

# 步骤 4：跑 mongo_driver 单测（含 9 个新增 index_spec_ 用例）
$ cargo test -p dbx-core --lib --no-default-features \
    --features "duckdb-sidecar,mq-admin,system-fonts" mongo_driver::
   test result: ok. 97 passed; 0 failed; 0 ignored
```

新增的 9 个 `index_spec_*` 测试全部 PASS：
`index_spec_from_document_reports_every_modeled_property`、
`index_spec_from_document_canonicalizes_whole_doubles_and_marks_the_default_index`、
`index_spec_from_document_keeps_non_numeric_key_directions_literal`、
`index_spec_from_document_accepts_numeric_truthiness_for_flags`、
`index_spec_from_document_collects_unmodeled_options_without_losing_them`、
`index_spec_from_document_derives_a_name_when_the_server_omits_it`、
`index_spec_from_document_reads_int64_and_double_ttl_values`、
`index_spec_from_index_info_marks_properties_as_incomplete`、
`index_spec_from_index_info_falls_back_to_columns_without_an_index_type`。

编译期仅遗留两条**与本次改动无关的预存 warning**（已通过 `git stash` 在 HEAD 上单独复现，确认非本次引入）：
- `crates/dbx-core/src/db/agent_driver.rs:3093` `unused import: spawn_agent_process`
- `crates/dbx-core/src/mongo_ops.rs:677` `unused import: super::*`（仅 `#[cfg(test)]` 模块，`#[cfg(unix)]` 用例在 Windows 上不编译所致）

---

## 4. 前端已切换到新端点，但要记得两件事

1. **api 层新增项**：
   - `apps/desktop/src/lib/backend/tauri.ts` → `mongoListIndexSpecs`（调 `invoke("mongo_list_index_specs", ...)`）
   - `apps/desktop/src/lib/backend/http.ts` → `mongoListIndexSpecs`（`POST /api/mongo/list-index-specs`）
   - `apps/desktop/src/lib/backend/api.ts` → `export const mongoListIndexSpecs = forward("mongoListIndexSpecs")`
   - 类型 `MongoIndexSpec` / `MongoIndexKey` 已定义在 `tauri.ts` 并被 `http.ts` import。

2. ⚠️ **旧版（Legacy Agent）连接** 走降级路径：`properties_complete: false`，面板里稀疏/TTL/背景/存储桶会隐藏，只显示「使用原生驱动连接以查看…」提示 —— 这是有意为之（避免把后端读不到的值当作服务器真实值展示）。

---

## 5. 回归测试（前端，已经全绿，作为基准）

```bash
node node_modules/vitest/vitest.mjs run \
  apps/desktop/src/composables/__tests__/useSidebarDatabaseSpecificMutationRuntime.mongo.spec.ts \
  apps/desktop/src/lib/sidebar/__tests__/mongoCollectionMutation.spec.ts \
  packages/app-tests/productionGuardEntrypoints.test.ts \
  apps/desktop/src/components/sidebar/__tests__/SidebarTreeItemDialogs.mongoIndex.spec.ts

node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --project apps/desktop/tsconfig.json
```

- 全量 `vitest run`：**6996 / 6997 通过**，唯一失败 `windowsInstallerTemplate.spec.ts` 为**预存在问题**（与本次改动无关，已在`git stash`后单独复现）。
- 额外注意：`packages/app-tests` 里没有 `mongoListIndexSpecs` 的 guard 测试（前端新增的 API forward 不受现有守卫约束影响）。

---

## 6. 已知取舍 / 后续可做

| 项 | 说明 |
|----|------|
| `background` / `bucketSize` | MongoDB 4.2+ 忽略 background、4.4+ 移除 geoHaystack 后 bucketSize 失效 —— 面板已标注「兼容选项」 |
| `hidden` 索引 | 后端已透传并在面板显示，但新建表单**未提供** hidden 开关（`createIndexes` 支持 `hidden`，可后续加） |
| 字段 datalist 补全 | 依赖 `listMongoCompletionFields` 采样；MongoDB 无 schema，空集合无建议 |
| 部分过滤器校验 | 前端只做 JSON 合法性校验，结构合理性交给服务器 |

---

## 7. 文件清单（本次全部改动）

```
apps/desktop/src/components/sidebar/MongoIndexManagerDialog.vue          (新增)
apps/desktop/src/components/sidebar/SidebarTreeItemDialogs.vue
apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue
apps/desktop/src/components/sidebar/sidebarAsyncDialogs.ts
apps/desktop/src/components/sidebar/sidebarTreeDialogState.ts
apps/desktop/src/composables/useSidebarDatabaseSpecificMutationRuntime.ts
apps/desktop/src/lib/sidebar/mongoCollectionMutation.ts
apps/desktop/src/lib/backend/api.ts
apps/desktop/src/lib/backend/http.ts
apps/desktop/src/lib/backend/tauri.ts
apps/desktop/src/i18n/locales/en.ts
apps/desktop/src/i18n/locales/zh-CN.ts
apps/desktop/src/i18n/locales/zh-TW.ts
apps/desktop/src/composables/__tests__/useSidebarDatabaseSpecificMutationRuntime.mongo.spec.ts
apps/desktop/src/lib/sidebar/__tests__/mongoCollectionMutation.spec.ts
crates/dbx-core/src/db/mongo_driver.rs          (Rust，✅ 已编译/测试通过)
crates/dbx-core/src/mongo_ops.rs                (Rust，✅ 已编译通过)
src-tauri/src/commands/mongo_cmd.rs             (Rust，✅ 已编译通过)
src-tauri/src/lib.rs                            (Rust，✅ 已编译通过)
crates/dbx-web/src/routes/mongo.rs              (Rust，✅ 已编译通过)
crates/dbx-web/src/main.rs                      (Rust，✅ 已编译通过)
```