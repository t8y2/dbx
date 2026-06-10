import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildProcedureExecutionSql, buildProcedureExecutionSqlFromValues } from "../../apps/desktop/src/lib/routineExecutionSql.ts";
import { routineParametersFromResult, routineParametersQuery } from "../../apps/desktop/src/lib/routineParameters.ts";

test("builds procedure execution templates for common dialect families", () => {
  assert.equal(buildProcedureExecutionSql({ databaseType: "postgres", schema: "public", routineName: "refresh_stats" }), 'CALL "public"."refresh_stats"();');
  assert.equal(buildProcedureExecutionSql({ databaseType: "mysql", schema: "app", routineName: "refresh_stats" }), "CALL `refresh_stats`();");
  assert.equal(buildProcedureExecutionSql({ databaseType: "sqlserver", schema: "dbo", routineName: "refresh_stats" }), "EXEC [dbo].[refresh_stats];");
  assert.equal(buildProcedureExecutionSql({ databaseType: "dameng", schema: "SYSDBA", routineName: "refresh_stats" }), 'BEGIN\n  "SYSDBA"."refresh_stats"();\nEND;');
});

test("builds procedure execution templates from parameter values", () => {
  const parameters = [
    { name: "p_message", dataType: "text", mode: "IN" as const, ordinal: 1, value: "it's ready" },
    { name: "p_count", dataType: "integer", mode: "IN" as const, ordinal: 2, value: "3" },
    { name: "p_debug", dataType: "boolean", mode: "IN" as const, ordinal: 3, value: "true" },
    { name: "p_result", dataType: "text", mode: "OUT" as const, ordinal: 4, value: "" },
  ];

  assert.equal(
    buildProcedureExecutionSqlFromValues({
      databaseType: "postgres",
      schema: "public",
      routineName: "refresh_stats",
      parameters,
    }),
    'CALL "public"."refresh_stats"(' + "'it''s ready', 3, TRUE);",
  );

  assert.equal(
    buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "refresh_stats",
      parameters,
    }),
    "EXEC [dbo].[refresh_stats] @p_message = 'it''s ready', @p_count = 3, @p_debug = 1;",
  );
});

test("omits parameters that use database defaults", () => {
  assert.equal(
    buildProcedureExecutionSqlFromValues({
      databaseType: "postgres",
      schema: "public",
      routineName: "refresh_stats",
      parameters: [
        {
          name: "p_message",
          dataType: "text",
          mode: "IN",
          ordinal: 1,
          value: "",
          hasDefault: true,
          useDefault: true,
        },
      ],
    }),
    'CALL "public"."refresh_stats"();',
  );
});

test("uses named arguments when a defaulted positional argument is skipped", () => {
  assert.equal(
    buildProcedureExecutionSqlFromValues({
      databaseType: "postgres",
      schema: "public",
      routineName: "refresh_stats",
      parameters: [
        {
          name: "p_first",
          dataType: "text",
          mode: "IN",
          ordinal: 1,
          value: "",
          hasDefault: true,
          useDefault: true,
        },
        { name: "p_second", dataType: "integer", mode: "IN", ordinal: 2, value: "8" },
      ],
    }),
    'CALL "public"."refresh_stats"("p_second" => 8);',
  );

  assert.equal(
    buildProcedureExecutionSqlFromValues({
      databaseType: "oracle",
      schema: "APP",
      routineName: "refresh_stats",
      parameters: [
        {
          name: "P_FIRST",
          dataType: "VARCHAR2",
          mode: "IN",
          ordinal: 1,
          value: "",
          hasDefault: true,
          useDefault: true,
        },
        { name: "P_SECOND", dataType: "NUMBER", mode: "IN", ordinal: 2, value: "8" },
      ],
    }),
    'BEGIN\n  "APP"."refresh_stats"("P_SECOND" => 8);\nEND;',
  );
});

test("maps routine parameter query results into form metadata", () => {
  const parameters = routineParametersFromResult({
    columns: ["name", "data_type", "mode", "ordinal", "has_default"],
    rows: [
      ["p_message", "text", "IN", 1, true],
      ["p_total", "integer", "OUT", 2, false],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
  });

  assert.deepEqual(parameters, [
    { name: "p_message", dataType: "text", mode: "IN", ordinal: 1, hasDefault: true },
    { name: "p_total", dataType: "integer", mode: "OUT", ordinal: 2, hasDefault: false },
  ]);
});

test("builds parameter metadata queries for supported dialects", () => {
  assert.match(routineParametersQuery({ database: "app", databaseType: "postgres", schema: "public", routineName: "demo" }) ?? "", /pg_proc/);
  assert.match(routineParametersQuery({ database: "app", databaseType: "sqlserver", schema: "dbo", routineName: "demo" }) ?? "", /sys\.parameters/);
  assert.match(routineParametersQuery({ database: "app", databaseType: "mysql", routineName: "demo" }) ?? "", /SPECIFIC_SCHEMA = 'app'/);
  assert.match(routineParametersQuery({ database: "app", databaseType: "postgres", routineName: "demo" }) ?? "", /n\.nspname = 'public'/);
  assert.equal(routineParametersQuery({ database: "app", databaseType: "sqlite", schema: "main", routineName: "demo" }), null);
});
