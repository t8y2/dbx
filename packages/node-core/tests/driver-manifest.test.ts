import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { BRIDGE_REQUIRED_TYPES, DIRECT_QUERY_TYPES, isDirectQueryType } from "../src/diagnostics.js";

interface DriverManifest {
  drivers: Array<{
    dbType: string;
    mcpMode: "direct" | "bridge" | "unsupported";
    supportLevel: "connect" | "browse" | "understand" | "operate";
    capabilities: Record<DatabaseProductCapability, boolean>;
  }>;
}

const PRODUCT_CAPABILITY_KEYS = [
  "queryExecution",
  "metadataBrowse",
  "objectBrowser",
  "objectSource",
  "schemaSearch",
  "diagram",
  "tableDataEdit",
  "tableStructureEdit",
  "tableImport",
  "dataTransfer",
  "sqlFileExecution",
  "databaseCreate",
  "fieldLineage",
  "sqlExplain",
  "userAdmin",
  "driverManagement",
] as const;
type DatabaseProductCapability = (typeof PRODUCT_CAPABILITY_KEYS)[number];

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

test("Manticore Search is direct-query capable", () => {
  assert.equal(isDirectQueryType("manticoresearch"), true);
  assert.equal(DIRECT_QUERY_TYPES.includes("manticoresearch" as any), true);
});

test("GaussDB family requires the DBX Desktop bridge for MCP", () => {
  for (const dbType of ["gaussdb", "opengauss"] as const) {
    assert.equal(isDirectQueryType(dbType), false);
    assert.equal(DIRECT_QUERY_TYPES.includes(dbType as any), false);
    assert.equal(BRIDGE_REQUIRED_TYPES.includes(dbType as any), true);
  }
});

test("driver manifest declares support levels and product capabilities", () => {
  const manifest = loadManifest();

  for (const driver of manifest.drivers) {
    assert.match(driver.supportLevel, /^(connect|browse|understand|operate)$/);
    for (const key of PRODUCT_CAPABILITY_KEYS) {
      assert.equal(typeof driver.capabilities[key], "boolean", `${driver.dbType}.${key} should be a boolean`);
    }
    assert.equal(Object.keys(driver.capabilities).sort().join(","), [...PRODUCT_CAPABILITY_KEYS].sort().join(","));
  }

  const jdbc = manifest.drivers.find((driver) => driver.dbType === "jdbc");
  assert.equal(jdbc?.supportLevel, "browse");
  assert.equal(jdbc?.capabilities.metadataBrowse, true);
  assert.equal(jdbc?.capabilities.tableStructureEdit, false);

  const manticore = manifest.drivers.find((driver) => driver.dbType === "manticoresearch");
  assert.equal(manticore?.supportLevel, "operate");
  assert.equal(manticore?.capabilities.queryExecution, true);
  assert.equal(manticore?.capabilities.metadataBrowse, true);
  assert.equal(manticore?.capabilities.objectBrowser, false);
  assert.equal(manticore?.capabilities.tableDataEdit, true);
  assert.equal(manticore?.capabilities.tableStructureEdit, true);
  assert.equal(manticore?.capabilities.databaseCreate, false);
  assert.equal(manticore?.capabilities.userAdmin, false);
});
