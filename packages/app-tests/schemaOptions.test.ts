import assert from "node:assert/strict";
import { test } from "vitest";
import { schemaOptionsForConnection } from "../../apps/desktop/src/composables/useSchemaOptions.ts";

test("schema options respect Oracle visible database filters", () => {
  assert.deepEqual(
    schemaOptionsForConnection(["CAM", "00010", "00012", "SYS"], {
      db_type: "oracle",
      visible_databases: ["CAM", "00010"],
    }),
    ["CAM", "00010"],
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
