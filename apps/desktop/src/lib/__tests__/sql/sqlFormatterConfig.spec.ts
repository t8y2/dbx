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

  it("recognizes DBX positional and named parameter syntaxes by default", () => {
    expect(sqlFormatterOptions({}).paramTypes).toEqual({
      positional: true,
      named: [":", "@"],
      custom: [{ regex: String.raw`\$\{[^}]+\}` }, { regex: String.raw`#\{[^}]+\}` }],
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

  it("defaults empty-line preservation off and serializes an explicit opt-in", () => {
    const defaultConfig = JSON.parse(serializeSqlFormatterConfig({}));
    const optIn = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { preserveEmptyLines: true } }));

    expect(defaultConfig.options.preserveEmptyLines).toBe(false);
    expect(optIn).toEqual(expect.objectContaining({ ok: true }));
    if (optIn.ok) expect(optIn.settings.preserveEmptyLines).toBe(true);
  });

  it("defaults commaPosition to after and accepts before", () => {
    const defaultConfig = JSON.parse(serializeSqlFormatterConfig({}));
    expect(defaultConfig.options.commaPosition).toBe("after");

    const beforeResult = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { commaPosition: "before" } }));
    expect(beforeResult).toEqual(expect.objectContaining({ ok: true }));
    if (beforeResult.ok) expect(beforeResult.settings.commaPosition).toBe("before");
    expect(JSON.parse(serializeSqlFormatterConfig({ commaPosition: "before" })).options.commaPosition).toBe("before");

    const invalidResult = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { commaPosition: "invalid" } }));
    expect(invalidResult).toEqual(expect.objectContaining({ ok: false }));

    // sqlFormatterOptions must not include commaPosition so third-party sql-formatter does not throw
    expect("commaPosition" in sqlFormatterOptions({ commaPosition: "before" })).toBe(false);
  });
});

describe("sqlFormatterConfig layout style", () => {
  it("defaults to the DBX layout and keeps it out of the sql-formatter options", () => {
    const config = JSON.parse(serializeSqlFormatterConfig({}));

    expect(config.options.layoutStyle).toBe("dbx");
    // layoutStyle is DBX-private: handing it to sql-formatter would throw.
    expect("layoutStyle" in sqlFormatterOptions({ layoutStyle: "classic" })).toBe(false);
  });

  it("round-trips the classic layout style", () => {
    const serialized = JSON.parse(serializeSqlFormatterConfig({ layoutStyle: "classic" }));
    expect(serialized.options.layoutStyle).toBe("classic");

    const parsed = parseSqlFormatterConfig(serializeSqlFormatterConfig({ layoutStyle: "classic" }));
    expect(parsed).toEqual(expect.objectContaining({ ok: true }));
    if (parsed.ok) expect(parsed.settings.layoutStyle).toBe("classic");
  });

  it("rejects a layout style outside the accepted values", () => {
    const result = parseSqlFormatterConfig(JSON.stringify({ version: 2, formatter: "sql-formatter", options: { layoutStyle: "upstream" } }));

    expect(result).toEqual({ ok: false, message: "Invalid formatter option value: layoutStyle." });
  });

  it("accepts both config versions and rejects anything else", () => {
    // Version 1 predates layoutStyle; absence normalizes to the current
    // default and must never be read as a historical choice of classic.
    const version1 = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { keywordCase: "lower" } }));
    expect(version1).toEqual(expect.objectContaining({ ok: true }));
    if (version1.ok) {
      expect(version1.settings.layoutStyle).toBe("dbx");
      expect(version1.settings.keywordCase).toBe("lower");
    }

    expect(parseSqlFormatterConfig(JSON.stringify({ version: 2, formatter: "sql-formatter", options: { layoutStyle: "classic" } }))).toEqual(expect.objectContaining({ ok: true }));
    expect(parseSqlFormatterConfig(JSON.stringify({ version: 3, formatter: "sql-formatter", options: {} }))).toEqual({ ok: false, message: "Unsupported config version." });
  });
});
