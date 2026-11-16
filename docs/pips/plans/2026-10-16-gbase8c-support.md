# PIP: GBase 8c 支持

## 状态

Implemented（设计已确认，实现中）

## 摘要

为 DBX 新增南大通用 GBase 8c 连接类型：新 dbType `gbase8c`，`runtimeMode: agent`，由新增的 `agents/drivers/gbase8c` 模块通过**厂商 JDBC 驱动**（`com.gbase8c.Driver` + `jdbc:gbase8c://`）访问数据库。

GBase 8c 的内核是 openGauss（PostgreSQL 9.2 世代），因此**原生 Rust 路线在原理上也可行**，但厂商的分发与兼容性口径使它不可取：

- 官方文档通篇不出现 `com.gbase8c.Driver` / `jdbc:gbase8c://`，而厂商 jar **明确拒绝** `jdbc:postgresql://`（实测 `SQLException: No suitable driver found`）。也就是说「官方保真」保的是 jar 里的实现，不是文档承诺的任何东西。
- 无版本兼容矩阵、无发布说明、无 changelog；唯一口径是「新驱动前向兼容数据库」。
- 没有官方 Docker 镜像，也没有可复现的官方安装容器路径（安装包只有 V6 单一下载项）。

采用厂商 JDBC 的收益是：协议、认证、兼容模式等最难的部分全部由厂商客户端承担，DBX 侧只做元数据适配与描述符注册。

## 背景

### 为什么是「新 dbType + agent」而不是别的形状

| 方案 | 否决理由 |
|---|---|
| 挂到既有 `gbase` dbType 下当第三个 profile | `plugins/connection-types/gbase.yaml` 的 `dialect: GBase` 指向 MySQL 方言（反引号、MySQL `MODIFY COLUMN`），而 `dialect` / `defaultPort` / `transferObjectFamily` 都按 dbType 索引，profile 改不了 → 会继承 8a 的反引号与全表扫描口径 |
| 挂到 `postgres` / `opengauss` 下当 profile | 策略块（capabilities / mcpMode / traits）只按 dbType 索引，没有按 profile 覆盖的入口；实测 postgres 会继承 `sqlExplain:true`/`tableImport:true`/`mcpMode:direct`，opengauss 会继承 `mcpMode:bridge` 与 openGauss 专属对象树 |
| 原生 Rust 直连（复用 `PoolKind::Postgres`） | 见摘要：认证在默认配置下确实是标准 MD5，但 sha256-only 部署需要 `tokio-postgres-gaussdb` fork 的 GaussDB 握手，而该 fork 的 pin 是**孤儿提交**（`ac8ad476`，无任何分支或标签包含它，可被 GC），且无法前移（master 有 GaussDB 认证但缺 `RowStream::columns()`；`dev/row-stream-columns` 有后者但删掉了认证） |

### 为什么基类取 `ConfiguredJdbcAgent` 而不是 `PostgresLikeAgent`

在真机实例上实测 `PostgresLikeAgent` 依赖的三项能力：

| 依赖 | 实测 |
|---|---|
| `JOIN LATERAL`（`PostgresLikeAgent.java:495` primaryKeys、`:589` listIndexes、`:748,750` listForeignKeys） | **不支持**：`ERROR: syntax error at or near "select"`（指向 `lateral`） |
| `pg_catalog.to_regclass(text)`（`:355` 视图源码） | **不存在**：`ERROR: function pg_catalog.to_regclass(unknown) does not exist` |
| `pg_proc.prokind`（`:213,216,360,366`） | 列存在，但语义不可靠：函数 `f`、过程 `p` 可区分，而聚合的 `prokind` 仍是 `f`（`proisagg=t` 有 170 行） |

前两项分别打死三条热路径和视图源码，且 `PostgresLikeAgent` 的兜底**只存在于 `getTableDdl` 内部**，`listObjects`/`getColumns`/`listIndexes`/`listForeignKeys` 经 RPC 直调时零兜底。故取 `ConfiguredJdbcAgent`（代价是 `objectSource: false`，`getObjectSource` 抛 `UnsupportedOperationException`）。

## 已确认的设计决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 交付门槛 | 上游质量：先落本 spec，再写代码；i18n 只新增一个键（`connection.gbase8cCustomDriverHint`，13 份 locale）——因为 `supportsNativeAgentJdbcDriverConfigType` 必须纳入 `gbase8c`，用户才看得到 `jdbc_driver_paths` 字段；8c 本身没有专属表单字段 |
| 2 | 能力矩阵 | `operate` 但按实测裁剪：`tableStructureEdit` 关闭（DDL 必须随 `DBCOMPATIBILITY` 变化，而模式建库时固定且不可 SQL 修改） |
| 3 | 覆盖面 | Desktop + Web；MCP 走 `mcpMode: bridge`；CLI 直连与 `plugins/jdbc` Java 插件为非目标 |
| 4 | SQL 方言 | `dialect: PostgreSQL`，不新建 `plugins/dialects/gbase8c.yaml`（agent 路线下方言 yaml 的元数据半边用不上，DDL 半边只在 `tableStructureEdit` 打开后有用） |
| 5 | 兼容模式 | **不改任何共享代码**：实测四种兼容模式下双引号标识符都可用、反引号全部报错，而驱动的 `getIdentifierQuoteString()` 恰好返回双引号，故**不**把 `gbase8c` 加进 `isPostgresCompatibleJdbc`（见下） |
| 6 | 厂商 jar 分发 | `Agent-External-Driver: true`（用户自备），不提交到仓库 |
| 7 | 命名与图标 | 独立选择器条目 + `南大通用 GBase 8c` + `category: domestic` + 复用 `gbase.svg` |
| 8 | 验证实例 | 用官方 V6 安装包自建一次性本地实例（见附录 B），不提交 `deploy/database/gbase8c/` 菜谱 |
| 9 | 版本声明 | 描述符不写任何版本号，支持矩阵写「GBase 8c（以厂商 JDBC 驱动为准）」 |

### 决策 5 的证据（原方案已被实测推翻）

