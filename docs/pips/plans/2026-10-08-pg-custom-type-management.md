# PostgreSQL 系列自定义类型管理开发计划

> 状态：PostgreSQL 第一批已完成，其他内核待实施
>
> 日期：2026-10-08
>
> 目标版本：待排期
>
> 适用数据库：PostgreSQL、KingbaseES、openGauss、GaussDB、Vastbase
>
> 编译约束：本计划涉及的所有 Rust 构建、检查和测试必须使用 `CARGO_BUILD_JOBS=2` 或 `cargo ... -j 2`，避免占满开发机资源。

---

## 0. 实施状态（PostgreSQL 第一批已完成）

第一批 PostgreSQL 实现已经落地，对应本计划 Phase 1 – Phase 5 的 PostgreSQL 部分。

| 层 | 交付物 | 位置 |
| --- | --- | --- |
| 公共 DTO | 操作 ID、capability、draft、preview/apply、dependency、drop 模型；`CustomTypeDetails.owner`；`CustomTypeDomainConstraint.validated` | `crates/dbx-types/src/types.rs`、`apps/desktop/src/types/database.ts` |
| 纯 SQL 规划器 | 25 个操作 ID、标识符/字面值转义、Enum/Composite/Domain/Range 差异、事务策略、drop 语句 | `crates/dbx-sql-schema/src/custom_type_sql/`（41 个单元测试） |
| 驱动元数据 | `pg_get_userbyid` 所有者、`convalidated`、`custom_type_name_exists`、`custom_type_dependencies` | `crates/dbx-driver-postgres/src/postgres.rs` |
| Core 编排 | capability 探测与缓存、snapshot、plan revision、preview/apply、依赖、drop | `crates/dbx-core/src/schema/custom_types.rs` |
| 传输 | 6 个 Tauri 命令 + 6 个 Web 路由 | `crates/dbx-tauri-schema/src/{commands,lib}.rs`、`crates/dbx-web/src/{main.rs,routes/schema.rs}` |
| 前端 API | 6 个封装（tauri/http/api 三处一致） | `apps/desktop/src/lib/backend/` |
| 设计器 UI | 查看/新建/编辑三模式、四类专属表单、SQL 预览、删除确认（依赖列表 + CASCADE） | `apps/desktop/src/components/objects/CustomTypeInfoPanel.vue`、`components/objects/custom-type/` |
| 入口 | 树 `group-types` 新建、类型节点编辑/删除、对象浏览器类型筛选新建按钮与行菜单 | `SidebarTreeRuntimeHost.vue`、`ObjectBrowser.vue`、`queryStore.openCustomTypeDesigner` |
| 草稿助手 | 快照↔草稿转换、dirty 判断、本地校验、prune | `apps/desktop/src/lib/database/customTypeDraft.ts` |
| 真实库验证 | 8 个 live 用例（含 create/alter/drop/依赖/并发 revision/事务） | `crates/dbx-core/tests/live_postgres_custom_types.rs` |

### 0.1 与计划的偏差

1. **规划器是单模块目录而非四个文件**：`custom_type_sql/` 只有 `mod.rs`（差异 + 校验）、`postgres.rs`（语句生成）、`tests.rs`。差异算法与方言 SQL 混在一个 `mod.rs` 里对当前规模更易读，拆分粒度留给后续扩展。
2. **设计器沿用 `CustomTypeInfoPanel.vue` 文件名**：它是 7 个既有测试和 `ObjectBrowser` 的既有入口，重命名会扩散改动面。组件内部已按设计器组织，kind 专属表单拆到 `components/objects/custom-type/`。
3. **入口可见性用静态引擎开关，不用异步探测**：`customTypeCapabilities().management` 决定是否渲染入口（避免菜单构造时发起网络请求），逐操作的可用性仍由 `getCustomTypeManagementCapabilities` 返回，并在预览里给出阻断原因。
4. **`apply` 先比 revision，再报 blocked**：live 测试暴露的问题 —— 用陈旧草稿重新规划会得到「值 X 不存在 / Y 无法删除」这类症状性阻断，先报「对象已被他人修改」才是可执行的提示。

### 0.2 PostgreSQL 实测结论（172.16.15.160:5432，第八节矩阵的 PostgreSQL 列）

| 能力 | 结果 |
| --- | --- |
| CREATE ENUM / COMPOSITE / DOMAIN / RANGE | 通过 |
| ALTER TYPE ... ADD VALUE（无锚点 / BEFORE / AFTER，多语句） | 通过，且在单事务内可提交 |
| ADD VALUE 在事务内 | 支持（版本 >= 12 时开启该 capability） |
| ALTER TYPE ... RENAME VALUE + COMMENT ON TYPE | 通过 |
| 删除枚举值 / 重排已有值 | 按设计阻断，类型未被改动 |
| ADD / RENAME / ALTER ATTRIBUTE ... SET DATA TYPE / DROP ATTRIBUTE + 列注释 | 通过（`varchar(12)` 被服务端规范化为 `character varying(12)`，再次规划不产生语句） |
| CREATE DOMAIN（含 CHECK）、SET/DROP DEFAULT、SET NOT NULL、ADD/RENAME/DROP CONSTRAINT、VALIDATE CONSTRAINT | 通过 |
| CREATE TYPE ... AS RANGE | 通过；Range 定义修改被阻断 |
| Domain 基础类型 / collation 修改 | 按设计阻断 |
| 重命名类型、SET SCHEMA、OWNER、注释 | 通过 |
| 依赖列表（`pg_depend`，过滤内部依赖） | 正确报出 `orders.state` 列 |
| DROP ... RESTRICT | 服务端按预期拒绝，类型保留 |
| DROP ... CASCADE | 通过，且 Domain 使用 `DROP DOMAIN` |
| 预览后外部修改 → apply | 以「changed on the server」拒绝 |
| 建表名称冲突 | 阻断并给出 `identity.name_taken` |

复现命令：

```bash
CARGO_BUILD_JOBS=2 RUST_MIN_STACK=33554432 \
DBX_LIVE_POSTGRES_HOST=172.16.15.160 DBX_LIVE_POSTGRES_PORT=5432 \
DBX_LIVE_POSTGRES_USER=test DBX_LIVE_POSTGRES_PASSWORD=... \
DBX_LIVE_POSTGRES_DATABASE=testlic \
  cargo test -j 2 -p dbx-core --test live_postgres_custom_types -- --ignored --test-threads=1
```

`RUST_MIN_STACK` 是 libtest 的线程栈设置：debug 构建下这些异步用例的 future 超过默认栈，与本功能实现无关（`dbx-core --lib` 同样的用例集也需要它）。

### 0.3 第一轮 review 修复（9 项）

代码 review 提出 8 个问题，加上界面显示 i18n key 的缺陷，全部已确认为真实问题并修复。

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 (P1) | 表达式字段可注入额外 SQL | `base_type`/`default`/CHECK/子类型等文本直接拼进语句，执行层再按 `;` 拆分，绕过「apply 不接受任意 SQL」的接口约束与规划器的语句数/事务判断 | 新增 `custom_type_sql/fragment.rs`：拒绝未加引号的 `;`、SQL 注释、dollar-quoting、不配对的引号/括号；名称字段额外要求是单个标识符或点分限定的标识符。规划器在生成任何语句前逐字段校验，命中即 blocked。Core 侧再加一道兜底：用执行层**同一个** splitter（`query_execution_plan_with_compatibility`）验证批次与计划逐一对应，不符则拒绝执行 |
| 2 (P1) | CHECK 规范化会改写字符串字面量 | `collapse_whitespace` 不区分引号，且结果被用于**发射** SQL，`'a  b'` 变成 `'a b'`，约束语义被改变 | 拆成三个函数：`check_body`（发射：只去掉多余的 `CHECK` 关键字和一层外层括号，内部一字不改）、`canonical_check_expression` / `canonical_expression`（仅用于比较，且空白折叠改为引号感知）。顺带修掉一个隐藏缺陷：字面量内的空白差异现在能被正确识别为「已修改」 |
| 3 (P1) | DROP revision 未覆盖快照与依赖 | revision 只含 target/cascade/capability/statement。预览后新增依赖时 apply 仍通过，新对象会在用户未确认的情况下被级联删除 | revision 现在覆盖目标种类/所有者、**规范化后的依赖集合**（排序去重）、以及依赖列表是否完整。目标不存在或读不到时直接拒绝，而不是给出可执行的计划 |
| 4 (P1) | 破坏性修改没有二次确认 | `preview.destructive` 从未被前端使用；生产库保护只在标记为 production 时生效 | 保存先经 `DangerConfirmDialog`，展示语句与破坏性警告。与原生产确认是两个不同问题，因此对所有数据库生效 |
| 5 (P2) | 重命名顺序会必然失败 | 枚举按最终顺序「边走边改」，在锚点自己被重命名的场合会生成引用尚不存在锚点的语句；枚举/属性/约束的 `a→b, b→a` 名称交换会撞名 | 新增 `order_renames`：拓扑排序，目标仍被占用时延后；纯环用临时名（`dbx_tmp_rename_*`）两步完成。枚举改为两阶段（先全部重命名、再按最终邻居插入），并让锚点基于「此刻确实存在的标签」计算。目标名被不动对象占用时报 `rename.target_taken` |
| 6 (P2) | Base/Multirange 编辑入口不可用 | `draftFromDetails` 把二者伪装成 Range draft，后端随即报 `type.kind_immutable`；编辑按钮对所有可管理类型显示 | 新增 `CustomTypeDraftDefinition::None { type_kind }`，草稿如实声明种类。Base 走通用属性（名称/Schema/所有者/注释）编辑路径；Multirange 按设计保持只读，入口隐藏，且后端另加 `multirange.rename_unsupported` / `multirange.set_schema_unsupported` 阻断（仅注释与所有者可改） |
| 7 (P2) | 未保存修改可被直接丢弃 | 关闭按钮直接 `emit('close')`；父组件切换对象时也没有守卫；关闭整个 objects tab 同样静默丢弃 | 统一到 `confirmDiscard()`：关闭按钮、父组件重新指向、以及 `cancelEdit` 共用。设计器再把 dirty 状态上报到 tab（`customTypeDraftDirty`），`isTabDirty` 覆盖 objects 模式，关闭整个 tab 也会确认；卸载时发布 `false`，避免残留标记永久阻塞 |
| 8 (P2) | Domain `validated` 开关提供无法执行的状态 | 规划器只处理 `false→true`，`true→false` 既不生成语句也不报阻断，用户改了开关却「无变化、无法保存」 | 规划器对 `true→false` 返回 `domain.unvalidate_constraint_unsupported` 阻断（PostgreSQL 没有取消验证的语句）；界面上已验证约束的复选框禁用并给出原因 |
| 9 | 界面显示 i18n key（`contextMenu.createType`） | 新增的 `createType`/`editType`/`dropType` 被插到了 `grid` 区块而不是 `contextMenu` 区块 | 移到 `contextMenu`（已按区块边界校验位置） |

