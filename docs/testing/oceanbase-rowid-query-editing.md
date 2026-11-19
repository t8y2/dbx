# OceanBase Oracle 查询结果 ROWID 编辑

## 问题与复现

在 OceanBase Oracle 模式中创建无主键普通表，插入两行相同业务值。执行 `SELECT * FROM APP.ITEMS t` 或 `SELECT t.* FROM APP.ITEMS t`。修复前不会附加隐藏定位键，结果缺少可用于单行编辑的身份。

对视图或尚未确认类型的对象执行 `SELECT t.ROWID AS RID, t.LABEL FROM APP.ITEMS t`。修复前显式返回 ROWID 可以绕过普通表确认，错误开放编辑。

## 行为与验收

- 已确认的无主键单基表星号查询附加隐藏 `ROWIDTOCHAR(ROWID)`；保留原别名、引号、提示和注释。相同业务值的两行保持独立定位键。
- 物理主键优先。业务列 `"rowid"`、`"__DBX_PK_0"` 保持可见，隐藏别名避让已有名称。
- 视图、未知对象、其他 schema 的同名表不能赋予 ROWID 编辑权限；DISTINCT、分组、联表和集合运算保持原 SQL。
- `PARTITION(P0)`、`SUBPARTITION(P0)`、`PARTITION FOR (...)` 不得被误当表别名。语义解析器尚不能可靠区分这些后缀，隐藏键构造跳过改写，保留原 SQL；不生成 `PARTITION.*`。
- PIVOT、UNPIVOT 及其他未完整解析的来源后缀保持原 SQL 且只读；引号别名、普通联表和 SQL Server `WITH (...)` 表提示保留现有来源映射。
- 数据库更新行数保护报告过期 ROWID 时，显示错误并保留修改草稿。删除返回 0 行沿用现有冲突提示及刷新行为，不将已经结束的删除保留为自动重试任务。
- 单行、单条普通 ROWID UPDATE 返回已知影响 0 行时报告冲突，保留草稿并暂停自动重试。此保护补齐既有零行更新缺口，不从混合批次总行数、缺失或负数计数、PL/SQL 未知计数推断匹配失败。
- 只读网格不准备或执行保存；正常保存与执行失败反馈分别验证。

## 自动验证

Store 测试从 `executeTabSql` 进入，只在后端 API 和连接元数据边界提供夹具。新增用例在基线复现 10 项失败，修复后通过。隐藏键测试验证实际 SQL 构造；DataGrid 测试挂载组件并点击保存工具栏，覆盖只读、正常删除、零行删除、执行失败及过期更新草稿。

相关文件：

- `queryStore.oceanbaseRowId.spec.ts`
- `queryStore.hiddenPrimaryKey.spec.ts`
- `editableQueryHiddenKeys.spec.ts`
- `useDataGridEditor.spec.ts`
- `DataGridRowIdSaveFeedback.spec.ts`

## 待完成验收

本批次未重新执行 OceanBase 实库或桌面 GUI 验收。需要在隔离普通表中操作两条相同值，只更新选中行并读回；验证视图只读、业务列可见，以及另一会话删除目标后更新失败保留草稿。组件测试和 SQL 构造测试不替代数据库或 GUI 验收。原生 Oracle 行为需要单独实库回归。
