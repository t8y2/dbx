import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DEFAULT_SQL_FORMATTER_SETTINGS,
  parseSqlFormatterConfig,
  serializeSqlFormatterConfig,
  normalizeSqlFormatterSettings,
  syncSqlFormatterConfigDraft,
  sqlFormatterOptions,
} from "../../apps/desktop/src/lib/sqlFormatterConfig.ts";

test("normalizes empty formatter settings to defaults", () => {
  assert.deepEqual(normalizeSqlFormatterSettings({}), DEFAULT_SQL_FORMATTER_SETTINGS);
});

test("keeps valid formatter settings and clamps invalid values", () => {
  const settings = normalizeSqlFormatterSettings({
    keywordCase: "lower",
    dataTypeCase: "upper",
    functionCase: "lower",
    useTabs: true,
    tabWidth: 4,
    logicalOperatorNewline: "after",
    expressionWidth: 120,
    linesBetweenQueries: 2,
    denseOperators: true,
    newlineBeforeSemicolon: true,
  });

  assert.deepEqual(settings, {
    keywordCase: "lower",
    dataTypeCase: "upper",
    functionCase: "lower",
    useTabs: true,
    tabWidth: 4,
    logicalOperatorNewline: "after",
    expressionWidth: 120,
    linesBetweenQueries: 2,
    denseOperators: true,
    newlineBeforeSemicolon: true,
  });

  assert.deepEqual(
    normalizeSqlFormatterSettings({
      keywordCase: "camel",
      dataTypeCase: "invalid",
      functionCase: "invalid",
      useTabs: "yes",
      tabWidth: 99,
      logicalOperatorNewline: "middle",
      expressionWidth: -1,
      linesBetweenQueries: 9,
      denseOperators: "true",
      newlineBeforeSemicolon: "false",
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
          ...DEFAULT_SQL_FORMATTER_SETTINGS,
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
        useTabs: false,
        tabWidth: 4,
        logicalOperatorNewline: "after",
        expressionWidth: 80,
        linesBetweenQueries: 0,
        denseOperators: false,
        newlineBeforeSemicolon: true,
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, {
    keywordCase: "lower",
    functionCase: "upper",
    dataTypeCase: "preserve",
    useTabs: false,
    tabWidth: 4,
    logicalOperatorNewline: "after",
    expressionWidth: 80,
    linesBetweenQueries: 0,
    denseOperators: false,
    newlineBeforeSemicolon: true,
  });
});

test("rejects malformed formatter config files", () => {
  assert.deepEqual(parseSqlFormatterConfig("{bad json").ok, false);
  assert.deepEqual(parseSqlFormatterConfig(JSON.stringify({ version: 2, formatter: "sql-formatter", options: {} })).ok, false);
  assert.deepEqual(parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "prettier", options: {} })).ok, false);
  assert.deepEqual(
    parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { unknown: true } })).ok,
    false,
  );
});

test("rejects invalid known formatter option values when parsing config files", () => {
  const invalidKeywordCase = parseSqlFormatterConfig(
    JSON.stringify({ version: 1, formatter: "sql-formatter", options: { keywordCase: "camel" } }),
  );
  assert.equal(invalidKeywordCase.ok, false);
  if (!invalidKeywordCase.ok) assert.match(invalidKeywordCase.message, /keywordCase/);

  const invalidBoolean = parseSqlFormatterConfig(
    JSON.stringify({ version: 1, formatter: "sql-formatter", options: { useTabs: "yes" } }),
  );
  assert.equal(invalidBoolean.ok, false);
  if (!invalidBoolean.ok) assert.match(invalidBoolean.message, /useTabs/);

  const invalidNumericChoice = parseSqlFormatterConfig(
    JSON.stringify({ version: 1, formatter: "sql-formatter", options: { tabWidth: 3 } }),
  );
  assert.equal(invalidNumericChoice.ok, false);
  if (!invalidNumericChoice.ok) assert.match(invalidNumericChoice.message, /tabWidth/);
});

test("syncs valid JSON drafts so outer settings apply can persist them", () => {
  let synced = DEFAULT_SQL_FORMATTER_SETTINGS;
  const result = syncSqlFormatterConfigDraft(
    JSON.stringify({
      version: 1,
      formatter: "sql-formatter",
      options: {
        ...DEFAULT_SQL_FORMATTER_SETTINGS,
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
        ...DEFAULT_SQL_FORMATTER_SETTINGS,
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
      useTabs: true,
      tabWidth: 2,
      logicalOperatorNewline: "before",
      expressionWidth: 50,
      linesBetweenQueries: 1,
      denseOperators: false,
      newlineBeforeSemicolon: true,
    },
  );
});