本轮还发现并修复了一个由修复 #5 暴露的既有缺陷：域约束**同时**改名与改表达式时，规划器会既生成 `RENAME` 又生成 `DROP 旧名 + ADD 新名`，后者的 `DROP 旧名` 必然失败。现在三者分组规划：先 drop（替换与删除）、再 rename（仅保留原表达式者）、最后 add 与 validate。

验证：planner 70 个单测（含新增的「重放式」断言——按 PostgreSQL 的插入/重命名语义逐步重演语句，验证每条在执行时刻都合法）、Core 14 个单测、前端 19972 个测试、12 个真实 PostgreSQL 用例（新增注入拦截、字面量保真、Base/Multirange 保护、新依赖使 CASCADE 计划失效）。

### 0.4 第二轮 review 修复（跨语言 payload + 3 项 + 界面 key）

用户实测报错 `invalid args `request` for command `preview_custom_type_change`: missing field `base_type``，加上第二轮 review 的 3 项。

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 0 | 编辑已有 Domain/Range/Base 类型时 SQL 预览报 `missing field base_type` | `CustomTypeDraftDefinition` 只写了 `rename_all = "snake_case"`，它作用于 **variant 名**；variant **内部字段**仍是 `base_type` / `not_null` / `type_kind`，而前端一律发 camelCase。Enum/Composite 之所以没暴露，只是因为其字段（`values`/`attributes`）是单词 | 加 `rename_all_fields = "camelCase"`。并新建 `tests/fixtures/custom-type-payload-contract.json`，**Rust 与 TS 两侧测试共读同一份 fixture**（`custom_type_payload_contract.rs` 验证可反序列化 + 往返 + 规划无副作用；`customTypePayloadContract.spec.ts` 验证 builder 输出与之逐字节相等），字段名再漂移会在 CI 失败而不是等到运行时 |
| 1 (P1) | 破坏性确认框被永久设为 loading，无法确认或取消 | 打开前就设 `pendingDestructiveSave = true` 并并入 `loading`；而 `DangerConfirmDialog` 在 loading 时会禁用确认、取消 **并拒绝自身的关闭请求**（`dialogOpen` setter 里 `if (props.loading && !value) return`） | 删掉该 pending 标志，确认框只作为纯确认闸门：打开时可交互，确认后关闭对话框、由面板接管进行中状态（Save 置灰 + 转圈）。与同类破坏性 DDL 的既有做法一致（`ObjectBrowser.confirmDrop` 同样不给对话框传 `loading`），也避免 `SET NOT NULL` 这类慢语句把用户锁在无法关闭的模态里 |
| 2 (P2) | 重命名环经过临时名后，后续语句仍引用临时名 | 复合属性/域约束在重命名步骤上记 `step.from -> step.to`；环会经过 `dbx_tmp_rename_*`，于是 `city -> dbx_tmp_…` 被当成最终名，后续 `ALTER ATTRIBUTE` / `COMMENT ON COLUMN` / `VALIDATE CONSTRAINT` 指向该临时名 → 事务失败 | 显式区分「执行步骤的当前名」与「业务对象的最终名」：`order_renames` 只负责产出安全步骤，之后按 **original → final** 建立映射（`for (original, final) in &renames`），所有后续语句一律用最终名。新增两个测试：属性交换 + 改类型/注释、约束交换 + VALIDATE，断言语句中不出现 `dbx_tmp_rename` |
| 3 (P2) | DROP revision 的依赖键缺父对象身份 | 键为 `kind\|schema\|name\|deptype`，但驱动把列依赖的 `name` 设为列名、表名放在 `parent`。于是 `orders.state` 与 `invoices.state` 哈希相同：预览后依赖从一张表换到另一张同 schema 同列名的表，apply 仍通过，`CASCADE` 会删掉未经确认的新依赖 | 键加入 `parent`。并加强目标覆盖：revision 直接哈希 **完整目标快照**，另外显式带上 `catalogId`（PostgreSQL `pg_type.oid`，仅作为稳定身份，不进前端逻辑），从而也能识别「同名同类型对象被删除后重建」 |
| 4 | 界面显示 `contextMenu.createType` 等 key | 第一轮新增的 3 个 key 被插进了 `grid` 区块而非 `contextMenu` 区块 | 移入 `contextMenu`（按区块边界校验位置） |

关于 reviewer 建议的「apply 时在锁保护下完成最终校验」：本库没有对 `pg_type` 这类系统目录开放 `SELECT ... FOR UPDATE`（PostgreSQL 不允许对 catalog 加行锁），而 advisory lock 只能约束协作方、挡不住任意 DDL，因此效果有限。当前采用组合防护：plan revision（含完整快照、OID、规范化依赖集）→ apply 前重算并与 revision 比对 → 复用执行层 `use_transaction` 的原子批。这与仓库既有 SQLite/结构变更的做法一致。真正的残余窗口（重算与第一条语句之间）仍存在，已在计划的风险表里列明；若要彻底消除，需要 `LOCK TABLE pg_type` 这类重量级方案，收益不足。

### 0.5 第三轮 review 修复（2026-10-09，6 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 (P1) | 类型字段可通过逗号插入额外 ALTER 操作，绕过 destructive 与 capability 判断 | 类型和默认值分别用 PostgreSQL 方言解析为单个类型/表达式，要求消费至 EOF；名称字段拒绝相邻标识符。保留原始 SQL 文本，不用 AST 重新输出用户表达式 |
| 2 (P1) | CHECK 以中文字符串开头时按字节切片触发 panic，release 会 abort | CHECK 关键字识别使用安全的字节前缀比较，中文及 emoji 回归覆盖 |
| 3 (P1) | 只查直接依赖，遗漏数组、Domain 和视图等间接依赖，旧 CASCADE 计划仍可执行 | 递归遍历依赖及内部所有权边，遍历后再隐藏实现对象；列保留子对象身份，默认值依赖不再忽略。依赖新增可选 catalogId，revision 使用结构化身份键，区分重载、重建和名称中的分隔符 |
| 4 (P2) | 限定或已引用的 collation 被整体再次引用 | 按限定名称组件引用，保留已有双引号；支持 `pg_catalog."C"` 和 `"C"` |
| 5 (P2) | Enum 重命名后新增旧标签被误判为重复 | 新增阶段基于已有标签的最终名称构建集合，不保留已释放名称或临时名称 |
| 6 (P2) | 刷新按钮直接清空未保存草稿 | 刷新复用 confirmDiscard；保存/删除执行期间禁用刷新，组件测试覆盖取消与确认两个分支 |

真实库验证：使用桌面 dbinfo 指定的 PostgreSQL **14.19**，18 个 Core live 用例全部通过。新增用例覆盖同语句注入拦截、中文 CHECK 的实际约束效果、限定 collation、Enum 标签复用，以及数组/Domain/默认值/两层视图依赖和陈旧 CASCADE 拒绝；确认级联后表的无关列仍然存在。每个用例使用随机临时 Schema 并清理，额外依赖查询探测使用事务回滚。

Rust 验证：75 项 SQL 规划测试和 18 项 Core 类型相关单测全部通过。

前端验证：相关组件与草稿/协议/生产保护测试 65 项通过，`vue-tsc --noEmit` 通过（仓库类型检查需要 `NODE_OPTIONS=--max-old-space-size=8192`）。

### 0.6 第四轮 review 修复（2026-10-09，7 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 (P1) | 自动重新预览会接受旧草稿，将其他会话的修改覆盖回去 | 详情增加 snapshotRevision，编辑请求携带 expectedSnapshotRevision；Core 在 preview 和 apply 都校验最初加载的快照。缺少版本的编辑请求明确拒绝。哈希包含 OID 和可编辑目录字段，排除派生 DDL 与版本字段本身 |
| 2 (P2) | KeepAlive 缓存淘汰后草稿丢失且 dirty 被清除 | QueryTab 持有完整 customTypeSession（草稿、原稿、原始详情和当前身份/模式）；组件恢复时保留原始版本并重新预览，卸载不清除 dirty。退出类型面板的父级入口也检查放弃确认，明确关闭时清理会话和打开请求 |
| 3 (P2) | CREATE DOMAIN 直接追加 NOT VALID 会语法错误 | 未验证约束通过后续 ALTER DOMAIN ADD CONSTRAINT 添加，与创建组成原子事务，并检查对应 capability |
| 4 (P2) | 修改回填的 NOT VALID 约束时将后缀包进 CHECK 内 | check_body 只移除完整 CHECK 括号之外的 NOT VALID，保留表达式中的字符串与空白；验证状态仍由独立字段决定 |
| 5 (P2) | 中文及含空格的 multirange 伴生名称使 Range 编辑被阻断 | multirangeName 按原始对象名称处理，统一 quote_ident，不再当作 SQL 标识符片段校验；包含引号和分号的名称也保持在引用边界内 |
| 6 (P2) | 保存后刷新恢复旧名称或重新进入创建模式 | 父组件同步保存后的名称、Schema 和查看模式；普通刷新使用当前对象身份，缓存恢复也使用保存后的身份 |
| 7 (P2) | 防抖期间用新草稿搭配旧 planRevision 保存 | 草稿变化时同步清空旧预览并使在途响应失效；新预览返回前禁止保存；卸载取消计时器与请求结果回填 |

