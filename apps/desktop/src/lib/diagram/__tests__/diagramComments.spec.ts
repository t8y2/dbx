import { describe, expect, it } from "vitest";
import { CARD_BOTTOM_PADDING, CARD_HEADER_HEIGHT, COLUMN_ROW_HEIGHT, COMMENT_LINE_HEIGHT, diagramTableCardHeight, diagramVisibleColumns, tableCardHeight } from "@/lib/diagram/diagram-constants";
import type { DiagramTable } from "@/lib/diagram/erDiagram";

function table(overrides: Partial<DiagramTable> = {}): DiagramTable {
  return {
    name: "copy_src",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar(64)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
    ...overrides,
  };
}

describe("diagramTableCardHeight", () => {
  it("matches the plain card height when nothing has a comment", () => {
    expect(diagramTableCardHeight(table())).toBe(tableCardHeight(2));
    expect(diagramTableCardHeight(table())).toBe(CARD_HEADER_HEIGHT + 2 * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING);
  });

  it("adds one line for the table comment", () => {
    expect(diagramTableCardHeight(table({ comment: "订单主表" }))).toBe(tableCardHeight(2) + COMMENT_LINE_HEIGHT);
  });

  it("adds one line per commented column", () => {
    const commented = table({
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "主键ID" },
        { name: "name", data_type: "varchar(64)", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "下单人" },
      ],
    });
    expect(diagramTableCardHeight(commented)).toBe(tableCardHeight(2) + 2 * COMMENT_LINE_HEIGHT);

    const withTableComment = table({ ...commented, comment: "测试用表" });
    expect(diagramTableCardHeight(withTableComment)).toBe(tableCardHeight(2) + 3 * COMMENT_LINE_HEIGHT);
  });

  it("ignores blank and missing comments", () => {
    const blank = table({
      comment: "   ",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "" },
        { name: "name", data_type: "varchar(64)", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "\n" },
      ],
    });
    expect(diagramTableCardHeight(blank)).toBe(tableCardHeight(2));
    expect(diagramTableCardHeight(table({ comment: null }))).toBe(tableCardHeight(2));
  });

  it("does not count columns marked for DROP COLUMN", () => {
    const dropped = table({
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "主键ID" },
        { name: "note", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "备注" },
      ],
      droppedColumnNames: ["note"],
    });
    expect(diagramVisibleColumns(dropped).map((column) => column.name)).toEqual(["id"]);
    expect(diagramTableCardHeight(dropped)).toBe(tableCardHeight(2) + COMMENT_LINE_HEIGHT);
  });

  it("honours caller-supplied card metrics", () => {
    const commented = table({ comment: "备注" });
    expect(diagramTableCardHeight(commented, { cardHeaderHeight: 44, columnRowHeight: 24, cardBottomPadding: 12, commentLineHeight: 10 })).toBe(tableCardHeight(2) + 10);
    expect(tableCardHeight(3, { columnRowHeight: 10 })).toBe(CARD_HEADER_HEIGHT + 30 + CARD_BOTTOM_PADDING);
  });
});
