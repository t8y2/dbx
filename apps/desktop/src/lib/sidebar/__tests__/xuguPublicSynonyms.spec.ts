import { describe, expect, it } from "vitest";
import { isXuguPublicSynonymScope, XUGU_PUBLIC_SYNONYM_SCOPE, xuguSchemaDisplayName } from "@/lib/sidebar/xuguPublicSynonyms";

describe("Xugu public synonym scope", () => {
  it("uses an independent protocol identity", () => {
    expect(XUGU_PUBLIC_SYNONYM_SCOPE).not.toBe("GUEST");
    expect(isXuguPublicSynonymScope(XUGU_PUBLIC_SYNONYM_SCOPE)).toBe(true);
    expect(isXuguPublicSynonymScope("GUEST")).toBe(false);
  });

  it("only replaces the reserved key for display", () => {
    expect(xuguSchemaDisplayName(XUGU_PUBLIC_SYNONYM_SCOPE)).toBe("Public synonyms");
    expect(xuguSchemaDisplayName("GUEST")).toBe("GUEST");
    expect(xuguSchemaDisplayName("AppSchema")).toBe("AppSchema");
  });
});
