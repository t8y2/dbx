# PIP: 达梦数据库用户/角色管理（侧边栏"用户"、"角色"菜单）

- 日期：2026-08-06
- 分支：`feature/dameng-user-role-admin`（基线 upstream/main @ 2daf8cb4b）
- 范围：标准版（用户+角色：列表/新建/删除/锁定解锁/改密 + 角色授予回收 + 系统权限 GRANT/REVOKE + 默认表空间下拉；不含对象级权限、资源限制）

## 背景

达梦（Dameng）在 DBX 中是受支持方言，侧边栏已有 `dameng-job-admin`（作业管理）特殊节点。
官方 DM 管理工具的用户/角色管理功能（DBA_USERS / DBA_ROLES / DBA_ROLE_PRIVS / DBA_SYS_PRIVS / DBA_TABLESPACES）
尚未覆盖。本计划参照现有 `dameng-job-admin` + `user-admin` 模式新增"用户"、"角色"两类菜单。

## 实现路径（前端拼 SQL + 通用查询执行，无专用后端 API，与 DamengJobAdmin 一致）

### 新增文件

1. `apps/desktop/src/lib/database/damengPrincipalAdmin.ts` — SQL 生成 + 结果解析层
   - 查询：用户列表、角色列表、用户已授角色、角色成员、用户系统权限、角色系统权限、表空间列表
   - DDL：创建用户、改密、锁定/解锁、删除用户（CASCADE）、创建角色、删除角色
   - DCL：授予/回收角色、授予/回收系统权限
   - 系统权限集合（Oracle 风格常用项）：CREATE SESSION/TABLE/VIEW/PROCEDURE/SEQUENCE/TRIGGER/ANY 等；运行时通过 SYSTEM_PRIVILEGE_MAP 过滤出当前实例真实存在的权限
   - 系统用户保护集合：SYSDBA/SYSSSO/SYSAUDITOR/SYS；预定义角色集合：DBA/PUBLIC/RESOURCE/VTI/SOI/SVI 及 AUDITOR/SSO/DBO 类型角色（不可删除/修改）
   - 解析函数：parseDamengUsers / parseDamengRoles / parseDamengRolePrivs / parseDamengSysPrivs / parseDamengTablespaces / parseDamengSystemPrivilegeMap / parseDamengRoleGraph / damengRolesClosure

2. `apps/desktop/src/components/admin/DamengUserAdmin.vue` — 用户管理组件（独立）
   - 列表：用户名、锁定状态、默认表空间、创建时间
   - 操作：新建（用户名/密码/默认表空间/是否锁定）、改密、锁定/解锁、删除（系统用户禁用）
   - 详情面板：已授角色（可授予/回收）、系统权限（可授予/回收）
   - 破坏性操作走 executeWithProductionSqlGuard + SQL 预览确认（DamengJobAdmin 同款）

3. `apps/desktop/src/components/admin/DamengRoleAdmin.vue` — 角色管理组件（独立）
   - 列表：角色名、角色 ID
   - 操作：新建、删除（预定义角色禁用）
   - 详情面板：角色成员（用户，系统用户禁止回收）、系统权限（预定义角色不可授予/回收）

### 修改文件

- `apps/desktop/src/types/database.ts` — TreeNodeType 加 `dameng-users`/`dameng-roles`；QueryTabMode 加对应值
- `apps/desktop/src/stores/connectionStore.ts` — buildDamengUserNode / buildDamengRoleNode（参照 buildDamengJobAdminNode），withConnectionUtilityNodes 注册
- `apps/desktop/src/stores/queryStore.ts` — openDamengUsers() / openDamengRoles()（参照 openDamengJobAdmin）
- `apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue` — 节点点击路由（参照 dameng-job-admin 分支）
- `apps/desktop/src/components/sidebar/TreeItem.vue` — 图标 + 节点 label
- `apps/desktop/src/lib/sidebar/treeNodeIcon.ts` — 图标映射
- `apps/desktop/src/lib/sidebar/treeNodeClick.ts` / `sidebarNodeOrdering.ts` / `sidebarTreeItemLayout.ts` — 节点类型注册
- `apps/desktop/src/components/layout/ContentArea.vue` — tab mode → 组件渲染（参照 dameng-jobs）
- `apps/desktop/src/i18n/locales/zh-CN.ts` / `en.ts` 等 8 语言 — 文案

### 测试

- `packages/app-tests/damengPrincipalAdmin.test.ts` — SQL 层单测（转义、SQL 形状、系统用户保护）
- 组件测试（可选）

## 关键设计

- 系统用户（SYSDBA/SYSSSO/SYSAUDITOR/SYS）禁止删除/改密/锁定，详情面板内对系统用户禁止授予/回收角色与权限
- 改密权限模型（实测校正）：SYS 永不改；SYSSSO/SYSAUDITOR 仅本人可改；SYSDBA 可改普通用户；普通用户只能改自己
- 角色展示为传递闭包（实测：SYSDBA→DBA→VTI、PUBLIC→SVI 为嵌套授予），与官方客户端一致；内部隐藏角色 SYS_ADMIN 过滤（不可授予/回收）
- 预定义角色（DBA/PUBLIC/RESOURCE/VTI/SOI/SVI/DB_AUDIT_*/DB_POLICY_*/DB_OBJECT_*）不可删除、不可修改权限集；PUBLIC 不建议回收（官方文档警告回收后大量功能不可用）；VTI/SOI/SVI 的默认固定授权（DBA→VTI、SYSDBA→SOI、PUBLIC→SVI）不可回收
- 达梦 DBA_ROLES 无 ROLE_ID 列（与 Oracle 不同），角色列表不展示角色 ID
- DBA_ 视图查询失败（非 SYSDBA 权限不足）时提示降级信息
- 所有 DDL/DCL 走 executeWithProductionSqlGuard
