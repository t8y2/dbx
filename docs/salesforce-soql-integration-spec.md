# Salesforce (SOQL) 驱动集成 Spec

> 状态：v1.1 — D1~D6 已决策（见 §13）；M0+M1 已交付并经真实 sandbox 验证；M2 OAuth 已实现（PKCE 浏览器流 + Device Flow + refresh 持久化/自动续期），Connected App 暂为 BYO（bundled client id 待注册后填入 salesforce_oauth.rs 默认值）
> 日期：2026-09-21
> 范围：为 DBX 新增 Salesforce 连接类型，支持 SOQL 查询、sObject 元数据浏览、行级 DML、SOQL 自动补全，并最终暴露到 MCP。

---

## 1. 目标与非目标

### 目标
- 用户可以像连接其他 40+ 数据库一样连接 Salesforce org（生产/Sandbox）。
- 在查询编辑器执行 SOQL，结果以现有 DataGrid 呈现，支持分页。
- 对象树浏览：sObject → fields（含 label、类型、可编辑性）。
- 行级 DML：网格内编辑/新增/删除记录（受 capability 与只读会话控制）。
- SOQL 语法高亮 + 上下文感知自动补全（对象、字段、关系穿越、picklist 值）。
- MCP bridge 暴露只读查询能力给 AI agent。

### 非目标（明确不做）
- SQL → SOQL 自动翻译层（语义差异大，见 §10 开放问题 Q1 讨论记录）。
- Apex 执行、Tooling API（元数据开发类查询）、Metadata API 部署。
- Bulk API 2.0 大批量导入导出（远期，对齐 `dataTransfer` capability 时再议）。
- Report / Dashboard / Analytics API。

---

## 2. 认证设计

### 2.1 支持的登录方式（按优先级）

| # | 方式 | 模式 | 说明 |
|---|------|------|------|
| 1 | OAuth Authorization Code + PKCE | 桌面 | 主路径。复用 `crates/dbx-driver-mongodb/src/mongo_oidc.rs` 的模式：本地 `TcpListener` 监听回调 → 系统浏览器授权 → code 换 token。Connected App 需配置 `refresh_token` scope 以获取长期令牌 |
| 2 | OAuth Device Flow | 桌面 + **web** | `grant_type=urn:ietf:params:oauth:grant-type:device_code`。UI 显示 user code，用户在任意设备浏览器输入。**这是 web/Docker 模式下唯一的浏览器授权方式** |
| 3 | 粘贴 Access Token + instance_url | 桌面 + web | 调试/CI/兜底。Session ID 可直接作 Bearer token。无 refresh 能力，过期后需重新粘贴 |
| 4 | Username-Password OAuth | 桌面 + web | ⚠️ Salesforce 已弃用（新 Connected App 无法启用）。仅作为 BYO Connected App 的兼容项，UI 上明确标注 deprecated；密码需拼接 security token |
| — | JWT Bearer / Client Credentials | 不做 | 面向无人值守自动化，非交互式用户场景 |

### 2.2 Connected App 策略（**已决策 D1**）
- **采用方案 A**：DBX 官方内置一个 Connected App（bundle client_id，PKCE 公共客户端无 secret），用户零配置；另留 BYO 高级选项 + token 粘贴兜底。DBeaver、Data Loader 均为内置模式。
- 落地事项：注册开发者 org、创建 Connected App（redirect URI 含 `http://localhost:*/callback` 与 Device Flow）、client_id 以配置常量内置；撰写「org admin 审批 Connected App」引导文档。
- 风险：需维护该 app、遵守 Salesforce ToS/品牌规范；部分 org 限制未审批 Connected App（用户卡在授权页，提示文档引导 admin 审批）。

### 2.3 登录端点
- 三选：`login.salesforce.com`（生产）/ `test.salesforce.com`（Sandbox）/ 自定义 My Domain。
- `instance_url` 一律以 token 响应为准，后续所有 API 调用打 instance_url，不依赖登录域名。

