import { describe, expect, it } from "vitest";
import { isXuguPublicSynonymScope, isXuguPublicSynonymTreeNode, sortXuguSchemaInfos, XUGU_PUBLIC_SYNONYM_SCOPE, xuguSchemaDisplayName } from "@/lib/sidebar/xuguPublicSynonyms";
import { compareSidebarNames } from "@/lib/database/databaseTree";

describe("Xugu public synonym scope", () => {
  it("uses an independent protocol identity", () => {
    expect(XUGU_PUBLIC_SYNONYM_SCOPE).not.toBe("GUEST");
    expect(XUGU_PUBLIC_SYNONYM_SCOPE.startsWith("\u0000")).toBe(true);
    expect(isXuguPublicSynonymScope(XUGU_PUBLIC_SYNONYM_SCOPE)).toBe(true);
    expect(isXuguPublicSynonymScope("GUEST")).toBe(false);
    expect(isXuguPublicSynonymScope("__DBX_XUGU_PUBLIC_SYNONYMS__")).toBe(false);
  });

  it("only replaces the reserved key for display", () => {
    expect(xuguSchemaDisplayName(XUGU_PUBLIC_SYNONYM_SCOPE)).toBe("Public synonyms");
    expect(xuguSchemaDisplayName("GUEST")).toBe("GUEST");
    expect(xuguSchemaDisplayName("AppSchema")).toBe("AppSchema");
  });

  it("identifies only the synthetic Xugu schema tree node", () => {
    expect(isXuguPublicSynonymTreeNode("xugu", "schema", XUGU_PUBLIC_SYNONYM_SCOPE)).toBe(true);
    expect(isXuguPublicSynonymTreeNode("xugu", "schema", "__DBX_XUGU_PUBLIC_SYNONYMS__")).toBe(false);
    expect(isXuguPublicSynonymTreeNode("postgres", "schema", XUGU_PUBLIC_SYNONYM_SCOPE)).toBe(false);
    expect(isXuguPublicSynonymTreeNode("xugu", "database", XUGU_PUBLIC_SYNONYM_SCOPE)).toBe(false);
  });

  it("keeps the public synonym scope after every real schema", () => {
    const schemas = [
      { name: XUGU_PUBLIC_SYNONYM_SCOPE, comment: null },
      { name: "SYSDBA", comment: null },
      { name: "AppSchema", comment: null },
      { name: "GUEST", comment: null },
    ];

    expect(sortXuguSchemaInfos(schemas, compareSidebarNames).map((schema) => schema.name)).toEqual(["AppSchema", "GUEST", "SYSDBA", XUGU_PUBLIC_SYNONYM_SCOPE]);
  });

  it("does not treat the real GUEST schema as a public-synonym scope", () => {
    const schemas = [{ name: "GUEST" }, { name: XUGU_PUBLIC_SYNONYM_SCOPE }];
    expect(sortXuguSchemaInfos(schemas, compareSidebarNames).map((schema) => schema.name)).toEqual(["GUEST", XUGU_PUBLIC_SYNONYM_SCOPE]);
  });
});
