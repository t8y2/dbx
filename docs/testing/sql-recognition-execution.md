# SQL 识别与执行回归

当前整合基线：`becccf108f2a91c99e16d8e4951dd15dd0369492`。初始复现基线为 `da281de1d147fac2d9242b44384c5cde370c3600`。范围为 SQL 识别、手工事务提交、JDBC 批量超时与取消、Oracle/OB Oracle 脚本切分。未包含对象管理、LOB 或过程多结果功能。

## 与上游实现的比较

- #11849 已补齐复合触发器和存储例程声明区的嵌套子程序。采用上游限定在触发器头部的识别方式，删除本 PR 扫描整个 token 集合的重复分支；保留 Oracle/OB Oracle、独占行 `/`、后续 ALTER/CREATE 的回归用例。原复合触发器用例已在当前 main 上通过。
- #11951 已在公共 Oracle 方言配置中关闭反斜杠转义，删除本 PR 的 OB 重复配置。光标选句使用的 SqlScanner 仍需读取该配置，不能只保留配置而撤销入口修复；新增 Oracle 系空行选句用例，当前 main 失败、候选通过。
- 当前 main 仍无法通过 nq、跨块 q/nq、OB 专属引号、DBLink、重复提交、Rust RPC 超时、JDBC 批量取消/回滚以及 Transwarp 取消回归。保留这些增量。
- main 新增关闭后重开标签的能力。补测同一标签 ID 对应新对象时，旧提交成功或失败均不清除新事务，且新事务仍独立去重。复用现有 Store 流程，不增加新的交互。

## 1. DBLink 被误识别为参数

Oracle 和 OceanBase Oracle 的以下脚本中，参数识别把 `LINK` 加入参数列表；同名 `@set` 还可能替换对象链接。

```sql
SELECT seq.NEXTVAL@LINK, @value FROM dual;
CREATE SYNONYM local_t FOR app.remote_t@LINK;
MERGE INTO local_t t USING app.remote_t@LINK s
ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.v=@value;
```

复现：将单条脚本交给 `extractSqlParameters`，数据库类型选择 `oracle` 或 `oceanbase-oracle`。SELECT、MERGE 预期只返回 `value`，同义词语句预期无参数；基线实际多返回 `LINK`。在脚本前声明 `@set LINK = wrong;`，检查展开结果仍保留链接。MERGE 同时覆盖匿名块中的第一条语句。

验收：远程序列、同义词目标、MERGE 来源保留 `@LINK`；真正参数正常识别和替换；已有普通 FROM、表达式和其他方言用例通过。复用共享 `sqlDatabaseLinks.ts`，同时覆盖参数替换和变量展开。

## 2. 同一事务重复提交

复现：建立 Oracle/OB Oracle 手工事务，使后端提交 Promise 暂不完成，连续调用真实 store 的 `commitTransaction` 两次。基线调用后端两次，第二次可能报事务不存在。

验收：同一标签、同一事务只发出一次后端请求，所有调用者收到相同成功或失败结果；切换连接、库、schema、关闭标签或关闭后重开同 ID 标签后的迟到结果不清除新事务；同步异常后仍可提交下一事务。实际工具栏连点验收单独记录。

## 3. 批量失败、超时或取消后继续执行

复现：通过 `JsonRpcServer.dispatchForRuntime("execute_batch", ...)` 传入两条写入和 `timeoutSecs`。JDBC 边界记录 Statement 超时与取消；第一条阻塞时取消，再放行第一条。基线不设置指定超时、未追踪活动 Statement，fallback 可能继续第二条。OceanBase Connector/J 还允许 `continueBatchOnError=true` 导致失败后继续。

此外，Rust `AgentDriverClient` 的四个批量/事务入口未把超时放入 RPC 参数。使用真实客户端连接返回收到参数的测试 Agent，指定 7 秒后，基线收到的 `timeoutSecs` 为 NULL；修复后为 7，后续无超时请求为 0。

实库复现步骤：在隔离表准备两行，连接 A 锁定第一行；连接 B 执行“更新第一行、更新第二行”的批量并设置短超时。等待失败后用独立连接读回第二行，再释放 A 的锁。另用无效第一条检查错误即停，用取消检查迟到成功不会触发后续项。结束后删除本次创建的隔离对象并读回确认。