**原方案**：`isPostgresCompatibleJdbc`（`agents/common/src/main/java/com/dbx/agent/AbstractJdbcAgent.java:534-554`）匹配 9 个关键串，`jdbc:gbase8c:` 与 `com.gbase8c.Driver` 一个都不匹配，所以打算把 `gbase8c` 加进该列表，让 `resolveIdentifierQuote` 走 `GAUSSDB_COMPATIBILITY_SQL` + `gaussdbIdentifierQuote`，理由是「B 模式（MySQL 兼容）应该用反引号，而驱动只会返回双引号」。

**实测推翻了这条推理**。在同一个实例上对四种兼容模式各建一张 `public.qt (id int, "na me" varchar(10))` 并执行三种写法：

| 模式 | `datcompatibility` | 裸标识符 | 双引号 `"na me"` | 反引号 `` `na me` `` |
|---|---|---|---|---|
| dbx_a | A（Oracle） | 可用 | **可用** | `ERROR: syntax error at or near "`"` |
| dbx_b | B（MySQL） | 可用 | **可用** | `ERROR: syntax error at or near "`"` |
| dbx_c | C（Teradata） | 可用 | **可用** | `ERROR: syntax error at or near "`"` |
| dbx_pg | PG | 可用 | **可用** | `ERROR: syntax error at or near "`"` |

也就是说 **GBase 8c 在任何兼容模式下都不接受反引号**，B 模式也照样是双引号——`gaussdbIdentifierQuote` 里 `M|B|MYSQL → 反引号` 那条映射是华为 GaussDB 的行为，不是 GBase 8c 的行为。若照原方案接线，B 模式会开始输出反引号，**把本来能用的查询改成语法错误**。

同时实测驱动的 `getIdentifierQuoteString()` 在四种模式下**都是双引号**，与数据库行为一致。而 `isPostgresCompatibleJdbc` 全仓只有一个消费点（`AbstractJdbcAgent.java:448`，即 `resolveIdentifierQuote`），所以「什么都不改」既正确又零风险：gbase8c 的引号走默认回落，拿到的正是正确答案。

`SELECT datcompatibility FROM pg_catalog.pg_database WHERE datname = current_database()` 在该实例上确实可用（返回 `PG`/`A`/`B`/`C`），只是**本类型不需要它**。

顺带实测：`SET search_path TO "dbx_smoke"` 在四种模式下均无报错，故 profile 的 `schemaSwitchPrefix` 取 `SET search_path TO` 正确。

## 驱动架构与文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `plugins/connection-types/gbase8c.yaml` | 新增 | dbType `gbase8c`、`rustVariant: Gbase8c`、`dialect: PostgreSQL`、`runtimeMode: agent`、`mcpMode: bridge`、`agentKey: gbase8c`、`defaultPort: 5432`、`driverStoreOrder: 55`、`traits: {schemaAware, treeSchema, pgVacuum}`、`supportLevel: operate`，能力集见描述符草案 |
| `plugins/connection-types/profiles/catalog.yaml` | 修改 | `id: gbase8c` / `label: 南大通用 GBase 8c` / `icon: gbase` / `port: 5432` / `user: gbase` / `category: domestic` |
| `agents/drivers/gbase8c/build.gradle` | 新增 | `Agent-Label: GBase 8c`、`Agent-External-Driver: true`、`Main-Class: com.dbx.agent.gbase8c.Gbase8cAgent`、`fileTree(libs)` |
| `agents/drivers/gbase8c/src/main/java/com/dbx/agent/gbase8c/Gbase8cAgent.java` | 新增 | `extends ConfiguredJdbcAgent`；profile；`listDatabases` 覆写 |
| `agents/drivers/gbase8c/src/test/java/com/dbx/agent/gbase8c/Gbase8cAgentTest.java` | 新增 | 继承 `JdbcFakeExecutionBehaviorTest`（执行路径共享契约）+ 驱动类断言 |
| `agents/drivers/gbase8c/src/test/java/com/dbx/agent/gbase8c/Gbase8cAgentMetadataTest.java` | 新增 | profile 契约、`excludedSchemas`、`tableTypes` 交集、`listDatabases` SQL、`setSchemaSQL` |
| `agents/drivers/gbase8c/src/test/java/com/dbx/agent/gbase8c/Gbase8cAgentLiveTest.java` | 新增 | 真机冒烟（`DBX_TEST_GBASE8C_URL` 门控），结果见「实测冒烟结果」 |
| `agents/settings.gradle`、`agents/build.gradle`、`agents/versions.json`、`agents/README.md`、`agents/README.zh-CN.md` | 修改 | 模块注册的五道闸 + 两张支持表各加一行 |
| `apps/desktop/src/components/connection/ConnectionDialog.vue` | 修改 | `supportsNativeAgentJdbcDriverConfigType` 加 `gbase8c`（否则用户看不到「驱动 JAR」字段）；`nativeAgentJdbcDriverHint` 加分支 |
| `apps/desktop/src/components/icons/DatabaseIcon.vue` | 修改 | `gbase8c: "gbase.png"` |
| `apps/desktop/src/i18n/locales/*.ts` | 修改 | 13 份 locale 加 `connection.gbase8cCustomDriverHint` |
| `apps/desktop/src/lib/database/databaseNamespaceCreation.ts` | 修改 | `Record<DatabaseType, …>` 矩阵加 `gbase8c`（deferred：建库要显式 `DBCOMPATIBILITY`） |
| `apps/desktop/src/lib/database/databasePropertyEditing.ts` | 修改 | 同一张 `Record<DatabaseType, …>` 矩阵加 `gbase8c`（deferred） |
| `docs/data/databaseSupport.ts` | 修改 | 加一行 `gbase8c` |
| `crates/dbx-types/src/models/connection.rs` | 修改 | `default_database` → `Some("postgres")`；脱敏 URL 与带凭据 URL 各加一支 `gbase8c://` |
| `crates/dbx-sql-dialect/src/sql_dialect/ddl_profile.rs` | 修改 | `profile_for` 的 PG 家族臂加 `Gbase8c`（**编译必需**） |
| `crates/dbx-sql-dialect/src/sql_dialect/capabilities.rs` | 修改 | `is_schema_aware` 加 `Gbase8c`（`schemaAware` 在 Rust 侧**唯一**载体：capabilities/traits 不进 `DatabaseManifestEntry`） |
| `crates/dbx-sql-core/src/sql.rs` | 修改 | `is_postgres_string_lexer_database` 加 `Gbase8c`（字面量词法 `E'…'`/嵌套注释） |
| `crates/dbx-sql-core/src/query_execution_sql.rs`、`sql_risk.rs` | 修改 | PG 家族写检测加 `Gbase8c`（缺了会让 `SELECT … INTO newtable` 漏检成只读） |
| `crates/dbx-sql-data/src/data_grid_sql.rs` | 修改 | 三处：字面量反斜杠保留、`col::text` 过滤转换、无主键行谓词 |
| `crates/dbx-sql-data/src/database_structure_search_sql.rs` | 修改 | 结构搜索的 PG 家族臂加 `Gbase8c`（缺了功能静默不可用） |
| `crates/dbx-sql-schema/src/schema_diff.rs` | 修改 | `is_postgres_family_ddl` 加 `Gbase8c`（`compareModes` 含 schema） |
| `crates/dbx-sql-schema/src/db_admin_sql.rs` | 修改 | `supports_vacuum_table`（`pgVacuum` 的唯一载体）、`supports_truncate_table_cascade` |
| `crates/dbx-core/src/connection/mod.rs` | 修改 | `agent_connection_pool_database_type!` 宏加 `Gbase8c`（**编译必需**：`:2780` 的 `match` 无通配） |
| `crates/dbx-core/src/safety/production_safety.rs` | 修改 | `schema_first_qualifier_type`（两段名归属判定）+ SQL 扫描器的 `postgres_family` |
| `crates/dbx-core/src/data/script_generator.rs` | 修改 | 幂等 `CREATE TABLE` 重写的 PG 臂 |
| `crates/dbx-core/tests/database_capabilities.rs` | 修改 | `agent_key` / `is_agent_type` / 产品能力断言 |

