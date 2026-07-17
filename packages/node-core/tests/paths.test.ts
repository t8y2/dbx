import assert from "node:assert/strict";
import { test } from "vitest";
import { appDataDirFromInputs } from "../src/paths.js";

test("default app data dir matches Tauri local data dir on Linux", () => {
  assert.equal(appDataDirFromInputs({ platform: "linux", home: "/home/dbx" }), "/home/dbx/.local/share/com.dbx.app");
});

test("DBX_DATA_DIR overrides the default app data dir", () => {
  assert.equal(appDataDirFromInputs({ platform: "linux", home: "/home/dbx", envDataDir: "/tmp/dbx-data" }), "/tmp/dbx-data");
});
