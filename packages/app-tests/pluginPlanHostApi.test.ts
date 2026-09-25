import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { PluginHostBridge } from "../../apps/desktop/src/lib/plugins/pluginHostBridge.ts";
import {
  MAX_PLUGIN_PLAN_BYTES,
  MAX_PLUGIN_PLAN_SQL_CHARS,
  MAX_PLUGIN_PLAN_TIMEOUT_MS,
  PLUGIN_PLAN_PERMISSION,
  PLUGIN_PLAN_WARNING,
} from "../../apps/desktop/src/types/pluginPlan.ts";
import type { PluginPlanCapabilities, PluginPlanRequest } from "../../apps/desktop/src/types/pluginPlan.ts";
import type { InstalledPlugin, PluginWorkbenchContribution } from "../../apps/desktop/src/types/database.ts";

/**
 * The plan Host API (#9675) spans three languages: the Rust core that owns
 * EXPLAIN generation, the TS bridge that enforces the manifest permission, and
 * the plugin-facing SDK. Constant drift, a renamed field, or a permission that
 * exists on only one side would fail silently at runtime, so these tests read
 * the Rust sources and compare them against what the bridge really sends.
 */

const planCoreSource = readFileSync("crates/dbx-core/src/query/plugin_plan.rs", "utf8");
const manifestSource = readFileSync("crates/dbx-plugin-runtime/src/plugins/manifest.rs", "utf8");
const manifestSchema = JSON.parse(readFileSync("plugins/manifest.schema.json", "utf8"));

/** Extracts `<name>`'s `pub` field names from a Rust source block. */
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