### 刻意不做的改动

| 位置 | 为什么不改 |
|---|---|
| `agents/common/**` | 原计划要把 `gbase8c` 加进 `isPostgresCompatibleJdbc`，被实测推翻（见决策 5）；本功能零共享 Java 代码改动 |
| `crates/dbx-driver-agent/src/agent_connection.rs` | `agent_connect_params_with_role` 的三段 postgres-like 分支都**不能**加 `Gbase8c`：只加 `:106/:122` 会在 `:555-561` 的 scheme `match` 撞 `unreachable!()`；两处都加则 Rust 会自己拼 URL，与「Java profile 自己拼 `jdbc:gbase8c://`」冲突。兜底臂 `:141-143` 返回空 `connection_string`，正是 Java `JdbcAgentProfile.buildUrl` 期望的输入 |
| `src-tauri/src/commands/connection.rs` | agent 家族路由由 manifest 驱动（`database_capabilities::is_agent_type` ← `database_manifest::is_agent_runtime`），`Gbase8c` 自动命中 `:1845`/`:2313` 的守卫臂 |
| `crates/dbx-core/src/schema/providers/native.rs` | 该 provider 无任何调用点（`providers/mod.rs` 只有一行 `pub(super) mod native;`，`crates/dbx-core/src` 内 grep `native::` 零命中），且 agent 类型不会进去 |
| `crates/dbx-core/src/connection/mod.rs:1066 needs_legacy_postgres_like_database_probe` | 它给「旧记录/被清空的 database」在 `postgres` 不存在时回退 `template1`。实测实例的 `postgres` 存在，`default_database()` 现在也给 `postgres`，没有 legacy 记录需要兜底；纳入会引入每次空库连接的探测成本 |
| `crates/dbx-core/src/schema/mod.rs:7765 is_agent_postgres_metadata_fallback_config` | 是否让 agent 元数据缺失时回退原生 tokio-postgres 池需要针对本类型实测（注释明确 UXDB 被排除，并非「PG 家族一律纳入」） |
| `crates/dbx-core/src/schema/mod.rs:9942 is_agent_pg_sequence_config` | 序列走 agent 的 `relkind='S'` 查询还是原路径，同样需要实测 |
| `crates/dbx-core/src/schema/mod.rs:11083 supports_custom_type_details` | 刻意收窄的「已验证五族」名单，测试 `:3513-3532` 反而断言 Highgo/Uxdb 为假 |
| `agents/metadata-constraint-coverage.tsv` | 该表只要求覆写了 `listTables`/`listObjects` 的驱动登记；本 agent 不覆写，靠收窄 `tableTypes` 白名单解决 |
| `deploy/database/gbase8c/**` | Q9 决策：不做菜谱 |


## 描述符草案

```yaml
schemaVersion: 1
order: 455
dbType: gbase8c
compareModes: [schema, data]
rustVariant: Gbase8c
label: 南大通用 GBase 8c
dialect: PostgreSQL
runtimeMode: agent
mcpMode: bridge
agentKey: gbase8c
driverStoreVisible: true
driverStoreOrder: 55
singleConnectionPool: true
metadataConnectionScoped: false
skipTcpProbe: true
defaultPort: 5432
traits:
  schemaAware: true
  treeSchema: true
  pgVacuum: true
supportLevel: operate
capabilities:
  queryExecution: true
  metadataBrowse: true
  objectBrowser: true
  objectSource: false
  schemaSearch: true
  diagram: true
  tableDataEdit: true
  tableStructureEdit: false
  tableImport: false
  dataTransfer: false
  sqlFileExecution: true
  databaseCreate: false
  fieldLineage: false
  sqlExplain: false
  userAdmin: false
  driverManagement: true
```

`transferSupportLevel` / `transferObjectFamily` **刻意省略**（与 `plugins/connection-types/uxdb.yaml` 一致）：两者只有在 `dataTransfer: true` 时才有消费者，而本类型 `dataTransfer: false`。

## Agent profile

`agents/drivers/gbase8c` 的 profile 槽位取值及其依据：

