import { describe, expect, it } from "vitest";
import { buildCustomTypeTreeChildren } from "@/lib/sidebar/customTypeTree";
import type { CustomTypeDetails, TreeNode } from "@/types/database";

const parent: TreeNode = {
  id: "c:db:app:types:status",
  label: "status",
  type: "type",
  connectionId: "c",
  database: "db",
  schema: "app",
};

function details(overrides: Partial<CustomTypeDetails>): CustomTypeDetails {
  return {
    name: "status",
    schema: "app",
    kind: "enum",
    members: [],
    properties: { domainConstraints: [] },
    ...overrides,
  };
}

describe("custom type sidebar tree", () => {
  it("builds composite fields with their data types", () => {
    const children = buildCustomTypeTreeChildren(parent, details({ kind: "composite", members: [{ name: "city", dataType: "text", ordinal: 1 }] }));

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ id: "c:db:app:types:status:type-member:field:city", label: "city", type: "type-member", meta: { kind: "field", displayValue: "text", ordinal: 1 } });
  });

  it("builds enum values in backend order", () => {
    const children = buildCustomTypeTreeChildren(
      parent,
      details({
        members: [
          { name: "", dataType: "", ordinal: 1, enumValue: "draft" },
          { name: "", dataType: "", ordinal: 2, enumValue: "published" },
        ],
      }),
    );

    expect(children.map((child) => child.label)).toEqual(["draft", "published"]);
    expect(children.map((child) => child.id)).toEqual(["c:db:app:types:status:type-member:enum-value:draft", "c:db:app:types:status:type-member:enum-value:published"]);
  });

  it("keeps existing member IDs stable when a new member is inserted", () => {
    const before = buildCustomTypeTreeChildren(
      parent,
      details({
        members: [
          { name: "", dataType: "", ordinal: 1, enumValue: "draft" },
          { name: "", dataType: "", ordinal: 2, enumValue: "published" },
        ],
      }),
    );
    const after = buildCustomTypeTreeChildren(
      parent,
      details({
        members: [
          { name: "", dataType: "", ordinal: 1, enumValue: "new" },
          { name: "", dataType: "", ordinal: 2, enumValue: "draft" },
          { name: "", dataType: "", ordinal: 3, enumValue: "published" },
        ],
      }),
    );
    expect(after.find((child) => child.label === "draft")?.id).toBe(before.find((child) => child.label === "draft")?.id);
    expect(after.find((child) => child.label === "published")?.id).toBe(before.find((child) => child.label === "published")?.id);
  });

  it("encodes member identity characters in IDs", () => {
    const children = buildCustomTypeTreeChildren(parent, details({ members: [{ name: "", dataType: "text", ordinal: 1, enumValue: "a:b/c" }] }));
    expect(children[0].id).toContain("a%3Ab%2Fc");
  });

  it.each(["domain", "range", "multirange", "base"] as const)("does not add property children for %s types", (kind) => {
    expect(
      buildCustomTypeTreeChildren(
        parent,
        details({
          kind,
          properties: {
            baseType: "text",
            rangeSubtype: "numeric",
            domainConstraints: [{ name: "value_check", definition: "CHECK (VALUE IS NOT NULL)" }],
          },
        }),
      ),
    ).toEqual([]);
  });
});
