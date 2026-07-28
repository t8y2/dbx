import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function assertIncludes(file, needle, message) {
  assert.ok(read(file).includes(needle), `${message}\nMissing ${needle} in ${file}`);
}

function assertMatches(file, pattern, message) {
  assert.match(read(file), pattern, `${message}\nPattern ${pattern} not found in ${file}`);
}

assertMatches("src-tauri/Cargo.toml", /mq-admin\s*=\s*\[[^\]]*"dbx-core\/mq-admin"[^\]]*\]/, "Tauri crate must expose an mq-admin feature that enables dbx-core/mq-admin.");
assertMatches("src-tauri/Cargo.toml", /default\s*=\s*\[[^\]]*"mq-admin"[^\]]*\]/, "Tauri default features must include mq-admin so desktop commands are registered.");
assertMatches("crates/dbx-web/Cargo.toml", /\[features\][\s\S]*mq-admin\s*=\s*\[[^\]]*"dbx-core\/mq-admin"[^\]]*\]/, "Web crate must expose an mq-admin feature that enables dbx-core/mq-admin.");
assertMatches("crates/dbx-web/Cargo.toml", /\[features\][\s\S]*default\s*=\s*\[[^\]]*"mq-admin"[^\]]*\]/, "Web default features must include mq-admin so web routes are registered.");

assertIncludes("apps/desktop/src/components/layout/ContentArea.vue", "MqAdminConsole", "Main content area must import and render the MQ admin console.");
assertIncludes("apps/desktop/src/components/layout/ContentArea.vue", "activeTab.mode === 'mq'", "Main content area must have an mq mode render branch.");
assertIncludes("apps/desktop/src/components/sidebar/TreeItem.vue", '"mq"', "Sidebar connection handling must be aware of MQ connections.");
assertIncludes("apps/desktop/src/stores/queryStore.ts", "openMqAdmin", "Query store must expose an MQ admin tab opener.");

const manifest = JSON.parse(read("crates/dbx-core/assets/database-drivers.manifest.json"));
const drivers = Array.isArray(manifest) ? manifest : manifest.drivers;
assert.ok(drivers?.some((driver) => driver.dbType === "mq"), "Driver manifest must include dbType=mq.");
const mqDriver = drivers.find((driver) => driver.dbType === "mq");
assert.ok(mqDriver.driverProfiles?.some((profile) => profile.profile === "rabbitmq"), "MQ driver manifest entry must include a rabbitmq driver profile.");

const mqHttp = read("apps/desktop/src/lib/backend/mq-http.ts");
assert.ok(!mqHttp.includes('post("/mq/'), "MQ HTTP client must not call unprefixed /mq paths.");
assert.ok(mqHttp.includes('post("/api/mq/'), "MQ HTTP client must call /api/mq paths in web mode.");
assertIncludes("apps/desktop/src/lib/backend/mq-http.ts", 'post("/api/mq/consumers/group-config/get"', "MQ HTTP client must call consumer group config get route.");
assertIncludes("apps/desktop/src/lib/backend/mq-tauri.ts", 'invoke("mq_get_consumer_group_config"', "MQ Tauri client must invoke consumer group config command.");
assertIncludes("crates/dbx-web/src/main.rs", '"/mq/consumers/group-config/get"', "dbx-web must register consumer group config get route.");
assertIncludes("src-tauri/src/lib.rs", "mq_get_consumer_group_config", "Tauri must register consumer group config command.");

for (const route of ["exchanges/list", "exchanges/create", "exchanges/delete", "bindings/list", "bindings/bind", "bindings/unbind", "client-connections/list", "client-connections/close", "channels/list"]) {
  assertIncludes("apps/desktop/src/lib/backend/mq-http.ts", `post("/api/mq/${route}"`, `MQ HTTP client must call /api/mq/${route} route.`);
  assertIncludes("crates/dbx-web/src/main.rs", `"/mq/${route}"`, `dbx-web must register /mq/${route} route.`);
}
for (const command of ["mq_list_exchanges", "mq_create_exchange", "mq_delete_exchange", "mq_list_bindings", "mq_bind", "mq_unbind", "mq_list_client_connections", "mq_list_client_channels", "mq_close_client_connection"]) {
  assertIncludes("apps/desktop/src/lib/backend/mq-tauri.ts", `invoke("${command}"`, `MQ Tauri client must invoke ${command} command.`);
  assertIncludes("src-tauri/src/lib.rs", command, `Tauri must register ${command} command.`);
}

