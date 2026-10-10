# OceanBase Oracle 表结构克隆

关联 #11430。当前状态为开发完成，待统一验收。

OB 克隆使用列元数据生成 CREATE TABLE，并依次创建有序主键、NORMAL 索引和表列注释。普通索引方向读取 SYS.ALL_IND_COLUMNS.DESCEND。原生 Oracle 的现有克隆分支不变。

对象列表和侧栏均支持目标 schema 输入。执行前确认框显示精确目标、复制内容、排除的外键、触发器、特殊索引及约束名称，并说明分区、物理属性不复制。默认表达式保留原文，可能继续依赖源序列或函数。索引使用目标派生的新名称，主键由服务器命名；不沿用源对象名。

所有元数据和目标重名检查完成后才进入确认与生产执行保护。DDL 逐条执行，失败即停止，显示成功步骤及失败 SQL。只有 CREATE 已确认成功时才提供人工删除克隆的恢复 SQL；未确认创建时要求先检查数据库，不建议删除现有对象。没有自动回滚或自动清理。

## 已编写、未运行的行为用例

`apps/desktop/src/lib/__tests__/database/oceanbaseTableClone.spec.ts` 覆盖列 BYTE/CHAR 和 NUMBER 负 scale 的传递、默认值及非空、复合主键顺序、索引方向、跨 schema、名称与注释转义、元数据不足/截断/权限/冲突、确认取消、部分失败停止与恢复记录。

必要 TS 语法检查和 git diff --check 已完成。类型检查、组件运行、常规测试、双审、GUI、实库和 CI 均未运行。

## 统一验收

1. 在专用源/目标 schema 建立上述类型、复合主键和 ASC/DESC 索引。克隆后逐项比较字典，不以 CREATE 成功代替保真验收。
2. 两个入口及粘贴结构选项覆盖确认取消、只读保护、生产确认取消、目标冲突、跨 schema 权限失败、刷新及原生 Oracle 回归。
3. 注入第二步和索引步骤失败，核对实际已提交对象、错误记录和恢复 SQL；注入 CREATE 超时，确认没有误导性删除建议。
4. 验证 quoted owner/table/column、Unicode 和嵌入引号名称；确认目标派生索引名称发生冲突时在写入前拒绝。
5. 检查分区表及 CHECK/UNIQUE、特殊索引、外键、触发器排除提示。当前复制范围不包含分区及物理存储属性。

字典依据：[ALL_IND_COLUMNS](https://en.oceanbase.com/docs/common-oceanbase-database-10000000001973077)、[ALL_TAB_COMMENTS](https://en.oceanbase.com/docs/common-oceanbase-database-10000000001105005)。文档依据不等于目标版本实库验证。
