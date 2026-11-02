import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { PluginHostBridge } from "../../apps/desktop/src/lib/plugins/pluginHostBridge.ts";
import {
  MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS,
  PLUGIN_SCHEMA_METADATA_PERMISSION,
} from "../../apps/desktop/src/types/pluginSchemaMetadata.ts";
import type { PluginTableContext, PluginTableMetadata } from "../../apps/desktop/src/types/pluginSchemaMetadata.ts";
import type { InstalledPlugin, PluginWorkbenchContribution } from "../../apps/desktop/src/types/database.ts";

const coreSource = readFileSync("crates/dbx-core/src/schema/plugin_metadata.rs", "utf8");
const manifestSource = readFileSync("crates/dbx-plugin-runtime/src/plugins/manifest.rs", "utf8");
const manifestSchema = JSON.parse(readFileSync("plugins/manifest.schema.json", "utf8"));

function rustStructFields(source: string, name: string): string[] {
  const marker = `pub struct ${name} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Could not find struct ${name}`);
  let depth = 0;
  let end = start;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  return source
    .slice(start, end)
    .split("\n")
    .map((line) => /^\s*pub\s+([a-z0-9_]+)\s*:/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined);
}

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function plugin(permissions: string[]): InstalledPlugin {
  return {
    manifest: { id: "sample", name: "Sample", version: "1.0.0", permissions, drivers: [], contributions: [] },
    compatibility: { compatible: true },
  } as InstalledPlugin;
}

const workbench = { type: "workbench", id: "sample.main", label: "Sample" } as PluginWorkbenchContribution;

function sandbox() {
  const messages: Record<string, unknown>[] = [];
  const target = { postMessage: (message: unknown) => messages.push(message as Record<string, unknown>) } as unknown as Window;
  return { messages, target };
}

function send(bridge: PluginHostBridge, target: Window, params: unknown, id = "1"): void {
  bridge.handleWindowMessage({
    source: target,
    data: { source: "dbx-plugin", version: 1, type: "request", id, method: "host.getTableMetadata", params },
  } as MessageEvent);
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("schema metadata request and response fields match the Rust/TS contract", () => {
  assert.deepEqual(rustStructFields(coreSource, "PluginTableContext").map(camelCase), ["connectionId", "database", "schema", "table"]);
  assert.deepEqual(rustStructFields(coreSource, "PluginColumnMetadata").map((field) => (field === "default_value" ? "default" : camelCase(field))), [
    "name",
    "dataType",
    "nullable",
    "length",
    "precision",
    "scale",
    "default",
  ]);
  assert.deepEqual(rustStructFields(coreSource, "PluginTableMetadata").map(camelCase), ["columns", "fieldCapabilities"]);
  assert.ok(manifestSource.includes(`"${PLUGIN_SCHEMA_METADATA_PERMISSION}"`));
  assert.ok(manifestSchema.properties.permissions.items.anyOf[0].enum.includes(PLUGIN_SCHEMA_METADATA_PERMISSION));
  assert.equal(MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS, 256);
});

test("the bridge sends only the canonical table context and never reaches an undeclared plugin adapter", async () => {
  const { messages, target } = sandbox();
  const sent: PluginTableContext[] = [];
  const result: PluginTableMetadata = {
    columns: [{ name: "id", dataType: "integer", nullable: false }],
    fieldCapabilities: { length: "unknown", precision: "unknown", scale: "unknown", default: "unknown" },
  };
  const bridge = new PluginHostBridge(plugin([PLUGIN_SCHEMA_METADATA_PERMISSION]), workbench, {}, () => target, {
    invoke: async <T>() => undefined as T,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
    getTableMetadata: async (context) => {
      sent.push(context);
      return result;
    },
  });

  send(bridge, target, { connectionId: " c1 ", database: "app", schema: " ", table: " users " });
  await until(() => sent.length === 1, "the metadata request");
  assert.deepEqual(sent[0], { connectionId: "c1", database: "app", table: "users" });
  await until(() => messages.some((message) => message.id === "1"), "the metadata response");
  assert.deepEqual(messages.find((message) => message.id === "1")?.result, result);

  const denied = sandbox();
  let called = false;
  const deniedBridge = new PluginHostBridge(plugin([]), workbench, {}, () => denied.target, {
    invoke: async <T>() => undefined as T,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
    getTableMetadata: async () => {
      called = true;
      return result;
    },
  });
  send(deniedBridge, denied.target, { connectionId: "c1", table: "users" }, "denied");
  await until(() => denied.messages.length === 1, "the permission rejection");
  assert.match(String(denied.messages[0].error), /host\.schema:read/);
  assert.equal(called, false);
});