### 2.4 Token 存储与续期
- access_token + refresh_token 持久化到现有 SQLite `connection_secrets` 表（`FileSecretStore`，key 形如 `plugin_connection.salesforce_refresh_token`）。
- ⚠️ **安全注意**：现有 secret 存储为**明文 SQLite**（与所有既有驱动的密码同级）。Salesforce refresh_token 是长期有效凭据，泄露即可完全访问 org。本 spec 接受与现状一致的风险等级，但建议在文档中标注；若未来引入 SQLCipher/keychain 迁移，Salesforce token 应首批受益。
- 续期逻辑在驱动内实现（无现成通用 token-refresh 框架）：access_token 失效（401）→ 用 refresh_token 换新 → 仍失败则标记连接需重新授权。
- 参考现状：mongo_oidc 的 refresh_token **不持久化**（进程内存活），Salesforce 不能照搬——用户预期是「连一次一直能用」。
- web 模式：沿用 `owner_scope` 会话隔离机制。

### 2.5 web 模式 OAuth 结论（已由代码调查确认）
- mongo_oidc 的 localhost 回调在 web 模式**不可用**（监听在服务器、回调打到用户机器；浏览器 opener 是 Tauri-only API，web 端有硬 guard）。
- 本期方案：**web 模式仅支持 Device Flow + token 粘贴**；桌面模式支持全部方式。
- 远期可选：dbx-web 增加服务端回调路由（`/oauth/salesforce/callback`），需处理多用户会话与 redirect URI 注册，暂不做。

---

## 3. 当前用户与权限探测（MVP 内含）

连接建立后立即执行：
1. `GET /services/oauth2/userinfo` → user_id、name、email、organization_id（不消耗 SOQL 配额）。
2. SOQL：
   ```sql
   SELECT Id, Username, Profile.Name, Profile.PermissionsModifyAllData,
          Profile.PermissionsViewAllData
   FROM User WHERE Id = '<userId>'
   ```
   `PermissionsModifyAllData = true` 即事实管理员（比匹配 Profile.Name 可靠）。

用途：
- 连接状态栏显示身份徽章（用户名 @ org，admin 加标记）。
- 非 admin 用户执行 DML 前展示额外警示。
- MCP 侧暴露 `current_user` 上下文。

粒度说明：PermissionSet 可授予细分权限，二值判断只是粗判，仅作 UI 提示用途，**不作为安全边界**（真正的访问控制在 Salesforce 服务端）。

---

## 4. 驱动架构与文件清单

架构模式与所有既有驱动一致（枚举分发，无统一 trait）：

| 文件 | 动作 | 内容 |
|------|------|------|
| `plugins/connection-types/salesforce.yaml` | 新建 | 连接类型定义（见 §5） |
| `crates/dbx-drivers/src/db/salesforce_driver.rs` | 新建 | HTTP client（reqwest）、OAuth 流程、SOQL 执行、describe 元数据、DML 命令解释 |
| `crates/dbx-drivers/src/db/mod.rs` | 修改 | 注册模块 |
| `crates/dbx-core/src/connection/mod.rs` | 修改 | `PoolKind::Salesforce(SfClient)` 变体 |
| `crates/dbx-core/src/connection/driver_runtime.rs` | 修改 | 连接创建路由 |
| `crates/dbx-core/src/query/mod.rs` | 修改 | 查询分发 match 臂（SOQL 执行 + DML 伪命令解释） |
| `crates/dbx-core/src/schema/mod.rs` | 修改 | 元数据浏览分发（listTables → sObjects，listColumns → fields） |
| `crates/dbx-drivers/src/salesforce_oauth.rs` | 新建 | PKCE / Device Flow / token 刷新（参考 mongo_oidc.rs 结构） |
| `apps/desktop/public/icons/database/salesforce.svg` + `DatabaseIcon.vue` | 新建/修改 | 图标（注意 Salesforce 品牌使用规范） |
| `apps/desktop/src/components/connection/ConnectionDialog.vue` | 修改 | 连接表单分支（认证方式选择、OAuth 按钮、token 状态） |
| `apps/desktop/src/i18n/locales/*.ts` | 修改 | en / zh-CN / es 翻译 |
| `scripts/sync-connection-types.mjs` | 运行 | 生成前端类型 |

参考模板：**Elasticsearch 驱动**（HTTP REST、native + bridge、动态元数据映射）。

