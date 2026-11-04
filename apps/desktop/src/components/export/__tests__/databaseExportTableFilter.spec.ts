import { describe, expect, it } from "vitest";
import { filterExportTables, filterTableNames, matchTableFilter } from "../databaseExportTableFilter";

describe("databaseExportTableFilter", () => {
  const sampleTables = ["users", "user_profiles", "orders", "order_items", "products", "PRODUCT_TAGS", "accounts_bak", "system_logs_2024", "test[table]", "special*char"];

  describe("空查询与空白字符 (Empty and Whitespace Queries)", () => {
    it("空字符串应返回全部表列表", () => {
      expect(filterTableNames(sampleTables, "")).toEqual(sampleTables);
      expect(filterExportTables(sampleTables, "")).toEqual(sampleTables);
      expect(matchTableFilter("users", "")).toBe(true);
    });

    it("纯空格字符串应返回全部表列表", () => {
      expect(filterTableNames(sampleTables, "   ")).toEqual(sampleTables);
      expect(filterExportTables(sampleTables, " \t \n ")).toEqual(sampleTables);
      expect(matchTableFilter("orders", "   ")).toBe(true);
    });

    it("空查询返回的是浅拷贝数组，不应直接返回原引用", () => {
      const result = filterTableNames(sampleTables, "");
      expect(result).toEqual(sampleTables);
      expect(result).not.toBe(sampleTables);
    });
  });

  describe("单表名普通文本模糊包含匹配 (Single Token Substring Matching)", () => {
    it("默认大小写不敏感匹配", () => {
      expect(filterTableNames(sampleTables, "USER")).toEqual(["users", "user_profiles"]);
      expect(filterTableNames(sampleTables, "tags")).toEqual(["PRODUCT_TAGS"]);
      expect(matchTableFilter("PRODUCT_TAGS", "tag")).toBe(true);
      expect(matchTableFilter("orders", "order")).toBe(true);
      expect(matchTableFilter("orders", "user")).toBe(false);
    });

    it("支持大小写敏感选项 (caseSensitive: true)", () => {
      expect(filterTableNames(sampleTables, "product", { caseSensitive: true })).toEqual(["products"]);
      expect(filterTableNames(sampleTables, "PRODUCT", { caseSensitive: true })).toEqual(["PRODUCT_TAGS"]);
      expect(matchTableFilter("PRODUCT_TAGS", "product", { caseSensitive: true })).toBe(false);
      expect(matchTableFilter("PRODUCT_TAGS", "PRODUCT", { caseSensitive: true })).toBe(true);
    });

    it("包含特殊字符的普通文本搜索", () => {
      expect(filterTableNames(sampleTables, "[table]")).toEqual(["test[table]"]);
      expect(filterTableNames(sampleTables, "*char")).toEqual(["special*char"]);
    });
  });

  describe("逗号分隔多表匹配 (Comma-separated Multiple Tokens)", () => {
    it("支持英文逗号分隔的多表匹配（OR 逻辑）", () => {
      const result = filterTableNames(sampleTables, "user,order");
      expect(result).toEqual(["users", "user_profiles", "orders", "order_items"]);
    });

    it("支持中文逗号分隔的多表匹配", () => {
      const result = filterTableNames(sampleTables, "product，order");
      expect(result).toEqual(["orders", "order_items", "products", "PRODUCT_TAGS"]);
    });

    it("支持中英文逗号混合分隔", () => {
      const result = filterTableNames(sampleTables, "user, order，product");
      expect(result).toEqual(["users", "user_profiles", "orders", "order_items", "products", "PRODUCT_TAGS"]);
    });

    it("正确去除各 token 前后空格，并过滤空 token", () => {
      expect(filterTableNames(sampleTables, " , user ,  , order , ")).toEqual(["users", "user_profiles", "orders", "order_items"]);
    });

    it("纯逗号输入应等同于空查询返回全部表", () => {
      expect(filterTableNames(sampleTables, ",,,")).toEqual(sampleTables);
      expect(filterTableNames(sampleTables, " , ， ,  ")).toEqual(sampleTables);
      expect(matchTableFilter("users", ",,,")).toBe(true);
    });

    it("matchTableFilter 对逗号分隔条件的判断", () => {
      expect(matchTableFilter("users", "user, order")).toBe(true);
      expect(matchTableFilter("orders", "user, order")).toBe(true);
      expect(matchTableFilter("products", "user, order")).toBe(false);
    });
  });

  describe("正则表达式支持 (Regular Expression Queries)", () => {
    it("匹配以指定前缀开头的表 /^user/", () => {
      const result = filterTableNames(sampleTables, "/^user/");
      expect(result).toEqual(["users", "user_profiles"]);
    });

    it("匹配以特定后缀结尾的表 /_bak$/i", () => {
      const result = filterTableNames(sampleTables, "/_bak$/i");
      expect(result).toEqual(["accounts_bak"]);
    });

    it("大小写 flags 显式指定与默认 flags", () => {
      // 显式带 i
      expect(filterTableNames(sampleTables, "/product/i")).toEqual(["products", "PRODUCT_TAGS"]);
      // 默认不区分大小写，自动应用 i
      expect(filterTableNames(sampleTables, "/product/")).toEqual(["products", "PRODUCT_TAGS"]);
      // 当 options.caseSensitive 为 true 且正则未声明 i 时区分大小写
      expect(filterTableNames(sampleTables, "/product/", { caseSensitive: true })).toEqual(["products"]);
    });

    it("逗号分隔中混合使用正则与普通关键词", () => {
      const result = filterTableNames(sampleTables, "/^user/, order, /_bak$/");
      expect(result).toEqual(["users", "user_profiles", "orders", "order_items", "accounts_bak"]);
    });

    it("正则中包含逗号的整体匹配模式，如 /(user|order)/", () => {
      const result = filterTableNames(sampleTables, "/(user|order)/");
      expect(result).toEqual(["users", "user_profiles", "orders", "order_items"]);
    });

    it("过滤有状态标志 g 与 y，避免 test() 产生 lastIndex 状态异常", () => {
      // g flag 会被清除，确保连续调用或多次过滤时行为稳定
      const regexQuery = "/user/g";
      expect(filterTableNames(sampleTables, regexQuery)).toEqual(["users", "user_profiles"]);
      expect(filterTableNames(sampleTables, regexQuery)).toEqual(["users", "user_profiles"]);
    });
  });

  describe("非法与不完整正则表达式的安全降级容错 (Fault-tolerant Fallback)", () => {
    it("未闭合的字符集 /[abc/ 自动降级为普通模糊包含，不抛出异常", () => {
      expect(() => filterTableNames(sampleTables, "/[abc/")).not.toThrow();
      expect(filterTableNames(["test/[abc/1", "normal"], "/[abc/")).toEqual(["test/[abc/1"]);
    });

    it("不匹配的括号 /( 或 /(/ 自动降级为普通模糊包含，不抛出异常", () => {
      expect(() => filterTableNames(sampleTables, "/(")).not.toThrow();
      expect(() => filterTableNames(sampleTables, "/(/")).not.toThrow();
      expect(filterTableNames(["tbl/(1", "tbl_2"], "/(")).toEqual(["tbl/(1"]);
    });

    it("带有非法 flag 的模式如 /user/xyz 自动降级为普通包含", () => {
      expect(() => filterTableNames(sampleTables, "/user/xyz")).not.toThrow();
      expect(filterTableNames(["/user/xyz_test", "other"], "/user/xyz")).toEqual(["/user/xyz_test"]);
    });

    it("孤立的反斜杠 /\\/ 或 /[a-/ 等不合法语法平滑处理", () => {
      expect(() => filterTableNames(sampleTables, "/\\/")).not.toThrow();
      expect(() => filterTableNames(sampleTables, "/[a-/")).not.toThrow();
      expect(() => matchTableFilter("users", "/[a-/")).not.toThrow();
    });

    it("单斜杠或非正则斜杠格式降级为普通文本搜索", () => {
      expect(filterTableNames(["path/to/table", "other"], "/")).toEqual(["path/to/table"]);
      expect(filterTableNames(["path/to/table", "other"], "path/to")).toEqual(["path/to/table"]);
    });
  });

  describe("边界与极端情况测试 (Edge & Extreme Cases)", () => {
    it("空表名列表输入", () => {
      expect(filterTableNames([], "users")).toEqual([]);
      expect(filterTableNames([], "")).toEqual([]);
    });

    it("超长查询字符串安全处理", () => {
      const longQuery = "a".repeat(1000);
      expect(() => filterTableNames(sampleTables, longQuery)).not.toThrow();
      expect(filterTableNames(sampleTables, longQuery)).toEqual([]);
    });

    it("超多逗号与连续空格", () => {
      const crazyQuery = ", , ,  ,  user  , , ,  order  , , ,";
      expect(filterTableNames(sampleTables, crazyQuery)).toEqual(["users", "user_profiles", "orders", "order_items"]);
    });

    it("包含特殊正则字符的普通字符串不会被误认为是正则表达式", () => {
      // 没有前后斜杠，只是含有 ^, $, *, +
      expect(filterTableNames(sampleTables, "^user")).toEqual([]);
      expect(filterTableNames(sampleTables, "*char")).toEqual(["special*char"]);
      expect(filterTableNames(sampleTables, "[table]")).toEqual(["test[table]"]);
    });
  });
});
