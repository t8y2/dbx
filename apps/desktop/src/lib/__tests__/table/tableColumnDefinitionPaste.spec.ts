import { describe, expect, it } from "vitest";
import { createPastedColumnDrafts, parseTableColumnDefinitions } from "@/lib/table/tableColumnDefinitionPaste";

describe("table column paste default literals", () => {
  it.each([
    ["FLOAT", "1e3"],
    ["DOUBLE", "-1.2E-3"],
    ["FLOAT", "+.5e+3"],
    ["FLOAT", ".5e-3"],
    ["DOUBLE", "1.e3"],
    ["DECIMAL(10,2)", ".5"],
    ["DECIMAL(10,2)", "-.5"],
    ["DECIMAL(10,2)", "1."],
    ["BIGINT UNSIGNED", "18446744073709551615"],
    ["BIT(1)", "b'0'"],
    ["BIT(4)", "B'0010'"],
    ["BIT(4)", "0b0010"],
    ["FLOAT", "(1e3 + .5e-3)"],
    ["BIT(4)", "(b'01' | 0b10)"],
  ])("preserves %s DEFAULT %s in a mixed batch and its drafts", (type, value) => {
    const result = parseTableColumnDefinitions(`id INT DEFAULT 0, value ${type} DEFAULT ${value} COMMENT 'Value', created_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
    expect(result.diagnostics).toEqual([]);
    expect(result.columns).toHaveLength(3);
    expect(result.columns[1]).toMatchObject({ dataType: type, defaultValue: value, comment: "Value" });
    let id = 0;
    const drafts = createPastedColumnDrafts(result.columns, () => String(++id));
    expect(drafts[1]).toMatchObject({ id: "new:2", defaultValue: value });
    expect(drafts[1].original).toBeUndefined();
  });

  it.each(["1e", "1e+", "1.2.3", ".", "1 e3", "1/* gap */e3", ". 5", "b'02'", "b '0'", "0b2", "0b 01", "1; DROP TABLE users", "(1e3 +)", "(. 5)", "(1e+)"])("rejects malformed or separated literal %s atomically", (value) => {
    const result = parseTableColumnDefinitions(`id INT, value FLOAT DEFAULT ${value}`);
    expect(result.columns).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("still accepts the issue example and rejects duplicate names", () => {
    const sql = `create_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      update_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
      delete_time INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '删除时间，Unix秒级时间戳，0表示未删除',
      created_by BIGINT NULL COMMENT '创建操作人ID',
      updated_by BIGINT NULL COMMENT '最后修改操作人ID'`;
    const result = parseTableColumnDefinitions(sql);
    expect(result.diagnostics).toEqual([]);
    expect(result.columns).toHaveLength(5);
    expect(result.columns[1].extra.onUpdateCurrentTimestamp).toBe(true);
    expect(parseTableColumnDefinitions(sql, ["CREATE_TIME"])).toMatchObject({ columns: [], diagnostics: [{ code: "duplicate" }] });
  });
});
