import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DBX_CONNECTION_TYPE_DESCRIPTION } from "../src/index.js";

interface DriverManifest {
  drivers: Array<{ dbType: string }>;
}

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