### 4.1 API 版本策略
- Pin 一个固定版本（如 `v62.0`）作为默认；高级配置允许覆盖。
- Salesforce API 每版本保留 ≥3 年，pin 策略风险可控；每年随大版本升级一次。

---

## 5. 连接配置 Schema（salesforce.yaml 草案）

```yaml
runtimeMode: native          # HTTP REST，同 Elasticsearch
mcpMode: bridge              # SOQL 非标准 SQL
supportLevel: browse         # MVP：查询 + 元数据浏览；DML 落地后升 operate（或自定义 capability 覆盖）
behaviorTraits:
  schemaAware: false
  singleDatabase: true       # 一个 org = 一个"数据库"
```

连接表单字段：
- 认证方式（枚举：oauth_browser / oauth_device / access_token / user_pass）
- environment（枚举：production / sandbox / custom_my_domain → 自定义登录 URL）
- client_id / client_secret（BYO 模式；内置模式隐藏）
- access_token + instance_url（token 粘贴模式）
- username / password(+security token)（deprecated 模式，带警示）
- api_version（高级，默认 pin 值）

capabilities 覆盖（MVP）：
`queryExecution ✅ / metadataBrowse ✅ / objectBrowser ✅ / schemaSearch ✅`，
其余（objectSource、diagram、tableDataEdit、tableImport、dataTransfer、sqlFileExecution、databaseCreate、sqlExplain、userAdmin、driverManagement、fieldLineage）全 ❌；`tableDataEdit` 在 Phase 2 打开。

---

## 6. 元数据与 Schema 映射

| Salesforce | DBX 抽象 | API |
|---|---|---|
| org | database（singleDatabase） | — |
| sObject | table | `GET /sobjects/`（支持 ETag/If-Modified-Since） |
| field | column（label + apiName + type + updateable/nillable） | `GET /sobjects/{type}/describe` |
| relationship | 外键提示（补全用，不建 ER） | describe 的 childRelationships |

### 6.1 缓存策略（关键，配额敏感）
- 大 org 有数百 sObject，全量 describe 可达数十 MB，且 Salesforce 按 org 限每日 API 调用。
- **惰性加载**：对象树只拉 `/sobjects/`（轻量列表）；describe 仅在展开某对象/补全需要时触发。
- **磁盘缓存**：describe 结果按 `(instance_url, api_version, sobject)` 键缓存到本地；`/sobjects/` 用条件请求（ETag）做增量刷新。
- 缓存对前端补全（§9）同样供数。

---

## 7. 查询执行（SOQL → QueryResult）

- `GET /services/data/{ver}/query?q=<SOQL>` → JSON → `QueryResult { columns, column_types, rows, has_more, session_id }`。
- 列类型用 field type（string/int/double/date/datetime/boolean/reference/picklist/…）填充 `column_types`。
- **分页**：首批 ≤2000 行；`nextRecordsUrl` 映射到 `has_more=true` + `session_id`（存 QueryLocator），复用现有游标分页机制。UI 提供「加载更多」而非默认全量拉取（配额保护）。
- **compound fields**（Name/Address）：默认展平为子字段列；查询里直接 select compound 字段时按返回 JSON 展平。
  - 已实现：`parse_describe_columns` 直接过滤 SOQL 无法投影的 describe 字段——compound `address`/`location`（子字段 `BillingStreet` 等本身就在 describe 里，展平即「只保留子字段」）与 `accessible=false`（无 FLS 读权限，SOQL 报 INVALID_FIELD）。这两类字段只要出现在 SELECT 列表里就会让**整条查询**失败，因此不能进网格投影，也不进补全列表。
- **数据网格 SQL 构建**（右键对象 →「查看数据」）：走 `build_table_data_select_sql` 的 Salesforce 专用分支 `build_salesforce_table_select_sql`，不能复用 ANSI 形状。SOQL 三处差异：无 `SELECT *`、无定界标识符（`FROM "Account"` 报 MALFORMED_QUERY，双引号在 SOQL 里是字符串字面量）、无尾分号。投影优先用 describe 字段名逐个列出（任意页大小都合法）；拿不到字段列表时退回 `FIELDS(ALL)`，并把 LIMIT 压到 ≤200（Salesforce 对 `FIELDS(*)` 的硬性上限）。`OFFSET` 上限 2000，超出直接透传给 org 报错而不静默改页。
  - 前端配套：`requiresEagerTableMetadataForDataOpen()` 把 salesforce 与 mysql/postgres 一并列入「必须先拿到列再建 SQL」，否则列列表为空只能走 200 行上限的 `FIELDS(ALL)` 兜底。`quoteTableIdentifier` 对 salesforce 原样返回，与 Rust 侧 `quote_table_identifier` 对齐（网格排序/筛选也走它）。
