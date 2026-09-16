import { describe, expect, it } from "vitest";
import { analyzeIntentionActions, type IntentionAction } from "@/lib/editor/sqlIntentionActions";
import { sqlFixtureCursor } from "@/lib/sql/semantic/fixtures";

// ==================== Helpers ====================

/** 用 | 标记光标位置，返回第一个 action（或 null） */
function actionAtCursor(input: string, databaseType?: string): IntentionAction | null {
  const { sql, cursor } = sqlFixtureCursor(input);
  const actions = analyzeIntentionActions({ sql, cursor, databaseType: databaseType as never });
  return actions[0] ?? null;
}

/** 用 | 标记光标位置，返回所有 actions */
function actionsAtCursor(input: string, databaseType?: string): IntentionAction[] {
  const { sql, cursor } = sqlFixtureCursor(input);
  return analyzeIntentionActions({ sql, cursor, databaseType: databaseType as never });
}

// ==================== Tests ====================

describe("sqlIntentionActions - qualify/unqualify identifier", () => {
  // ---- Bug 8: 已限定标识符不应被错误地再次限定 ----

  describe("已限定标识符（Bug 8 修复）", () => {
    it("MySQL 反引号限定: `su`.`user_id` 光标在 user_id 上 → 提供取消限定", () => {
      const action = actionAtCursor("SELECT `su`.`user_id|` FROM sys_user AS su", "mysql");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe("`user_id`");
    });

    it("MySQL 反引号限定: `su`.`user_id` 光标在 user_id 上 → span 覆盖完整限定标识符", () => {
      const action = actionAtCursor("SELECT `su`.`user_id|` FROM sys_user AS su", "mysql");
      expect(action).not.toBeNull();
      const sql = "SELECT `su`.`user_id` FROM sys_user AS su";
      const coveredText = sql.slice(action!.span.start, action!.span.end);
      expect(coveredText).toContain("su");
      expect(coveredText).toContain("user_id");
    });

    it('PostgreSQL 双引号限定: "su"."user_id" 光标在 user_id 上 → 提供取消限定', () => {
      const action = actionAtCursor('SELECT "su"."user_id|" FROM sys_user AS su', "postgres");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe('"user_id"');
    });

    it("无引号限定: su.user_id 光标在 user_id 上 → 提供取消限定", () => {
      const action = actionAtCursor("SELECT su.user_id| FROM sys_user AS su");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe("user_id");
    });

    it("不应生成 `su`.`su`.su 这样的无效 SQL", () => {
      const action = actionAtCursor("SELECT `su`.`user_id|` FROM sys_user AS su", "mysql");
      expect(action).not.toBeNull();
      expect(action!.replacement).not.toBe("`su`.su");
      expect(action!.replacement).not.toContain("`su`.`su`");
    });
  });

  // ---- 表别名不应被限定 ----

  describe("表别名跳过", () => {
    it("光标在 FROM 子句的表别名 su 上 → 不提供限定", () => {
      const action = actionAtCursor("SELECT user_id FROM sys_user AS su WHERE su|", "mysql");
      expect(action).toBeNull();
    });

    it("光标在 JOIN 的表别名 sup 上 → 不提供限定", () => {
      const action = actionAtCursor("SELECT * FROM sys_user su JOIN sys_user_post sup| ON su.user_id = sup.user_id");
      expect(action).toBeNull();
    });
  });

  // ---- 未限定标识符 → 提供限定 ----

  describe("未限定标识符 → 提供限定", () => {
    it("单表有别名: user_id → 添加别名限定", () => {
      const action = actionAtCursor("SELECT user_id| FROM sys_user AS su", "mysql");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toContain("su");
      expect(action!.replacement).toContain("user_id");
    });

    it("MySQL 反引号包裹列名: `user_id` → 限定为 `su`.`user_id`", () => {
      const action = actionAtCursor("SELECT `user_id|` FROM sys_user AS su", "mysql");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toContain("su");
    });
  });

  // ---- Projection 别名跳过 ----

  describe("projection 别名跳过", () => {
    it("光标在列别名 n 上 → 不提供限定", () => {
      const action = actionAtCursor("SELECT user_name AS n| FROM sys_user su");
      expect(action).toBeNull();
    });
  });

  // ---- 多表 JOIN 场景 ----

  describe("多表 JOIN", () => {
    it("双表 JOIN 中仅出现在一个表的列 → 提供取消限定", () => {
      // user_name 只在 su 上引用，不产生歧义
      const action = actionAtCursor("SELECT su.user_name| FROM sys_user su JOIN sys_user_post sup ON su.user_id = sup.user_id");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe("user_name");
    });

    it("双表 JOIN 中同名列（两个限定符都引用） → 不提供取消限定（歧义检测）", () => {
      // user_id 同时被 su 和 sup 引用，取消限定会产生歧义
      const action = actionAtCursor("SELECT su.user_id| FROM sys_user su JOIN sys_user_post sup ON su.user_id = sup.user_id");
      expect(action).toBeNull();
    });

    it("双表 JOIN 中同名列（仅一个限定符引用） → 仍提供取消限定", () => {
      // user_id 只被 su 引用（ON 条件用了 sup.user_id，但 SELECT 中只有 su.user_name）
      const action = actionAtCursor("SELECT su.user_name| FROM sys_user su JOIN sys_user_post sup ON su.user_id = sup.user_id");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
    });

    it("双表 JOIN 中未限定列（ON 中用 1 个限定符引用）→ 提供限定", () => {
      // user_id 在 ON 中被 su 引用 → 可推断属于 sys_user
      const action = actionAtCursor("SELECT user_id| FROM sys_user su JOIN sys_user_post sup ON su.user_id = sup.post_id");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toContain("su");
    });

    it("双表 JOIN 中未限定列（两个限定符都引用）→ 提供所有候选表限定选项", () => {
      // user_id 同时被 su 和 sup 引用 → 歧义，但提供所有候选让用户选择
      const actions = actionsAtCursor("SELECT user_id| FROM sys_user su JOIN sys_user_post sup ON su.user_id = sup.user_id");
      expect(actions.length).toBe(2);
      expect(actions[0].kind).toBe("qualify_identifier");
      expect(actions[1].kind).toBe("qualify_identifier");
      const labels = actions.map((a) => a.label).sort();
      expect(labels).toEqual(["su.user_id", "sup.user_id"]);
    });

    it("双表 JOIN 中未限定列（未在任何限定符中引用）→ 提供所有候选表限定选项", () => {
      // unique_col 未在 SQL 中被任何限定符引用 → 无法自动推断，提供所有候选让用户选择
      const actions = actionsAtCursor("SELECT unique_col| FROM sys_user su JOIN sys_user_post sup ON su.user_id = sup.user_id");
      expect(actions.length).toBe(2);
      expect(actions[0].kind).toBe("qualify_identifier");
      const labels = actions.map((a) => a.label).sort();
      expect(labels).toEqual(["su.unique_col", "sup.unique_col"]);
    });
  });

  // ---- WHERE / ON 子句中的列 ----

  describe("WHERE / ON 子句", () => {
    it("WHERE 中未限定列 → 提供限定", () => {
      const action = actionAtCursor("SELECT * FROM sys_user su WHERE user_id|", "mysql");
      if (action) {
        expect(action.kind).toBe("qualify_identifier");
        expect(action.replacement).toContain("su");
      }
    });

    it("ON 条件中已限定列 → 提供取消限定", () => {
      const action = actionAtCursor("SELECT * FROM sys_user su JOIN sys_user_post sup ON su.user_id| = sup.user_id");
      if (action) {
        expect(action.kind).toBe("unqualify_identifier");
        expect(action.replacement).toBe("user_id");
      }
    });
  });

  // ---- 不应提供操作的场景 ----

  describe("不应提供操作", () => {
    it("光标在字符串字面量中 → 不提供操作", () => {
      const action = actionAtCursor("SELECT 'user|_id' FROM sys_user su");
      expect(action).toBeNull();
    });
  });

  // ---- 回归测试: 确保原有功能不受影响 ----

  describe("回归测试", () => {
    it("无引号单表未限定列 → 正常限定", () => {
      const action = actionAtCursor("SELECT name| FROM users u");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toContain("u");
      expect(action!.replacement).toContain("name");
    });

    it("无引号单表已限定列 → 正常取消限定", () => {
      const action = actionAtCursor("SELECT u.name| FROM users u");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe("name");
    });
  });

  // ---- 引号标识符保留（PR Review 阻塞项 2）----

  describe("引号标识符保留", () => {
    it("MySQL 反引号保留字 qualify → 保留引号", () => {
      const action = actionAtCursor("SELECT `order`| FROM users u", "mysql");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toBe("`u`.`order`");
    });

    it("MySQL 反引号空格列名 qualify → 保留引号", () => {
      const action = actionAtCursor("SELECT `user id`| FROM users u", "mysql");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toBe("`u`.`user id`");
    });

    it("PG 双引号大小写敏感列名 qualify → 保留引号", () => {
      const action = actionAtCursor('SELECT "UserName"| FROM users u', "postgres");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("qualify_identifier");
      expect(action!.replacement).toBe('"u"."UserName"');
    });

    it("MySQL 反引号保留字 unqualify → 保留引号", () => {
      const action = actionAtCursor("SELECT `u`.`order`| FROM users u", "mysql");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe("`order`");
    });

    it("PG 双引号大小写敏感列名 unqualify → 保留引号", () => {
      const action = actionAtCursor('SELECT "u"."UserName"| FROM users u', "postgres");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe('"UserName"');
    });
  });

  // ---- schema.table.column 三段式标识符（PR Review 阻塞项 3）----

  describe("schema.table.column 三段式标识符", () => {
    it("三段式 unqualify → 替换为裸列名（保留引号）", () => {
      const action = actionAtCursor("SELECT dbo.users.user_id| FROM dbo.users", "sqlserver");
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("unqualify_identifier");
      expect(action!.replacement).toBe("[user_id]");
    });

    it("三段式同名列歧义检测 → 不提供 unqualify", () => {
      // dbo.users.user_id 和 dbo.orders.user_id 都是 3 段式
      const sql = "SELECT dbo.users.user_id| FROM dbo.users JOIN dbo.orders ON dbo.users.user_id = dbo.orders.user_id";
      const action = actionAtCursor(sql, "sqlserver");
      expect(action).toBeNull();
    });
  });

  // ---- 引号标识符歧义检测（PR Review 阻塞项 3）----

  describe("引号标识符歧义检测", () => {
    it("MySQL 反引号同名列歧义 → 不提供 unqualify", () => {
      const sql = "SELECT `su`.`user_id`| FROM sys_user `su` JOIN sys_user_post `sup` ON `su`.`user_id` = `sup`.`user_id`";
      const action = actionAtCursor(sql, "mysql");
      expect(action).toBeNull();
    });

    it("PG 双引号同名列歧义 → 不提供 unqualify", () => {
      const sql = 'SELECT "su"."user_id"| FROM sys_user "su" JOIN sys_user_post "sup" ON "su"."user_id" = "sup"."user_id"';
      const action = actionAtCursor(sql, "postgres");
      expect(action).toBeNull();
    });
  });
});