| 槽位 | 取值 | 依据 |
|---|---|---|
| `driverClass` | `com.gbase8c.Driver` | 实测 `Class.forName` 成功；`META-INF/services/java.sql.Driver` 内容即此类 |
| `urlTemplate` | `jdbc:gbase8c://{host}:{port}/{database}` | 实测厂商 jar 拒绝 `jdbc:postgresql://` |
| `defaultPort` | `5432` | 官方默认端口；CN 是客户端入口 |
| `excludedSchemas` | 17 个（见下） | 实测 `getSchemas()` 返回 19 个，其中 17 个是 openGauss 系统 schema |
| `tableTypes` | `{TABLE, VIEW}` | **必须收窄**：默认白名单含 `SYSTEM TABLE`/`SYSTEM VIEW`，实测跨 schema 返回 531 个对象、其中 331 个是 SYSTEM |
| `identifierQuote` | `"` | 静态回落值；实际由 `datcompatibility` 决定 |
| `schemaSwitchPrefix` | `SET search_path TO` | 默认值是 `SET SCHEMA`（Oracle 味），PG 家族必须改 |
| `catalogFallbackEnabled` | `true` | 驱动行的 `TABLE_CAT=null`，`getSchemas` 的回退路径需要它兜底 |
| `nativeTableDdlSupported` | `false` | `tableStructureEdit` 关闭 |
| `objectSourceSupported` | `false` | `ConfiguredJdbcAgent.getObjectSource` 抛异常 |
| `triggersSupported` | `false` | 继承实现是恒定空列表 |

`excludedSchemas` 实测清单：

```
auditadmin, audituser, blockchain, coverage, cstore, db4ai, dbe_perf,
dbe_pldebugger, dbe_pldeveloper, dbe_sql_util, information_schema,
pg_catalog, pkg_service, securityadmin, snapshot, sqladvisor, sysadmin
```

注：`getExcludedSchemas()` 全仓只有两处消费（`StandardJdbcMetadata.java:84` 的 `listSchemas`、`:462` 的补全过滤），`listTables`/`listObjects` 都不看它 —— 本驱动是全仓第一个真正使用这个槽的 profile。

## Agent 覆写清单

| 方法 | 是否覆写 | 理由 |
|---|---|---|
| `listDatabases()` | **必须** | 继承路径是 `StandardJdbcMetadata.java:25-34` 的 `conn.getMetaData().getCatalogs()`，实测**只返回 1 行**（当前库），而服务器上有 7 个库。改查 `SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname` |
| `resultValueReader()` | **不覆写** | 继承的 3 参 `resultValue`（`AbstractJdbcAgent.java:637-670`）把 `OTHER`/`STRUCT`/`BLOB`/`CLOB`/`ARRAY` 全部交给 `rs.getString`，而实测 `getString` 对这些类型**全部可用**：`raw`/`json`/`inet`→`AABB`/`{"k":1}`/`10.0.0.1`（底层 `PGobject`）、`uuid`→文本、`blob`→`424C4F4231`、`clob`→`CLOB1`、`_int4`/`_text`（jdbc=2003 ARRAY，底层 `PgArray`）→`{1,2,3}`/`{x,y}`。没有任何一类需要额外处理，多加一条路径只会引入未测分支 |
| `listTables(schema, …)` | **不覆写** | 实测厂商驱动**遵守** `types` 数组：`{TABLE,VIEW}` 精确返回 2 行、`{INDEX}` 才 2 行、只有 `types=null` 才出现 `TABLE_TYPE='INDEX'` 行。收窄 `tableTypes` 白名单即可，无需后置过滤，因而也不需要登记 `agents/metadata-constraint-coverage.tsv` |
| `listTriggers` / `getTableDdl` 的 check 约束 | 不覆写 | 均不在本版能力范围内 |

**硬约束：agent 代码不得 import 任何 `com.gbase8c.*` 类型。** 驱动会让 `getObject()` 返回 `com.gbase8c.core.types.PGClob` 与 `com.gbase8c.util.PGobject`；继承路径从不调 `getObject`，这正是它安全的原因。`resultValue` 覆写只能用 `java.sql.*` 的标准接口。

**两个已知的重复，是刻意的：**

- `LIST_DATABASES_SQL` 与 `PostgresLikeAgent.java:141-142` 的 `datistemplate = false ORDER BY datname` 逐字相同。前者用 `profile.catalogRelation("database")` 拼字符串，而本 Agent 继承 `ConfiguredJdbcAgent`，拿不到 `PostgresLikeAgent` 实例；共享这段 SQL 必须改 `agents/common/**`，而那是本 spec 明确不动的地方。将来若把该查询下沉到 `JdbcAgentProfile`，这处应当一起收编。
- `GBASE8C_PROFILE` 用 12 个位置参数构造，末尾四个裸布尔（`catalogFallbackEnabled=true`、`nativeTableDdlSupported/objectSourceSupported/triggersSupported=false`）。这是 `JdbcAgentProfile` 既有的构造器形状，同为 PG 家族的 `uxdb`/`highgo` 也这么写；可读性问题由 `Gbase8cAgent.java` 里那段点名注释承担，避免为一个驱动引入全仓没有的具名覆写风格。

## 需要同时改的 Rust 与前端接线点

| 位置 | 改动 |
|---|---|
| ~~`agents/common/src/main/java/com/dbx/agent/AbstractJdbcAgent.java:534-554`~~ | **不改**：实测推翻（见决策 5）。`isPostgresCompatibleJdbc` 的唯一消费点是 `:448` 的 `resolveIdentifierQuote`，默认回落给出的双引号在四种模式下都正确 |
| `crates/dbx-types/build.rs` | 无需改（读目录自动生成 `DatabaseType::Gbase8c`） |
| `crates/dbx-core/src/connection/mod.rs:2780+` | 无需改（agent 路线不发原生 pool） |
| `src-tauri/src/commands/connection.rs:1432` | 无需改（同上） |
| `crates/dbx-core/src/schema/providers/native.rs` | 无需改（同上） |
| `apps/desktop/src/components/connection/ConnectionDialog.vue:3778-3780` | `supportsNativeAgentJdbcDriverConfigType` 加 `gbase8c`，否则用户在表单里看不到 `jdbc_driver_paths` |
| `apps/desktop/src/components/connection/ConnectionDialog.vue:3795-3799` | `nativeAgentJdbcDriverHint` 加 `gbase8c` 分支 |
| ~~`apps/desktop/src/lib/database/gbase8cDriverOptions.ts`~~ | **不建**：`AbstractJdbcAgent.loadDriver`（`:127-144`）在 `jdbc_driver_class` 为空时回落到 profile 的 `driverClass()`，所以只给 `jdbc_driver_paths` 即可；唯一先例 `bigquery`（同为 `Agent-External-Driver`）也没有 `*DriverOptions.ts` |
| `crates/dbx-core/assets/database-drivers.manifest.json`（生成物） | 由 `pnpm generate:connection-types` 重生成 |