验证：78 项 SQL 规划测试、14 项 Core 编排单测、6 项跨语言协议测试、69 项前端组件/草稿/协议/生产保护测试通过；vue-tsc 与 git diff --check 通过。共享协议 fixture 覆盖 snapshotRevision / expectedSnapshotRevision 的 camelCase 传输。

真实 PostgreSQL 14.19：21 项 live 用例全部通过。新增三个用例分别覆盖 NOT VALID 创建后回填编辑、并发修改发生后重新预览和执行都拒绝旧草稿、中文 Range 的自动伴生名称不阻止修改备注。所有测试使用随机 Schema，并完成清理。

### 0.7 后续 review 修复与提交前检查（2026-10-09）

- 生成的字符串字面量显式处理反斜杠，避免受 `standard_conforming_strings` 设置影响；表达式校验与 CHECK 规范化共享 E/e 字符串扫描逻辑。
- 注释修改在所有者转移之前执行；从查看模式进入编辑时加载角色列表，Domain 的验证开关以原始快照为准。
- 依赖遍历区分自动删除与需要 CASCADE 的路径，将分类纳入计划版本；枚举标签保留有意义的首尾空白。
- 保存或删除期间，通过缓存保留机制让整个所属页面持续挂载，成功结果、失败错误和会话更新仍能送达。操作结束后释放保留状态，恢复普通的三页缓存淘汰；只读请求继续使用原来的过期响应保护。
- 已有空 Composite 可以编辑通用属性，也允许删除最后一个字段；新建 Composite 仍保留至少一个字段的校验。
- 回归覆盖保存期间连续切换标签页、请求结束前后返回、保存失败、删除完成、缓存释放，以及空 Composite 的注释修改和最后一个字段删除。

提交前验证：86 项 SQL 规划器测试、18 项 Core 编排测试、6 项跨语言协议测试和 596 项前端相关测试通过；TypeScript 检查通过，相关文件 lint 无错误。Rust 测试均使用 `--offline -j 2`。

### 0.8 尚未开始的阶段

- Phase 6（Kingbase / Vastbase Agent）：能力矩阵仍为 fail closed，这些连接保持只读类型浏览。
- Phase 7（openGauss / GaussDB）：同上。
- Phase 8 收尾：多语言文案目前只有 en / zh-CN 完整，其余语言回落到 key 之前需要补齐。

---

## 1. 背景与现状

DBX 已经能够在 PostgreSQL 系列数据库中列出和查看用户自定义类型，但目前仍是只读能力：

- 支持的数据库：`postgres`、`opengauss`、`gaussdb`、`kingbase`、`vastbase`。
- 支持识别的类型：`enum`、`composite`、`domain`、`range`、`multirange`、`base`。
- 支持查看类型成员、属性和生成的 DDL。
- PostgreSQL、GaussDB 走原生 PostgreSQL 驱动。
- Kingbase、Vastbase 通过 Agent 的 `get_type_details` 获取详情。
- 前端 `CustomTypeInfoPanel.vue` 只有查看模式。
- 左侧树和对象浏览器没有新建、编辑、删除入口。
- `customTypeCapabilities()` 只有 `details / members / ddl` 三个只读开关。

主要代码位置：

| 模块 | 当前文件 | 当前职责 |
| --- | --- | --- |
| 前端详情面板 | `apps/desktop/src/components/objects/CustomTypeInfoPanel.vue` | 只读显示成员、属性和 DDL |
| 对象浏览器 | `apps/desktop/src/components/objects/ObjectBrowser.vue` | 打开类型详情和 DDL |
| 左侧树菜单 | `apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue` | 复制类型 DDL、复制名称 |
| 前端静态能力 | `apps/desktop/src/lib/database/databaseObjectCapabilities.ts` | PG 系列只读能力开关 |
| 前端数据类型 | `apps/desktop/src/types/database.ts` | `CustomTypeDetails` 等类型 |
| Tauri API | `crates/dbx-tauri-schema/src/commands.rs` | `get_custom_type_details` |
| Web API | `crates/dbx-web/src/routes/schema.rs` | `GET /schema/custom-type-details` |
| Core 编排 | `crates/dbx-core/src/schema/mod.rs` | 路由到原生驱动或 Agent |
| PostgreSQL 元数据 | `crates/dbx-driver-postgres/src/postgres.rs` | 类型列表、详情和 CREATE DDL |
| Kingbase 元数据 | `agents/drivers/kingbase-go/kingbase_metadata.go` | 类型列表和详情 |
| Vastbase 元数据 | `agents/drivers/vastbase-go/vastbase_metadata.go` | 类型列表和详情 |
| 公共 Rust DTO | `crates/dbx-types/src/types.rs` | 类型详情结构 |

本功能不能简单实现为“编辑 CREATE DDL，然后 DROP + CREATE”。类型经常被表字段、函数参数、默认值、其他类型和约束引用，重建会造成大范围依赖破坏。正常编辑必须生成最小 `ALTER TYPE` / `ALTER DOMAIN` 语句。

---

## 2. 目标

### 2.1 用户目标

1. 用户可以从左侧“类型”分组或对象浏览器新建自定义类型。
2. 用户可以用结构化界面修改数据库允许安全修改的类型属性。
3. 用户可以在执行前查看 DBX 将要执行的完整 SQL。
4. 用户可以删除类型，并在删除前看到依赖和 `CASCADE` 风险。
5. 用户能够清楚知道某个操作为什么在当前数据库、版本或兼容模式下不可用。
6. 修改成功后，左侧树、对象浏览器和当前详情面板立即同步。

### 2.2 工程目标

1. SQL 生成集中在一个 Rust 纯规划器中，不在 Vue、Tauri/Web 路由或各 Agent 中重复拼接。
2. 预览 SQL 和实际执行 SQL必须来自同一个计划生成过程。
3. 应用变更前重新读取数据库状态并校验计划 revision，拒绝陈旧编辑。
4. 所有写操作继续经过只读连接保护、生产库确认和查询历史记录。
5. 每一种数据库能力都必须通过显式 capability 控制，不能按“PG 家族”一次性全开。
6. 新增能力必须有纯单元测试、API 契约测试、前端组件测试和真实库集成测试。

---

## 3. 非目标

第一版不包含以下能力：

- 删除 PostgreSQL Enum 的已有值。
- 任意重排 Enum 的已有值。
- 自动重建已被依赖对象引用的 Enum、Range 或 Base 类型。
- 结构化创建 Base 类型。
- 独立创建或结构化修改 Multirange 伴生类型。
- 修改 Range 的 subtype、canonical、subtype_diff 或 opclass。
- 自动迁移使用旧类型的表数据。
- 把类型管理加入 Schema Diff、数据传输或 MCP 工具。
- 跨数据库复制类型。

这些操作如后续需要支持，应单独设计“重建向导”，不能混入普通编辑保存流程。

---

## 4. 第一版功能范围

### 4.1 类型能力矩阵

| 类型 | 新建 | 安全增量修改 | 通用修改 | 删除 |
| --- | --- | --- | --- | --- |
| Enum | 是 | 新增值；经验证后支持重命名值 | 重命名、Schema、Owner、注释 | `DROP TYPE` |
| Composite | 是 | 新增、重命名、删除字段；修改字段类型和注释 | 重命名、Schema、Owner、注释 | `DROP TYPE` |
| Domain | 是 | 默认值、NOT NULL、约束的增删改名与验证 | 重命名、Schema、Owner、注释 | `DROP DOMAIN` |
| Range | 是 | 否，定义属性创建后只读 | 重命名、Schema、Owner、注释 | `DROP TYPE` |
| Multirange | 否 | 否 | 只读；必要时跟随所属 Range 显示 | 默认禁止单独删除 |
| Base | 否 | 否 | 重命名、Schema、Owner、注释，具体按能力开放 | `DROP TYPE` |

说明：

- “通用修改”也必须逐数据库验证，不等于默认开放。
- Composite 属性没有独立的 `NULL/NOT NULL` 和默认值语义，编辑表格只显示“名称、类型、注释”。现有详情中的 nullable/default 列不进入编辑表单。
- Domain 的基础类型和 collation 创建后不可原地修改，编辑模式下只读。
- Range 创建后核心定义不可通过 PostgreSQL 标准 `ALTER TYPE` 修改。
- Multirange 通常是 Range 自动生成的伴生对象，删除入口应引导用户操作所属 Range。

### 4.2 分阶段开放原则

能力不按数据库名称直接推断，而按真实库验证结果开放：

1. PostgreSQL 先实现和验证完整首版范围。
2. Kingbase 两种兼容模式分别验证，不能共用结论。
3. Vastbase 仅在 PostgreSQL 兼容模式下验证和开放。
4. openGauss、GaussDB 分别验证，不因共享驱动自动开放。
5. 未识别版本、新版本或未知兼容模式默认 fail closed，只保留已验证的只读能力。

