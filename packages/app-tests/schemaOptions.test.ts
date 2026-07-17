import assert from "node:assert/strict";
import { test } from "vitest";
import { schemaOptionsForConnection } from "../../apps/desktop/src/composables/useSchemaOptions.ts";

test("schema options respect Oracle visible database filters", () => {
  assert.deepEqual(
    schemaOptionsForConnection(["CAM", "00010", "00012", "SYS"], {
      db_type: "oracle",
      visible_databases: ["CAM", "00010"],
    }),
    ["00010", "CAM"],
  );
});

test("schema options keep default system-schema filtering without explicit filters", () => {
  assert.deepEqual(
    schemaOptionsForConnection(["CAM", "SYS", "SYSTEM"], {
      db_type: "oracle",
      visible_databases: undefined,
    }),
    ["CAM"],
  );
});

test("schema options respect visible schemas for OceanBase Oracle mode", () => {
  assert.deepEqual(
    schemaOptionsForConnection(
      ["ORAAUDITOR", "APP", "SYS"],
      {
        db_type: "oceanbase-oracle",
        visible_schemas: { SYS: ["ORAAUDITOR"] },
      },
      "SYS",
    ),
    ["ORAAUDITOR"],
  );
});

test("schema options support legacy visible database filters for OceanBase Oracle mode", () => {
  assert.deepEqual(
    schemaOptionsForConnection(["ORAAUDITOR", "APP", "SYS"], {
      db_type: "oceanbase-oracle",
      visible_databases: ["ORAAUDITOR"],
    }),
    ["ORAAUDITOR"],
  );
});
