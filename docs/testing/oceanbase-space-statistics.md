# OceanBase Oracle 空间统计

关联 #11436，依赖 O12a 行数状态。开发完成，待统一验收。

Core 统计入口先读取全局优化器行数，再独立读取两个空间来源。一个来源失败不会把另一个来源的结果替换成零。取消请求不继续探测其余来源。

- `SYS.DBA_OB_TABLE_SPACE_USAGE` 使用 `OCCUPY_SIZE` 和 `REQUIRED_SIZE`，按实际视图/字段可读性探测，不以版本字符串直接启用。
- `SYS.DBA_OB_TABLE_LOCATIONS` 与 `SYS.DBA_OB_TABLET_REPLICAS` 按 Tablet、LS、服务器 IP/端口关联，只汇总 Leader。基表、索引和 LOB 辅助表分别展示，缺 Leader、重复 Leader 或字节值不完整保持未知。
- 两个来源都是独立快照，不相加。`total_bytes` 保持未知；OB 列表单独显示来源的占用空间，不将其声称为表、索引、LOB 总量或租户磁盘总量。
- 查询限定 schema，1000 行 keyset 分页，不逐表查询。不使用 Oracle SEGMENTS 估算 OB 存储。

列表、卡片、对象详情及 DataGrid 表详情复用 O12a 的 schema 缓存和旧响应保护，新增空间来源、Leader 范围、状态、数据/占用字节及分项。显式刷新替换缓存，未找到的表显示未知。

## 已写、未执行的验证

Core 单元用例和生产入口 RPC fixture 覆盖现代视图、旧来源、真实零、独立权限错误、缺失 LOB、大 schema 分页、截断、无效字节、取消和原生 Oracle 回归。前端用例覆盖空间展示、真实详情组件和共享缓存附加字段。

必要 Rust 格式/语法、TS 语法、Vue script 解析、Python AST 与 diff 检查已完成。这不代表类型检查或功能测试通过。

统一验收须在专用 OB schema 比较非分区表、分区表、多个索引、LOB、空表、缺权限和视图缺失的真实字典。特别核对现代表视图与旧 tablet 来源的口径差异、Leader 切换/缺失、两个来源独立失败、分页刷新竞态和两处详情 GUI。完整测试、类型检查、构建、双审、CI 仍待安排。

依据：[官方表空间视图](https://en.oceanbase.com/docs/common-oceanbase-database-10000000001976635)、[官方 TABLE_LOCATIONS 字段](https://www.oceanbase.com/en/docs/common-oceanbase-database-cn-1000000000750513)、[4.2.5 Oracle 模式 SYS.TABLE_LOCATIONS 示例](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000001499832)。这些材料不代替目标实例验收。