## 非目标

- `plugins/jdbc` Java 插件路线（`DbxJdbcPlugin.java` 有独立的方言映射表）
- CLI 直连
- `tableStructureEdit` / DDL 生成（`DBCOMPATIBILITY` A 模式下空串即 NULL、`DATE`→`TIMESTAMP(0)`、CHAR 按字节计；同一份 DDL 在一个 8c 实例上对、在另一个上错，而模式建库时固定且不可 SQL 修改）
- 数据传输与表导入（依赖上面的 DDL 生成）
- `deploy/database/gbase8c/` 菜谱
- sm3 认证（本构建的 `postgresql.conf` 注释只列出 `0=md5 / 1=sha256+md5 / 2=sha256`）

## 附录 A：真机实测事实表

观测实例：官方 `GBase8cV6_S1.0.0B20_centos7.8_x86_64.tar.gz`，容器 `centos:7.9.2009`，`simpleInstall` 单节点。

### A.1 认证与连接

| 探针 | 结果 |
|---|---|
| `password_encryption_type=1`（分布式默认） | 服务端索要 **auth code 5 = 标准 MD5**，salt `1446da93` |
| `password_encryption_type=2`（仅 sha256） | 服务端索要 **auth code 10 + int32 标签 2**，载荷 136 字符十六进制 |
| 初始用户远端连接 | **被拒**：`SFATAL MForbid remote connection with initial user.`（SQLSTATE 28000） |
| `ssl` 默认值 | `off`；SSLRequest 回 `N` |
| SSLRequest（8 字节 `80877103`） | 服务端回 `N` |
| 厂商驱动连接耗时 | 614 ms（`dbx` 用户，sha256-only） |

### A.2 版本与兼容模式

| 探针 | 结果 |
|---|---|
| `select version()` | `(GBase8cV6 1.0.0B20 build 80563724) compiled at 2026-05-13 03:09:52 commit 0 last mr 1443  on x86_64-unknown-linux-gnu, compiled by g++ (GCC) 10.3.0, 64-bit` —— **不含 `PostgreSQL` 子串** |
| `JDBC getDatabaseProductName/Version` | `GBase8c` / `9.2.4` |
| `show server_version_num` | `90204` |
| `datcompatibility` | `postgres = PG`、`template0 = A`、`template1 = A` |
| 四模式建库 | `CREATE DATABASE dbx_a/dbx_b/dbx_c/dbx_pg DBCOMPATIBILITY 'A'/'B'/'C'/'PG'` 全部成功，同实例共存 |
| `dolphin%` schema（B 模式重写目标） | `dbx_b` 中计数为 0 |
| `current_schema()` | 用户 `dbx` 在 `postgres` 里是 `dbx`，在 `dbx_pg`/`dbx_a`/`dbx_b`/`dbx_c` 里是 `public`；同名用户 schema 只在 `postgres` 存在 |

### A.3 目录面

| 探针 | 结果 |
|---|---|
| `information_schema` 视图数 | 66 |
| `pg_catalog` 普通表数 | 130 |
| `pg_proc.prokind` | 列存在；函数 `f`、过程 `p`；但分布只见 `f`，而 `proisagg=t` 有 170 行 |
| `JOIN LATERAL` | **不支持** |
| `pg_catalog.to_regclass(text)` | **不存在** |
| `array_position` | **不存在**（`pg_proc` 命中 0） |
| 双参 `pg_get_viewdef(regclass, bool)` | 存在（对表报 `Not a view`，是语义错而非缺函数） |
| `generate_series` | 可用 |
| `array_length(int2vector, 1)` | 可用（返回 2） |
| 例程创建 | `CREATE FUNCTION … AS $$ … $$ LANGUAGE plpgsql` 成功；`CREATE PROCEDURE … AS $$ … $$ LANGUAGE plpgsql` **语法报错**，必须用 openGauss 的 `AS BEGIN … END; /` 经 `gsql -f` 提交 |

### A.4 JDBC 驱动怪癖

| 探针 | 结果 |
|---|---|
| `getCatalogs()` | **1 行**（当前库）；`pg_database` 有 7 行 |
| `getTableTypes()` | 含非标准项 `INDEX`、`SYSTEM INDEX`、`SYSTEM TABLE`、`SYSTEM VIEW`、`SYSTEM TOAST INDEX`、`SYSTEM TOAST TABLE`、`TYPE`、`LOCAL TEMPORARY`、`TEMPORARY *` |
| `getTables(types=null)` | 返回 `TABLE_TYPE='INDEX'` 行（`t1_pkey`、`idx_t1_name`） |
| `getTables(types={TABLE,VIEW})` | 精确 2 行 |
| `getTables(types={TABLE,VIEW,SYSTEM TABLE,SYSTEM VIEW})` 跨全 schema | **531 行，其中 331 行是 SYSTEM**（`pg_catalog.gs_*`、`information_schema.sql_*`） |
| `getSchemas()` | 19 个，含 `dbe_*`/`cstore`/`db4ai`/`blockchain`/`securityadmin`/`sysadmin`/`snapshot`/`sqladvisor`/`pkg_service`/`auditadmin`/`audituser`/`coverage`；不含 `dbx` |
| `getTables` 行的 catalog | `TABLE_CAT=null`、`TABLE_SCHEM=dbx_smoke` |
| `getProcedures` / `getFunctions` | 函数出现在 `getProcedures`（`PROCEDURE_TYPE=2`），`getFunctions` 返回 0 行 |
| `getImportedKeys` | 可用：`fk=child_pid_fkey pid -> t1.id updateRule=3 deleteRule=3` |
| 表注释 | 经 `getTables` 的 `REMARKS` 返回（实测 `remarks=smoke table`） |
| `getDriverName()` | `GBASE JDBC Driver /*$mvn.project.property.parsedversion.osgiversion$*/` —— 厂商漏替换的 Maven 占位符 |
| `getIdentifierQuoteString()` | PG/A/B/C **四模式全是双引号**，且与数据库行为一致（双引号标识符全模式可用，反引号全模式 `syntax error`） |
| `getTypeInfo` | 每行 `precision=0`；`getColumns.COLUMN_SIZE` 常为 `2147483647` |

