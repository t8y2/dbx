import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
const connectionMutationRuntime = readFileSync("apps/desktop/src/composables/useSidebarConnectionMutationRuntime.ts", "utf8");
const databaseSpecificMutationRuntime = readFileSync("apps/desktop/src/composables/useSidebarDatabaseSpecificMutationRuntime.ts", "utf8");
const tableMutationRuntime = readFileSync("apps/desktop/src/composables/useSidebarTableMutationRuntime.ts", "utf8");

function functionBody(name: string): string {
  const source = [runtimeHost, connectionMutationRuntime, databaseSpecificMutationRuntime, tableMutationRuntime].find((candidate) => candidate.includes(`function ${name}(`));
  assert.ok(source, name);
  const signatureIndex = Math.max(source.indexOf(`async function ${name}(`), source.indexOf(`function ${name}(`));
  assert.notEqual(signatureIndex, -1, name);
  const bodyStart = source.indexOf("{", signatureIndex);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`Could not parse ${name}`);
}

test("mutation families retain accepted targets, failures, and refresh work", () => {
  const rename = functionBody("confirmRenameObject");
  assert.match(rename, /sidebarFormTarget\.value \?\? activeNode\.value/);
  assert.match(rename, /try \{/);
  assert.match(rename, /catch \(e: any\)/);

  for (const name of ["confirmEmptyTable", "confirmTruncateTable"]) {
    const body = functionBody(name);
    assert.match(body, /sidebarDangerTarget\.value \?\? activeNode\.value/);
    assert.match(body, /refreshMutatedTableDataTabsForNode\(node\)/);
    assert.match(body, /tableOperationFailed/);
  }

  for (const name of ["confirmCreateNacosNamespace", "confirmEditNacosNamespace", "confirmDropDatabase"]) {
    const body = functionBody(name);
    assert.match(body, /try \{/);
    assert.match(body, /catch \([A-Za-z]+: any\)/);
    assert.match(body, /finally \{/);
    assert.match(body, /Loading\.value = false/);
  }

  // Mongo collection mutations share a production-gated shell for failures / loading.
  const dropMongoCollection = functionBody("confirmDropMongoCollection");
  assert.match(dropMongoCollection, /runMongoSidebarMutation/);
  assert.match(dropMongoCollection, /onError:\s*toastMutationError/);
  assert.match(dropMongoCollection, /api\.mongoDropCollection/);


  const redis = functionBody("confirmFlushRedisDb");
  assert.match(redis, /updateRedisDbKeyStats/);
  assert.match(redis, /dbx-redis-db-flushed/);

  const cancel = functionBody("cancelConnectionAttempt");
  assert.match(cancel, /cancelConnecting/);
  assert.match(cancel, /connectCancelled/);
});

test("menu and dialog mutations resolve immutable accepted targets", () => {
  assert.match(runtimeHost, /createSidebarMenuContext\(node, connectionStore\.selectedTreeNodeIds/);
  assert.match(runtimeHost, /bindMenuTarget\(rawItems, menuContext\.target, menuContext\.selectedNodeIds\)/);
  assert.match(runtimeHost, /activateActionTarget\(target\)/);
  assert.match(runtimeHost, /findSidebarActionTarget\(connectionStore\.treeNodes, target\) \?\? target/);
  assert.match(runtimeHost, /routedRequest\.confirm = async \(\) => \{[\s\S]*?activateActionTarget\(target\)/);
  assert.match(runtimeHost, /createRoutedSidebarDialogController\(controller, \{[\s\S]*?wrapAction: \(action\) => \{[\s\S]*?activateActionTarget\(target\)/);
});
