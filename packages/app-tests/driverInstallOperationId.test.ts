import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("driver installation operation IDs support insecure HTTP contexts", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");

  assert.match(driverStore, /import \{ uuid \} from "@\/lib\/common\/utils"/);
  assert.doesNotMatch(driverStore, /crypto\.randomUUID\(\)/);
  assert.match(driverStore, /activeAgentOperationId\.value = uuid\(\)/);
  assert.doesNotMatch(connectionDialog, /crypto\.randomUUID\(\)/);
  assert.match(connectionDialog, /agentInstallOperationId\.value = uuid\(\)/);
});
