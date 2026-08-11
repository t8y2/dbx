import { describe, expect, it } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS, parseSqlFormatterConfig, serializeSqlFormatterConfig, sqlFormatterOptions } from "@/lib/sql/sqlFormatterConfig";

describe("sqlFormatterConfig shortcut storage", () => {
  it("does not serialize JSON editor shortcut settings", () => {
    const config = JSON.parse(serializeSqlFormatterConfig(DEFAULT_SQL_FORMATTER_SETTINGS));

    expect(config.editor).toBeUndefined();
  });

  it("ignores legacy JSON editor shortcut settings on import", () => {
    const result = parseSqlFormatterConfig(
      JSON.stringify({
        version: 1,
        formatter: "sql-formatter",
        options: {},
        editor: {
          scope: "legacyJsonEditorScope",
          shortcuts: [{ id: "unknownLegacyShortcut", enabled: "yes" }],
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("merges DBX custom parameter types with user paramTypes", () => {
    const options = sqlFormatterOptions({
      paramTypes: {
        positional: false,
        named: ["@"],
        custom: [{ regex: String.raw`\{\{[^}]+\}\}` }],
      },
    });

    expect(options.paramTypes).toEqual({
      positional: false,
      named: ["@"],
      custom: [{ regex: String.raw`\{\{[^}]+\}\}` }, { regex: String.raw`\$\{[^}]+\}` }, { regex: String.raw`#\{[^}]+\}` }],
    });
  });

  it("accepts the same-line logical operator mode", () => {
    const result = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { logicalOperatorNewline: "none" } }));

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) expect(result.settings.logicalOperatorNewline).toBe("none");
    expect(sqlFormatterOptions({ logicalOperatorNewline: "none" }).logicalOperatorNewline).toBe("before");
  });

  it("accepts and serializes the FROM clause layout", () => {
    const result = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { fromClauseLayout: "sameLine" } }));

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) expect(result.settings.fromClauseLayout).toBe("sameLine");
    expect(JSON.parse(serializeSqlFormatterConfig({ fromClauseLayout: "sameLine" })).options.fromClauseLayout).toBe("sameLine");
  });
});
