import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import {
  DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES,
  defaultSqlVariableSyntaxToggles,
  enabledSqlParameterSyntaxes,
  isApplicableCompatibilityMode,
  isModeDependentSubstitutionDatabase,
  isOracleSubstitutionDatabase,
  normalizeSqlVariableSyntaxOverrides,
  resolveSqlVariableSyntaxToggles,
  updateSqlVariableSyntaxToggle,
} from "@/lib/sql/sqlVariableSyntax";

describe("isModeDependentSubstitutionDatabase", () => {
  it("identifies mode-dependent database types", () => {
    expect(isModeDependentSubstitutionDatabase("opengauss")).toBe(true);
    expect(isModeDependentSubstitutionDatabase("gaussdb")).toBe(true);
    expect(isModeDependentSubstitutionDatabase("kingbase")).toBe(true);
  });

  it("returns false for mode-independent databases or undefined", () => {
    expect(isModeDependentSubstitutionDatabase("oracle")).toBe(false);
    expect(isModeDependentSubstitutionDatabase("postgres")).toBe(false);
    expect(isModeDependentSubstitutionDatabase("mysql")).toBe(false);
    expect(isModeDependentSubstitutionDatabase("sqlserver")).toBe(false);
    expect(isModeDependentSubstitutionDatabase("sqlite")).toBe(false);
    expect(isModeDependentSubstitutionDatabase(undefined)).toBe(false);
  });
});

describe("isApplicableCompatibilityMode", () => {
  it("validates openGauss and GaussDB compatibility modes", () => {
    expect(isApplicableCompatibilityMode("opengauss", "A")).toBe(true);
    expect(isApplicableCompatibilityMode("opengauss", "b")).toBe(true);
    expect(isApplicableCompatibilityMode("gaussdb", "C")).toBe(true);
    expect(isApplicableCompatibilityMode("opengauss", "oracle")).toBe(false);
  });

  it("validates Kingbase compatibility modes", () => {
    expect(isApplicableCompatibilityMode("kingbase", "oracle")).toBe(true);
    expect(isApplicableCompatibilityMode("kingbase", "pg")).toBe(true);
    expect(isApplicableCompatibilityMode("kingbase", "A")).toBe(false);
  });

  it("returns false for non-mode-dependent databases or undefined inputs", () => {
    expect(isApplicableCompatibilityMode("postgres", "pg")).toBe(false);
    expect(isApplicableCompatibilityMode(undefined, "A")).toBe(false);
    expect(isApplicableCompatibilityMode("opengauss", undefined)).toBe(false);
  });
});

describe("isOracleSubstitutionDatabase", () => {
  it("identifies Oracle and Oracle-compatible databases", () => {
    expect(isOracleSubstitutionDatabase("oracle")).toBe(true);
    expect(isOracleSubstitutionDatabase("oceanbase-oracle")).toBe(true);
    expect(isOracleSubstitutionDatabase("dameng")).toBe(true);
    expect(isOracleSubstitutionDatabase("yashandb")).toBe(true);
    expect(isOracleSubstitutionDatabase("oscar")).toBe(true);
  });

  it("checks compatibility modes for openGauss and Kingbase", () => {
    expect(isOracleSubstitutionDatabase("opengauss", "A")).toBe(true);
    expect(isOracleSubstitutionDatabase("opengauss", "a")).toBe(true);
    expect(isOracleSubstitutionDatabase("opengauss", "PG")).toBe(false);
    expect(isOracleSubstitutionDatabase("opengauss", undefined)).toBe(false);

    expect(isOracleSubstitutionDatabase("gaussdb", "A")).toBe(true);
    expect(isOracleSubstitutionDatabase("gaussdb", "B")).toBe(false);

    expect(isOracleSubstitutionDatabase("kingbase", "oracle")).toBe(true);
    expect(isOracleSubstitutionDatabase("kingbase", "ORACLE")).toBe(true);
    expect(isOracleSubstitutionDatabase("kingbase", "pg")).toBe(false);
    expect(isOracleSubstitutionDatabase("kingbase", undefined)).toBe(false);
  });

  it("returns false for non-Oracle database types or undefined", () => {
    expect(isOracleSubstitutionDatabase("mysql")).toBe(false);
    expect(isOracleSubstitutionDatabase("postgres")).toBe(false);
    expect(isOracleSubstitutionDatabase("sqlserver")).toBe(false);
    expect(isOracleSubstitutionDatabase("sqlite")).toBe(false);
    expect(isOracleSubstitutionDatabase(undefined)).toBe(false);
  });
});

