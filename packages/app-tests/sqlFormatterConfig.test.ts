import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS, normalizeSqlFormatterSettings, parseSqlFormatterConfig, serializeSqlFormatterConfig, sqlFormatterOptions, syncSqlFormatterConfigDraft } from "../../apps/desktop/src/lib/sqlFormatterConfig.ts";

const defaultOptionSettings = DEFAULT_SQL_FORMATTER_SETTINGS;

test("normalizes empty formatter settings to defaults", () => {
  assert.deepEqual(normalizeSqlFormatterSettings({}), DEFAULT_SQL_FORMATTER_SETTINGS);
});

test("keeps valid formatter settings and clamps invalid values", () => {
  const settings = normalizeSqlFormatterSettings({
    keywordCase: "lower",
    dataTypeCase: "upper",
    functionCase: "lower",
    identifierCase: "upper",
    indentStyle: "tabularLeft",
    useTabs: true,
    tabWidth: 4,
    logicalOperatorNewline: "after",
    expressionWidth: 120,
    linesBetweenQueries: 2,
    denseOperators: true,
    newlineBeforeSemicolon: true,
    paramTypes: { named: [":"], custom: [{ regex: "\\{\\w+\\}" }] },
  });

  assert.deepEqual(settings, {
    ...DEFAULT_SQL_FORMATTER_SETTINGS,
    keywordCase: "lower",
    dataTypeCase: "upper",
    functionCase: "lower",
    identifierCase: "upper",
    indentStyle: "tabularLeft",
    useTabs: true,
    tabWidth: 4,
    logicalOperatorNewline: "after",
    expressionWidth: 120,
    linesBetweenQueries: 2,
    denseOperators: true,
    newlineBeforeSemicolon: true,
    paramTypes: { named: [":"], custom: [{ regex: "\\{\\w+\\}" }] },
  });

  assert.deepEqual(
    normalizeSqlFormatterSettings({
      keywordCase: "camel",
      dataTypeCase: "invalid",
      functionCase: "invalid",
      identifierCase: "invalid",
      indentStyle: "wide",
      useTabs: "yes",
      tabWidth: 99,
      logicalOperatorNewline: "middle",
      expressionWidth: -1,
      linesBetweenQueries: 9,
      denseOperators: "true",
      newlineBeforeSemicolon: "false",
      paramTypes: { named: ["#"] },
      editor: { shortcuts: [{ id: "duplicateLine", keys: { windows: "Ctrl+W", linux: "Ctrl+W", macos: "Cmd+W" }, enabled: false }] },
    }),
    DEFAULT_SQL_FORMATTER_SETTINGS,
  );
});

test("serializes formatter config as a stable versioned envelope", () => {
  const json = serializeSqlFormatterConfig({
    ...DEFAULT_SQL_FORMATTER_SETTINGS,
    keywordCase: "lower",
  });
  assert.equal(
    json,
    JSON.stringify(
      {
        version: 1,
        formatter: "sql-formatter",
        options: {
          ...defaultOptionSettings,
          keywordCase: "lower",
        },
      },
      null,
      2,
    ),
  );
});

test("parses valid formatter config files", () => {
  const result = parseSqlFormatterConfig(
    JSON.stringify({
      version: 1,
      formatter: "sql-formatter",
      ignoredTopLevelField: "ok",
      options: {
        keywordCase: "lower",
        functionCase: "upper",
        dataTypeCase: "preserve",
        identifierCase: "lower",
        indentStyle: "tabularRight",
        useTabs: false,
        tabWidth: 4,
        logicalOperatorNewline: "after",
        expressionWidth: 80,
        linesBetweenQueries: 0,
        denseOperators: false,
        newlineBeforeSemicolon: true,
        paramTypes: { named: [":"], quoted: ["@"], positional: true },
      },
      editor: {
        scope: "legacyJsonEditorScope",
        platforms: ["windows", "macos"],
        shortcuts: [{ id: "unknownLegacyShortcut", action: "copyLineDown", keys: { windows: "", linux: "Ctrl+W", macos: "Cmd+W" }, enabled: "yes" }],
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, {
    ...DEFAULT_SQL_FORMATTER_SETTINGS,
    keywordCase: "lower",
    functionCase: "upper",
    dataTypeCase: "preserve",
    identifierCase: "lower",
    indentStyle: "tabularRight",
    useTabs: false,
    tabWidth: 4,
    logicalOperatorNewline: "after",
    expressionWidth: 80,
    linesBetweenQueries: 0,
    denseOperators: false,
    newlineBeforeSemicolon: true,
    paramTypes: { named: [":"], quoted: ["@"], positional: true },
  });
});

test("ignores legacy editor shortcut fields in formatter config files", () => {
  const result = parseSqlFormatterConfig(
    JSON.stringify({
      version: 1,
      formatter: "sql-formatter",
      options: {},
      editor: {
        shortcuts: [{ id: "unknown", keys: { windows: "" }, enabled: "not-a-boolean" }],
      },
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.settings, DEFAULT_SQL_FORMATTER_SETTINGS);
  }
});

test("rejects malformed formatter config files", () => {
  assert.deepEqual(parseSqlFormatterConfig("{bad json").ok, false);
  assert.deepEqual(parseSqlFormatterConfig(JSON.stringify({ version: 2, formatter: "sql-formatter", options: {} })).ok, false);
  assert.deepEqual(parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "prettier", options: {} })).ok, false);
  assert.deepEqual(parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { unknown: true } })).ok, false);
});

