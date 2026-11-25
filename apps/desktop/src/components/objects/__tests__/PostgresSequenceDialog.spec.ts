// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import PostgresSequenceDialog from "../PostgresSequenceDialog.vue";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  connectionWriteUnlockState: vi.fn(),
  unlockConnectionWrites: vi.fn(),
  store: { connections: [] as ConnectionConfig[], ensureConnected: vi.fn(), invalidateMetadataCache: vi.fn() },
}));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, connectionWriteUnlockState: mocks.connectionWriteUnlockState, unlockConnectionWrites: mocks.unlockConnectionWrites }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));

const metadataColumns = ["oid", "sequence_schema", "sequence_name", "data_type", "start_value", "min_value", "max_value", "increment", "cache_size", "cycle", "can_read_state", "can_alter"];
const cleanups: Array<() => void> = [];
const result = (columns: string[], rows: unknown[][]) => ({ columns, rows, affected_rows: 0 }) as QueryResult;
const writes = () => mocks.executeQuery.mock.calls.filter((call) => /^ALTER\s+SEQUENCE/.test(call[2]));
const field = (name: string) => document.querySelector<HTMLInputElement>(`[data-testid="sequence-${name}"]`)!;
const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-testid="sequence-${name}"]`)!;
const preview = () => document.querySelector('[data-testid="sequence-sql-preview"]')?.textContent;

async function edit(name: string, value: string) {
  field(name).value = value;
  field(name).dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
}
async function check(name: string, value: boolean) {
  field(name).checked = value;
  field(name).dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}

beforeEach(() => {
  mocks.store.connections = reactive([]);
  mocks.store.ensureConnected.mockResolvedValue(undefined);
  mocks.connectionWriteUnlockState.mockResolvedValue(0);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.executeQuery.mockReset();
  mocks.connectionWriteUnlockState.mockReset();
  mocks.unlockConnectionWrites.mockReset();
  mocks.store.ensureConnected.mockReset();
  mocks.store.invalidateMetadataCache.mockReset();
});

async function mount(options: { version?: string; databaseType?: DatabaseType; canReadState?: boolean; canAlter?: boolean; production?: boolean; readOnly?: boolean; stateFailure?: boolean } = {}) {
  const control = {
    metadata: ["12345", "public", "test_seq", "bigint", "1", "1", "9223372036854775807", "1", "1", false, options.canReadState ?? true, options.canAlter ?? true] as unknown[],
    state: ["9007199254740993", true] as unknown[],
    writeFailure: "",
    writeOutcome: "not_started" as "not_started" | "unknown",
    reloadFailure: false,
    failReloadAfterWrite: false,
  };
  mocks.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
    if (sql.includes("current_setting('server_version_num')")) {
      if (control.reloadFailure) throw new Error("connection lost during reload");
      return result(["server_version_num"], [[options.version ?? "160002"]]);
    }
    if (sql.includes("FROM pg_catalog.pg_sequence s")) return result(metadataColumns, [[...control.metadata]]);
    if (sql.startsWith("SELECT last_value::text")) {
      if (options.stateFailure) throw new Error("permission denied for sequence");
      return result(["last_value", "is_called"], [[...control.state]]);
    }
    if (/^ALTER\s+SEQUENCE/.test(sql)) {
      if (control.writeFailure) throw new BackendErrorException({ version: 1, code: "DBX-DB-1000", messageKey: "backendErrors.unknown", messageParams: {}, source: "postgres", detail: control.writeFailure, operationOutcome: control.writeOutcome });
      if (control.failReloadAfterWrite) control.reloadFailure = true;
      return result([], []);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  mocks.store.connections.push({ id: "pg", name: "test PostgreSQL", db_type: options.databaseType ?? "postgres", is_production: options.production, read_only: options.readOnly } as ConnectionConfig);
  const saved = vi.fn();
  const state = reactive({ open: true, connectionId: "pg", database: "test_database", schema: "public", name: "test_seq" });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(PostgresSequenceDialog, {
        ...state,
        onSaved: saved,
        "onUpdate:open": (open: boolean) => {
          state.open = open;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(button("refresh")?.disabled).toBe(false));
  return { control, state, saved };
}

describe("PostgreSQL sequence properties", () => {
  it("reads sequence state without consuming a value and preserves bigint precision", async () => {
    await mount();
    expect(document.body.textContent).toContain("9007199254740993");
    expect(field("maxValue").value).toBe("9223372036854775807");
    expect(field("maxValue").type).toBe("text");
    expect(field("restart-enabled").checked).toBe(false);
    expect(field("restartWith")).toBeNull();
    expect(button("save").disabled).toBe(true);
    expect(mocks.executeQuery.mock.calls.every((call) => !/\b(?:nextval|setval|currval)\s*\(/i.test(call[2]))).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("updates only the changed parameter without implicitly resetting the sequence", async () => {
    const { saved } = await mount();
    await edit("increment", "7");
    expect(preview()).toBe('ALTER SEQUENCE "public"."test_seq"\n  INCREMENT BY 7;');
    button("save").click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(writes()).toHaveLength(1);
    expect(writes()[0]![2]).toBe('ALTER SEQUENCE "public"."test_seq"\n  INCREMENT BY 7;');
    expect(mocks.store.invalidateMetadataCache).toHaveBeenCalledWith("pg", "test_database", "public");
  });

  it("changes START WITH independently from an explicitly enabled restart", async () => {
    await mount();
    await edit("startValue", "50");
    expect(preview()).toContain("START WITH 50");
    expect(preview()).not.toContain("RESTART");
    await check("restart-enabled", true);
    expect(field("restartWith").value).toBe("");
    expect(button("save").disabled).toBe(true);
    await edit("restartWith", "9007199254740993");
    expect(preview()).toContain("RESTART WITH 9007199254740993");
    await check("restart-enabled", false);
    expect(preview()).not.toContain("RESTART");
    button("save").click();
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toBe('ALTER SEQUENCE "public"."test_seq"\n  START WITH 50;');
  });

  it("retains a failed save draft and permits retry", async () => {
    const { control, saved } = await mount();
    control.writeFailure = "permission denied to alter sequence";
    await edit("cacheSize", "12");
    button("save").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(control.writeFailure));
    expect(field("cacheSize").value).toBe("12");
    expect(button("save").disabled).toBe(false);
    expect(saved).not.toHaveBeenCalled();
    expect(mocks.store.invalidateMetadataCache).not.toHaveBeenCalled();
    control.writeFailure = "";
    button("save").click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(writes()).toHaveLength(2);
  });

  it("does not replay RESTART after a successful write followed by a failed reload", async () => {
    const { control, saved } = await mount();
    control.failReloadAfterWrite = true;
    await check("restart-enabled", true);
    await edit("restartWith", "20");
    button("save").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("connection lost during reload"));
    expect(document.body.textContent).toContain("postgresSequence.saved");
    expect(saved).toHaveBeenCalledOnce();
    expect(button("save").disabled).toBe(true);
    expect(field("restartWith")).toBeNull();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]![2]).toContain("RESTART WITH 20");
    control.reloadFailure = false;
    button("refresh").click();
    await vi.waitFor(() => expect(field("increment")).not.toBeNull());
    expect(field("restart-enabled").checked).toBe(false);
    expect(button("save").disabled).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it("requires a fresh read after a lost write response instead of offering a restart replay", async () => {
    const { control, saved } = await mount();
    control.writeFailure = "connection lost after sending ALTER";
    control.writeOutcome = "unknown";
    await check("restart-enabled", true);
    await edit("restartWith", "20");
    button("save").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(control.writeFailure));
    expect(button("save").disabled).toBe(true);
    expect(field("restartWith").value).toBe("20");
    expect(saved).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    button("refresh").click();
    await vi.waitFor(() => expect(field("restart-enabled").checked).toBe(false));
    expect(button("save").disabled).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it.each([{ canReadState: false }, { stateFailure: true }])("keeps parameters editable when sequence state cannot be read (%j)", async (options) => {
    await mount(options);
    expect(document.body.textContent).toContain("postgresSequence.stateUnavailable");
    if (options.canReadState === false) expect(mocks.executeQuery.mock.calls.some((call) => call[2].startsWith("SELECT last_value::text"))).toBe(false);
    await edit("increment", "2");
    expect(button("save").disabled).toBe(false);
  });

  it("shows metadata read-only when the connection user does not own the sequence", async () => {
    await mount({ canAlter: false });
    expect(field("increment").closest("fieldset")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("postgresSequence.ownerRequired");
    expect(button("save").disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("rejects PostgreSQL before version 10 before querying pg_sequence", async () => {
    await mount({ version: "90624" });
    expect(document.body.textContent).toContain("postgresSequence.errors.unsupportedVersion");
    expect(mocks.executeQuery).toHaveBeenCalledOnce();
    expect(button("save").disabled).toBe(true);
  });

  it.each(["gaussdb", "mysql"] as const)("does not run PostgreSQL-specific SQL for %s", async (databaseType) => {
    await mount({ databaseType });
    expect(document.body.textContent).toContain("postgresSequence.postgresOnly");
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(button("save").disabled).toBe(true);
  });

  it("rejects an invalid increment before executing any write", async () => {
    await mount();
    await edit("increment", "0");
    expect(document.body.textContent).toContain("postgresSequence.errors.invalidIncrement");
    expect(button("save").disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it.each(["oid", "definition"])("requires refresh after the sequence %s changes", async (change) => {
    const { control, saved } = await mount();
    await edit("increment", "4");
    if (change === "oid") control.metadata[0] = "56789";
    else control.metadata[8] = "20";
    button("save").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("postgresSequence.conflict"));
    expect(writes()).toEqual([]);
    expect(saved).not.toHaveBeenCalled();
    expect(field("increment").value).toBe("4");
  });

  it("uses the real production guard and preserves the draft when confirmation is cancelled", async () => {
    await mount({ production: true });
    await edit("increment", "3");
    button("save").click();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    expect(safety.pending?.sql).toContain("INCREMENT BY 3");
    expect(writes()).toEqual([]);
    safety.cancel();
    await vi.waitFor(() => expect(button("save").disabled).toBe(false));
    expect(field("increment").value).toBe("3");
    expect(writes()).toEqual([]);
    button("save").click();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
  });

  it.each(["close", "switch"])("cancels pending production confirmation on target %s", async (action) => {
    const { state, control, saved } = await mount({ production: true });
    await edit("increment", "3");
    button("save").click();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    if (action === "close") state.open = false;
    else {
      control.metadata[2] = "other_seq";
      state.name = "other_seq";
    }
    await nextTick();
    expect(safety.pending).toBeUndefined();
    safety.confirm();
    await nextTick();
    expect(writes()).toEqual([]);
    expect(saved).not.toHaveBeenCalled();
  });

  it("honors the real read-only unlock guard", async () => {
    await mount({ readOnly: true });
    await edit("increment", "3");
    button("save").click();
    const unlock = useReadOnlyUnlockStore();
    await vi.waitFor(() => expect(unlock.pending).toBeDefined());
    expect(unlock.pending?.sql).toContain("INCREMENT BY 3");
    expect(writes()).toEqual([]);
    unlock.cancel();
    await vi.waitFor(() => expect(button("save").disabled).toBe(false));
    expect(writes()).toEqual([]);
  });
});