- **表数据 CSV 导出**：`export_table_data_csv_core` 对 Salesforce 显式拒绝（不写文件）。该路径用 `LIMIT <page_size> OFFSET <n>` 翻页、以「短页」为终止条件，两个前提在 SOQL 下都不成立（单批 ≤2000 行、`OFFSET` ≤2000），首页永远看起来是短页，结果是**静默截断**的 CSV。正确实现要跟随 QueryLocator（`fetch_more`）翻页，与网格「加载更多」一致；该入口目前没有 UI 调用方，故先拒绝并提示改用「执行 SOQL → 导出结果集」。
- **reference 字段**：显示 Id；用户在补全引导下自行写 relationship 查询取 Name。
- **queryAll**（回收站）：编辑器工具栏开关，切 `/queryAll` 端点。Phase 2+。
- **错误映射**：API errorCode → 用户可读信息（MALFORMED_QUERY=语法错误+原文、INVALID_FIELD=字段不存在/无 FLS 权限、INSUFFICIENT_ACCESS、REQUEST_LIMIT_EXCEEDED=当日 API 配额耗尽提示）。governor limit 错误必须明确归因到 Salesforce 侧，避免用户误判为 DBX bug。

---

## 8. DML 设计（**已决策 D2/D6：网格行级编辑 + JSON 伪命令通道**）

### 8.1 背景（代码调查结论）
- 现有 DataGrid 保存链路是「后端生成 SQL 语句文本 + 回滚语句 → 前端 executeBatch 执行」，**契约是 SQL 文本**，SOQL 无 DML，不能直接复用。
- **DynamoDB 先例**：非 SQL 驱动的 tableDataEdit 走两条路——DocumentBrowser（JSON 文档编辑）+ 通过查询通道发送伪命令文本（`"DBX DYNAMODB PUT ITEM"` 等），由驱动在 execute_query 里解释执行。
- Neo4j/TDengine 先例：`prepare_data_grid_save` 有专用 builder，生成方言语句。

### 8.2 采用方案：网格行级编辑 + JSON 伪命令通道（模式 A）
- 前端复用 `useDataGridEditor`（dirtyRows/newRows/deletedRows 采集、保存编排、错误展示全部现成）。
- 后端为 Salesforce 写专用 save builder：不生成 SQL，生成**结构化伪命令**（建议 JSON 载荷优于 DynamoDB 式纯文本，如 `DBX SALESFORCE DML {"op":"update","type":"Account","id":"001...","fields":{...}}`），经现有查询通道下发，驱动解释为 REST 调用：
  - update → `PATCH /sobjects/{type}/{id}`
  - insert → `POST /sobjects/{type}`（返回新 Id 回填网格）
  - delete → `DELETE /sobjects/{type}/{id}`
- **行必须有 Id**：无 Id 列的查询结果禁用编辑（网格已有 keyless 处理经验，直接套用 guard 思路）。
- **可编辑性由 describe 驱动**：field 的 `updateable=false`（formula/rollup/auto-number）→ 该列网格只读；`nillable/defaultedOnCreate` 参与新增行校验。
- **错误按行映射**：逐条执行（或 Composite API 批量），validation rule / FLS 失败映射为「第 N 行失败 + Salesforce 错误原文」，成功行不回滚（REST 无事务；如需原子性，Phase 3 评估 Composite Tree/Graph API）。
- 回滚语句（rollbackStatements）对 Salesforce 无意义 → 返回空 + 前端保存前弹确认（展示将执行的 REST 操作清单预览）。

