import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES, enabledSqlParameterSyntaxes, normalizeSqlVariableSyntaxOverrides, resolveSqlVariableSyntaxToggles, sqlVariableSyntaxKeysForDatabase } from "@/lib/sql/sqlVariableSyntax";

describe("resolveSqlVariableSyntaxToggles", () => {
  it("uses the backward-compatible defaults when there are no overrides", () => {
    expect(resolveSqlVariableSyntaxToggles(undefined, "mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
    expect(resolveSqlVariableSyntaxToggles({}, "mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("uses the defaults for a database type without an entry", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { shell: false } }, "postgres")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("uses the defaults when the database type is unknown", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { shell: false } }, undefined)).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("applies only the disabled syntaxes for the matching database type", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { sqlserver: false, atSet: false } }, "mysql")).toEqual({
      positional: true,
      named: true,
      shell: true,
      mybatis: true,
      sqlserver: false,
      atSet: false,
      replaceInsideQuotes: false,
      ansiQuotes: false,
      noBackslashEscapes: false,
    });
  });

  it("enables quoted interpolation only for an explicit per-database opt-in", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { replaceInsideQuotes: true } }, "mysql").replaceInsideQuotes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ mysql: { replaceInsideQuotes: true } }, "postgres").replaceInsideQuotes).toBe(false);
  });

  it("applies NO_BACKSLASH_ESCAPES only to compatible database types", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { noBackslashEscapes: true } }, "mysql").noBackslashEscapes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ doris: { noBackslashEscapes: true } }, "doris").noBackslashEscapes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ starrocks: { noBackslashEscapes: true } }, "starrocks").noBackslashEscapes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ postgres: { noBackslashEscapes: true } }, "postgres").noBackslashEscapes).toBe(false);
  });

  it("applies ANSI_QUOTES only to compatible database types", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { ansiQuotes: true } }, "mysql").ansiQuotes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ doris: { ansiQuotes: true } }, "doris").ansiQuotes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ starrocks: { ansiQuotes: true } }, "starrocks").ansiQuotes).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({ postgres: { ansiQuotes: true } }, "postgres").ansiQuotes).toBe(false);
  });

  it("shows the SQL mode compatibility setting only for supported database types", () => {
    expect(sqlVariableSyntaxKeysForDatabase("mysql")).toContain("ansiQuotes");
    expect(sqlVariableSyntaxKeysForDatabase("mysql")).toContain("noBackslashEscapes");
    expect(sqlVariableSyntaxKeysForDatabase("doris")).toContain("ansiQuotes");
    expect(sqlVariableSyntaxKeysForDatabase("doris")).toContain("noBackslashEscapes");
    expect(sqlVariableSyntaxKeysForDatabase("starrocks")).toContain("ansiQuotes");
    expect(sqlVariableSyntaxKeysForDatabase("starrocks")).toContain("noBackslashEscapes");
    expect(sqlVariableSyntaxKeysForDatabase("postgres")).not.toContain("ansiQuotes");
    expect(sqlVariableSyntaxKeysForDatabase("postgres")).not.toContain("noBackslashEscapes");
  });
});

describe("enabledSqlParameterSyntaxes", () => {
  it("returns the five placeholder syntaxes and never atSet", () => {
    expect(enabledSqlParameterSyntaxes(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES)).toEqual(["positional", "named", "shell", "mybatis", "sqlserver"]);
  });

  it("filters out disabled placeholder syntaxes", () => {
    expect(enabledSqlParameterSyntaxes({ positional: false, named: true, shell: false, mybatis: true, sqlserver: false, atSet: true, replaceInsideQuotes: true, ansiQuotes: true, noBackslashEscapes: true })).toEqual(["named", "mybatis"]);
  });

  it("ignores the atSet toggle entirely", () => {
    expect(enabledSqlParameterSyntaxes({ positional: true, named: true, shell: true, mybatis: true, sqlserver: true, atSet: false, replaceInsideQuotes: true, ansiQuotes: true, noBackslashEscapes: true })).toEqual(["positional", "named", "shell", "mybatis", "sqlserver"]);
    expect(enabledSqlParameterSyntaxes({ positional: false, named: false, shell: false, mybatis: false, sqlserver: false, atSet: true, replaceInsideQuotes: false, ansiQuotes: false, noBackslashEscapes: false })).toEqual([]);
  });
});

describe("normalizeSqlVariableSyntaxOverrides", () => {
  it("returns an empty object for non-object input", () => {
    expect(normalizeSqlVariableSyntaxOverrides(undefined)).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides(null)).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides([])).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides("mysql")).toEqual({});
  });

  it("keeps only values that differ from their defaults", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { positional: true, shell: false, atSet: false, replaceInsideQuotes: true, ansiQuotes: true } })).toEqual({
      mysql: { shell: false, atSet: false, replaceInsideQuotes: true, ansiQuotes: true },
    });
  });

  it("drops entries containing only default values", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { positional: true, replaceInsideQuotes: false }, postgres: {} })).toEqual({});
  });

  it("keeps NO_BACKSLASH_ESCAPES only for compatible database types", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { noBackslashEscapes: true }, doris: { noBackslashEscapes: true }, postgres: { noBackslashEscapes: true } })).toEqual({
      mysql: { noBackslashEscapes: true },
      doris: { noBackslashEscapes: true },
    });
  });

  it("keeps ANSI_QUOTES only for compatible database types", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { ansiQuotes: true }, starrocks: { ansiQuotes: true }, postgres: { ansiQuotes: true } })).toEqual({
      mysql: { ansiQuotes: true },
      starrocks: { ansiQuotes: true },
    });
  });

  it("ignores non-boolean values and unknown keys", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { shell: "false", named: 0, bogus: false, sqlserver: false } })).toEqual({ mysql: { sqlserver: false } });
  });

  it("skips non-object database entries", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: null, postgres: [], sqlserver: { shell: false } })).toEqual({ sqlserver: { shell: false } });
  });

  it("is stable across a round-trip", () => {
    const normalized = normalizeSqlVariableSyntaxOverrides({ mysql: { shell: false, replaceInsideQuotes: true }, oracle: { atSet: false, named: false } });
    expect(normalizeSqlVariableSyntaxOverrides(normalized)).toEqual(normalized);
  });

  it("reads through a Vue reactive proxy without throwing (settings store is reactive; structuredClone would throw DataCloneError here)", () => {
    const overrides = reactive({ mysql: { shell: false, atSet: false } });
    const cloned = normalizeSqlVariableSyntaxOverrides(overrides);
    expect(cloned).toEqual({ mysql: { shell: false, atSet: false } });
    // Detached from the reactive source: mutating the clone must not touch the proxy.
    cloned.mysql = {};
    expect(overrides.mysql).toEqual({ shell: false, atSet: false });
  });
});
