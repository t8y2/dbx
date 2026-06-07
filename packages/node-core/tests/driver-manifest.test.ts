import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRIDGE_REQUIRED_TYPES, DIRECT_QUERY_TYPES, isDirectQueryType } from "../src/diagnostics.js";

interface DriverManifest {
  drivers: Array<{
    dbType: string;
    mcpMode: "direct" | "bridge" | "unsupported";
  }>;
}

function loadManifest(): DriverManifest {
  const path = fileURLToPath(new URL("../../../crates/dbx-core/assets/database-drivers.manifest.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as DriverManifest;
}

test("diagnostic query mode lists match the driver manifest", () => {
  const manifest = loadManifest();
  const directTypes = manifest.drivers.filter((driver) => driver.mcpMode === "direct").map((driver) => driver.dbType);
  const bridgeTypes = manifest.drivers.filter((driver) => driver.mcpMode === "bridge").map((driver) => driver.dbType);

  assert.deepEqual([...DIRECT_QUERY_TYPES].sort(), directTypes.sort());
  assert.deepEqual([...BRIDGE_REQUIRED_TYPES].sort(), bridgeTypes.sort());
});

test("runtime direct query routing matches diagnostic direct query types", () => {
  for (const dbType of DIRECT_QUERY_TYPES) {
    assert.equal(isDirectQueryType(dbType), true, `${dbType} should use direct query routing`);
  }

  for (const dbType of BRIDGE_REQUIRED_TYPES) {
    assert.equal(isDirectQueryType(dbType), false, `${dbType} should not use direct query routing`);
  }
});
