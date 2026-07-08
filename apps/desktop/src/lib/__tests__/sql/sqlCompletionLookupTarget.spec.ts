import { describe, expect, it } from "vitest";
import { resolveSqlCompletionTableLookupTarget } from "@/lib/sql/sqlCompletionLookupTarget";

describe("sqlCompletionLookupTarget", () => {
  it("treats qualified table completion as a database lookup for MySQL-compatible engines", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "default_db",
      supportsDatabaseQualifier: true,
      completionContext: {
        qualifier: "game_data",
        prefix: "",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "game_data",
      filter: "",
      qualifierDatabase: "game_data",
    });
  });

  it("preserves the known database casing when the qualifier matches locally", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "default_db",
      supportsDatabaseQualifier: true,
      knownDatabases: ["Game_Data"],
      completionContext: {
        qualifier: "game_data",
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "Game_Data",
      filter: "ord",
      qualifierDatabase: "Game_Data",
    });
  });

  it("keeps schema-aware qualified table completion scoped to the schema", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "app",
      currentSchema: "public",
      supportsDatabaseQualifier: false,
      completionContext: {
        qualifier: "sales",
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "app",
      schema: "sales",
      filter: "ord",
    });
  });

  it("uses the current schema for unqualified table completion", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "app",
      currentSchema: "public",
      supportsDatabaseQualifier: true,
      completionContext: {
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "app",
      schema: "public",
      filter: "ord",
    });
  });
});
