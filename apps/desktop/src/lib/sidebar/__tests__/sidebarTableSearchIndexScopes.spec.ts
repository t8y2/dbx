// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sidebarTableSearchIndexScopes } from "@/lib/sidebar/sidebarTableSearchIndex";

const MAX = 200;

describe("table search index scopes", () => {
  it("queries and attributes an explicit schema scope", () => {
    expect(sidebarTableSearchIndexScopes({ schema: "public", database: "app", children: [] }, MAX)).toEqual([{ schema: "public", attributeSchema: true }]);
  });

  it("attributes every loaded schema child", () => {
    const parent = {
      database: "app",
      children: [
        { type: "schema", schema: "public" },
        { type: "schema", schema: "sales" },
        { type: "table", schema: "ignored" },
      ],
    };
    expect(sidebarTableSearchIndexScopes(parent, MAX)).toEqual([
      { schema: "public", attributeSchema: true },
      { schema: "sales", attributeSchema: true },
    ]);
  });

  it("stays unattributed when a database has more schemas than the build may walk", () => {
    const children = Array.from({ length: 3 }, (_, index) => ({ type: "schema", schema: `s${index}` }));
    expect(sidebarTableSearchIndexScopes({ database: "app", children }, 2)).toEqual([{ schema: "app", attributeSchema: false }]);
  });

  /**
   * #14736: database-only drivers (MySQL and friends) have no schema level in the
   * tree, so the index may query with the database name but must not stamp it onto
   * rows. Stamping used to diverge the indexed node id from the live one, and the
   * sidebar then drew the same table twice.
   */
  it("queries the database name without attributing it as a schema", () => {
    expect(sidebarTableSearchIndexScopes({ database: "new_tv", children: [] }, MAX)).toEqual([{ schema: "new_tv", attributeSchema: false }]);
  });

  it("returns nothing without a database context", () => {
    expect(sidebarTableSearchIndexScopes({ children: [] }, MAX)).toEqual([]);
  });
});