describe("defaultSqlVariableSyntaxToggles", () => {
  it("defaults substitution to false for generic, MySQL, PostgreSQL, etc.", () => {
    expect(defaultSqlVariableSyntaxToggles("mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
    expect(defaultSqlVariableSyntaxToggles("postgres")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
    expect(defaultSqlVariableSyntaxToggles("sqlserver")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
    expect(defaultSqlVariableSyntaxToggles(undefined)).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("defaults substitution to true for Oracle-compatible databases", () => {
    expect(defaultSqlVariableSyntaxToggles("oracle").substitution).toBe(true);
    expect(defaultSqlVariableSyntaxToggles("oceanbase-oracle").substitution).toBe(true);
    expect(defaultSqlVariableSyntaxToggles("dameng").substitution).toBe(true);
    expect(defaultSqlVariableSyntaxToggles("yashandb").substitution).toBe(true);
    expect(defaultSqlVariableSyntaxToggles("oscar").substitution).toBe(true);
    expect(defaultSqlVariableSyntaxToggles("opengauss", "A").substitution).toBe(true);
    expect(defaultSqlVariableSyntaxToggles("kingbase", "oracle").substitution).toBe(true);
  });

  it("defaults named to false for Neo4j and NebulaGraph", () => {
    expect(defaultSqlVariableSyntaxToggles("neo4j").named).toBe(false);
    expect(defaultSqlVariableSyntaxToggles("nebula").named).toBe(false);
  });
});

describe("resolveSqlVariableSyntaxToggles", () => {
  it("enables default syntaxes when there are no overrides", () => {
    expect(resolveSqlVariableSyntaxToggles(undefined, "mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
    expect(resolveSqlVariableSyntaxToggles({}, "mysql")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("enables database-specific defaults for Oracle without overrides", () => {
    const oracleToggles = resolveSqlVariableSyntaxToggles(undefined, "oracle");
    expect(oracleToggles.substitution).toBe(true);
    expect(oracleToggles.named).toBe(true);
  });

  it("enables every syntax for a database type without an entry", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { shell: false } }, "postgres")).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("disables SQL-style named parameters for Neo4j patterns", () => {
    const toggles = resolveSqlVariableSyntaxToggles(undefined, "neo4j");
    expect(toggles).toEqual({ ...DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES, named: false });
    expect(enabledSqlParameterSyntaxes(toggles)).not.toContain("named");
    expect(resolveSqlVariableSyntaxToggles({ neo4j: { shell: false } }, "neo4j")).toEqual({ ...toggles, shell: false });
  });

  it("disables SQL named placeholders for NebulaGraph", () => {
    const toggles = resolveSqlVariableSyntaxToggles(undefined, "nebula");
    expect(toggles).toEqual({ ...DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES, named: false });
    expect(enabledSqlParameterSyntaxes(toggles)).not.toContain("named");
    expect(resolveSqlVariableSyntaxToggles(undefined, "mysql").named).toBe(true);
  });

  it("enables default syntaxes when the database type is unknown", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { shell: false } }, undefined)).toEqual(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES);
  });

  it("applies only the overridden syntaxes for the matching database type", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { sqlserver: false, atSet: false } }, "mysql")).toEqual({
      positional: true,
      named: true,
      shell: true,
      mybatis: true,
      sqlserver: false,
      substitution: false,
      atSet: false,
    });
  });

  it("allows user to explicitly override substitution on non-Oracle and Oracle databases", () => {
    // Explicitly enabling substitution on PostgreSQL
    expect(resolveSqlVariableSyntaxToggles({ postgres: { substitution: true } }, "postgres").substitution).toBe(true);
    // Explicitly disabling substitution on Oracle
    expect(resolveSqlVariableSyntaxToggles({ oracle: { substitution: false } }, "oracle").substitution).toBe(false);
  });

  it("disables every syntax when substitution is globally disabled", () => {
    expect(resolveSqlVariableSyntaxToggles({ mysql: { shell: false } }, "mysql", false)).toEqual({
      positional: false,
      named: false,
      shell: false,
      mybatis: false,
      sqlserver: false,
      substitution: false,
      atSet: false,
    });
    expect(resolveSqlVariableSyntaxToggles(undefined, "oracle", false)).toEqual({
      positional: false,
      named: false,
      shell: false,
      mybatis: false,
      sqlserver: false,
      substitution: false,
      atSet: false,
    });
  });

  it("restores per-database overrides when substitution is re-enabled", () => {
    const overrides = { mysql: { shell: false as const, atSet: false as const } };

    resolveSqlVariableSyntaxToggles(overrides, "mysql", false);

    expect(resolveSqlVariableSyntaxToggles(overrides, "mysql", true)).toEqual({
      positional: true,
      named: true,
      shell: false,
      mybatis: true,
      sqlserver: true,
      substitution: false,
      atSet: false,
    });
    expect(overrides).toEqual({ mysql: { shell: false, atSet: false } });
  });
});

describe("enabledSqlParameterSyntaxes", () => {
  it("returns the five default placeholder syntaxes for generic databases and never atSet", () => {
    expect(enabledSqlParameterSyntaxes(DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES)).toEqual(["positional", "named", "shell", "mybatis", "sqlserver"]);
  });

  it("returns all six placeholder syntaxes when substitution is enabled", () => {
    expect(enabledSqlParameterSyntaxes({ ...DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES, substitution: true })).toEqual(["positional", "named", "shell", "mybatis", "sqlserver", "substitution"]);
  });

  it("filters out disabled placeholder syntaxes", () => {
    expect(enabledSqlParameterSyntaxes({ positional: false, named: true, shell: false, mybatis: true, sqlserver: false, substitution: true, atSet: true })).toEqual(["named", "mybatis", "substitution"]);
  });

  it("ignores the atSet toggle entirely", () => {
    expect(enabledSqlParameterSyntaxes({ positional: true, named: true, shell: true, mybatis: true, sqlserver: true, substitution: true, atSet: false })).toEqual(["positional", "named", "shell", "mybatis", "sqlserver", "substitution"]);
    expect(enabledSqlParameterSyntaxes({ positional: false, named: false, shell: false, mybatis: false, sqlserver: false, substitution: false, atSet: true })).toEqual([]);
  });
});

describe("normalizeSqlVariableSyntaxOverrides", () => {
  it("returns an empty object for non-object input", () => {
    expect(normalizeSqlVariableSyntaxOverrides(undefined)).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides(null)).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides([])).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides("mysql")).toEqual({});
  });

  it("keeps only syntaxes that deviate from defaults", () => {
    expect(
      normalizeSqlVariableSyntaxOverrides({
        mysql: { positional: true, shell: false, substitution: false, atSet: false },
        postgres: { substitution: true },
        oracle: { substitution: false, shell: true },
      }),
    ).toEqual({
      mysql: { shell: false, atSet: false },
      postgres: { substitution: true },
      oracle: { substitution: false },
    });
  });

  it("drops entries with no deviating syntaxes", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { positional: true, substitution: false }, postgres: {} })).toEqual({});
    expect(normalizeSqlVariableSyntaxOverrides({ oracle: { positional: true, substitution: true } })).toEqual({});
  });

  it("ignores non-boolean values and unknown keys", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: { shell: "false", named: 0, bogus: false, sqlserver: false } })).toEqual({ mysql: { sqlserver: false } });
  });

  it("skips non-object database entries", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ mysql: null, postgres: [], sqlserver: { shell: false } })).toEqual({ sqlserver: { shell: false } });
  });

  it("is stable across a round-trip", () => {
    const normalized = normalizeSqlVariableSyntaxOverrides({
      mysql: { shell: false },
      postgres: { substitution: true },
      oracle: { atSet: false, substitution: false },
    });
    expect(normalizeSqlVariableSyntaxOverrides(normalized)).toEqual(normalized);
  });

  it("reads through a Vue reactive proxy without throwing (settings store is reactive; structuredClone would throw DataCloneError here)", () => {
    const overrides = reactive({ mysql: { shell: false, atSet: false }, postgres: { substitution: true } });
    const cloned = normalizeSqlVariableSyntaxOverrides(overrides);
    expect(cloned).toEqual({ mysql: { shell: false, atSet: false }, postgres: { substitution: true } });
    // Detached from the reactive source: mutating the clone must not touch the proxy.
    cloned.mysql = {};
    expect(overrides.mysql).toEqual({ shell: false, atSet: false });
  });

  it("preserves explicit substitution: false for mode-dependent databases without compatibility mode", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: false } })).toEqual({ opengauss: { substitution: false } });
    expect(normalizeSqlVariableSyntaxOverrides({ gaussdb: { substitution: false } })).toEqual({ gaussdb: { substitution: false } });
    expect(normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: false } })).toEqual({ kingbase: { substitution: false } });
  });

  it("preserves explicit substitution: true for mode-dependent databases without compatibility mode", () => {
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: true } })).toEqual({ opengauss: { substitution: true } });
    expect(normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: true } })).toEqual({ kingbase: { substitution: true } });
  });

  it("preserves explicit substitution overrides for mode-dependent databases regardless of compatibilityMode", () => {
    // openGauss substitution: false and true are always preserved across A, B, and unspecified modes
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: false } }, "A")).toEqual({ opengauss: { substitution: false } });
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: true } }, "A")).toEqual({ opengauss: { substitution: true } });
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: true } }, "B")).toEqual({ opengauss: { substitution: true } });
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: false } }, "B")).toEqual({ opengauss: { substitution: false } });

    // Kingbase substitution: false and true are always preserved across oracle, pg, and unspecified modes
    expect(normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: false } }, "oracle")).toEqual({ kingbase: { substitution: false } });
    expect(normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: true } }, "oracle")).toEqual({ kingbase: { substitution: true } });
    expect(normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: true } }, "pg")).toEqual({ kingbase: { substitution: true } });
    expect(normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: false } }, "pg")).toEqual({ kingbase: { substitution: false } });
  });

  it("does not let unrelated compatibility modes affect another database type during normalization", () => {
    // openGauss "A" mode must not cause Kingbase substitution: false to be dropped
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: false }, kingbase: { substitution: false } }, "A")).toEqual({
      opengauss: { substitution: false },
      kingbase: { substitution: false },
    });
    // Kingbase "oracle" mode must not cause openGauss substitution: false to be dropped
    expect(normalizeSqlVariableSyntaxOverrides({ opengauss: { substitution: false }, kingbase: { substitution: false } }, "oracle")).toEqual({
      opengauss: { substitution: false },
      kingbase: { substitution: false },
    });
  });

  it("round-trips mode-dependent overrides correctly into resolution", () => {
    const rawSaved = { opengauss: { substitution: false } };
    const normalized = normalizeSqlVariableSyntaxOverrides(rawSaved);
    expect(normalized).toEqual({ opengauss: { substitution: false } });

    // Runtime resolution in A-mode honors the explicit false override
    expect(resolveSqlVariableSyntaxToggles(normalized, "opengauss", true, "A").substitution).toBe(false);

    // Kingbase runtime resolution in oracle mode honors explicit false override
    const kbNormalized = normalizeSqlVariableSyntaxOverrides({ kingbase: { substitution: false } });
    expect(resolveSqlVariableSyntaxToggles(kbNormalized, "kingbase", true, "oracle").substitution).toBe(false);

    // Control: without override, A-mode and oracle-mode default to true
    expect(resolveSqlVariableSyntaxToggles({}, "opengauss", true, "A").substitution).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({}, "kingbase", true, "oracle").substitution).toBe(true);
    expect(resolveSqlVariableSyntaxToggles({}, "postgres", true).substitution).toBe(false);
  });
});

