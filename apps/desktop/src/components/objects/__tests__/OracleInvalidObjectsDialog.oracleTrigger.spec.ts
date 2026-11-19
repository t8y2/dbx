// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import type { ConnectionConfig, ObjectSource } from "@/types/database";
import OracleInvalidObjectsDialog from "../OracleInvalidObjectsDialog.vue";

const rpc = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  executeQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(async () => undefined),
  listPlugins: vi.fn(async () => []),
  listInstalledAgents: vi.fn(async () => []),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...rpc }));
const owner = " Trigger.Owner ",
  name = ' Tr"igger ',
  executionSchema = "Execution.Owner";
const config = { id: "trigger-diagnostics", name: "Trigger diagnostics", db_type: "oceanbase-oracle", username: executionSchema, database: "service" } as ConnectionConfig;
const target = { connectionId: config.id, database: "service", catalog: " Catalog ", owner, name, executionSchema };
let raw: ObjectSource;
let app: App | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  const connections = useConnectionStore();
  connections.connections = [config];
  connections.connectedIds.add(config.id);
  raw = {
    name,
    schema: owner,
    object_type: "TRIGGER",
    source: "BEGIN NULL; END;",
    editable: false,
    trigger: {
      name,
      event: "UPDATE",
      timing: "BEFORE",
      enabled: false,
      valid: false,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        engineVersion: "4.2.5.7_107",
        owner,
        name,
        objectId: "9007199254740993",
        scope: "SCHEMA",
        scopeOwner: owner,
        definition: { origin: "catalog-body", format: "body", complete: false },
        errors: [{ sequence: 1, line: 2, position: 3, text: "Missing procedure" }],
        reads: { identity: { state: "available" }, scope: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "denied" }, errors: { state: "available" } },
      },
    },
  };
  rpc.getObjectSource.mockImplementation(async () => JSON.parse(JSON.stringify(raw)));
  rpc.executeQuery.mockResolvedValue({ columns: [], rows: [] });
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  useSqlExecutionDangerStore().cancelAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
async function mount(expectedObjectId = "9007199254740993", connection = config) {
  const host = document.createElement("div");
  document.body.append(host);
  const openSource = vi.fn();
  const open = ref(true);
  useConnectionStore().connections = [connection];
  app = createApp({ render: () => h(OracleInvalidObjectsDialog, { open: open.value, connection, database: "service", schema: executionSchema, triggerContext: { target, expectedObjectId }, onOpenSource: openSource }) });
  app.use(getActivePinia()!);
  app.use(i18n);
  app.mount(host);
  await vi.waitFor(() => expect(rpc.getObjectSource).toHaveBeenCalled());
  await nextTick();
  return { openSource, open };
}
const button = (key: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === i18n.global.t(key));

it("preselects the exact raw trigger and compiles with the shared actor, retaining INVALID after an accepted receipt", async () => {
  const { openSource } = await mount();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Missing procedure"));
  expect(rpc.getObjectSource).toHaveBeenCalledWith(config.id, "service", owner, name, "TRIGGER", undefined, undefined, { identityMode: "exact", catalog: " Catalog " });
  const compile = button("processList.oracleInvalidObjects.compile")!;
  expect(compile.disabled).toBe(false);
  compile.click();
  const danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  expect(danger.pending?.sql).toBe('ALTER TRIGGER " Trigger.Owner "." Tr""igger " COMPILE');
  danger.confirm();
  await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("processList.oracleInvalidObjects.compileStillInvalid")));
  expect(rpc.executeQuery).toHaveBeenCalledTimes(1);
  expect(rpc.executeQuery.mock.calls[0]?.[3]).toBe(executionSchema);
  expect(rpc.executeQuery.mock.calls[0]?.[4]).toBeUndefined();
  expect(rpc.executeQuery.mock.calls[0]?.[5]).toEqual(expect.objectContaining({ catalog: " Catalog " }));
  expect(document.body.textContent).toContain("Missing procedure");
  button("processList.oracleInvalidObjects.openSource")!.click();
  expect(openSource).toHaveBeenCalledWith(expect.objectContaining({ owner, name, type: "TRIGGER", objectId: "9007199254740993" }));
});

it("shows denied error metadata rather than an empty error list", async () => {
  raw.trigger!.oracle_metadata!.reads.errors = { state: "denied", message: "ALL_ERRORS denied" };
  raw.trigger!.oracle_metadata!.errors = [];
  await mount();
  await vi.waitFor(() => expect(document.body.textContent).toContain("ALL_ERRORS denied"));
  expect(document.body.textContent).not.toContain(i18n.global.t("processList.oracleInvalidObjects.noErrors"));
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});

it("opens the same exact source with the selected dictionary error coordinates", async () => {
  const { openSource } = await mount();
  const label = i18n.global.t("editor.locateError", { line: 2, column: 3 });
  await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((item) => item.getAttribute("aria-label") === label)).toBe(true));
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label)!.click();
  expect(openSource).toHaveBeenCalledWith(expect.objectContaining({ owner, name, type: "TRIGGER" }), { line: 2, position: 3 });
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});

it("refuses a same-name replacement without reading a guessed schema or submitting DDL", async () => {
  raw.trigger!.oracle_metadata!.objectId = "replacement-id";
  await mount();
  await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("oracleTrigger.reloadBaseline")));
  expect(rpc.executeQuery).not.toHaveBeenCalled();
  expect(useSqlExecutionDangerStore().pending).toBeUndefined();
});

it("cancels an unissued compile when the diagnostic context closes", async () => {
  const { open } = await mount();
  await vi.waitFor(() => expect(button("processList.oracleInvalidObjects.compile")).toBeDefined());
  button("processList.oracleInvalidObjects.compile")!.click();
  const danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  open.value = false;
  await vi.waitFor(() => expect(danger.pending).toBeUndefined());
  expect(rpc.executeQuery).not.toHaveBeenCalled();
});

it("limits DM diagnostics to this trigger and reads back native disable after a failed compile without sending ENABLE", async () => {
  raw.trigger!.enabled = true;
  raw.trigger!.oracle_metadata!.engine = "dm";
  raw.trigger!.oracle_metadata!.engineVersion = "8.1.3";
  rpc.executeQuery.mockImplementation(async () => {
    raw.trigger!.enabled = false;
    return { columns: [], rows: [], execution_error: true, error: "Compilation failed" };
  });
  await mount(undefined, { ...config, db_type: "dameng" });
  await vi.waitFor(() => expect(button("processList.oracleInvalidObjects.compile")).toBeDefined());
  button("processList.oracleInvalidObjects.compile")!.click();
  const danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  danger.confirm();
  await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("processList.oracleInvalidObjects.compileUnknown")));
  expect(document.body.textContent).toContain("INVALID");
  expect(document.body.textContent).toContain(i18n.global.t("objects.disabled"));
  expect(rpc.executeQuery).toHaveBeenCalledTimes(1);
  expect(rpc.executeQuery.mock.calls[0]?.[2]).toBe('ALTER TRIGGER " Trigger.Owner "." Tr""igger " COMPILE');
});
