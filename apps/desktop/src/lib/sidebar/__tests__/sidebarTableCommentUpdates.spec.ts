import { describe, expect, it } from "vitest";
import { createSidebarTableCommentUpdates, patchSidebarTableCommentScopes, type SidebarTableCommentUpdate } from "@/lib/sidebar/sidebarTableCommentUpdates";
import type { SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import type { TableInfo } from "@/types/database";

const scope = { connectionId: "conn", database: "app", schema: "sales", catalog: "catalog-a" };
const update: SidebarTableCommentUpdate = { ...scope, revision: 1, tableName: "orders", comment: null };

describe("sidebar table comment updates", () => {
  it("clears only the matching table across same-name schemas and catalogs without mutating inputs", () => {
    const entries: TableInfo[] = [
      { name: "orders", table_type: "BASE TABLE", schema: "sales", comment: "old comment" },
      { name: "orders", table_type: "BASE TABLE", schema: "audit", comment: "audit comment" },
      { name: "orders", table_type: "VIEW", schema: "sales", comment: "view comment" },
    ];
    const scopes: SidebarRegexIndexScope[] = [
      { ...scope, parentNodeId: "sales", nodeType: "schema", entries },
      { ...scope, catalog: "catalog-b", parentNodeId: "other-catalog", nodeType: "schema", entries },
      { ...scope, schema: "audit", parentNodeId: "audit", nodeType: "schema", entries: [{ name: "orders", table_type: "TABLE", comment: "other schema" }] },
    ];
    const original = structuredClone(scopes);

    const patched = patchSidebarTableCommentScopes(scopes, [update]);

    expect(patched[0]?.entries.map((entry) => entry.comment)).toEqual([null, "audit comment", "view comment"]);
    expect(patched[1]).toBe(scopes[1]);
    expect(patched[2]).toBe(scopes[2]);
    expect(scopes).toEqual(original);
  });

  it("protects an in-flight read while allowing a later database read to report a newer comment", () => {
    const updates = createSidebarTableCommentUpdates();
    const pendingRead = updates.begin();
    const staleRows: TableInfo[] = [{ name: "orders", table_type: "TABLE", comment: "old comment" }];

    updates.record(update);
    expect(pendingRead.patchEntries(scope, staleRows)[0]?.comment).toBeNull();
    expect(staleRows[0]?.comment).toBe("old comment");
    pendingRead.finish();

    // The next read starts after the refresh and must trust its newer DB row.
    const laterRead = updates.begin();
    const freshRows: TableInfo[] = [{ name: "orders", table_type: "TABLE", comment: "changed again in database" }];
    expect(laterRead.patchEntries(scope, freshRows)).toBe(freshRows);
    laterRead.finish();
  });
});