---

## 5. 用户界面设计

## 5.1 统一“类型设计器”

将现有类型详情抽屉升级为统一设计器，支持三种模式：

```ts
type CustomTypeDesignerMode = "view" | "create" | "edit";
```

不为新建、编辑分别增加不同弹窗。统一设计器继续位于对象浏览器右侧：

- 查看模式默认沿用当前约 `420px` 宽度。
- 新建、编辑模式首次打开时建议扩展到 `640px`。
- 继续使用对象浏览器现有 `280px - 900px` 可拖动宽度。
- 抽屉关闭前，如果存在未保存修改，必须弹出放弃修改确认。

建议拆分组件，避免继续扩大单文件：

```text
components/objects/custom-type/
  CustomTypeDesigner.vue
  CustomTypeHeader.vue
  CustomTypeDefinitionForm.vue
  CustomTypeEnumEditor.vue
  CustomTypeCompositeEditor.vue
  CustomTypeDomainEditor.vue
  CustomTypeRangeEditor.vue
  CustomTypeSqlPreview.vue
  CustomTypeDeleteDialog.vue
  customTypeDraft.ts
  customTypeValidation.ts
```

现有 `CustomTypeInfoPanel.vue` 可以分两步迁移：

1. 先改为 `CustomTypeDesigner.vue` 的薄包装，保持现有调用方和测试稳定。
2. 调用方迁移完毕后再删除包装或重命名文件。

## 5.2 查看模式

保持当前“成员 / 属性 / DDL”三个页签，并增加顶部操作：

- `Pencil`：进入编辑模式。
- `RefreshCw`：重新读取当前类型。
- `Trash2`：打开删除确认。
- `X`：关闭抽屉。

只读连接：

- 不显示编辑和删除按钮，或显示禁用状态并提供只读原因 tooltip。
- 仍允许查看和复制 DDL。

不完整 DDL：

- Base、Multirange 等继续显示现有 warning。
- 不完整 DDL不能作为“可执行源码”进入编辑模式。

## 5.3 新建模式

顶部固定字段：

| 字段 | 控件 | 规则 |
| --- | --- | --- |
| Schema | 可搜索下拉框 | 默认当前 Schema；只列出当前连接可见 Schema |
| 名称 | Input | 必填；不在前端自行大小写折叠 |
| 类型 | Select / segmented control | Enum、Composite、Domain、Range；能力不支持的选项禁用并显示原因 |
| Owner | 可搜索下拉框 | 可选；为空时使用当前用户 |
| 注释 | Textarea | 可选 |

类型一旦产生有效草稿后切换类型种类，应弹出确认，因为会丢失当前类型专属配置。

## 5.4 编辑模式

顶部显示：

- 原始完全限定名。
- 类型种类 badge；类型种类不可修改。
- Schema、名称、Owner、注释字段。
- `保存`、`取消`。

编辑模式载入时保存不可变原始快照。所有 SQL 都通过“原始快照 vs 当前草稿”生成，不允许根据 DOM 操作历史直接拼 SQL。

## 5.5 Enum 编辑器

使用稳定高度的表格列表：

| 列 | 内容 |
| --- | --- |
| 顺序 | 序号和拖动手柄 |
| 值 | Input |
| 状态 | Existing / New / Renamed |
| 操作 | 在前插入、在后插入、重命名、删除新增值 |

规则：

- 新建类型时可以增删和自由排序所有值。
- 编辑已有类型时，已有值不能删除。
- 已有值不能通过拖动改变彼此顺序。
- 新值可以插入到已有值之前或之后，对应 `BEFORE` / `AFTER`。
- 新值之间的顺序由规划器计算，不由前端直接生成定位 SQL。
- `RENAME VALUE` 只有 capability 开放时才允许。
- 如果数据库不支持事务内安全执行多条 `ADD VALUE`，第一版只允许一次保存新增一个值，或明确返回阻断项，避免部分成功。
- 值必须唯一，比较按数据库字面值精确匹配，不在前端统一转小写。

## 5.6 Composite 编辑器

表格列：

| 列 | 内容 |
| --- | --- |
| 顺序 | 已有字段固定相对顺序；新增字段默认追加 |
| 名称 | Input |
| 数据类型 | 可搜索类型选择器，允许输入完整类型表达式 |
| 注释 | Input |
| 操作 | 新增、重命名、删除 |

规则：

- 使用后端 `list_data_types` 作为建议列表，但不能限制用户输入 schema-qualified、自定义类型、数组或带参数类型。
- 已有字段通过 `originalName` 保持身份，避免把重命名误判为删除后新增。
- 修改字段类型是潜在破坏性操作，应在预览中显示 warning。
- 删除已有字段是破坏性操作，必须标记 destructive。
- 第一版不支持把已有字段移动到不同位置。
- 新增字段默认放在末尾；只有数据库经验证支持位置语法后才扩展。

## 5.7 Domain 编辑器

表单：

- 基础类型：创建时可编辑，编辑时只读。
- Collation：创建时可选，编辑时只读。
- 默认值：SQL 表达式输入框，不自动加引号。
- NOT NULL：Switch。
- CHECK 约束表格：名称、表达式、是否已验证、操作。

规则：

- CHECK 输入只填写表达式，界面可接受用户输入 `CHECK (...)`，规划器统一规范化。
- 修改约束定义生成 `DROP CONSTRAINT` + `ADD CONSTRAINT`，必须在同一事务中执行。
- 新增约束默认直接验证；后续可增加 `NOT VALID` 和显式 `VALIDATE` 工作流。
- 删除约束标记 destructive。
- 从 nullable 改为 NOT NULL 可能扫描并锁定依赖列，显示性能警告。

## 5.8 Range 编辑器

创建字段：

- Subtype，必填。
- Subtype opclass，可选。
- Canonical function，可选。
- Subtype diff function，可选。
- Multirange type name，可选，仅 capability 支持时显示。

编辑模式：

- 上述字段全部只读。
- 仅允许经过验证的通用修改：名称、Schema、Owner、注释。
- 提示“Range 核心属性创建后不能原地修改”。

## 5.9 SQL 预览

设计器下半部分提供可折叠 SQL 预览，交互与表结构编辑器一致：

- 草稿变化后 debounce 调用后端 preview。
- 展示准确 SQL、语句数量、warning、阻断原因。
- 支持复制 SQL。
- preview 加载中保存按钮不可用。
- `blockedChanges` 非空时保存按钮不可用。
- warning 不一定阻止保存；destructive warning 需要额外确认。
- 前端不缓存并重新提交 SQL，只提交结构化 draft 和 `planRevision`。

## 5.10 删除对话框

复用 `DangerConfirmDialog`，新建 `CustomTypeDeleteDialog.vue` 封装类型特有逻辑：

- 显示完全限定名、类型种类。
- 默认使用 `RESTRICT`。
- 展示 drop preview SQL。
- 展示直接依赖列表和依赖数量。
- `CASCADE` 默认关闭。
- 打开 `CASCADE` 后重新生成 preview。
- 依赖结果不完整时必须提示，不能显示“无影响”。
- Multirange 默认不提供单独删除，显示所属 Range。
- 执行时继续经过 production guard。

---

## 6. PostgreSQL SQL 语义

## 6.1 通用操作

普通类型：

```sql
ALTER TYPE "app"."status" RENAME TO "order_status";
ALTER TYPE "app"."status" SET SCHEMA "shared";
ALTER TYPE "app"."status" OWNER TO "app_owner";
COMMENT ON TYPE "app"."status" IS '订单状态';
COMMENT ON TYPE "app"."status" IS NULL;
```

Domain 使用独立关键字：

```sql
ALTER DOMAIN "app"."email" RENAME TO "email_address";
ALTER DOMAIN "app"."email" SET SCHEMA "shared";
ALTER DOMAIN "app"."email" OWNER TO "app_owner";
COMMENT ON DOMAIN "app"."email" IS '邮箱地址';
DROP DOMAIN "app"."email" RESTRICT;
```

规划器在名称或 Schema 改变后，后续语句必须引用变更后的身份。语句顺序固定为：

1. 类型专属结构变更。
2. 重命名。
3. 移动 Schema。
4. 修改 Owner。
5. 修改注释。

如果特定数据库要求不同顺序，由 dialect capability/adapter 调整，不在前端处理。

## 6.2 Enum

```sql
ALTER TYPE "app"."status" ADD VALUE 'archived';
ALTER TYPE "app"."status" ADD VALUE 'review' BEFORE 'published';
ALTER TYPE "app"."status" ADD VALUE 'archived' AFTER 'published';
ALTER TYPE "app"."status" RENAME VALUE 'draft' TO 'pending';
```

必须阻止：

- 删除已有值。
- 改变已有值之间的相对顺序。
- 生成重复值。
- 在 capability 未验证时使用 `IF NOT EXISTS`、`BEFORE/AFTER` 或 `RENAME VALUE`。

## 6.3 Composite

```sql
ALTER TYPE "app"."address" ADD ATTRIBUTE "country" text RESTRICT;
ALTER TYPE "app"."address" RENAME ATTRIBUTE "city" TO "city_name" RESTRICT;
ALTER TYPE "app"."address" ALTER ATTRIBUTE "zip" SET DATA TYPE varchar(12) RESTRICT;
ALTER TYPE "app"."address" DROP ATTRIBUTE "legacy" RESTRICT;
COMMENT ON COLUMN "app"."address"."city_name" IS '城市';
```

`CASCADE/RESTRICT` 是否支持及默认值由 capability 决定。第一版默认 `RESTRICT`，不自动扩大影响范围。

## 6.4 Domain