### 8.3 配套/后续形态
- **单记录 JSON 编辑器**（模式 C）：复用 DocumentBrowser 交互，作为网格编辑的补充（长文本、多字段记录更顺手）。Phase 3。
- **SQL 风格 DML 翻译**（模式 B）：仅受限子集（`WHERE Id = / IN` 直译），Phase 3+，非必须。
- **External ID upsert**：`PUT /sobjects/{type}/{extIdField}/{value}`，Phase 3。
- **Bulk API 2.0**：对齐 dataTransfer 时再议，非本 spec 范围。

### 8.4 安全约束
- 一切写操作受 ReadOnlySessionControl 约束。
- 非 admin 用户（§3）DML 前额外警示。
- MCP 侧 DML 暴露见开放决策 D3。

---

## 9. 自动补全与语法高亮

### 9.1 复用面（代码调查结论）
- 编辑器为 CodeMirror（`QueryEditor.vue` + `@codemirror/lang-sql`），补全引擎 `sqlCompletion.ts` 纯前端，消费后端 `listTables/listColumns` 元数据 → **对象/字段补全的管道全部现成**，只要 §6 的元数据 provider 就位即自动生效。
- 方言三层，需各加一处：
  1. `codemirrorSqlDialect.ts`：新增 `SQLDialect.define()` 注册 SOQL（keywords：FROM/WHERE/ORDER BY/LIMIT/OFFSET/GROUP BY/TYPEOF/INCLUDES/EXCLUDES/FIELDS/NULLS FIRST…；无 JOIN、无 `;` 多语句）。
  2. `semantic/dialect.ts`：SOQL 适配器（语句分割、引号语义——SOQL 标识符不引用，字符串单引号）。
  3. `plugins/dialects/soql.yaml`：Rust 侧类型目录（Id/Currency/Phone/Email/Picklist/DateTime…），供 dbx-sql 类型映射。

### 9.2 SOQL 特有补全（新工作，按价值排序）
1. **字段级上下文补全**：确定 FROM 对象后，SELECT/WHERE/ORDER BY/GROUP BY 位置补全字段；**关系逐级穿越**（`Account.` → Owner/Parent 关系字段 → `Account.Owner.` → User 字段）。需要在 completion source 里加「当前光标上下文扫描」（轻量 scanner：找最近 FROM 对象 + 点号前缀，不需完整 parser）。
2. **picklist 值补全**：`WHERE StageName = '` 后补全 describe 的 `picklistValues`。现有补全引擎没有值级数据源，需要扩展元数据管道（listColumns 返回 picklist values，或新增 API）。**独特卖点，优先做**。
3. **展开全部字段**：SOQL 无 `SELECT *`，提供快捷动作在 `SELECT ` 后生成全字段列表（过滤无 FLS 权限字段）。
4. **日期字面量/函数**：TODAY、YESTERDAY、LAST_N_DAYS:n、THIS_FISCAL_YEAR、聚合函数。
5. 补全列表显示 `Label (ApiName)` 双列，插入 ApiName。
6. 轻量静态提示（非阻断）：`SELECT *` 提示、GROUP BY 一致性。

数据源：全部来自 §6 的 describe 缓存。

---

## 10. MCP 暴露（**已决策 D3：只读默认暴露；DML 连接级开关 + 人工确认，默认关**）

### 10.1 已实现（M5）

清单里的 `mcpMode: bridge` 是**声明性字段**：全仓无运行时消费者（`grep mcp_mode` 只命中 `crates/dbx-types/src/database_manifest.rs`），Salesforce 走 `runtimeMode: native` 进程内路径（`PoolKind::Salesforce`），因此 Local 与 Web 两种 MCP 后端都能直接用同一批工具，不需要 bridge 进程。

只读面（默认暴露，无需额外授权）：

| 工具 | Salesforce 行为 |
|---|---|
| `dbx_list_tables` | 列出 org 对象（describe global 缓存） |
| `dbx_describe_table` | 列出对象字段 |
| `dbx_execute_query` | 执行 SOQL；`dbx-sql` 的 Salesforce 分类器把 SOQL 判为 `Read` |
| `dbx_list_databases` | 不返回数据库，而是说明「一个 org 就是一个作用域」并指向 `dbx_list_tables` + SOQL 示例 |
| `dbx_execute_batch` | 拒绝（`DBX_BATCH_UNSUPPORTED`）：SOQL 只读，无多语句脚本可批 |
| `dbx_open_session` | 拒绝（`SESSION_UNSUPPORTED`）：每次调用都是无状态 REST，无会话可固定、无事务 |
| `dbx_salesforce_current_user` | 新增：连接用户 / 简档 / org 显示名 / 是否具备 “Modify All Data” |