for (const route of ["users/list", "users/create", "users/delete", "user-permissions/list", "user-permissions/grant", "user-permissions/revoke"]) {
  assertIncludes("apps/desktop/src/lib/backend/mq-http.ts", `post("/api/mq/${route}"`, `MQ HTTP client must call /api/mq/${route} route.`);
  assertIncludes("crates/dbx-web/src/main.rs", `"/mq/${route}"`, `dbx-web must register /mq/${route} route.`);
}
for (const command of ["mq_list_users", "mq_create_user", "mq_delete_user", "mq_list_user_permissions", "mq_grant_user_permission", "mq_revoke_user_permission"]) {
  assertIncludes("apps/desktop/src/lib/backend/mq-tauri.ts", `invoke("${command}"`, `MQ Tauri client must invoke ${command} command.`);
  assertIncludes("src-tauri/src/lib.rs", command, `Tauri must register ${command} command.`);
}

for (const route of ["policies/list", "policies/set", "policies/delete", "overview", "nodes"]) {
  assertIncludes("apps/desktop/src/lib/backend/mq-http.ts", `post("/api/mq/${route}"`, `MQ HTTP client must call /api/mq/${route} route.`);
  assertIncludes("crates/dbx-web/src/main.rs", `"/mq/${route}"`, `dbx-web must register /mq/${route} route.`);
}
for (const command of ["mq_list_policies", "mq_set_policy", "mq_delete_policy", "mq_get_overview", "mq_list_nodes"]) {
  assertIncludes("apps/desktop/src/lib/backend/mq-tauri.ts", `invoke("${command}"`, `MQ Tauri client must invoke ${command} command.`);
  assertIncludes("src-tauri/src/lib.rs", command, `Tauri must register ${command} command.`);
}

assertIncludes("apps/desktop/src/lib/backend/api.ts", 'mqTestConnection = forward("mqTestConnection")', "MQ frontend calls must use the shared forward() API layer.");
assertIncludes("apps/desktop/src/lib/backend/api.ts", 'mqGetConsumerGroupConfig = forward("mqGetConsumerGroupConfig")', "MQ frontend must forward consumer group config API.");
assertIncludes("apps/desktop/src/components/connection/ConnectionDialog.vue", "mqAdminUrl", "Connection dialog must include MQ admin URL fields.");
assertIncludes("apps/desktop/src/components/connection/ConnectionDialog.vue", "external_config", "Connection dialog must submit MQ external_config.");

const mqConsole = read("apps/desktop/src/components/mq/MqAdminConsole.vue");
for (const tab of ["policies", "permissions", "raw"]) {
  assert.ok(mqConsole.includes(`'${tab}'`), `MQ console must expose a ${tab} tab.`);
}
for (const panel of ["PoliciesPanel.vue", "PermissionsPanel.vue", "RawApiPanel.vue"]) {
  assert.ok(fs.existsSync(path.join(root, "apps/desktop/src/components/mq", panel)), `Missing MQ panel: ${panel}`);
  assertIncludes(`apps/desktop/src/components/mq/${panel}`, "readOnly", `${panel} must honor read-only mode.`);
}
for (const panel of ["TenantsPanel.vue", "NamespacesPanel.vue", "TopicsPanel.vue", "SubscriptionsPanel.vue"]) {
  assertIncludes(`apps/desktop/src/components/mq/${panel}`, "readOnly", `${panel} must disable mutating actions in read-only mode.`);
}
for (const panel of ["ExchangesPanel.vue", "SendMessagePanel.vue", "rabbitmq/RabbitMqClientsPanel.vue", "ProducerConsumerPanel.vue"]) {
  assertIncludes(`apps/desktop/src/components/mq/${panel}`, "readOnly", `${panel} must disable mutating actions in read-only mode.`);
}

console.log("MQ integration checks passed");