test("rejects invalid known formatter option values when parsing config files", () => {
  const invalidKeywordCase = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { keywordCase: "camel" } }));
  assert.equal(invalidKeywordCase.ok, false);
  if (!invalidKeywordCase.ok) assert.match(invalidKeywordCase.message, /keywordCase/);

  const invalidBoolean = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { useTabs: "yes" } }));
  assert.equal(invalidBoolean.ok, false);
  if (!invalidBoolean.ok) assert.match(invalidBoolean.message, /useTabs/);

  const invalidNumericChoice = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { tabWidth: 3 } }));
  assert.equal(invalidNumericChoice.ok, false);
  if (!invalidNumericChoice.ok) assert.match(invalidNumericChoice.message, /tabWidth/);

  const invalidParams = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { params: ["42"] } }));
  assert.equal(invalidParams.ok, false);
  if (!invalidParams.ok) assert.match(invalidParams.message, /params/);

  const legacyNullParams = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { params: null } }));
  assert.equal(legacyNullParams.ok, true);

  const invalidParamTypes = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { paramTypes: { custom: [{ regex: "" }] } } }));
  assert.equal(invalidParamTypes.ok, false);
  if (!invalidParamTypes.ok) assert.match(invalidParamTypes.message, /paramTypes/);
});

test("syncs valid JSON drafts so outer settings apply can persist them", () => {
  let synced = DEFAULT_SQL_FORMATTER_SETTINGS;
  const result = syncSqlFormatterConfigDraft(
    JSON.stringify({
      version: 1,
      formatter: "sql-formatter",
      options: {
        ...defaultOptionSettings,
        keywordCase: "lower",
        tabWidth: 4,
      },
    }),
    (settings) => {
      synced = settings;
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(synced, {
    ...DEFAULT_SQL_FORMATTER_SETTINGS,
    keywordCase: "lower",
    tabWidth: 4,
  });
});

test("does not sync invalid JSON drafts", () => {
  let synced = DEFAULT_SQL_FORMATTER_SETTINGS;
  const result = syncSqlFormatterConfigDraft(
    JSON.stringify({
      version: 1,
      formatter: "sql-formatter",
      options: {
        ...defaultOptionSettings,
        keywordCase: "camel",
      },
    }),
    (settings) => {
      synced = settings;
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(synced, DEFAULT_SQL_FORMATTER_SETTINGS);
});

test("maps DBX formatter settings to sql-formatter options", () => {
  assert.deepEqual(
    sqlFormatterOptions({
      ...DEFAULT_SQL_FORMATTER_SETTINGS,
      keywordCase: "lower",
      useTabs: true,
      newlineBeforeSemicolon: true,
    }),
    {
      keywordCase: "lower",
      dataTypeCase: "preserve",
      functionCase: "preserve",
      identifierCase: "preserve",
      indentStyle: "standard",
      useTabs: true,
      tabWidth: 2,
      logicalOperatorNewline: "before",
      expressionWidth: 50,
      linesBetweenQueries: 1,
      denseOperators: false,
      newlineBeforeSemicolon: true,
    },
  );

  assert.deepEqual(
    sqlFormatterOptions({
      ...DEFAULT_SQL_FORMATTER_SETTINGS,
      paramTypes: { positional: true },
    }),
    {
      keywordCase: "upper",
      dataTypeCase: "preserve",
      functionCase: "preserve",
      identifierCase: "preserve",
      indentStyle: "standard",
      useTabs: false,
      tabWidth: 2,
      logicalOperatorNewline: "before",
      expressionWidth: 50,
      linesBetweenQueries: 1,
      denseOperators: false,
      newlineBeforeSemicolon: false,
      paramTypes: { positional: true },
    },
  );
});
