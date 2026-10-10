# OceanBase Oracle 物化视图重命名边界

#11465 的当前代码修正只让后端与已隐藏的前端入口一致。后端不再生成未经验证的 `ALTER MATERIALIZED VIEW ... RENAME TO`，直接返回 DBX 未启用该能力、版本/补丁/schema 未验证的明确错误。普通 VIEW 由 O10 处理，本票不改变其行为，也不改变原生 Oracle 及其他驱动。

官方 [4.3.5 Oracle 模式文档](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000002501011) 说明物化视图重命名从 BP3 支持，使用 RENAME；[4.4.2 文档](https://en.oceanbase.com/docs/common-oceanbase-database-10000000003455395) 同样指向 RENAME。当前构建选项不携带版本或补丁能力，因此不能仅凭数据库类型启用。该错误不表示 OceanBase 所有版本都不支持。

已写后端拒绝生成 DDL、quoted schema/name 和其他数据库/普通 VIEW 回归用例，并补充前端能力隐藏断言。仅进行必要语法/格式检查，未运行测试。

统一验收仍须在专用 schema 核实目标版本和 BP、MV 创建、正确 RENAME、同名冲突、权限、依赖及刷新状态，并比对前后字典。确认目标版本能力后才贯通菜单、SQL、执行和刷新。不得用 DROP/CREATE 冒充无损改名。

当前为防止错误 SQL 的开发完成，V01 的版本能力和 GUI 验证未完成。
