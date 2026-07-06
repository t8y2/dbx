# Issue #2389 SQL 语句框线识别交接文档

## 背景

Issue: https://github.com/t8y2/dbx/issues/2389

目标：增强查询编辑器里的 SQL 语句识别能力。当光标处在某条 SQL 语句内部时，编辑器需要用框线标出当前完整的可执行语句。这个“当前语句”的语义应该被多个入口共用，包括视觉框线、左侧 gutter 执行按钮、快捷键执行和工具栏执行。

这个能力不能只覆盖简单的 `SELECT`，还需要兼容常见 SQL 变体。重点场景包括多行 DDL、CTE、MySQL delimiter 脚本、存储过程、PL/SQL 块、Redis 命令行、空白行、注释行，以及字符串或注释里包含分号的语句。

## 期望行为

- 光标在 SQL 语句内部：显示绿色框线，框住完整的当前可执行语句。
- 手动选中 SQL：隐藏当前语句框线，保持“执行选区”的语义优先。
- 光标在空白行或纯注释行：不显示当前语句框线。
- 光标在 MySQL `CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT` 的 body 内部：框住整个复合定义，而不是框住内部的 `UPDATE`、`INSERT` 或 `SELECT`。
- MySQL `DELIMITER` 命令行不是可执行 SQL 语句，不应该显示当前语句框线。
- Redis 查询页可以按当前命令行显示框线。
- MongoDB 以及其他不支持 execution target picker 的非 SQL 查询类型，不显示这个 SQL 当前语句框线。
- 框线右侧应该对齐当前语句内最长的可见行，而不是铺满整个查询窗口。
- 视觉框线应该把紧邻的结尾分号也纳入宽度计算，避免分号落在框线外或压到右侧边框。

## 当前实现内容

本轮主要改动文件：

- `apps/desktop/src/lib/sql/sqlStatementRanges.ts`
- `apps/desktop/src/lib/sql/executableStatementRangeCache.ts`
- `apps/desktop/src/components/editor/QueryEditor.vue`
- `apps/desktop/src/lib/__tests__/sql/sqlStatementRanges.spec.ts`
- `apps/desktop/src/lib/__tests__/sql/executableStatementRangeCache.spec.ts`

### SQL Range 公共入口

`sqlStatementRanges.ts` 新增导出：

```ts
currentExecutableStatementRange(sql, cursorPos, databaseType)
```

这个函数用于统一当前可执行语句查找逻辑：

- Redis：委托给当前命令行 range。
- MongoDB：返回 `null`，因为 MongoDB 已排除在 execution target picker 行为之外。
- SQL 数据库：委托给 `statementRangeAtCursor`。

`buildExecutionCandidates` 现在也使用 `currentExecutableStatementRange`，这样执行候选和当前语句视觉框线使用同一个顶层来源。

### MySQL 复合 CREATE 语句处理

`splitStatementRangeAtSoftStarts` 现在会对 MySQL 复合 CREATE 语句提前返回，不再继续按内部软起点拆分。

当前覆盖：

- `CREATE PROCEDURE`
- `CREATE FUNCTION`
- `CREATE TRIGGER`
- `CREATE EVENT`

这些语句经过 delimiter 解析后会被视为一条完整可执行语句。这可以避免存储过程 body 被内部的 `UPDATE users` 或 `INSERT INTO audit_logs` 错误拆开。

相关 helper：

```ts
isMySqlCompoundCreateStatement(sql, databaseType)
```

这个 helper 只对 MySQL 生效。它会扫描 SQL 开头部分的词，同时跳过注释、字符串和引用标识符，然后判断 `CREATE` 后面是否出现复合对象关键字。

### Range 缓存

`executableStatementRangeCache.ts` 现在同时保存：

- `byStart`：供左侧 gutter 执行按钮按行起点查找语句。
- `ranges`：供光标位置查找当前语句，避免重复解析。

新增函数：

```ts
executableStatementRangeAtCursor(cache, cursorPos)
```

它支持：

- 光标在 range 内部。
- 光标在语句前面的缩进空白里。
- 光标刚好在同一行分号后面。
- 光标在空白行或纯注释行时返回 `null`。

### QueryEditor 视觉框线

`QueryEditor.vue` 新增 CodeMirror `ViewPlugin`：

```ts
currentStatementFrameHighlighter
```

它负责：

- 从缓存 range 中计算当前可执行语句。
- 给语句起止行之间创建 line decoration。
- 当存在非空选区时隐藏框线。
- 当 `databaseType` 变化时清空并重算缓存。
- 使用 CSS 伪元素在被装饰的行上绘制框线。

框线宽度规则：

- 宽度基于当前语句内最长的可见行。
- ASCII 字符按 1 列计算。
- CJK/全角字符按 2 列计算。
- Tab 按 4 列计算。
- 额外增加 `2ch` 右侧余量，避免末尾分号或最后一个字符压到右边框。
- 如果语句 range 后面紧邻一个分号，这个分号只参与框线宽度计算，不改变实际执行 SQL。