```sql
ALTER DOMAIN "app"."email" SET DEFAULT ''::text;
ALTER DOMAIN "app"."email" DROP DEFAULT;
ALTER DOMAIN "app"."email" SET NOT NULL;
ALTER DOMAIN "app"."email" DROP NOT NULL;
ALTER DOMAIN "app"."email" ADD CONSTRAINT "email_valid" CHECK (VALUE ~ '.+@.+');
ALTER DOMAIN "app"."email" DROP CONSTRAINT "email_valid" RESTRICT;
ALTER DOMAIN "app"."email" RENAME CONSTRAINT "email_valid" TO "email_format";
ALTER DOMAIN "app"."email" VALIDATE CONSTRAINT "email_valid";
```

约束定义变化不能误判为约束改名。仅当 `originalName` 保持且表达式未变时，名称变化才生成 `RENAME CONSTRAINT`；表达式变化必须生成 drop + add。

## 6.5 Range

```sql
CREATE TYPE "app"."price_range" AS RANGE (
  subtype = numeric,
  subtype_opclass = "pg_catalog"."numeric_ops",
  canonical = "app"."price_range_canonical",
  subtype_diff = "pg_catalog"."numrange_subdiff",
  multirange_type_name = "price_multirange"
);
```

创建后只生成通用 `ALTER TYPE`，不生成 Range 核心属性变更 SQL。

## 6.6 删除

```sql
DROP TYPE "app"."status" RESTRICT;
DROP TYPE "app"."status" CASCADE;
DROP DOMAIN "app"."email" RESTRICT;
DROP DOMAIN "app"."email" CASCADE;
```

禁止把 Domain 错误地生成成 `DROP TYPE`。

---

## 7. 数据模型与 API 合同

## 7.1 扩展现有详情模型

在 `crates/dbx-types/src/types.rs` 和 `apps/desktop/src/types/database.ts` 中补充管理所需字段：

```rust
pub struct CustomTypeDetails {
    pub name: String,
    pub schema: String,
    pub kind: CustomTypeKind,
    pub owner: Option<String>,
    pub comment: Option<String>,
    pub members: Vec<CustomTypeMember>,
    pub properties: CustomTypeProperties,
    pub ddl: Option<CustomTypeDdl>,
}
```

建议扩展：

```rust
pub struct CustomTypeDomainConstraint {
    pub name: String,
    pub definition: String,
    pub validated: Option<bool>,
}

pub struct CustomTypeProperties {
    // existing fields...
    pub owning_range_type: Option<String>, // multirange -> range
}
```

兼容要求：

- 新字段使用 `Option` 和 serde default，旧 Agent 返回值仍能反序列化。
- Kingbase、Vastbase Agent 同步返回 owner、constraint validation 和 owning range，无法读取时返回 `None`，不能伪造值。
- 修复 CREATE DDL：类型或 Domain 有 comment 时应附带正确的 `COMMENT ON TYPE/DOMAIN`。

## 7.2 类型身份和草稿

公共 DTO 建议放在 `dbx-types`：

```rust
pub struct CustomTypeIdentity {
    pub schema: String,
    pub name: String,
    pub kind: CustomTypeKind,
}

pub struct CustomTypeDraft {
    pub schema: String,
    pub name: String,
    pub owner: Option<String>,
    pub comment: Option<String>,
    pub definition: CustomTypeDraftDefinition,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CustomTypeDraftDefinition {
    Enum { values: Vec<CustomTypeEnumValueDraft> },
    Composite { attributes: Vec<CustomTypeAttributeDraft> },
    Domain { base_type: String, collation: Option<String>, default: Option<String>, not_null: bool, constraints: Vec<CustomTypeDomainConstraintDraft> },
    Range { subtype: String, subtype_opclass: Option<String>, canonical_function: Option<String>, subtype_diff_function: Option<String>, multirange_name: Option<String> },
}
```

编辑身份字段：

```rust
pub struct CustomTypeEnumValueDraft {
    pub value: String,
    pub original_value: Option<String>,
}

pub struct CustomTypeAttributeDraft {
    pub name: String,
    pub original_name: Option<String>,
    pub data_type: String,
    pub comment: Option<String>,
}

pub struct CustomTypeDomainConstraintDraft {
    pub name: String,
    pub original_name: Option<String>,
    pub expression: String,
    pub validated: Option<bool>,
}
```

`original_* = None` 表示新对象。已有对象必须携带原始身份，不能通过数组下标推断。

## 7.3 Capability 模型

静态前端 `customTypeCapabilities()` 继续决定是否显示只读详情；新增运行时管理能力：

```rust
pub struct CustomTypeManagementCapabilities {
    pub database_type: DatabaseType,
    pub product_version: Option<String>,
    pub compatibility_mode: Option<String>,
    pub operations: BTreeMap<CustomTypeOperation, CustomTypeOperationCapability>,
    pub capability_revision: String,
}

pub struct CustomTypeOperationCapability {
    pub supported: bool,
    pub reason_code: Option<String>,
    pub reason: Option<String>,
}
```

稳定操作 ID 至少包括：

```text
create.enum
create.composite
create.domain
create.range
alter.rename
alter.setSchema
alter.owner
alter.comment
alter.enum.addValue
alter.enum.renameValue
alter.composite.addAttribute
alter.composite.renameAttribute
alter.composite.alterAttributeType
alter.composite.dropAttribute
alter.domain.default
alter.domain.notNull
alter.domain.addConstraint
alter.domain.renameConstraint
alter.domain.dropConstraint
alter.domain.validateConstraint
drop.restrict
drop.cascade
transactionalDdl
```

能力来源优先级：

1. 数据库类型和兼容模式硬边界。
2. 服务端版本或 catalog 特征探测。
3. 仓库内真实库验证 allowlist。
4. 未验证组合返回 `supported=false`。

不要仅依赖产品版本字符串解析。openGauss、GaussDB、Kingbase、Vastbase 可能报告兼容版本号但缺少对应语法。

## 7.4 Preview 和 Apply

```rust
pub struct CustomTypeChangeRequest {
    pub target: Option<CustomTypeIdentity>, // None = create
    pub draft: CustomTypeDraft,
}

pub struct CustomTypePlanIssue {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
    pub severity: CustomTypePlanIssueSeverity,
}

pub struct CustomTypeChangePreview {
    pub statements: Vec<String>,
    pub warnings: Vec<CustomTypePlanIssue>,
    pub blocked_changes: Vec<CustomTypePlanIssue>,
    pub destructive: bool,
    pub transaction_policy: CustomTypeTransactionPolicy,
    pub plan_revision: String,
    pub resulting_identity: CustomTypeIdentity,
}

pub enum CustomTypeTransactionPolicy {
    Required,
    Preferred,
    Autocommit,
}

pub struct ApplyCustomTypeChangeRequest {
    pub change: CustomTypeChangeRequest,
    pub expected_plan_revision: String,
}

pub struct CustomTypeChangeResult {
    pub identity: CustomTypeIdentity,
    pub statements: Vec<String>,
    pub affected_rows: u64,
}
```

关键合同：

- preview 只返回计划，不执行 SQL。
- apply 不接受前端传入的任意 SQL。
- apply 重新读取数据库状态、重新生成计划并比较 revision。
- `blocked_changes` 非空时 preview 可以返回，但 apply 必须拒绝。
- 无变化时 `statements=[]`，apply 返回明确的 no-op 错误或 no-op 结果，前后端统一一种行为。
- `plan_revision` 必须覆盖：当前快照、草稿、能力 revision、语句、事务策略。

## 7.5 Drop Preview 和 Apply

```rust
pub struct CustomTypeDropRequest {
    pub target: CustomTypeIdentity,
    pub cascade: bool,
}

pub struct CustomTypeDependency {
    pub kind: String,
    pub schema: Option<String>,
    pub name: String,
    pub parent: Option<String>,
    pub description: String,
    pub dependency_type: Option<String>,
}

pub struct CustomTypeDropPreview {
    pub statement: String,
    pub dependencies: Vec<CustomTypeDependency>,
    pub dependencies_complete: bool,
    pub warnings: Vec<CustomTypePlanIssue>,
    pub blocked_changes: Vec<CustomTypePlanIssue>,
    pub plan_revision: String,
}
```

apply 同样只接收结构化 request 和 `expected_plan_revision`。

---

## 8. Rust SQL 规划器

## 8.1 模块位置

在 `crates/dbx-sql-schema` 新增：

```text
src/custom_type_sql/
  mod.rs
  model.rs
  validation.rs
  create.rs
  alter.rs
  drop.rs
  postgres.rs
  tests.rs
```

职责：

- 输入数据库方言能力、原始快照和草稿。
- 验证草稿和不允许的变更。
- 生成最小 SQL 语句。
- 返回结构化 warning / blocked change。
- 不连接数据库、不读取全局状态、不执行 SQL。

Core 负责数据库状态读取和 revision；规划器不负责网络和执行。

## 8.2 标识符和字面值

必须复用或抽取现有 PostgreSQL quoting helper，禁止在多个模块重复：

- Identifier：双引号，内部 `"` 变为 `""`。
- String literal：单引号，内部 `'` 变为 `''`。
- 类型表达式、默认表达式和 CHECK 表达式不能整体作为 identifier 或 literal 引用。
- Owner、Schema、类型名、字段名和约束名必须按 identifier 处理。

单元测试必须覆盖：

- 空格、中文、大小写混合、双引号。
- Enum 值中的单引号、反斜杠和换行。
- schema-qualified 类型。
- 数组和带参数类型，如 `numeric(18, 4)[]`。
- SQL 注入样式输入不能突破 identifier/literal 边界。

## 8.3 Diff 算法

### Enum

