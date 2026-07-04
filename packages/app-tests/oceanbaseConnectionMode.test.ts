import { strict as assert } from "node:assert";
import { test } from "vitest";
import { oceanbaseModeConnectionPatch, oceanbaseSubModeFromConfig } from "../../apps/desktop/src/lib/database/oceanbaseConnectionMode.ts";

test("detects OceanBase Oracle mode from either database type or driver profile", () => {
  assert.equal(oceanbaseSubModeFromConfig({ db_type: "mysql", driver_profile: "oceanbase-oracle" }), "oracle");
  assert.equal(oceanbaseSubModeFromConfig({ db_type: "oceanbase-oracle", driver_profile: "oceanbase" }), "oracle");
  assert.equal(oceanbaseSubModeFromConfig({ db_type: "mysql", driver_profile: "oceanbase" }), "mysql");
});

test("builds submit config identity from the selected OceanBase mode", () => {
  assert.deepEqual(oceanbaseModeConnectionPatch("oracle"), {
    db_type: "oceanbase-oracle",
    driver_profile: "oceanbase-oracle",
    driver_label: "OceanBase Oracle Mode",
  });
  assert.deepEqual(oceanbaseModeConnectionPatch("mysql"), {
    db_type: "mysql",
    driver_profile: "oceanbase",
    driver_label: "OceanBase",
  });
});
