# Oracle 与 OceanBase Oracle 外键编辑

关联 #11440。开发基于 #6973/#11439 的共同数据库会话、标识符处理、元数据完整性检查、执行结果结构及界面确认流程。生产入口同时接入 Web 与 Tauri。

## 行为

- 外键名称、源/目标列顺序、目标 schema 与表可编辑；删除动作仅提供 `NO ACTION`、`CASCADE`、`SET NULL`。
- Oracle 支持启用/验证与延迟选项；OceanBase 不提供延迟选项且后端拒绝绕过。已有 RELY 状态保留在读取、指纹与重建定义中。
- 仅改变启用/验证状态时直接变更状态。改变关系定义需要删除重建，预览包含完整 DDL、影响对象与原定义；不宣称多条 DDL 原子提交。
- 执行前重新读取源定义、目标主键/唯一约束及列序、表修订、列类型、授权与数据。引用键必须可见、已启用且不可延迟。
- 检查源表 ALTER 权限，以及跨 schema 目标表或逐列直接 REFERENCES 授权；无法确认时拒绝。列类型或字符集不一致时保守拒绝，提示不能确认兼容性，不用隐式转换猜测 DDL 是否可用。
- `VALIDATE` 预检按复合外键语义排除任一分量为 NULL 的行，再查无父行记录。`NOVALIDATE` 不把历史孤儿行误判为必须拒绝。
- 失败后读回原名与目标名对应的实际约束，保留错误及逐条结果。仅确认原约束与目标约束均不存在时显示重建原约束的恢复 SQL。任何执行后均需重新预览。
- 页面取消预览不执行 DDL；成功与部分失败均刷新元数据/DDL；仅全部成功才发出保存成功事件。

## 来源

- [Oracle ALTER TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ALTER-TABLE.html)
- [Oracle constraint](https://docs.oracle.com/en/database/oracle/oracle-database/18/sqlrf/constraint.html)
- [OceanBase ALTER TABLE 4.2.5](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000001504123)
- [OceanBase CREATE TABLE 4.3.0](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000000643870)

文档语法不是目标版本的实测证明；目标 OceanBase 4.2.5 的状态选项仍需统一实库验收。

## 验证状态与执行约定

生产代码与行为用例正在按队列开发；语法解析通过不代表测试或类型检查通过。待队列全部开发完成后，统一执行行为测试、编译、类型检查、独立双审、Oracle/OB 隔离实库与真实 GUI、CI、推送和 PR。

用例覆盖复合及 quoted 名称、跨 schema 与自引用、目标键/授权不可用、历史违规数据、NULL 语义、部分失败恢复、预览过期、取消及状态修改。所有新增用例尚未运行；真实环境仍需覆盖交叉引用与各目标版本差异。

用户当前模型约定：`gpt-6.1-sol / medium`，后续子 Agent 同样采用该配置；此前 Astra 设置不再适用。监控保持暂停。