### A.5 非标准类型的往返

| 类型 | `getColumns` | `getTypeInfo` | `getObject()` | `getString()` |
|---|---|---|---|---|
| `int1` | `int1` / −6 | −6 | `java.lang.Integer` | `200` |
| `int16` | — | 1111 | **列不可创建**：`ERROR: It's not supported to create int16 column` | — |
| `raw` | `raw` / 1111 | 1111 | `com.gbase8c.util.PGobject` | `AABB` |
| `blob` | `blob` / 2004 | 2004 | `byte[]` | `424C4F4231` |
| `clob` | `clob` / 2005 | 2005 | `com.gbase8c.core.types.PGClob` | `CLOB1` |
| `money` | `money` / 8 | 8 | `java.lang.Double = 12.34` | `$12.34` |
| `bytea` | `bytea` / −2 | −2 | `byte[]` | 十六进制文本 |
| `json` | `json` / 1111 | 1111 | `com.gbase8c.util.PGobject` | `{"k":1}` |
| `uuid` | `uuid` / 1111 | 1111 | `java.util.UUID` | 文本 |
| `inet` | `inet` / 1111 | 1111 | `com.gbase8c.util.PGobject` | `10.0.0.1` |
| `int[]` / `text[]` | `_int4`/`_text` / 2003 | 2003 | `com.gbase8c.jdbc.PgArray` | `{1,2,3}` / `{x,y}` |
| `jsonb` | — | 1111 | — | — |
| `abstime`/`reltime`/`tinterval`/`xid32`/`smgr`/`unknown` | — | 1111 | — | — |
| `pg_class`/`pg_proc`/`pg_type`/`gs_package` | — | **2002 (STRUCT)** | — | — |

`information_schema.table_constraints` 会把自动派生 NOT NULL 约束报成 `CHECK`（形如 `16393_16451_1_not_null`），而 `pg_constraint` 只列真约束（`contype='c'`）。若日后实现 check 约束列举，应读 `pg_constraint`。

## 实测冒烟结果（`Gbase8cAgentLiveTest`）

`agents/drivers/gbase8c/src/test/java/com/dbx/agent/gbase8c/Gbase8cAgentLiveTest.java` 对附录 B 建起来的真机实例跑通过（2026-10-16），是本功能唯一的端到端证据。跑法：把 `gbase8c-jdbc-3.0.0B02.jar` 放进 `agents/drivers/gbase8c/libs/`（被 `agents/.gitignore` 的 `**/libs/*.jar` 忽略），设 `DBX_TEST_GBASE8C_URL` / `_USER` / `_PASSWORD`（可选 `_SCHEMA`、`_DATABASE`）后 `./gradlew :gbase8c:test --tests '*Gbase8cAgentLiveTest*'`；环境变量缺失时整个用例被跳过。

| 断言 | 结果 |
|---|---|
| 用 `jdbc:gbase8c://…` + `com.gbase8c.Driver` 连上（走 `GBASE8C_PROFILE` 的 URL 模板） | ✅ |
| `listDatabases()` 返回**多个**库且含 `postgres`（覆写生效：驱动的 `getCatalogs()` 只给 1 行） | ✅ |
| `listSchemas()` 过滤掉 `dbe_perf` / `cstore` / `db4ai` / `sqladvisor` / `pkg_service` / `snapshot` | ✅ |
| `listTables(schema)` 的表类型 ⊆ `{TABLE, VIEW}`，无 `gs_` / `sql_` 前缀的系统对象 | ✅ |
| 表注释经 `REMARKS` 返回 | ✅ |
| `getColumns()` 报出主键列（`getIs_primary_key()`） | ✅ |
| `listIndexes()` 列出主键索引与它的列 | ✅ |
| `listForeignKeys()` 解出 `ref_table` | ✅ |
| `setSchemaSQL()` = `SET search_path TO "public"`，`getIdentifierQuote()` = `"` | ✅ |
| `executeQuery()` 返回列名与 2 行数据 | ✅ |
| `listObjects()` 列出新建的表 | ✅ |
| `executeTransaction()` 三条 DML 一次提交：`UPDATE` 1 行 + `DELETE` 0 行 + `INSERT` 1 行 → `getAffected_rows() == 2`，回读 `SELECT count(*)` == 1 | ✅ |

`tableDataEdit` 的证据是最后一行（数据网格的保存走 `executeTransaction` → `Statement.executeUpdate` + 显式提交）。`schemaSearch` 的证据见下。

### `schemaSearch` 的证据

结构搜索的 SQL 由 Rust 侧的 `postgres_family_structure_search_sql`（`crates/dbx-sql-data/src/database_structure_search_sql.rs:179-222`）生成，Java 测试拿不到它，因此把生成的字符串按 `schema=None` / `schema='public'`、`term='probe'`、`limit=200` 复刻后用容器内 `gsql` 对同一实例执行，两种过滤都返回同样的两行：

| object_schema | object_name | column_name | column_comment | table_comment |
|---|---|---|---|---|
| public | g8c_search_probe | probe_col_abc | probe column comment | |
| public | g8c_search_probe | | | probe table comment |

