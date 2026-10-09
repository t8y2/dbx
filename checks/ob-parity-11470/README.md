# Oracle / OceanBase 错误位置与有效状态验证

工单 #11470。当前仅准备代码和用例，未运行实库或 GUI。独立编译操作由 #11454 负责。

## 已发现的静态缺口

O07 基线 `b83064c2a4f5012479c497830f78c3e10583ac12` 的 OB `listObjects` 没有选取 `ALL_OBJECTS.STATUS`，已有 `ObjectInfo.valid` 因而始终未知。本票补读取及精确映射：VALID 为 true、INVALID 为 false，空值或其他状态仍未知。筛选、排序、分页保持 O07 查询结构。该缺口来自源码检查，实库复现和修复验收尚未执行。

依据：[OceanBase 4.2.5 ALL_OBJECTS](https://github.com/oceanbase/oceanbase-doc/blob/V4.2.5/en-US/700.reference/700.system-views/500.system-view-of-oracle-mode/200.dictionary-view-of-oracle-mode/2200.all_objects-of-oracle-mode.md)、[Oracle ALL_OBJECTS](https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_OBJECTS.html)。字典文档不代替实际驱动证据。

## 错误采样

使用 [error-cases.json](error-cases.json) 中的 SQL，经真实编辑器查询路径分别连接 Oracle 与 OB。语句仅包含 SELECT 或有明确语法错误的匿名块，不创建业务对象。先记录库、驱动和各层源码版本，保存脱敏后的 Agent RPC、Core 归一化错误和前端结果；不保存连接密码、令牌或业务 SQL。

对照 ASCII、中文和 emoji 样本确定字节、Unicode scalar 或 UTF-16 单位，再确定 0/1 起点。消息只给行号时不补造列；没有可靠位置时记录“无位置”。不得用手写错误文本替代真实驱动样本，或者先给数据集填写预期偏移再据此宣布通过。

编辑器检查包含单条执行、多语句中的选中片段、注释前缀、多行 PL/SQL、执行后修改文本、切换标签页。记录最终行列和 caret UTF-16 offset。分别核验 Web 与 Tauri 的实际可用环境，未运行的一端明确标记。

## 对象状态

在专用测试 schema 生成当轮唯一对象名并记录清单，创建有效过程、编译无效过程及一对包规格/包体。通过真实 Agent listObjects、Core 和对象树读取 VALID/INVALID；修正同一个隔离对象后刷新，核对旧状态消失。未知字段使用协议回归覆盖，不通过伪造实库状态制造“实测”。普通账号的不可见对象和权限错误分开记录，权限失败不能归为已确认空列表。

只清理本轮确切名称，不按公共前缀批量删除。保存原始 SQL、对象清单、实际结果和清理结果。运行前核对目标连接属于专用环境。

## 待运行用例

Agent 公开入口覆盖状态三值、包体类型、序列化及刷新；Core 类型回归覆盖缺失字段不默认有效；对象树回归覆盖规格/体状态和刷新为未知；位置消费回归覆盖无位置不猜测和源文本已变化时拒绝跳转。用例尚未执行，当前未修改错误偏移换算算法。

最终结论逐项使用“已支持”“不支持”“未验证”“确认缺陷”，并附对应真实证据。开发检查点不等于验收通过。
