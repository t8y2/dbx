import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES, enabledSqlParameterSyntaxes, normalizeSqlVariableSyntaxOverrides, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";

describe("resolveSqlVariableSyntaxToggles", () => {
  it("enables every syntax when there are no overrides", () => {
    expect(resolveSqlVariableSyntaxToggles(undefined, "mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
    expect(resolveSqlVariableSyntaxToggles({}, "mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("enables every syntax for a database type without an entry", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { shell: false } }, "postgres")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("enables every syntax when the database type is unknown", () => {
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
    });
  });
});

describe("enabledSqlParameterSyntaxes", () => {
  it("returns the five placeholder syntaxes and never atSet", () => {
    expect(enabledSqlParameterSyntaxes(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES)).toEqual(["positional", "named", "shell", "mybatis", "sqlserver"]);
  });

  it("filters out disabled placeholder syntaxes", () => {
    expect(enabledSqlParameterSyntaxes({ positional: false, named: true, shell: false, mybatis: true, sqlserver: false, atSet: true })).toEqual(["named", "mybatis"]);
  });

  it("ignores the atSet toggle entirely", () => {
    expect(enabledSqlParameterSyntaxes({ positional: true, named: true, shell: true, mybatis: true, sqlserver: true, atSet: false })).toEqual(["positional", "named", "shell", "mybatis", "sqlserver"]);
    expect(enabledSqlParameterSyntaxes({ positional: false, named: false, shell: false, mybatis: false, sqlserver: false, atSet: true })).toEqual([]);
  });
});

describe("normalizeSqlVariableSyntaxOverrides", () => {
  it("returns an empty object for non-object input", () => {
    expect(normalizeSqlVariableSyntaxOverrides(undefined)).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides(null)).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides([])).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides("mysql")).toEqual({});
  });

  it("keeps only syntaxes explicitly set to false", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { positional: true, shell: false, atSet: false } })).toEqual({ mysql: { shell: false, atSet: false } });
  });

  it("drops entries with no disabled syntaxes", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { positional: true }, postgres: {} })).toEqual({});
  });

  it("ignores non-boolean values and unknown keys", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { shell: "false", named: 0, bogus: false, sqlserver: false } })).toEqual({ mysql: { sqlserver: false } });
  });

  it("skips non-object database entries", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: null, postgres: [], sqlserver: { shell: false } })).toEqual({ sqlserver: { shell: false } });
  });

  it("is stable across a round-trip", () => {
    const normalized = normalizeSqlVariableSyntaxOverrides({ mysql: { shell: false }, oracle: { atSet: false, named: false } });
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