重要说明：曾经尝试用 `EditorView.coordsAtPos` 做实际像素测量，但在 CodeMirror decoration 更新过程中读取布局会导致光标移动后框线消失。因此当前实现回到纯文本宽度估算，避免 decoration 更新阶段读取 DOM 坐标。

## 重要测试场景

### 简单多语句 SQL

```sql
SELECT *
FROM apis AS ap
LIMIT 100;

SELECT *
FROM menus AS mn
LIMIT 100;
```

预期：光标在任意一个 `SELECT` 块内时，只框住对应的 `SELECT` 块。

### MySQL 多行 ALTER TABLE

```sql
ALTER TABLE `yb_course_order`
  ADD COLUMN `audit_status` tinyint(4) DEFAULT NULL
    COMMENT '审核状态：0-待审核，1-已通过，2-已拒绝',
  ADD COLUMN `close_reason` varchar(30) DEFAULT NULL
    COMMENT '关闭原因：timeout-超时关闭，cancel-取消关闭，refund-退款关闭',
  ADD COLUMN `paid_completion_time` datetime DEFAULT NULL
    COMMENT '订单完成支付(付清)时间 首次全额支付完成时记录，全部退款后不重置';
```

预期：光标在任意一行时，都框住完整 `ALTER TABLE` 语句。右边框需要足够覆盖中文注释，并且视觉上包含最后的分号。

### MySQL Delimiter + Procedure

```sql
DELIMITER $$

CREATE PROCEDURE sync_user_status()
BEGIN
  UPDATE users
  SET status = 'inactive'
  WHERE last_login_at < DATE_SUB(NOW(), INTERVAL 180 DAY);

  INSERT INTO audit_logs(action, created_at)
  VALUES ('sync_user_status', NOW());
END$$

DELIMITER ;

CALL sync_user_status();

SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10;
```

预期：

- 光标在 `DELIMITER $$` 行：不显示框线。
- 光标在 `CREATE PROCEDURE ... END$$` 内任意位置：框住整个 procedure 定义，而不是内部的 `UPDATE` 或 `INSERT`。
- 光标在 `CALL` 行：只框住 `CALL sync_user_status();`。
- 光标在最后的 `SELECT` 行：只框住最后的 `SELECT`。

### 注释与空白行

```sql
SELECT 1;
-- comment with ; semicolon

SELECT 2;
```

预期：注释行和空白行不显示框线；SQL 行只框住自己的语句。

### Redis

```redis
GET user:1
HGETALL user:profile:1
# comment line should not show current command frame
SCAN 0 MATCH user:* COUNT 20
```

预期：光标在 Redis 命令行时框住当前行；光标在注释行时不显示框线。

## 已知限制与后续风险

- 框线宽度仍然是基于文本列数的估算，不是精确像素测量。这样可以避免框线消失，但如果使用比例字体或特殊字形，右边界可能不是完全像素级对齐。
- 当前宽字符检测覆盖常见 CJK/全角 Unicode 范围。如果后续出现其他宽字符类别，可以继续扩展 `isWideSqlChar`。
- MySQL 复合语句检测当前通过扫描 `CREATE ... PROCEDURE/FUNCTION/TRIGGER/EVENT` 的前置词实现，能覆盖常见修饰符，但极端语法仍需要补测试。
- SQL Server `GO` batch 的前端 TypeScript splitter 目前没有完全对齐后端逻辑。后端已有 SQL Server 专门处理。如果用户反馈 SQL Server batch 框线异常，可能需要补齐前端解析。
- 视觉框线目前在 `QueryEditor.vue` 内实现，还没有浏览器级自动化视觉测试。

## 已经执行过的验证

第一轮实现时曾成功运行：

```bash
env CI=true pnpm test apps/desktop/src/lib/__tests__/sql/sqlStatementRanges.spec.ts apps/desktop/src/lib/__tests__/sql/executableStatementRangeCache.spec.ts
env CI=true pnpm typecheck
env CI=true pnpm lint
```

`pnpm lint` 当时通过，但输出了仓库既有 warning，和本次改动无关。

后续几轮 UI 和识别逻辑微调后，没有继续运行验证，因为用户明确要求“只实现，后续自己验证”。

## 换电脑继续开发建议

1. 用 MySQL 连接打开查询编辑器。
2. 粘贴上面的测试用例，重点验证 `ALTER TABLE` 和 `DELIMITER $$ CREATE PROCEDURE`。
3. 在每一行移动光标，确认框线目标和预期语句一致。
4. 确认左侧 gutter 执行按钮、快捷键执行、工具栏执行和视觉框线指向同一条当前语句。
5. 准备提交前建议运行：

```bash
env CI=true pnpm test apps/desktop/src/lib/__tests__/sql/sqlStatementRanges.spec.ts apps/desktop/src/lib/__tests__/sql/executableStatementRangeCache.spec.ts
env CI=true pnpm typecheck
```
