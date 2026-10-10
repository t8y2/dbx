# OceanBase Oracle 主键编辑

关联 #11439，依赖 #6973 的共同预检、预览、执行与读回流程，以及 #11415 的约束元数据。

## 实现边界

- 新增使用 `ADD CONSTRAINT ... PRIMARY KEY`，替换使用 `MODIFY PRIMARY KEY`，删除使用 `DROP PRIMARY KEY`。替换不会先删旧主键。
- 复用 Oracle 的列序、非空/重复数据检查、字典完整性检查、预览指纹、执行结果与恢复展示。
- OceanBase 分支检查目标表所有被外键引用的主键或唯一键；无法读取完整 `DBA_CONSTRAINTS` 时拒绝执行。
- OceanBase 管理主键存储，不生成 Oracle 的 `KEEP INDEX`、`USING INDEX` 或独立支持索引删除。界面隐藏该选项，后端也拒绝绕过界面传入的选项。
- 仅处理已启用、已验证、不可延迟的主键状态；不能确认或不能保留状态时拒绝。支持索引的原始字典字段进入指纹，单边缺失被拒绝。
- 每次执行重新预检，执行后读取实际约束。失败时保留逐步错误；只有确认旧主键已经不存在时提供按原名、原列序重建的 SQL。不会自动恢复或盲目重放。

## 文档依据

[OceanBase 4.2.5 ALTER TABLE](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000001504123) 记载新增、修改和删除主键语法，以及外键父表不能删除主键的限制。

[OceanBase 4.2.5 ALL_CONSTRAINTS](https://en.oceanbase.com/docs/common-oceanbase-database-10000000003157673) 记载约束状态与索引字段。文档依据不等于运行时验收；不宣称其他版本已实测。

## 待统一验收

已编写共同模块的 OceanBase 行为用例和界面用例，尚未运行。需统一执行 Oracle 回归、OceanBase 隔离表与真实 GUI 验证，涵盖单列/复合列调整、空表/有数据、重复/NULL、跨 schema 引用、quoted 名称、权限不足、失败读回、恢复与重试。

开发检查点不代表测试、实库、GUI、审查或 CI 验收通过。