写入面（**通道 B：两步确认**，新增三个工具中的后两个）：

1. `dbx_salesforce_prepare_write { op, object, id?, fields? }` — 只构造并校验 `DBX SALESFORCE DML` 伪命令，**不发送任何请求**。返回人类可读摘要（操作 / 对象 / 记录 Id / 逐字段值 / 连接 / 身份）+ 一次性 `confirm_token`。
2. `dbx_salesforce_apply_write { confirm_token }` — 只执行令牌对应的那一条语句；令牌单次有效、TTL 300 秒、与语句绑定，进程内最多 64 条待确认（超出淘汰最旧）。

服务端强制点（agent 无法绕过）：

- `dbx_execute_query` 对 Salesforce 连接显式拒绝写入伪命令（`SALESFORCE_DML_REQUIRES_CONFIRMATION`）。没有这一条，可写策略下的 agent 能直接把伪命令当「查询」发出去，同时绕过连接级开关和两步确认——而 Salesforce 无法回滚。
- 连接级开关 `allowSalesforceDml`（`McpConnectionRule`，`#[serde(default)]`，默认 `false`；老策略反序列化后自然为关）。未开启 → `SALESFORCE_DML_DISABLED`。
- `read_only` 是硬上限：`connection_allows_salesforce_dml` 要求 `allow_salesforce_dml && !read_only`，`effective_mcp_policy_with_legacy_allow_writes(…, Some(false))` 会连同 `allow_dangerous_sql` 一起清掉该开关；前端 `normalizeMcpGlobalPolicy` 与 `onMcpConnectionExecutionModeChange` 同样在切到只读时撤销它。
- prepare 与 apply **各自**跑一遍完整 `validate_sql_policy`（全局/连接/数据库只读、高风险分级、`targets_production_database`），所以两次调用之间撤销权限立即生效。
- prepare 时以驱动的 `parse_salesforce_statement` 为权威校验，保证不会为 org 必然拒绝的语句发令牌；`upsert`/bulk/composite 一律 `SALESFORCE_DML_INVALID`（一次只碰一条记录）。
- 身份查询是 best-effort：失败只在摘要里写「身份未知」，仍然完成 prepare，把是否 apply 的决定权留给人。

风险分级（`crates/dbx-sql-core/src/query_execution_sql.rs`，fail-closed）：SOQL → `Read`；带 Id 的单记录 DML → `ScopedWrite`（映射 `SqlRisk::Write`，只需 safe_write）；无 Id / 无法判定 → `OpaqueWrite`（映射 `SqlRisk::Ddl`，需 allow_dangerous_sql）。

前端开关位置：**设置 → MCP → 连接范围**，仅对 `db_type === "salesforce"` 的连接行渲染（`McpResourceScopePicker.vue`），文案 `settings.mcpConnectionPolicyAllowSalesforceDml`；有效执行模式为只读时点击只提示不保存。工具白名单里三个新工具可独立勾选，因此可以只给 agent 读能力（`current_user` + SOQL）而不给写通道。

历史与活动标签：`mcp_sql_activity_kind` / `mcp_sql_operation` 增加了 Salesforce 分支（`Read` → `query`/`SELECT`；写入 → `data_change`/对应 DML 动词）。通用路径按 SQL 风险档推断标签，而 Salesforce 的无范围写入 fail-closed 落在 DDL 档，会把一次记录写入误标成 `schema_change`；`mcp_sql_operation` 也只会取到伪命令首词 `DBX`。同理 `mcp_sql_has_forbidden_database_switch` 对 Salesforce 直接返回 `false`：SOQL 没有 `USE`、pool 按连接而非库分键，而通用 tokenizer 回退会把 JSON 字段值里的 `;` 当成语句边界，从而把 `{"Description":"a; USE prod"}` 这样的合法写入误判为切库。

### 10.2 未做（有意留待后续）