/** Reads a `const` or `pub const` literal from a Rust source block. */
function rustConst(source: string, name: string): string {
  const match = new RegExp(`(?:pub )?const ${name}\\s*:\\s*[^=]+=\\s*([^;]+);`).exec(source);
  assert.notEqual(match, null, `Could not find const ${name}`);
  return match![1].trim();
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

function send(bridge: PluginHostBridge, target: Window, method: string, params: unknown, id = "1"): void {
  bridge.handleWindowMessage({
    source: target,
    data: { source: "dbx-plugin", version: 1, type: "request", id, method, params },
  } as MessageEvent);
}

/** Polls until `check` passes; the bridge answers requests asynchronously. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("plan limits and mode match the Rust core", () => {
  // The plugin decides whether to run at all from these numbers, so a limit
  // raised in Rust without the matching TS change must fail this test.
  assert.equal(rustConst(planCoreSource, "MAX_PLUGIN_PLAN_TIMEOUT_MS").replaceAll("_", ""), String(MAX_PLUGIN_PLAN_TIMEOUT_MS));
  assert.equal(rustConst(planCoreSource, "MAX_PLUGIN_PLAN_SQL_CHARS").replaceAll("_", ""), String(MAX_PLUGIN_PLAN_SQL_CHARS));
  assert.equal(
    rustConst(planCoreSource, "MAX_PLUGIN_PLAN_BYTES").replaceAll("_", "").replaceAll(" ", ""),
    `4*1024*1024`,
  );
  assert.equal(MAX_PLUGIN_PLAN_BYTES, 4 * 1024 * 1024);
  assert.equal(rustConst(planCoreSource, "PLUGIN_PLAN_MODE_ESTIMATED"), '"estimated"');
});

test("plan warning codes match the Rust core", () => {
  assert.equal(rustConst(planCoreSource, "WARNING_PLAN_NOT_JSON"), `"${PLUGIN_PLAN_WARNING.notJson}"`);
  assert.equal(rustConst(planCoreSource, "WARNING_PLAN_TRUNCATED"), `"${PLUGIN_PLAN_WARNING.truncated}"`);
  assert.equal(rustConst(planCoreSource, "WARNING_PLAN_ROWS_TRUNCATED"), `"${PLUGIN_PLAN_WARNING.rowsTruncated}"`);
});

test("host.plans:read is declared by the runtime and the published schema", () => {
  const supportedPermissions = /pub const SUPPORTED_PLUGIN_PERMISSIONS[^=]*=\s*&\[([^\]]*)\]/.exec(manifestSource);
  assert.notEqual(supportedPermissions, null, "Could not find SUPPORTED_PLUGIN_PERMISSIONS");
  assert.ok(supportedPermissions![1].includes(`"${PLUGIN_PLAN_PERMISSION}"`), supportedPermissions![1]);

  const schemaPermissions: string[] = manifestSchema.properties.permissions.items.anyOf[0].enum;
  assert.ok(schemaPermissions.includes(PLUGIN_PLAN_PERMISSION), schemaPermissions.join(", "));

  // The read-only scope must stay the only plan permission: an execute scope
  // would mean actual plans, which this API deliberately does not serve.
  assert.equal(schemaPermissions.filter((permission) => permission.startsWith("host.plans")).length, 1);
});

test("the bridge sends exactly the fields the Rust request struct accepts", async () => {
  const { target } = sandbox();
  const sent: PluginPlanRequest[] = [];
  const bridge = new PluginHostBridge(plugin([PLUGIN_PLAN_PERMISSION]), workbench, {}, () => target, {
    invoke: async () => undefined,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
    getPlanCapabilities: async () => ({}) as PluginPlanCapabilities,
    explainPlan: async (request) => {
      sent.push(request);
      return { dbType: "postgres", format: "json", rawPlan: {}, truncated: false, warnings: [] };
    },
  });

  send(bridge, target, "host.explainPlan", {
    connectionId: "c1",
    database: "app",
    schema: "public",
    sql: "SELECT 1",
    mode: "estimated",
    timeoutMs: 1_000,
  });
  await until(() => sent.length === 1, "the plan request");

  const rustFields = rustStructFields(planCoreSource, "PluginPlanRequest").map(camelCase);
  assert.deepEqual(Object.keys(sent[0]).sort(), [...rustFields].sort());
  // Field names must line up, not just the count: `connectionId` vs `connection_id`
  // would deserialize into "missing field" on the Rust side.
  assert.deepEqual(rustFields.sort(), ["connectionId", "database", "mode", "schema", "sql", "timeoutMs"]);
});

test("an undeclared plugin cannot reach the plan API", async () => {
  const { messages, target } = sandbox();
  let called = 0;
  const bridge = new PluginHostBridge(plugin([]), workbench, {}, () => target, {
    invoke: async () => undefined,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
    getPlanCapabilities: async () => {
      called += 1;
      return {} as PluginPlanCapabilities;
    },
    explainPlan: async () => {
      called += 1;
      return {};
    },
  });

  send(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated" });
  await until(() => messages.length === 1, "the rejection");

  assert.match(String(messages[0].error), /host\.plans:read/);
  assert.equal(called, 0);
});

test("mode is required and only estimated is served", async () => {
  const { messages, target } = sandbox();
  const sent: PluginPlanRequest[] = [];
  const bridge = new PluginHostBridge(plugin([PLUGIN_PLAN_PERMISSION]), workbench, {}, () => target, {
    invoke: async () => undefined,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
    explainPlan: async (request) => {
      sent.push(request);
      return {};
    },
  });

  for (const [id, mode] of [["actual", "actual"], ["analyze", "analyze"], ["missing", undefined]] as const) {
    send(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode }, id);
  }
  await until(() => messages.length === 3, "the three rejections");

  assert.equal(sent.length, 0, "no non-estimated request may reach the backend");
  for (const message of messages) assert.match(String(message.error), /estimated/);
});

test("a host without the plan API advertises no capability and fails closed", async () => {
  const { messages, target } = sandbox();
  const bridge = new PluginHostBridge(plugin([PLUGIN_PLAN_PERMISSION]), workbench, {}, () => target, {
    invoke: async () => undefined,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
  });

  bridge.sendInit();
  assert.equal((messages[0].capabilities as { planApi: boolean }).planApi, false);

  send(bridge, target, "host.getPlanCapabilities", { connectionId: "c1" });
  await until(() => messages.length === 2, "the capability rejection");
  assert.match(String(messages[1].error), /unavailable/);
});

test("a plan request survives the bridge unchanged for the plugin", async () => {
  const { messages, target } = sandbox();
  const capabilities: PluginPlanCapabilities = {
    dbType: "postgres",
    dbVersion: "15.19",
    supports: { estimatedPlan: true },
    limits: { maxTimeoutMs: 30_000, maxPlanBytes: MAX_PLUGIN_PLAN_BYTES },
  };
  const result = {
    dbType: "postgres",
    dbVersion: "15.19",
    format: "json" as const,
    rawPlan: [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders" } }],
    truncated: false,
    warnings: [],
  };
  const bridge = new PluginHostBridge(plugin([PLUGIN_PLAN_PERMISSION]), workbench, {}, () => target, {
    invoke: async () => undefined,
    notify: async () => undefined,
    sendBinary: async () => undefined,
    readAsset: async () => ({ dataBase64: "", contentType: "" }),
    getPlanCapabilities: async () => capabilities,
    explainPlan: async () => result,
  });

  bridge.sendInit();
  assert.equal((messages[0].capabilities as { planApi: boolean }).planApi, true);

  send(bridge, target, "host.getPlanCapabilities", { connectionId: "c1" }, "caps");
  send(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated" }, "plan");
  await until(() => messages.length === 3, "both plan responses");

  assert.deepEqual(messages[1].result, capabilities);
  assert.deepEqual(messages[2].result, result);
  // Credentials never cross this boundary: the payload is the plan and metadata only.
  const serialized = JSON.stringify(messages[2].result);
  for (const secret of ["password", "credential", "connectionString", "username"]) {
    assert.ok(!serialized.toLowerCase().includes(secret.toLowerCase()), secret);
  }
});
