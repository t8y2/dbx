import { describe, expect, it } from "vitest";
import { usesOracleSessionCompletionColumns } from "@/lib/sql/oracleCompletionSession";

describe("Oracle session-scoped completion", () => {
  it("uses the tab session only for unqualified references without a selected schema", () => {
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle", clientSessionId: "tab-a" })).toBe(true);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oceanbase-oracle", clientSessionId: "tab-a" })).toBe(true);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle", clientSessionId: "tab-a", referenceSchema: "REPORTING" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oceanbase-oracle", clientSessionId: "tab-a", referenceSchema: "REPORTING" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle", clientSessionId: "tab-a", selectedSchema: "REPORTING" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oceanbase-oracle", clientSessionId: "tab-a", selectedSchema: "REPORTING" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "postgres", clientSessionId: "tab-a" })).toBe(false);
    expect(usesOracleSessionCompletionColumns({ databaseType: "oracle" })).toBe(false);
  });
});
