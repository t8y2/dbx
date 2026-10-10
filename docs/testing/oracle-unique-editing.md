# Oracle 与 OceanBase Oracle UNIQUE 编辑

关联 #11442。分支基于 E02 `38ae63b1fbced3332ce84b776c6f3226fc0db2e9`，复用已存在的会话、表身份、权限与结果结构。没有以 CHECK 票作为技术前置依赖。

## 约束与索引

- 按 `ALL_CONSTRAINTS.CONSTRAINT_TYPE='U'` 和实际名称读取约束，再读取列序及关联索引。不能仅凭某索引为 UNIQUE 就把它当作可编辑的原约束。
- 名称在约束字典中不唯一时拒绝，避免部分版本同名主键/唯一键的元数据歧义。
- 新增、改列、改名及删除都先检查命名、列可见性、重复数据、外键引用、索引身份和共享关系。依赖信息不可读时拒绝，不隐式级联。
- Oracle 默认保留原支持索引；保留的唯一索引仍会限制重复值。用户可明确选择完成后删除原索引，后端检查是否共享并保留完整索引 DDL。
- Oracle 优先复用列序匹配、状态正常、适合约束状态且未被其他约束占用的现有索引；否则先创建普通索引，再删除重建约束。普通索引不把 NOVALIDATE 或可延迟约束错误收紧为立即验证唯一索引。
- Oracle 仅修改启用/验证状态或仅改名时直接生成相应 DDL。停用时保留索引并在页面说明其限制仍可能生效。
- OceanBase 仅在实际 UNIQUE 名称、唯一索引名称和所属表对应，且索引未共享时通过索引 DDL 管理。其约束与索引共同删除，预览明确显示影响，并保存原索引 DDL用于恢复。前后端均不开放未经支持的 UNIQUE 启停、验证、延迟或 Oracle 索引处置选项。
- 复合唯一键预检排除全 NULL 行，但保留部分 NULL 行参与分组，以识别相同非空部分造成的冲突。

## 失败与验证

每次应用都重新预检并核对指纹。执行按步骤记录结果，失败后读取原名/新名约束；只有确认原约束缺失且恢复对象状态可知时才显示恢复语句，不自动恢复或重放。保留/移除原索引的恢复路径分别处理。

已编写约束身份、索引复用、复合列序、NULL 语义、引用/共享/权限不足、重名、部分失败、完整删除及 Oracle/OB 状态限制的后端与页面用例。2026-10-10 的验证记录如下，完整记录见 [PR #11550](https://github.com/t8y2/dbx/pull/11550)：

- 名称门禁的默认栈定向测试 14/14 通过。补充提交 `0de2384327b26bef91dd9a056ca9c7d25fcf5e59` 恢复依赖分支的外键名称门禁与 OceanBase 列权限字典修复，隔离生产源码测试 43 项通过，rustfmt 和差异检查通过。这不代表完整 Core 测试通过。
- 此前的 OceanBase 组合产物已完成真实 GUI 的复合列调整、quoted 名称、重复值与外键阻断、取消、元数据 stale，以及超长名部分失败后的人工恢复。独立读回原 20 项与额外七项，数据和普通索引身份一致；低权限未知依赖与撤销 ALTER 后的旧计划均未发送 DDL。
- 上述真实 GUI 证据对应此前组合产物，不覆盖新名称门禁。新门禁 GUI、独立唯一索引与约束的完整区分、完整 Core 及原生 Oracle 实库验收仍待完成。远端 CI 以当前提交的 Checks 为准。

## 来源与顺序

- [OceanBase 4.2.5 UNIQUE 文档及 NULL 示例](https://github.com/oceanbase/oceanbase-doc/blob/V4.2.5/en-US/700.reference/100.oceanbase-database-concepts/400.database-objects/100.database-objects-of-oracle-mode/800.data-integrity-of-oracle-mode/200.integrity-constraint-type-of-oracle-mode/300.uniqueness-constraint-of-oracle-mode.md)
- [OceanBase 4.2.5 ALTER TABLE](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000001504123)
- [Oracle ALTER TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ALTER-TABLE.html)

用户当前模型约定为 `gpt-6.1-sol / medium`，后续子 Agent 相同。全部代码和用例编写完后，才统一测试、类型检查、编译、双审、实库/GUI、CI、推送及 PR。监控保持暂停。