describe("updateSqlVariableSyntaxToggle", () => {
  it("preserves explicit substitution: false for openGauss in B mode when toggling shell", () => {
    // User already saved opengauss.substitution = false.
    // In B-mode, substitution defaults to false. Toggling shell to false must NOT drop substitution: false!
    const initial = { opengauss: { substitution: false } };
    const updated = updateSqlVariableSyntaxToggle(initial, "opengauss", "shell", false, "B");
    expect(updated).toEqual({
      opengauss: {
        substitution: false,
        shell: false,
      },
    });

    // When switched back to A-mode, substitution is still explicitly false
    expect(resolveSqlVariableSyntaxToggles(updated, "opengauss", true, "A").substitution).toBe(false);
  });

  it("preserves explicit substitution: false for openGauss in A mode when toggling shell", () => {
    const initial = { opengauss: { substitution: false } };
    const updated = updateSqlVariableSyntaxToggle(initial, "opengauss", "shell", false, "A");
    expect(updated).toEqual({
      opengauss: {
        substitution: false,
        shell: false,
      },
    });
  });

  it("preserves explicit substitution: false for Kingbase in pg mode when toggling shell", () => {
    const initial = { kingbase: { substitution: false } };
    const updated = updateSqlVariableSyntaxToggle(initial, "kingbase", "shell", false, "pg");
    expect(updated).toEqual({
      kingbase: {
        substitution: false,
        shell: false,
      },
    });
    // In oracle mode, substitution resolves to false because override is preserved
    expect(resolveSqlVariableSyntaxToggles(updated, "kingbase", true, "oracle").substitution).toBe(false);
  });

  it("preserves explicit substitution: false for Kingbase in oracle mode when toggling shell", () => {
    const initial = { kingbase: { substitution: false } };
    const updated = updateSqlVariableSyntaxToggle(initial, "kingbase", "shell", false, "oracle");
    expect(updated).toEqual({
      kingbase: {
        substitution: false,
        shell: false,
      },
    });
  });

  it("preserves explicit substitution: true for Kingbase in oracle mode when toggling shell", () => {
    const initial = { kingbase: { substitution: true } };
    const updated = updateSqlVariableSyntaxToggle(initial, "kingbase", "shell", false, "oracle");
    expect(updated).toEqual({
      kingbase: {
        substitution: true,
        shell: false,
      },
    });
    // In pg mode, substitution resolves to true because override is preserved
    expect(resolveSqlVariableSyntaxToggles(updated, "kingbase", true, "pg").substitution).toBe(true);
  });

  it("preserves explicit substitution: true for openGauss in A mode when toggling shell", () => {
    const initial = { opengauss: { substitution: true } };
    const updated = updateSqlVariableSyntaxToggle(initial, "opengauss", "shell", false, "A");
    expect(updated).toEqual({
      opengauss: {
        substitution: true,
        shell: false,
      },
    });
    // In B mode, substitution resolves to true because override is preserved
    expect(resolveSqlVariableSyntaxToggles(updated, "opengauss", true, "B").substitution).toBe(true);
  });

  it("does not introduce substitution override when toggling another syntax if substitution was not overridden", () => {
    const updated = updateSqlVariableSyntaxToggle({}, "opengauss", "shell", false, "B");
    expect(updated).toEqual({
      opengauss: {
        shell: false,
      },
    });
  });

  it("explicitly sets substitution to false or true for mode-dependent databases", () => {
    const setFalse = updateSqlVariableSyntaxToggle({}, "opengauss", "substitution", false, "B");
    expect(setFalse).toEqual({ opengauss: { substitution: false } });

    const setTrue = updateSqlVariableSyntaxToggle({}, "opengauss", "substitution", true, "A");
    expect(setTrue).toEqual({ opengauss: { substitution: true } });
  });

  it("retains explicit substitution override when reverting other toggles back to defaults", () => {
    const initial = { opengauss: { substitution: false, shell: false } };
    const updated = updateSqlVariableSyntaxToggle(initial, "opengauss", "shell", true, "B");
    expect(updated).toEqual({
      opengauss: {
        substitution: false,
      },
    });
  });

  it("drops non-mode-dependent toggles when matching database defaults", () => {
    const initial = { mysql: { shell: false } };
    const updated = updateSqlVariableSyntaxToggle(initial, "mysql", "shell", true);
    expect(updated).toEqual({});
  });

  it("ignores named parameter changes for Neo4j and NebulaGraph", () => {
    const initial = {};
    expect(updateSqlVariableSyntaxToggle(initial, "neo4j", "named", true)).toEqual({});
    expect(updateSqlVariableSyntaxToggle(initial, "nebula", "named", true)).toEqual({});
  });
});
