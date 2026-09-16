import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

test("allows the relationship diagram to control window fullscreen state", async () => {
  const capabilityUrl = new URL("../../src-tauri/capabilities/default.json", import.meta.url);
  const capability = JSON.parse(await readFile(capabilityUrl, "utf8")) as { permissions?: string[] };

  assert.ok(capability.permissions?.includes("core:window:allow-is-fullscreen"));
  assert.ok(capability.permissions?.includes("core:window:allow-set-fullscreen"));
});