验收：RPC 超时传到 Statement；准备和执行阶段的取消被保留；fallback 和事务执行不启动下一条；下一次 RPC 不继承上一次超时/取消；事务回滚未确认时，池连接先驱逐租约再关闭，非池连接直接关闭，不通过恢复 auto-commit 意外提交；OceanBase 连接属性强制失败即停，覆盖 URL 中相反配置。普通批量此前已成功的语句不承诺自动回滚。

连接池回归使用真实 RPC、Hikari 和隔离 H2 表，只在 JDBC 回滚边界注入 `HY000`、`HYT00`、`08006` 异常。第一会话插入后失败，在外层请求清理前让第二会话查询；修复前能读到未提交的一行，修复后读到零行并使用新的物理连接。此用例覆盖 `close()` 归还池连接与外层驱逐之间的窗口。

共享 RPC 的 Transwarp 自定义事务另有回归：通过真实 `execute_transaction` dispatch 检查指定超时，在 `BEGIN TRANSACTION` 或首条写入阻塞期间取消，迟到成功后不得继续写入或 COMMIT，应尝试 ROLLBACK。使用 JDBC 边界夹具，修复前超时与取消两项失败，修复后通过，下一请求不继承取消状态。Transwarp 实库尚未验收。

## 4. Oracle/OB Oracle 脚本切分错误

复现：将以下文本交给 `split_sql_statements_for_database`，基线会把字符串里的 `DELETE` 当成独立语句。

```sql
UPDATE events SET name = nq'{it's; DELETE FROM events; --}';
SELECT 1 FROM dual;
```

复合触发器历史复现：一个 `COMPOUND TRIGGER` 包含 `BEFORE STATEMENT` 和 `AFTER EACH ROW` 两个区段，随后以独占一行的 `/` 结束；初始基线把区段分为多条，当前 main 已解决。流式导入将 `q`/`nq` 前缀与引号跨 chunk 切开的缺陷在当前 main 仍可复现。

验收：引号内分号不拆句，复合触发器整体发送；流式导入与光标选句一致；普通多语句正常切分；OB Oracle 不采用 MySQL 反引号和 DELIMITER；其他方言及上游 XML 实体回归保持通过。解析测试不证明目标数据库支持所有触发器语法。

## 自动化命令与证据

```sh
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlDatabaseLinks.spec.ts apps/desktop/src/lib/__tests__/sql/sqlParameters.spec.ts apps/desktop/src/lib/__tests__/sql/sqlVariables.spec.ts apps/desktop/src/stores/__tests__/queryStore.manualTransactionCommit.spec.ts
cargo test -p dbx-sql-core --lib --locked
cargo test -p dbx-driver-agent --lib --locked batch_and_transaction_send_statement_timeout_to_agent
cd agents
./gradlew :common:test :oceanbase-oracle:test :oceanbase-oracle:shadowJar
```

当前 main 的行为复现失败包括 DBLink 10 项、事务并发 6 项、JDBC 批量生命周期 8 项及回滚连接池 1 项、SQL 切分 6 项和另测的光标反斜杠 1 项、Rust 四入口超时传递 1 项、Transwarp 2 项。测试调用生产入口；基线工作树仅加入回归测试及其测试依赖。修复后的定向测试通过，完整验证和实库、GUI、CI 状态以 PR 最新 SHA 的记录为准，未执行不得记为通过。

2026-10-13 使用本次独立构建的 OceanBase Agent，在 OceanBase Oracle 4.2.5.7 / Connector/J 2.4.19 上验证批量与事务的超时、取消四项，以及首条 SQL 失败后不执行下一条。五项通过，独立连接读回两行均未修改；专属临时表已删除并读回不存在。JAR SHA-256 为 `ea92c7cf7c10f872ca25a5f7db19374e1424fa64241493401f702898b74a9f09`。未替换现有运行实例的 Agent。此验证不替代原生 Oracle、Transwarp 实库及桌面 GUI 验收。

## 交付验收清单

- [ ] 本文四类行为回归通过，Core 到 Agent 的超时传递完整。
- [ ] 格式、lint、类型、相关 Rust/Java 测试及生成产物检查通过；基线失败单列证据。
- [ ] OceanBase Oracle 实库完成批量/事务超时及取消，读回后续行与清理结果。
- [ ] 产品工具栏连点、SQL 编辑器参数提示及执行反馈完成 GUI 验收。
- [ ] 原生 Oracle 相关入口完成实库兼容验收，或明确保留具体缺口。
- [ ] 修复 PR 对应的最新 SHA 必需 CI 通过；代码、实库、GUI 和部署状态分别记录。
