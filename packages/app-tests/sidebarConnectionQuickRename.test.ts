import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url);
const runtimeHost = readFileSync(new URL("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", repositoryRoot), "utf8");
const connectionTree = readFileSync(new URL("apps/desktop/src/components/sidebar/ConnectionTree.vue", repositoryRoot), "utf8");
const treeItem = readFileSync(new URL("apps/desktop/src/components/sidebar/TreeItem.vue", repositoryRoot), "utf8");

test("connection F2 rename uses the rendered row while explicit edit stays unchanged", () => {
  assert.match(runtimeHost, /const editTarget = selectedConnectionEditTarget[\s\S]*?emit\("request-connection-rename", editTarget\.connectionId\)/);
  assert.match(runtimeHost, /function requestEditSelectedConnection\(\): boolean \{[\s\S]*?connectionStore\.startEditing\(editTarget\.connectionId\)/);
  assert.match(connectionTree, /@request-connection-rename="startRenamingConnectionNode"/);
  assert.match(treeItem, /activeNode\.value\.type === "connection"\) startRenameConnection\(\)/);
  assert.match(treeItem, /async function finishRenameConnection\(\)[\s\S]*?connectionStore\.renameConnection\(connectionId, trimmed\)/);
});
