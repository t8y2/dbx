# SQL ↔ MongoDB 映射迁移

这是 DBX 风格、可人工审核的小批量迁移工作流，不是 Studio 3T 完整迁移引擎。

## 当前支持

- **SQL → MongoDB**：从 PostgreSQL、MySQL、SQLite 或 SQL Server 的已有表读取有限快照，按字段映射生成嵌套文档，追加到已有 MongoDB 集合。
- **MongoDB → SQL**：用严格 Extended JSON 的 $match 读取 MongoDB 集合，嵌套字段扁平映射到上述 SQL 数据库的已有表。
- 一次最多 **1000 行**；源快照、映射结果和生成命令分别不超过 **8 MiB**。读取上限外多一行以提示“仅为部分数据”，不是全库迁移。
- 源和映射后数据各预览前 50 行，同时显示**全部实际写入命令**。未展示的数据行仍能从全部命令核对；可以导出计划 JSON（含实际数据，应按敏感文件保管）。
- 逐条追加，进度以数据库确认的行数为准。遇到第一条失败即停止，不自动重试。

## 操作流程

1. 打开“SQL ↔ MongoDB 迁移”，选择方向和两侧连接。
2. SQL 侧输入数据库、可选 schema 和已有表名；MongoDB 侧选择已有库/集合。
3. 设置行数上限与逐字段映射。SQL 名称是字面列名（列名中有点不会当作路径）；Mongo 名称用 contact.name 表示嵌套对象。
4. 点击“读取并预览”。此时仅执行读取及目标元数据查询，不写入业务数据。
5. 核对两侧名称、源/结果、部分数据提示、全部命令，勾选人工确认，再点击“确认追加”。生产连接仍触发 DBX 的生产写入确认。
6. 失败或取消后核对已确认行数；结果不明的行必须在目标端人工检查，不能直接重复执行整个计划。

## 类型与精度

### SQL → MongoDB

- 自动类型：普通 SQL 字符串/布尔/安全数字保持原样。BIGINT/int8 转为 BSON Int64；DECIMAL/NUMERIC 从字符串转为 Decimal128。
- 显式类型：字符串、布尔、Int64、Decimal128、ObjectId、BSON 日期、Extended JSON。
- Decimal128 要求字符串输入，最多 34 位有效数字且满足 BSON 指数范围。超范围请映射为字符串，不静默四舍五入。
- 后端把精确 SQL decimal 返回为浮点数时直接拒绝；应先在数据库建立只读转换视图，以文本形式读取后再迁移。
- 超过 JavaScript 安全整数范围的普通数字、截断的长单元格、重复源列名均拒绝。
- EJSON 字段保留 $numberLong、$numberDecimal、$binary、$date 等规范表示。未包裹的 JSON 小数被拒绝，请显式使用 $numberDouble / $numberDecimal 字符串，防止 JSON.parse 丢精度。
- BSON 日期要求显式时区、最多毫秒精度；微秒/纳秒时间请映射为字符串，不截断精度。
- 未映射 _id 时由 MongoDB 生成；映射 _id 会保留源值，重复键按错误停止，不覆盖或 upsert。

### MongoDB → SQL

- 必须有后端返回的 canonical Extended JSON，不退回普通 JSON 猜测 BSON 类型。
- auto：原始标量及精确 BSON 数字；嵌套对象应映射叶字段，或使用 EJSON。
- string：字符串化普通标量、ObjectId、BSON 数字的精确文本。复杂 BSON、日期/二进制必须用 EJSON，不能悄悄降级。
- ejson：把包括 BSON 类型的完整值存入 SQL 文本列，可用于以后反向迁移。BSON null 为文本 null，与缺失字段策略的 SQL NULL 区分。
- 数组默认拒绝；可显式选择 EJSON 文本，或“仅首个元素（有损）”。不自动展开行、不生成子表、不执行 join。选择数组 EJSON + 类型 EJSON 不会双重编码。
- 缺失字段可选择报错、SQL NULL、或省略（由目标默认值处理）。
- 目标支持文本、布尔、整数和精确 NUMERIC/DECIMAL。检查长度、整数范围、precision/scale、可空性；精确小数不会写入 SQLite NUMERIC/REAL 以免浮点丢精度。
- SQL Server 文本目标要求 Unicode NVARCHAR/NCHAR/NTEXT。可检测的 MySQL 非 UTF-8 目标字符集被拒绝。其它服务器配置仍需人工确认。
- 时间/二进制/JSON/浮点等特殊 SQL 目标类型尚不直接写入，请使用兼容文本列和 EJSON 保存类型。

## 安全和边界

- 只生成带 LIMIT / TOP 的 SELECT *，不允许执行用户任意 SQL；SQL 标识符统一引用，文本按数据库方言使用安全编码，不依赖 MySQL 反斜杠模式。
- Mongo 筛选通过严格聚合 $match，不使用会猜测 24 位 _id 字符串或 ISODate 字符串类型的宽松 find 转换。
- 目标有效只读状态在预览、人工确认和**每一行**写入前检查。生产守卫适用于两种方向。预览后目标连接配置发生变化会拒绝继续。
- MySQL schema 必须匹配所选数据库；不支持跨附加 SQLite 数据库，避免生产范围守卫和实际目标不一致。
- Mongo 写入使用单文档 insert command、ordered=true、writeConcern=majority，检查 ok/n/writeErrors/writeConcernError。
- SQL 每行独立 INSERT；无自动建表、覆盖、DELETE、更新、upsert、跨库事务、回滚或断点续传。目标表约束、默认值和触发器仍有效。
- 取消读操作会取消请求并丢弃过期响应。取消写入仅在行间停止；正在执行的一行可能已落库，不能通过客户端取消证明它没有执行。
- 写入失败时保留已确认计数，标记结果不明的行。计划失效，必须重新预览；不会自动重试造成重复数据。
- 快照不加锁，不保证源在预览到确认间不变；写入的是用户审核的快照。读取顺序未定义，不把首次 1000 行声称为可靠的分页迁移。
- 不支持多表关联、数组展开成子表、schema 自动推断建表、索引/外键迁移、增量 CDC、服务器持久调度或大规模流式迁移。

## 验证

- apps/desktop/src/lib/mongo/__tests__/mongoMigration.spec.ts：映射、BSON、精度/截断拒绝、SQL 注入、数组、NULL/缺失、取消、失败/确认检查。
- scripts/mongo-migration-smoke.cjs：供 mongo-workbench-smoke.cjs 注册的进程内检查；包括 Node 内嵌 SQLite **:memory:** 中 Unicode/SQL 特殊字符/Int64 最大值实际 INSERT 往返。
- Vitest 与内存 SQLite smoke 覆盖映射及写入语义。完整跨引擎行为需要使用隔离的 MongoDB 和 SQL 实例验证；不要连接或写入真实用户数据库。

## 入口集成

组件：components/mongo/MongoMigrationDialog.vue；使用 v-model:open，可选 prefillConnectionId、prefillDatabase、prefillCollection。

独立翻译：lib/mongo/mongoMigrationMessages.ts。组件使用局部 i18n composer（继承全局语言），工具栏可复用导出的 mongoMigrationEn.title / mongoMigrationZh.title 或由主 i18n 增加入口标签。此模块不依赖修改主布局和侧栏。