1. 验证 `original_value` 在快照中存在且唯一。
2. 验证所有已有值仍然存在。
3. 验证已有值之间的相对顺序没有变化。
4. 原值变化生成 rename operation。
5. `original_value=None` 生成 add operation。
6. 按最终顺序从稳定锚点生成 `BEFORE/AFTER`。
7. capability 不支持的操作加入 `blocked_changes`。

### Composite

1. 按 `original_name` 匹配已有字段。
2. 原字段缺失表示 drop。
3. 同一 original 重复出现为无效草稿。
4. 名称变化生成 rename。
5. data type 变化生成 alter type。
6. comment 变化生成 `COMMENT ON COLUMN`。
7. 新字段生成 add attribute。
8. 保证后续操作引用 rename 后的字段名。

### Domain

1. 基础类型或 collation 变化直接阻断。
2. 比较规范化后的 default；空值表示 `DROP DEFAULT`。
3. 比较 NOT NULL。
4. 按 `original_name` 匹配约束。
5. 仅名称变化生成 rename。
6. 表达式变化生成 drop + add。
7. 删除已有约束标记 destructive。
8. 添加或设置 NOT NULL 生成潜在扫描/锁 warning。

### Range

1. 创建时完整验证必填 subtype。
2. 编辑时任何核心定义变化都加入 blocked。
3. 只生成通用属性变更。

## 8.4 语句排序和原子性

规划器返回稳定顺序，快照和草稿相同必须得到字节一致的 preview。

默认规则：

- 支持事务 DDL时，多语句变更使用一个事务。
- capability 标记 `transactionalDdl=false` 时：
  - 单语句可执行。
  - 多语句且存在部分成功风险时，第一版直接阻断，除非为该数据库编写了明确补偿策略。
- Enum `ADD VALUE` 的事务限制单独建 capability，不能仅沿用普通 DDL 事务能力。

---

## 9. Core 编排实现

## 9.1 新模块

在 `crates/dbx-core/src/schema/` 新增：

```text
custom_types.rs
custom_type_capabilities.rs
custom_type_dependencies.rs
custom_type_revision.rs
```

`schema/mod.rs` 只保留公开函数 re-export 和少量路由，不继续把所有实现写进单文件。

公开 Core API：

```rust
get_custom_type_management_capabilities_core(...)
preview_custom_type_change_core(...)
apply_custom_type_change_core(...)
preview_custom_type_drop_core(...)
apply_custom_type_drop_core(...)
list_custom_type_dependencies_core(...)
```

## 9.2 Snapshot

每次 preview/update apply 都从数据库重新读取：

- 类型详情。
- Owner。
- Domain constraint validation。
- Multirange 所属 Range。
- 必要的服务端版本和兼容模式。

创建模式读取目标名称是否已存在。不能只依赖对象列表缓存。

Canonical snapshot 使用稳定字段顺序序列化，再由 Core 的 `sha2` 生成 revision。不要把 OID 作为唯一 revision，因为同一对象结构变化时 OID 可能不变。

## 9.3 Apply 流程

```text
1. 校验连接存在、数据库类型支持类型管理。
2. 获取连接池。
3. 获取最新 capability。
4. 重新读取目标快照或确认创建目标不存在。
5. 使用同一规划器重新生成计划。
6. 比较 expectedPlanRevision。
7. blockedChanges 非空则拒绝。
8. 对所有 statements 执行 Core read-only 检查。
9. 按 transactionPolicy 执行。
10. 读取最终对象身份，返回结果。
```

并发策略：

- revision 解决“编辑期间对象已变化”的主要问题。
- 原生 PostgreSQL 尽可能在同一连接和事务中完成最终检查与执行。
- Agent 通过现有 batch/transaction 能力在同一 Agent 会话执行生成语句。
- 最终检查与第一条 ALTER 之间仍可能存在极短 TOCTOU 窗口；数据库对象锁和事务失败必须保证不静默覆盖。
- 任何 statement 失败时，返回具体 statement index 和数据库错误。
- 不支持事务 DDL的数据库禁止高风险多语句计划，避免部分成功。

## 9.4 执行复用

优先复用 `query` 模块已有能力：

- `check_read_only_for_connection_multi`。
- `execute_multi_core_with_options` 或下层共享执行内核。
- `use_transaction` 和 DDL rollback capability 检查。
- Agent `execute_batch` / `execute_query`。

如果现有公开函数不能保证“重算计划后执行同一组语句”，应抽取一个 Core 内部执行 helper，不要让 schema 模块绕过 query 安全检查。

## 9.5 生产库保护

前端保存和删除时：

```ts
executeWithProductionSqlGuard({
  connection,
  database,
  sql: preview.statements.join(";\n"),
  source: "custom-type-designer",
  execute: () => api.applyCustomTypeChange(...),
});
```

Core 仍执行只读连接检查。生产确认属于现有前端统一机制，新增 API 不能提供绕过 UI 的替代任意 SQL入口。

## 9.6 查询历史

成功和失败都写入现有 history store：

- SQL 使用 preview/apply 实际语句。
- 记录开始时间、耗时、成功/失败、错误。
- source 标记为 `custom-type-create`、`custom-type-alter`、`custom-type-drop`。

应抽取可复用 history helper，避免复制 `TableStructureEditor.vue` 的私有实现。

---

## 10. 依赖分析与删除

## 10.1 PostgreSQL 原生依赖

优先基于 `pg_depend` 和 `pg_describe_object` 获取直接依赖：

```sql
SELECT
  d.classid,
  d.objid,
  d.objsubid,
  d.deptype,
  pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
FROM pg_catalog.pg_depend d
WHERE d.refclassid = 'pg_catalog.pg_type'::regclass
  AND d.refobjid = $1;
```

同时使用明确查询补充结构化分类：

- `pg_attribute.atttypid`：表/视图字段。
- `pg_proc.prorettype / proargtypes / proallargtypes`：函数和过程。
- `pg_type.typbasetype / typelem`：派生 Domain、数组或相关类型。
- `pg_range.rngsubtype`：Range 对 subtype 的依赖。

输出要求：

- 去重。
- 过滤目标自身的自动数组类型和正常内部依赖。
- 保留无法分类的 `pg_describe_object` 文本。
- 标记 `dependenciesComplete=false`，如果 fallback 查询失败或兼容库缺少函数。

## 10.2 兼容库依赖

每个数据库分别验证 `pg_depend` 和 `pg_describe_object`：

- 完全兼容：复用原生查询。
- 只有 catalog 兼容：使用专用查询适配。
- 无法可靠读取：仍可允许 `RESTRICT` 删除，但必须显示“依赖预览不完整”；默认不开放 `CASCADE`。

## 10.3 删除后的状态处理

删除成功后：

1. 刷新左侧当前 Schema 的 `group-types`。
2. 触发 `dbx-refresh-object-browser`，作用域包含 connection/database/schema/catalog。
3. 关闭被删除类型的设计器。
4. 如果对象浏览器当前选中该行，清空选中状态。
5. 删除或失效对应的对象详情缓存。
6. 保留其他打开的查询标签，不主动关闭引用该类型的表标签。

---

## 11. Tauri、Web 和前端 API

## 11.1 Tauri 命令

在 `crates/dbx-tauri-schema` 注册：

```text
get_custom_type_management_capabilities
preview_custom_type_change
apply_custom_type_change
preview_custom_type_drop
apply_custom_type_drop
list_custom_type_dependencies
```

修改：

- `crates/dbx-tauri-schema/src/commands.rs`
- `crates/dbx-tauri-schema/src/lib.rs`
- command registry 长度测试。
- `apps/desktop/src/lib/backend/tauri.ts`

## 11.2 Web 路由

建议路由：

```text
GET  /schema/custom-types/capabilities
POST /schema/custom-types/preview
POST /schema/custom-types/apply
POST /schema/custom-types/drop-preview
POST /schema/custom-types/drop-apply
GET  /schema/custom-types/dependencies
```

修改：

- `crates/dbx-web/src/main.rs`
- `crates/dbx-web/src/routes/schema.rs`
- `apps/desktop/src/lib/backend/http.ts`
- `apps/desktop/src/lib/backend/api.ts`

所有 mutation 使用 POST JSON，不把 draft 放进 query string。

## 11.3 前端 API 类型

在 `apps/desktop/src/types/database.ts` 添加与 Rust serde camelCase 完全一致的接口。增加契约测试确保 Tauri 与 HTTP 暴露相同函数和参数。

---

## 12. 导航与入口接入

## 12.1 左侧树

`group-types` 菜单：

- `新建类型`，图标 `Plus`。
- 只在运行时 capability 至少支持一种 create 时显示。
- 只读连接不显示或禁用。

`type` 节点菜单：

- 查看详情。
- 编辑类型，图标 `Pencil`。
- 查看/复制 DDL。
- 复制名称。
- 删除类型，图标 `Trash2`，destructive。

现有单击展开成员行为保持不变，避免破坏 Enum/Composite 树展开。查看/编辑通过右键菜单进入对象浏览器设计器。

## 12.2 对象浏览器

- `ObjectFilter` 的 `types` 状态下显示 `Plus` 新建按钮。
- 类型行右键增加编辑和删除。
- 单击仍打开查看详情。
- 双击建议进入编辑模式；如果担心改变现有行为，首版仍打开查看详情，由显式编辑按钮进入编辑。
- 新建或编辑成功后保持筛选为 `types` 并定位新身份。

## 12.3 QueryStore 请求状态

参考 MySQL Event 的 request-id 机制扩展对象浏览器 tab：

```ts
objectBrowser?: {
  // existing fields...
  customTypeRequest?: {
    mode: "view" | "create" | "edit";
    schema?: string;
    name?: string;
    requestId: number;
  };
}
```

原因：对象浏览器 tab 会复用，不能只靠 prop 值是否变化触发同一个“新建类型”请求。每次菜单点击递增 requestId。