- 每次 apply 前弹出**桌面端**确认对话框（当前确认发生在 agent ↔ 人之间，DBX 只做服务端强制 + 摘要）。
- 对象级 createable/updateable/deletable 预检（现在靠 org 自身逐行报错）。
- External-ID upsert、Composite/Graph 原子多记录写入。

---

## 11. 分阶段里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| ✅ **M0 骨架** | salesforce.yaml + sync 脚本 + PoolKind/分发接线 + 图标 + 表单（token 粘贴模式）| manifest 三测试通过（`cargo test -p dbx-core --test database_capabilities` + 两个 `driver-manifest.test.ts`），能用粘贴 token 连上 dev org |
| ✅ **M1 查询闭环** | execute_query（SOQL→QueryResult）+ 分页 + 错误映射 + listTables/listColumns（describe 缓存）+ userinfo/admin 探测 | 对象树可浏览，SOQL 查询出结果，配额友好 |
| ✅ **M2 OAuth** | PKCE 浏览器流（桌面）+ Device Flow（web）+ token 持久化与刷新 | 桌面一键授权，重启不丢登录 |
| ✅ **M3 编辑体验** | SOQL 方言高亮 + 补全（对象/字段/关系/picklist）+ 展开全部字段 | 补全基于 describe 缓存，无重复 API 消耗 |
| ✅ **M4 DML** | 网格行级编辑（§8.2）+ tableDataEdit capability 打开 + 只读/警示联动 + 状态栏身份徽章 | 编辑-保存-逐行错误反馈闭环 |
| ✅ **M5 MCP** | 只读工具 Salesforce 化（§10.1）+ `dbx_salesforce_current_user` + SOQL 风险分级 + 拒绝 batch/session + 两步确认 DML 通道（连接级开关默认关） | agent 可通过 MCP 查询 org；写入必须 prepare→人工确认→apply，且无法从 `dbx_execute_query` 绕过 |

依赖关系：M1 是核心；M2/M3 可并行；M4 依赖 M1 的 describe 元数据；M5 依赖 M1。
**最短可演示路径：M0+M1（token 粘贴 + 查询 + 浏览）。**

---

## 12. 测试策略

- **手工/集成**：注册 Free Developer Edition org（developer.salesforce.com/signup）作为固定测试环境；seed 若干 Account/Contact/自定义对象。
- **Rust 单测**：HTTP 层 mock（照 Elasticsearch 驱动现有测试方式）；OAuth 流程用 mock token endpoint；SOQL→QueryResult 映射用录制的真实响应 fixture。
- **前端**：补全 scanner 单测（vitest）；DataGrid 编辑链路沿用现有测试模式。
- **MCP**：`cargo test -p dbx-mcp --lib salesforce` 覆盖两步确认通道（令牌单次有效/过期/上限、连接级开关、只读与生产规则、伪命令不能从 `dbx_execute_query` 偷渡、batch/session 拒绝、身份摘要）；前端 `mcpPolicySelection.spec.ts` 用正则从 `crates/dbx-mcp/src/server.rs` 抓取已注册工具名，断言工具目录与后端严格同步——新增工具若忘记加进 `MCP_TOOL_OPTIONS`，该测试会失败。
- **manifest 一致性**：CLAUDE.md 规定的三个测试进 CI 必跑。
- CI 不连真实 org（无 secret 依赖），真实 org 验证走手工 checklist。

---

## 13. 决策记录（2026-09-21 全部确认）

| # | 问题 | 决策 |
|---|---|---|
| **D1** | Connected App 分发 | ✅ 官方内置为主 + BYO 高级选项 + token 粘贴兜底 |
| **D2** | DML 机制 | ✅ 网格行级编辑（JSON 伪命令通道）为主，单记录 JSON 编辑器 Phase 3 补充（§8.2） |
| **D3** | MCP DML 暴露 | ✅ 只读工具默认暴露；DML 连接级开关 + 人工确认，默认关（实现为两步 `prepare_write`/`apply_write` 令牌通道，见 §10.1） |
| D4 | refresh_token 明文落盘 | ✅ 接受（与现状一致），文档标注；未来 secret 加密时首批迁移 |
| D5 | queryAll（回收站） | ✅ Phase 2，不进 MVP |
| D6 | 伪命令载荷格式 | ✅ JSON（可校验、可扩展） |
