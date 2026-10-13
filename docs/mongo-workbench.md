# Mongo 工作台

入口：工具栏更多菜单，以及 Mongo 数据库/集合右键菜单。保留 DBX 原主题和连接管理。

## 对比与手动同步

详见 [mongo-compare.md](mongo-compare.md)。支持跨连接、匹配键、忽略字段、字段级差异、双向手动同步、保存配置和多集合汇总。
部分读取、缺失匹配键和重复键禁止同步。同步前重新核对两侧，更新/删除使用目标完整快照条件；不是跨数据库事务。并发写入或网络失败后应重新对比。

## 聚合与代码生成

- 阶段添加、删除、排序、禁用、JSON 编辑、逐阶段只读预览。
- 管道 JSON 导入/导出（文件最多 2 MiB），mongosh、Node.js、Python、Java、C# 代码导出。
- 预览最多 10,000 文档，60 秒服务端时间限制。预览始终移除最终 $out/$merge。
- 写入重新执行完整管道而非预览样本；所有环境都须人工确认完整命令，生产库再确认，未解锁只读连接拒绝写入。跨库输出检查源库和目标库。
- JS EJSON 解码使用 relaxed:false，不把 BSON Int64 静默转为不精确的 JS Number。生成代码需要安装对应语言的 MongoDB 驱动。

## 集合结构分析

按 _id 顺序读取受上限约束的样本，统计根文档存在/缺失次数、数组元素出现次数、BSON 类型和示例，支持字段筛选与 JSON 导出。
最多 100,000 文档、64 MiB 输入、10,000 路径、32 层路径；明确标识截断和分析上限。统计仅代表样本，不是结构约束推断或随机抽样。

## 数据脱敏与文档重塑

按顺序执行遮盖、HMAC-SHA256 哈希、移除、JSON 替换、字段复制/移动。点路径支持嵌套结构，items.*.email 支持数组；不修改 _id，不穿透 BSON 标量。移除数组元素置为 null，不静默移动索引。
密钥至少 16 字符，仅保留于当前对话框内存，不写配置或导出。哈希不等于不可逆匿名化，应选用随机强密钥；未配置规则的字段保持原样。
预览两侧结果，可导出 EJSON。目标必须是不同集合，仅追加保留 _id 的文档，不覆盖已有 ID；写前重新核对源快照和目标缺失状态。截断输入拒绝复制，失败保留已执行部分，不自动重试或回滚。

## Mongo SQL 查询

支持明确子集：SELECT 字段/别名或单集合 *；等值 INNER/LEFT JOIN；WHERE 比较、IN、IS NULL、AND/OR；GROUP BY；COUNT/SUM/AVG/MIN/MAX；ORDER BY；LIMIT/OFFSET。
编译后展示管道，再执行只读 aggregate。不接受多语句、写入、DISTINCT/ALL、任意函数、算术、子查询、HAVING、UNION、RIGHT/FULL JOIN 或包含字面点号的字段名。
JOIN 字段需带别名，缺失值在条件中按 NULL 处理。COUNT 空输入为 0，SUM 空/全 NULL 为 NULL。数组、混合类型、排序和聚合数值行为仍遵循 MongoDB，而非某个 SQL 方言的完整语义。超出 JS 安全整数范围的数值常量拒绝翻译。

## JavaScript 工作台

支持 JavaScript 变量、函数、循环、顶层 await、async 迭代和脚本文件导入/保存。数据库桥接 API：find/findOne、aggregate、countDocuments、insertOne/Many、updateOne/Many、replaceOne、deleteOne/Many。
使用 await db.getCollection("items").find({}).limit(100).toArray()；find 支持 skip/sort，聚合分页用 $skip/$sort 阶段。默认读上限 100、最大 10,000，非无限服务器游标。
数据使用 canonical Extended JSON，提供 ObjectId/ISODate/NumberLong 辅助函数；不是完整 mongosh/IntelliShell，不提供模块、文件、网络和任意 runCommand。每个写操作显示实际命令并单独确认。
find 仅支持 0/1/布尔投影与 ±1 排序，高级表达式请改用 aggregate；拒绝 $where/$near 等与该只读聚合实现不兼容的筛选。桥接拒绝 Date/RegExp/Map/Set、undefined、稀疏数组、访问器、循环引用和不安全数值，避免静默丢数据；使用对应 EJSON 包装。写入返回原始 canonical 命令响应，而不是 mongosh 的 InsertOneResult 等对象。
脚本置于 opaque-origin iframe 的可终止 worker，CSP 禁止外部网络。120 秒超时、1,000 次数据库调用、1 MiB 日志、64 MiB 累计返回结果。取消停止后续调用，已经发送的写入可能仍已生效。
scripts/mongo-script-browser-smoke.cjs 提供无数据库的隔离验证页面，可检查 RPC、网络/DOM/存储隔离及无限循环超时。浏览器验证不能替代桌面 WebView 验证。

## 验证与边界

SQL ↔ Mongo 迁移详见 [mongo-migration.md](mongo-migration.md)，任务调度详见 [mongo-tasks.md](mongo-tasks.md)。分别为有上限的追加迁移和需进程运行的只读顺序任务，不是完整关系迁移平台或常驻系统服务。

聚合、对比筛选、替换值和任务 JSON 输入拒绝不安全整数、无限值及负零；精确大整数/十进制值请使用 canonical $numberLong/$numberDecimal 字符串包装，普通小数按 JavaScript binary64 处理。

开发验证入口：`scripts/verify-mongo-workbench.ps1`，可加 `-Full` 运行定向 Vitest 和生产构建，或加 `-Native` 运行 Rust 驱动及任务单元测试。需要事先安装相应工具链。

`node scripts/mongo-workbench-smoke.cjs` 运行无子进程、网络或数据库的快速检查；它不替代 Vitest、真实 MongoDB 集成或桌面验证。临时验证输出位于项目的 `tmp/mongo-workbench`。
