# OceanBase Oracle 索引类型核对（V03 / #11467）

## 当前状态

2026-10-09：生产代码及行为用例已编写，仅完成 Rust、Vue/TypeScript 语法解析。尚未执行测试、编译、类型检查、双审、V03 实库、GUI 或 CI；没有推送。此记录不代表引擎验收通过。

目标是此前 O01 使用的 OceanBase Oracle 4.2.5.7 / Connector/J 2.4.18。该版本身份尚未由 V03 重新实测。

## 文档依据与能力范围

依据 OceanBase 官方文档仓库 V4.2.5，固定提交 `ca366482741983979515ba234f41498ccf76fdee`：

- [CREATE INDEX](https://github.com/oceanbase/oceanbase-doc/blob/ca366482741983979515ba234f41498ccf76fdee/en-US/700.reference/500.sql-reference/100.sql-syntax/300.common-tenant-of-oracle-mode/900.sql-statement-of-oracle-mode/100.ddl-of-oracle-mode/1600.create-index-of-oracle-mode.md) 规定仅支持 USING BTREE，可指定 UNIQUE；键可以是列或表达式，不支持降序及布尔表达式。具体函数另有限制。
- [ALL_IND_EXPRESSIONS](https://github.com/oceanbase/oceanbase-doc/blob/ca366482741983979515ba234f41498ccf76fdee/en-US/700.reference/700.system-views/500.system-view-of-oracle-mode/200.dictionary-view-of-oracle-mode/1300.all_ind_expressions-of-oracle-mode.md) 提供索引、表的 owner/name、键位置及表达式。

| 选项 | V4.2.5 文档结论 | 编辑器处理 | V03 实库证据 |
| --- | --- | --- | --- |
| NORMAL | 支持 B-tree 普通索引 | 保留 | 待执行 |
| UNIQUE | 支持，属于独立属性 | 保留复选框 | 待执行 |
| FUNCTION-BASED NORMAL | 支持受限函数及表达式 | 4.2.5 版本范围开放逐项 SQL 表达式输入 | 待执行 |
| BITMAP | 不在仅支持 B-tree 的范围内 | 前端不提供，后端拒绝整批计划 | 待执行否定探针 |
| DOMAIN / FUNCTION-BASED DOMAIN / CLUSTER | 无对应 CREATE INDEX 能力 | 前端不提供，后端拒绝整批计划 | 待执行否定探针 |
| 版本缺失或其他版本 | 尚未核实 | 普通、唯一索引保持可用，高级类型暂不开放 | 不记为引擎不支持 |
| 字典权限不足或查询失败 | 元数据未取得 | 保留错误，不回退为空索引或“不支持” | 待执行权限矩阵 |

## 已修复的代码路径

OB 的 Oracle 方言映射原先暴露 BITMAP、DOMAIN 等选项，后端可能生成 BITMAP 或把其他类型静默降为普通索引。函数表达式原先又被当作物理列名引用。本次只针对 `oceanbase-oracle` 增加前后端一致的版本及类型检查，原生 Oracle 选项和 SQL 生成分支保留。

`databaseVersion` 随现有 Web/Tauri options 传入 SQL builder；未识别版本给出“未核实”错误。新建表、分区建表和结构修改共用后端检查，拒绝时不生成部分 DDL。未修改的服务器索引不会阻断无关编辑，显式删除沿用现有路径。

函数索引每个键使用一个独立输入框，可整体上下移动。含逗号或换行的表达式不拆分；普通列转入函数模式时保留双引号及顺序。只有全部项仍为已知物理列的精确引用，或清空表达式后，才允许切回 NORMAL。

后端解析单个完整表达式，拒绝多语句、额外键和无法解析的语法，不把解析器限制记为引擎不支持。生成时原文保留，并用换行隔开末尾行注释。具体函数是否可建索引、生成列限制及执行权限仍由服务器裁定；不承诺所有 Oracle 表达式均可通过本编辑器。

Agent 按 owner、索引名、表名和键位置连接 ALL_IND_EXPRESSIONS，函数键按 SQL 文本回读，复合键中的物理列变为精确 quoted SQL 项并标记原始 SQL 来源。函数索引缺少全部表达式时报告元数据不完整，不展示为可编辑的 SYS_NC 隐藏列。普通索引列名保持原格式。

## 统一验收待办

1. 执行新增 Rust、Vue/TypeScript、Java 用例及相关回归，完成类型检查与构建。用例覆盖版本未知、非法类型整批拒绝、表达式边界、quoted 名称、复合键顺序、原生 Oracle BITMAP、字典缺失与权限错误。
2. 对精确提交进行 Standards / Spec 双审；确认 Java 与前端索引元数据契约一致。
3. 在专用 4.2.5.7 对象上通过生产 Agent 做普通、唯一、函数索引的预览、执行、字典回读。覆盖 LOWER、带逗号函数、混合 quoted 列、唯一冲突、函数限制、无 INDEX 权限和字典访问失败。
4. 执行 BITMAP、DOMAIN、FUNCTION-BASED DOMAIN、CLUSTER 否定探针，保存真实错误；版本未知、权限失败和引擎不支持分开记。
5. GUI 核对选项、顺序调整、表达式保留、错误与刷新；原生 Oracle 回归。精确清理本票对象并读回确认。
6. 验收完成后记录提交 SHA、实库版本、GUI 证据及 CI 链接，再按整体队列安排推送/PR。
