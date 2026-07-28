import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { usesOracleSessionCompletionColumns } from "@/lib/sql/oracleCompletionSession";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");

describe("Oracle session-scoped completion", () => {
  it("uses the tab session only for unqualified references without a selected schema", () => {
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle", clientSessionId: "tab-a" })).toBe(true);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle", clientSessionId: "tab-a", referenceSchema: "REPORTING" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle", clientSessionId: "tab-a", selectedSchema: "REPORTING" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "postgres", clientSessionId: "tab-a" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle" })).toBe(false);
  });

  it("passes tab context into QueryEditor and clears local caches when the tab or context changes", () => {
    expect(contentAreaSource).toContain(':client-session-id="activeTab.id"');
    expect(contentAreaSource).toContain(':completion-context-version="activeTab.completionContextVersion"');
    expect(queryEditorSource).toMatch(/watch\(\s*\[\(\) => props\.clientSessionId, \(\) => props\.completionContextVersion\][\s\S]*?refreshCompletionCache\(\)/);
  });
});