即该查询只用 `pg_attribute` / `pg_class` / `pg_namespace` / `pg_description`，不碰 `JOIN LATERAL` 与 `to_regclass`，在 8c 内核上可用（字段命中与表注释命中两个分支都命中）。

**冒烟发现的既有特性（不是本功能的缺陷，已写进用例注释）**：厂商驱动的 `getIndexInfo` 把主键索引报成普通唯一索引（`is_primary=false`、`constraint_backed=false`），与 `getPrimaryKeys` 的 `PK_NAME` 对不上；主键本身由 `getColumns()` 的 `is_primary_key` 正确报告。`StandardJdbcMetadata` 对所有 `ConfiguredJdbcAgent` 驱动共用这条路径，所以不是 GBase 8c 特有，修它属于另一个改动。

### 「数据库」是必填项（真机实测）

Agent 用 `jdbc:gbase8c://{host}:{port}/{database}` 拼 URL。库名留空时 URL 退化成 `jdbc:gbase8c://host:port/`，实测厂商驱动会拿**用户名**当库名去连：

| URL | 结果 |
|---|---|
| `jdbc:gbase8c://127.0.0.1:15432/dbx_pg` | 连上，`current_database=dbx_pg`、`current_schema=public` |
| `jdbc:gbase8c://127.0.0.1:15432/` | `FATAL: database "dbx" does not exist`（驱动拿用户名当库名） |
| `jdbc:gbase8c://127.0.0.1:15432` | `No suitable driver found`（URL 必须在 host/port 后带 `/`） |

因此前端把 GBase 8c 并入「库名必填」一族（与 `kingbase` / `xugu` 同列）：占位文案走 `connection.databasePlaceholderRequired`，提交校验走 `hasGbase8cConnectionDatabase`（`apps/desktop/src/lib/connection/gbase8cDatabase.ts`，配套 `apps/desktop/src/lib/__tests__/connection/gbase8cDatabase.spec.ts`）。填了完整 `connection_string` 时不要求库名——`JdbcAgentProfile.buildUrl` 在它非空时原样使用。

### 本地 dev 驱动包与发布包不一样（本次验证的重要前提）

`agents/drivers/gbase8c/build.gradle` 用 `fileTree(dir: 'libs', include: ['*.jar'])` 收集依赖，而 `agents/.gitignore:1` 的 `**/libs/*.jar` 只允许厂商 jar 存在于本地。于是：

- **本地**：`libs/gbase8c-jdbc-3.0.0B02.jar` 在 → Gradle 打出的 `dbx-agent-gbase8c.jar` **内含** `com/gbase8c/Driver.class`（本次实测该包 1699797 B，内部确认有 `com/gbase8c/**`），驱动管理装的就是它，所以本机连接不再需要填 jar；跑 `Gbase8cAgentLiveTest` 也依赖这个 jar 在 `libs/` 里。
- **发布**：CI 从干净检出构建，`libs/` 为空 → 包内没有厂商驱动，`Agent-External-Driver: true` 对应的 `external_driver_required: true` 才是真的，用户必须自备 jar。

这个差异本身是设计允许的（同一份源码在两种环境下各取所需），但**在带着 `libs/` 的机器上跑 `release:agents`，会打出一个内含厂商 jar 却声明「需要外部驱动」的包**，等于在没有再分发许可的情况下分发了该 jar。`agents/scripts/validate_agents.py` 目前没有这条检查（全仓唯一相关断言是 `agents/drivers/transwarp/src/test/java/com/dbx/agent/transwarp/TranswarpAgentTest.java:179` 的 `assertFalse(...)`，方向正好相反）。建议在发布流程里补一条「声明外部驱动的模块，其 shadow jar 不得包含该驱动类」的校验；本 spec 不含这项改动。

## 附录 B：临时验证实例的构建方式

不提交为 `deploy/database/` 菜谱，仅作本地验证。完整步骤：

1. 取包：`https://www.gbase.cn/download/gbase-8c?category=INSTALL_PACKAGE`（需登录）→ `GBase8cV6_S1.0.0B20_centos7.8_x86_64.tar.gz`（306043750 B，sha256 `7C69D7446D0E8EB9B60F188F1532C2DB826865447BCE4C1650CF5537DF2CAFCB`）
2. 解包：内含 `…_CentOS_x86_64.tar.bz2`（server 树，1559 项）、`…_om.tar.gz`（OM 工具）、`upgrade_sql.tar.gz`
3. 基座：`docker run -d --name dbx-gbase8c-test -p 15432:5432 centos:7.9.2009 sleep infinity`
4. 依赖：把 `CentOS-*.repo` 移走，写 vault 源（`http://vault.centos.org/7.9.2009/os/x86_64/` + `/updates/x86_64/`，`gpgcheck=0`），装 `libaio-0.3.109-13.el7`
5. 安装：建非 root 用户 `gbase`，server 树放 `/opt/gbase`，`sh simpleInstall/install.sh -w '<强密码>'`（stdin 喂 `no` 跳过 demo 库；注意答 `no` 时脚本退出码为 1 但安装成功）
6. 远端接入：`postgresql.conf` 改 `listen_addresses = '*'`、`password_encryption_type = 1`（或 2），`pg_hba.conf` 追加 `host all all 0.0.0.0/0 sha256`，`gs_ctl stop/start -Z single_node`
7. 非初始用户：`CREATE USER dbx WITH PASSWORD '…'; ALTER USER dbx SYSADMIN;` —— **初始用户不能远端连接**
8. 客户端：厂商驱动 `GBase-JDBC-x86_64.zip`（796565 B，页面无需登录）→ `gbase8c-jdbc-3.0.0B02.jar`（842978 B）

已知非致命噪音：`[Alarm Module]` 系列、`failed to open feature control file … gbased.version`、`could not create any HA TCP/IP sockets`、`Failed to obtain environment value $GAUSSLOG!`、`ERROR: gtm proxy: ProxyEventListener: socket broken!`（单节点无 GTM，连 `localhost:6666` 失败属预期）。

