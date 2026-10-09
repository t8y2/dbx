# OceanBase Oracle 非表对象迁移读源

关联 #11466。开发完成，待统一验收。以下缺陷由生产路径静态核对确认，尚未通过真实数据库复现或测试运行验收。

原迁移入口 `transfer_oracle_schema_objects` 直接执行 GET_DDL；源码编辑器调用 `get_object_source_core`，Agent 已具备字典优先/回退。两者读取能力不同。原迁移也没有拒绝空字符串源码。

## 当前修改

OB 来源在原依赖顺序和目标存在检查之后，改用源码编辑器的生产读源入口，覆盖既有 VIEW、MATERIALIZED_VIEW、PROCEDURE、FUNCTION、TRIGGER、SEQUENCE。没有新增包、类型或同义词选择，没有给物化视图编造字典回退。原生 Oracle/Dameng 保持原分支。

已启用的跨数据库类型迁移目前仅允许 SEQUENCE，其 OB 读源也经过相同入口，之后保留原有目标方言转换。没有开放原先禁止的跨类型视图或程序迁移。

- VIEW 字典返回 SELECT 正文时，读取实际列名，保留显式视图列别名，并复用视图 DDL 终止处理。
- 声明类型、对象名、属主不符或源码为空明确失败。目标属主总是限定，不依赖当前会话创建到正确 schema。
- Oracle tokenizer 的源位置只替换声明和源 schema 限定符，保留字符串、注释、q-quote 和 PL/SQL 正文。动态 SQL 字符串内的 owner 不替换。
- TRIGGER 读取复用 O08 完整触发器 helper，补齐表属主和启停状态。元数据不完整时拒绝返回片段；源码编辑器及迁移得到相同完整源码。此路径要求 ALL_SOURCE/GET_DDL 之外还可读取该触发器的 ALL_TRIGGERS 状态。
- 使用已有 Oracle 分句器执行多语句脚本，触发器 CREATE 与状态恢复分开执行。后续步骤失败时报告已完成 DDL 数量，不计为迁移成功，也不声称自动回滚。

PUBLIC/__public 及 synonymSource 规范归 E05b。本票不修改 OceanBaseOracleAgent.queryObjects 或 OceanBaseSchemaObjects.java。

## 已写、未运行的行为用例

Core 生产迁移入口使用 RPC fixture，令原始 GET_DDL 明确失败、get_object_source 可读，覆盖六类对象及依赖顺序、视图别名、触发器状态、空源码/权限错误/部分执行失败和原生 Oracle 路由。纯源码用例覆盖 quoted owner、嵌入引号、q-quote、声明不符及拆分后的状态语句。Agent 用例覆盖不依赖 GET_DDL 的触发器完整源码及启停状态。

只完成 Rust 格式/语法、Python AST、两份生产 Java 的局部 javac、diff 检查。未运行定向/全量测试、类型检查、完整构建、双审、CI、GUI 或实库。

## 统一验收要求

使用同一账号、实例版本和隔离对象对照编辑器与迁移。构造 GET_DDL 不可用而字典可读的条件，再迁入专用目标 schema，逐类核对完整定义、名称、权限和有效状态。验证缺失、无权限、未知版本 MV、同名目标跳过、失败后继续及取消。原生 Oracle 单独回归，真实传输 GUI 和错误恢复仍待确认。

RPC fixture 是待运行的受控用例，不能代替真实数据库权限及版本能力证明。
