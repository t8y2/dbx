import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { DBX_CONNECTION_TYPE_DESCRIPTION } from "../src/index.js";

interface DriverManifest {
  drivers: Array<{
    dbType: string;
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

test("add connection database type description includes every manifest database type", () => {
  const manifest = loadManifest();

  for (const driver of manifest.drivers) {
    assert.match(DBX_CONNECTION_TYPE_DESCRIPTION, new RegExp(`\\b${driver.dbType}\\b`));
  }
});

test("driver manifest includes product capability metadata for every database type", () => {
  const manifest = loadManifest();

  for (const driver of manifest.drivers) {
    assert.match(driver.supportLevel, /^(connect|browse|understand|operate)$/);
    for (const key of PRODUCT_CAPABILITY_KEYS) {
      assert.equal(typeof driver.capabilities[key], "boolean", `${driver.dbType}.${key} should be a boolean`);
    }
  }
});