工具的坑：`gs_guc` 的 `-Z` 只接受 `coordinator`/`datanode`/`gtm`（`single_node` 会报 `unrecognized node type`），因此单节点下直接编辑 `postgresql.conf`/`pg_hba.conf`；`gs_ctl restart` 在本环境不可靠（报 `stopped waiting` + `could not start server`），改用 `stop` → sleep → `start`。

## 决策日志

| 日期 | 决策 | 变更原因 |
|---|---|---|
| 2026-10-16 | 运行时路线从「原生 Rust 复用 `PoolKind::Postgres`」改为「新 dbType + agent + 厂商 JDBC」 | 用户指出保持与官方一致的兼容性的唯一方式是使用官方发布的 JDBC；实测证实厂商 jar 拒绝 `jdbc:postgresql://` |
| 2026-10-16 | 基类从 `PostgresLikeAgent` 改为 `ConfiguredJdbcAgent` | 真机实测 `JOIN LATERAL` 不支持、`to_regclass` 不存在，打死三条热路径与视图源码 |
| 2026-10-16 | `tableStructureEdit` 保持关闭 | DDL 必须随 `DBCOMPATIBILITY` 变化，模式建库时固定且不可 SQL 修改 |
| 2026-10-16 | 兼容模式只做标识符引号一层 | 实测四种模式的 `getIdentifierQuoteString()` 全是双引号，B 模式必须靠 `datcompatibility` 才能拿到反引号 |
| 2026-10-16 | 兼容模式**不改共享代码**（原计划给 `isPostgresCompatibleJdbc` 加 `gbase8c`） | 实测四种兼容模式下反引号**全部报错**、双引号全部可用，驱动的默认回答就是双引号；原计划会让 B 模式输出反引号从而弄坏查询 |
| 2026-10-16 | `resultValueReader` **不覆写**（原列为建议项） | 实测 `getString` 对 `raw`/`json`/`inet`/`uuid`/`blob`/`clob`/`_int4`/`_text` 全部可用，多一条路径只增加未测分支 |
| 2026-10-16 | 厂商 jar 走 `Agent-External-Driver: true` | jar 内只有 BSD-2/PostgreSQL License 文本，厂商未声明再分发权，Maven Central 无 `cn.gbase` 坐标 |
| 2026-10-16 | `driverStoreOrder` 取 **55** 而不是 17 | `driverStoreOrder` 与可见 profile 的 `storeOrder` 共用一个唯一序列，实测 1–54 全被占用（gbase 15、gbase8s profile 16、access 17…iris 42、duckdb/mq/sqlserver/sqlite/etcd 43–49…oracle 54）；README 要求这些值「stable」，所以新条目取下一个空位而不是重排既有 40 项 |
| 2026-10-16 | `agent_connection.rs` 的三段 postgres-like 分支**不**纳入 `Gbase8c` | 只加 `:106/:122` 会在 `:555-561` 的 scheme `match` 撞 `unreachable!()`；两处都加则 Rust 自己拼 URL，与「Java profile 拼 `jdbc:gbase8c://`」冲突。兜底臂返回空 `connection_string`，正是 Java 侧期望的输入 |
| 2026-10-16 | `needs_legacy_postgres_like_database_probe` **不**纳入 `Gbase8c` | 该探测给「旧记录/被清空的 database」在 `postgres` 不存在时回退 `template1`；实测实例有 `postgres`，且本类型没有 legacy 记录，纳入只会给每次空库连接加一次探测 |
| 2026-10-16 | 前端两张 `Record<DatabaseType, …>` 矩阵给 `gbase8c` 填 `deferred` | `databaseNamespaceCreation` 的理由是 `databaseCreate: false` 且建库要显式 `DBCOMPATIBILITY`（建库时固定、不可 SQL 修改）；`databasePropertyEditing` 的理由是库/模式注释编辑尚未实测。两条都与父 `gbase` 条目的保守处理一致 |
| 2026-10-16 | 不改 `schema/mod.rs:7765` / `:9942` / `:11083` | 分别是「agent 元数据缺失时是否回退原生 PG 池」「序列是否走 agent 的 `relkind='S'` 查询」「自定义类型详情」，都需要针对本类型单独实测，注释本身也说明它们不是「PG 家族一律纳入」 |
| 2026-10-16 | 补 `apps/desktop/src/lib/connection/driver-category-definitions.ts` 的 `gbase8c: "domestic"` | `/code-review` 之后的 `pnpm test` 抓到：`driverCategoryDefinitions.spec.ts` 的「covers every driver the store can list」是从 manifest 派生的 store-visible agent key 全集，漏一个键会让驱动商店把该驱动渲染成未分组（注释里写着 `oracle-oci` 就这么漏过一次） |
| 2026-10-16 | 补 `docs/lib/agentRegistry.ts` 的 `driverLabels` 与 `.github/scripts/{label-pull-request,database-issue-catalog}.mjs` 的别名 | code review 发现：文档的驱动表会退回 `key.replace(/-/g, " ")` 显示裸 `gbase8c`，PR 也拿不到 `database: gbase` 标签 |
| 2026-10-16 | `schemaSearch` / `tableDataEdit` 从「声明但未实测」补成有证据 | code review 指出这两项与「只声明实测通过的项」冲突：`tableDataEdit` 由 `Gbase8cAgentLiveTest` 新增的 `executeTransaction()` 断言补齐，`schemaSearch` 用容器内 `gsql` 原样执行 `postgres_family_structure_search_sql` 生成的 SQL 补齐 |
| 2026-10-16 | 前端「数据库」对 GBase 8c 由选填改为必填 | 试用反馈：界面显示「可选」，但库名留空时 URL 退化成 `jdbc:gbase8c://host:port/`，厂商驱动拿用户名当库名去连，报 `FATAL: database "dbx" does not exist`。改为与 `kingbase`/`xugu` 相同的处理：占位走 `databasePlaceholderRequired`，提交校验走新模块 `apps/desktop/src/lib/connection/gbase8cDatabase.ts`（带 spec） |
| 2026-10-16 | 驱动提示文案改为点名「手动 classpath」开关 | 原文案写「在『驱动 JAR』里指向 …」，但该区块里真正要打开的是默认收起的「手动 classpath」开关，试用时按原文案找不到入口 |