`openObjectBrowser()` 建议重构为 options 参数，避免继续增加位置参数：

```ts
openObjectBrowser({
  connectionId,
  database,
  schema,
  catalog,
  initialObjectFilter: "types",
  customTypeRequest,
});
```

为减少一次性改动，可以先增加 `openCustomTypeDesigner()` 包装函数，内部复用现有 API，后续再重构通用签名。

---

## 13. 前端状态与校验

## 13.1 草稿状态

`customTypeDraft.ts` 提供纯函数：

```text
draftFromDetails(details)
emptyDraft(kind, schema)
normalizeDraft(draft)
draftIsDirty(original, current)
draftValidationIssues(draft, capabilities)
```

不能直接修改后端返回的 `details` 对象。

## 13.2 请求防抖和陈旧响应

复用 `createSidePanelRequestGuard()`：

- 切换类型时旧详情请求不能覆盖当前状态。
- preview 每次草稿变化递增 requestId。
- 旧 preview 响应不得覆盖新草稿。
- apply 期间禁止切换模式和重复保存。
- apply 成功后重新加载详情，以数据库返回状态为准。

## 13.3 前端快速校验

前端仅做即时体验校验：

- 必填名称。
- Enum 重复值。
- Composite 重复字段名。
- Domain 重复约束名。
- Range subtype 必填。

Rust 规划器必须重复执行全部校验，不能信任前端。

---

## 14. Capability 实现计划

## 14.1 PostgreSQL

最低探测：

- `server_version_num`。
- `pg_type.typtype` 是否支持 `m`。
- `pg_range.rngmultitypid` 是否存在。
- `ALTER TYPE ... RENAME VALUE` 的最低版本规则。
- Enum `ADD VALUE` 在事务中的行为。

版本规则必须有单元测试，但真实库验证仍是开放条件。

## 14.2 openGauss / GaussDB

- 读取现有 compatibility mode。
- A 模式和非 A 模式分别记录。
- 验证 `CREATE TYPE`、`CREATE DOMAIN`、各 ALTER 和事务行为。
- 不假设支持 Multirange。
- 如果 catalog 支持读取但 DDL 不支持，保持只读。

## 14.3 Kingbase

- 从 Agent `connection_info` 获取 `compatibilityMode` 和 product version。
- PostgreSQL、Oracle、MySQL 兼容模式分开验证。
- MySQL 兼容模式当前类型列表会降级为空，管理 capability 必须全部关闭。
- 两个现有 Kingbase 测试实例分别执行矩阵，记录其兼容模式和版本。

## 14.4 Vastbase

- 从 Agent `connection_info` 获取兼容模式。
- MySQL 兼容模式全部关闭。
- PostgreSQL 兼容模式逐项验证。
- `dbinfo` 与 DBX 已保存连接的 Vastbase 端口不同，执行 live test 前先确认正确测试端口，避免将网络配置问题误判成语法不支持。

## 14.5 Capability 缓存

- 以 physical pool + database + server identity 为 key 缓存。
- 连接重建、数据库切换或 product version 改变时失效。
- capability response 带 revision，计划 revision 包含它。
- 探测失败时不缓存“支持”，只缓存短时失败或返回 fail closed。

---

## 15. 测试计划

## 15.1 Rust 纯单元测试

包：`dbx-sql-schema`

覆盖：

- 每类 CREATE SQL。
- 每一种 ALTER diff。
- Domain 使用 `ALTER/DROP DOMAIN` 而非 TYPE。
- Enum 添加前后定位。
- Enum 删除和重排被阻断。
- Composite rename + type change + comment 的语句顺序。
- Domain 约束 rename 与定义变化的区分。
- Range 编辑核心属性被阻断。
- 标识符和 literal 转义。
- 空草稿、重复项、缺失 original identity。
- capability 关闭时返回 blocked，而不是生成 SQL。
- 稳定输入产生字节一致输出。

## 15.2 Core 单元/集成测试

覆盖：

- preview 不执行 SQL。
- apply 重算计划。
- revision 匹配成功。
- 对象在 preview 后发生变化时 apply 拒绝。
- capability revision 改变时 apply 拒绝。
- 只读连接拒绝 apply/drop。
- blocked plan 拒绝 apply。
- create 目标已存在时拒绝。
- update/drop 目标已不存在时返回明确错误。
- 多语句事务失败回滚。
- 非事务数据库的高风险多语句计划被阻断。
- Domain drop SQL正确。
- dependenciesComplete 失败降级。

## 15.3 PostgreSQL live test

在临时 Schema 中创建：

```text
Enum: status
Composite: address
Domain: email
Range: price_range
Table dependencies: orders
Function dependency: normalize_status(status)
```

用例：

1. 创建四类类型并读取详情。
2. Enum 尾部新增、BEFORE、AFTER、rename。
3. Enum 删除和重排必须在 preview 阶段拒绝。
4. Composite 新增、rename、alter type、comment、drop attribute。
5. Domain default、not null、约束新增/rename/修改/删除。
6. Range 通用 rename/comment；核心属性修改拒绝。
7. `DROP ... RESTRICT` 有依赖时失败且对象保留。
8. `DROP ... CASCADE` 预览依赖并成功删除。
9. preview 后外部 ALTER，apply revision 冲突。
10. 任意一条多语句 ALTER 失败时事务回滚。
11. 中文、引号和大小写敏感名称。
12. 清理临时 Schema。

## 15.4 Agent live test

扩展：

- `agents/drivers/kingbase-go/integration_test.go`
- `agents/drivers/vastbase-go/integration_test.go`

Agent 侧重点：

- 详情新增字段兼容。
- capability 所需 connection info 完整。
- Core 生成 SQL 通过 Agent batch 执行。
- 事务和错误返回不丢失 statement index。
- MySQL 兼容模式 fail closed。

openGauss/GaussDB 使用 Rust 原生驱动 live test，分别记录能力，不合并结论。

## 15.5 前端纯函数测试

新增：

```text
apps/desktop/src/lib/__tests__/customType/customTypeDraft.spec.ts
apps/desktop/src/lib/__tests__/customType/customTypeValidation.spec.ts
apps/desktop/src/lib/__tests__/database/customTypeCapabilities.spec.ts
```

覆盖草稿转换、dirty 判断、本地校验和 capability 展示。

## 15.6 Vue 组件测试

扩展/新增：

```text
components/objects/__tests__/CustomTypeDesigner.component.spec.ts
components/objects/__tests__/ObjectBrowser.customTypeMutation.component.spec.ts
components/sidebar/__tests__/SidebarTreeRuntimeHost.customTypeMenu.spec.ts
```

覆盖：

- view/create/edit 三模式。
- 各类型动态表单。
- SQL preview loading/error/stale response。
- blocked 时保存禁用。
- 未保存关闭确认。
- read-only 入口隐藏。
- production guard 被调用。
- apply 成功后的刷新和定位。
- delete dependencies、CASCADE 切换。
- 复用对象浏览器 tab 时 requestId 生效。

## 15.7 API 契约测试

- Tauri registry 包含全部新命令。
- Web router 包含全部新路由。
- `api.ts` 的 Tauri/HTTP forward 一致。
- Rust camelCase 与 TypeScript 字段一致。
- 旧 Agent 缺少新增 optional 字段时仍能读取详情。

## 15.8 i18n 测试

新增 key 分组建议：

```text
customType.actions.*
customType.editor.*
customType.validation.*
customType.warnings.*
customType.dependencies.*
customType.capabilities.*
customType.delete.*
```

至少保证中文和英文完整；遵循项目现有 locale parity 测试要求更新其他语言或 fallback，不能留下直接显示 key 的界面。

---

## 16. 真实库兼容验证矩阵

每个实例执行以下操作并记录：`supported / syntax-error / permission-error / unsupported / transactional`。

| 操作 | PostgreSQL | Kingbase 1 | Kingbase 2 | openGauss | GaussDB | Vastbase |
| --- | --- | --- | --- | --- | --- | --- |
| CREATE ENUM | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| ADD ENUM VALUE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| RENAME ENUM VALUE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| CREATE COMPOSITE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| ADD ATTRIBUTE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| RENAME ATTRIBUTE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| ALTER ATTRIBUTE TYPE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| DROP ATTRIBUTE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| CREATE DOMAIN | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| ALTER DOMAIN 属性 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| Domain constraints | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| CREATE RANGE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| RENAME / SET SCHEMA | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| OWNER / COMMENT | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| DROP RESTRICT | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| DROP CASCADE | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| 多语句事务回滚 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |
| 依赖查询完整性 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |

验证要求：

- 测试使用随机临时 Schema。
- 测试结束无论成功失败都 `DROP SCHEMA ... CASCADE`。
- 测试不得使用系统 Schema。
- 记录 product name、product version、compatibility mode 和 driver version。
- 权限错误不能被记录为“不支持语法”，应使用具备类型 DDL 权限的测试用户重试。
- openGauss 当前测试端口不可达时，不允许用 GaussDB 结果代替。

---

## 17. 分阶段开发任务

## Phase 0：能力调查与规格冻结

目标：先用真实库确定允许实现的 SQL，不写 UI mutation。

- [ ] 为六个测试实例记录产品版本和兼容模式。
- [ ] 解决 Vastbase 测试端口不一致。
- [ ] 恢复或确认 openGauss 测试实例。
- [ ] 编写独立、可清理的 SQL capability fixture。
- [ ] 跑完 §16 矩阵。
- [ ] 确认每种数据库的事务行为。
- [ ] 固化首版 allowlist。
- [ ] 更新本计划中的“待验证”结果。

验收：没有任何 mutation capability 基于猜测开放。

## Phase 1：公共 DTO 与纯 SQL 规划器

- [ ] 扩展 `CustomTypeDetails` 管理字段。
- [ ] 定义 identity、draft、capability、preview、apply、dependency DTO。
- [ ] 新建 `dbx-sql-schema::custom_type_sql`。
- [ ] 实现 PostgreSQL quoting helper 复用。
- [ ] 实现 Enum create/diff。
- [ ] 实现 Composite create/diff。
- [ ] 实现 Domain create/diff。
- [ ] 实现 Range create和只读编辑限制。
- [ ] 实现通用 rename/schema/owner/comment。
- [ ] 实现 TYPE/DOMAIN drop。
- [ ] 完成纯单元测试。

验收：给定 snapshot 和 draft，可以稳定生成 SQL 或明确 blocked，不连接数据库。

## Phase 2：Core Preview/Apply 与 PostgreSQL

- [ ] 新建 Core custom type 模块。
- [ ] 实现 PostgreSQL management snapshot。
- [ ] 实现 capability 探测与缓存。
- [ ] 实现 plan revision。
- [ ] 实现 preview change。
- [ ] 实现 apply change。
- [ ] 实现依赖查询。
- [ ] 实现 drop preview/apply。
- [ ] 接入 read-only 检查。
- [ ] 接入事务执行。
- [ ] 提供 statement index 错误。
- [ ] 完成 PostgreSQL live test。

验收：不经过前端也能用 Core API安全完成 PostgreSQL 类型生命周期管理。

## Phase 3：Tauri/Web API

- [ ] 注册六个 Tauri 命令。
- [ ] 添加六个 Web endpoint。
- [ ] 添加 `tauri.ts` 和 `http.ts` 封装。
- [ ] 添加 `api.ts` forward。
- [ ] 更新 registry/router/contract 测试。
- [ ] 验证 Web 和 Desktop 返回相同结构。

验收：Desktop/Web 都能完成 preview/apply，且 apply 不接受任意 SQL。

## Phase 4：类型设计器 UI

- [ ] 拆分现有详情组件。
- [ ] 实现 view/create/edit 状态机。
- [ ] 实现 Header 和通用属性表单。
- [ ] 实现 Enum 编辑器。
- [ ] 实现 Composite 编辑器。
- [ ] 实现 Domain 编辑器。
- [ ] 实现 Range 编辑器。
- [ ] 实现 SQL preview。
- [ ] 实现 dirty close guard。
- [ ] 接入 production guard。
- [ ] 接入 history。
- [ ] 实现 apply 后 reload。
- [ ] 完成组件测试。

验收：在 PostgreSQL 上可通过结构化 UI 完成首版范围操作。

## Phase 5：导航、删除和刷新

- [ ] 左侧 `group-types` 添加新建。
- [ ] 左侧类型节点添加查看、编辑、删除。
- [ ] 对象浏览器类型筛选添加新建按钮。
- [ ] 对象浏览器类型菜单添加编辑、删除。
- [ ] 扩展 QueryStore customTypeRequest。
- [ ] 实现共享删除对话框。
- [ ] 展示依赖和 CASCADE。
- [ ] 成功后刷新树和对象浏览器。
- [ ] 重命名/移动 Schema 后定位新身份。
- [ ] 完成菜单和刷新测试。

验收：所有入口行为一致，不出现保存成功但列表仍显示旧对象的情况。

## Phase 6：Kingbase/Vastbase Agent

- [ ] 扩展 Agent 详情字段。
- [ ] 暴露 capability 所需版本/兼容模式。
- [ ] 验证 Core 计划通过 Agent 执行。
- [ ] 验证 Agent batch 事务。
- [ ] 完成 Kingbase 兼容模式矩阵。
- [ ] 完成 Vastbase 兼容模式矩阵。
- [ ] 按真实结果逐项开放 capability。
- [ ] 保持旧 Agent 协议兼容或明确最低 Agent 版本。

验收：未验证模式仍只读，已验证模式通过相同 UI 和 Core planner 管理类型。

## Phase 7：openGauss/GaussDB

- [ ] 完成 openGauss live matrix。
- [ ] 完成 GaussDB live matrix。
- [ ] 实现必要的 capability adapter。
- [ ] 处理 catalog/版本探测差异。
- [ ] 按结果逐项开放。
- [ ] 增加回归测试。

验收：两个产品独立记录能力，不互相继承未经验证的操作。

## Phase 8：收尾和发布门禁

- [ ] 全部 i18n。
- [ ] 键盘导航和焦点顺序。
- [ ] 窄窗口、长名称、长类型表达式布局检查。
- [ ] 浅色/深色模式截图检查。
- [ ] Production/read-only 回归。
- [ ] 错误翻译和 statement 定位。
- [ ] 文档和 changelog。
- [ ] 更新 capability 矩阵。

---

## 18. 验收标准

### 功能验收

1. 在支持的 PostgreSQL 实例中可以创建 Enum、Composite、Domain、Range。
2. 可以执行本计划定义的安全增量修改。
3. 不支持的修改在 preview 阶段明确阻断，不会尝试执行。
4. 删除默认 RESTRICT，CASCADE 必须显式开启。
5. 删除前能看到依赖；无法完整读取时有明确警告。
6. UI 预览 SQL 与 apply 返回的 executed statements 一致。
7. preview 后对象被其他会话修改，apply 必须拒绝并要求刷新。
8. 只读连接不能通过任何类型管理入口写数据库。
9. 生产库修改必须弹出现有 production confirmation。
10. 操作成功后树、对象浏览器和详情状态同步。

### 兼容验收

1. 每个开放 capability 都有对应真实库测试结果。
2. Kingbase/Vastbase MySQL 兼容模式不得显示 PG 类型管理入口。
3. openGauss、GaussDB 不因共享 PostgreSQL 驱动自动获得能力。
4. Base、Multirange 不出现误导性的结构化保存按钮。
5. 旧 Agent 返回缺少 optional 字段时，详情查看不崩溃。

### 工程验收

1. Vue 中没有自定义类型 DDL 字符串拼接。
2. Kingbase/Vastbase Agent 中没有复制一套变更 SQL 规划器。
3. apply API 不接收任意 statements。
4. 所有 warning/blocked reason 有稳定 code。
5. Rust、TypeScript、HTTP、Tauri 合同测试通过。
6. 所有 Rust 命令遵守两核心限制。

---

## 19. 验证命令

Rust 命令统一限制两个编译任务：

```bash
CARGO_BUILD_JOBS=2 cargo test -j 2 -p dbx-sql-schema custom_type
CARGO_BUILD_JOBS=2 cargo test -j 2 -p dbx-driver-postgres custom_type
CARGO_BUILD_JOBS=2 cargo test -j 2 -p dbx-core custom_type
CARGO_BUILD_JOBS=2 cargo test -j 2 -p dbx-tauri-schema
CARGO_BUILD_JOBS=2 cargo test -j 2 -p dbx-web
CARGO_BUILD_JOBS=2 cargo check -j 2 -p dbx
```

前端：

```bash
pnpm test -- apps/desktop/src/lib/__tests__/customType
pnpm test -- apps/desktop/src/components/objects/__tests__/CustomTypeDesigner.component.spec.ts
pnpm test -- apps/desktop/src/components/objects/__tests__/ObjectBrowser.customTypeMutation.component.spec.ts
pnpm test -- apps/desktop/src/components/sidebar/__tests__/SidebarTreeRuntimeHost.customTypeMenu.spec.ts
pnpm typecheck
```

Agent：

```bash
python3 scripts/validate_agents.py
cd agents/drivers/kingbase-go && go test ./...
cd agents/drivers/vastbase-go && go test ./...
```

真实库测试必须使用环境变量提供连接信息，不把密码写入测试、日志、fixture 或文档。

---

## 20. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| PG 兼容库语法并不完全兼容 | 执行失败或部分成功 | 真实库矩阵 + capability fail closed |
| Enum 在旧版本事务行为不同 | 多值新增部分成功 | 单独 capability；不支持时限制为单语句 |
| Domain 添加约束扫描大量数据 | 长锁和超时 | preview warning；保留后续 NOT VALID 扩展位 |
| Composite 字段删除影响依赖 | 业务对象失效 | 默认 RESTRICT；标记 destructive；不自动 CASCADE |
| Preview 后对象发生变化 | 覆盖他人修改 | plan revision + apply 重读 + 事务失败回滚 |
| Agent 无法提供事务一致性 | 部分成功 | 验证 batch 事务；不满足时阻断多语句计划 |
| 依赖查询在兼容库不完整 | CASCADE 影响不透明 | dependenciesComplete；默认关闭 CASCADE |
| UI 状态与对象重命名后身份不一致 | 旧行、旧详情残留 | apply 返回 resultingIdentity；按新身份刷新定位 |
| Base/Multirange DDL 不完整 | 生成不可恢复对象 | 第一版不提供结构化创建/修改 |
| 大量编译消耗开发机资源 | 开发环境卡顿 | 所有 Cargo 命令固定 `-j 2` / `CARGO_BUILD_JOBS=2` |

---

## 21. 后续扩展

首版稳定后再单独评估：

1. Enum 重建向导：创建临时类型、转换依赖列、重建默认值和函数签名、交换名称。
2. Range 重建向导。
3. Base 类型高级创建器及 I/O 函数选择。
4. Domain `NOT VALID` / `VALIDATE` 分步工作流。
5. 类型依赖图。
6. Schema Diff 和数据传输中的类型同步。
7. MCP 类型管理工具，沿用同一个 preview/apply 合同和确认令牌。
8. 批量删除类型。
9. 类型权限管理。

这些扩展必须继续遵循“结构化请求、后端规划、预览 revision、应用前重算”的安全模型。
