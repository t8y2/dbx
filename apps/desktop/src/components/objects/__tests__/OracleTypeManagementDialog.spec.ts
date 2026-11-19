// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, OracleTypeManagementSnapshot } from "@/types/database";

const mocks = vi.hoisted(() => ({
  getOracleTypeManagementSnapshot: vi.fn(),
  buildOracleTypeManagementSql: vi.fn(),
  verifyOracleTypeData: vi.fn(),
  prepareOracleTypeEvolution: vi.fn(),
  executeConditionalUpdate: vi.fn(),
  cancelConditionalUpdate: vi.fn(),
  saveOpenTabsState: vi.fn(),
  loadOpenTabsState: vi.fn(),
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(async ({ source }: { source: string }) => source),
  checkConnectionHealth: vi.fn(async () => {}),
  deleteSchemaCachePrefix: vi.fn(async () => {}),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => {}),
  subscribeConnectionLiveness: vi.fn(async () => () => {}),
  subscribeConnectionIdleClosed: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...mocks }));

const target = { connectionId: "type-dialog", database: "service", owner: "APP", name: "T", databaseType: "oceanbase-oracle" as const };
const spec = 'CREATE OR REPLACE TYPE "APP"."T" AS OBJECT (ID NUMBER, MEMBER FUNCTION F RETURN NUMBER);';
const body = 'CREATE OR REPLACE TYPE BODY "APP"."T" AS MEMBER FUNCTION F RETURN NUMBER AS BEGIN RETURN 1; END; END;';
const changed = body.replace("RETURN 1", "RETURN 2");
const read = { state: "available" as const };
let actualBody: string;
let actualStatus: string;
let failure: "invalid" | "invalid-response-lost" | "unknown" | "different" | undefined;
let saved: { tabs: unknown[]; activeTabId: string | null };
let pinia: ReturnType<typeof createPinia>;
let app: App | undefined;
let host: HTMLElement | undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function snapshot(): OracleTypeManagementSnapshot {
  return {
    target: { connectionId: target.connectionId, database: target.database, owner: target.owner, name: target.name },
    visibilityScope: "current-user-visible-dictionaries",
    actingUser: "APP",
    actingUserRead: read,
    detailsRead: read,
    typeSource: spec,
    typeSourceRead: read,
    bodySource: actualBody,
    bodySourceRead: read,
    objects: [
      { owner: "APP", name: "T", objectType: "TYPE", exists: true, objectId: "9007199254740993", status: "VALID", statusRead: read, source: spec, sourceRead: read, sourceFingerprint: spec, errors: [], errorsRead: read, directPrivileges: [], privilegesRead: read },
      { owner: "APP", name: "T", objectType: "TYPE BODY", exists: true, objectId: "2", status: actualStatus, statusRead: read, source: actualBody, sourceRead: read, sourceFingerprint: actualBody, errors: [], errorsRead: read, directPrivileges: [], privilegesRead: { state: "unsupported" } },
    ],
    dependencies: [],
    dependenciesRead: read,
    persistentReferences: [],
    persistentReferencesRead: read,
    directPrivileges: [],
    privilegesRead: read,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.cancelConditionalUpdate.mockResolvedValue({ requested: false, terminal: true, databaseTerminal: true });
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      onmessage = null;
      onerror = null;
      close() {}
    },
  );
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/api/tab-runtime-cache/prune")) return new Response(JSON.stringify({ deletedEntries: 0, deletedBytes: 0, orphanDeletions: 0, remainingEntries: 0, remainingBytes: 0 }), { status: 200 });
      throw new Error(`Unmocked HTTP boundary: ${String(url)}`);
    }),
  );
  pinia = createPinia();
  setActivePinia(pinia);
  actualBody = body;
  actualStatus = "VALID";
  failure = undefined;
  saved = { tabs: [], activeTabId: null };
  mocks.getOracleTypeManagementSnapshot.mockImplementation(async () => clone(snapshot()));
  mocks.buildOracleTypeManagementSql.mockImplementation(async ({ source }) => ({ statements: [source], sourceFingerprint: source }));
  mocks.saveOpenTabsState.mockImplementation(async (payload) => {
    saved = clone(payload);
  });
  mocks.loadOpenTabsState.mockImplementation(async () => clone(saved));
  mocks.getObjectSource.mockImplementation(async () => ({ name: "T", object_type: "TYPE_BODY", source: actualBody, editable: true }));
  mocks.executeConditionalUpdate.mockImplementation(async (_connection, _database, sql) => {
    if (failure === "unknown") throw new Error("Unknown response");
    actualBody = failure === "different" ? sql.replace("RETURN 2", "RETURN 9") : sql;
    actualStatus = failure === "invalid" || failure === "invalid-response-lost" ? "INVALID" : "VALID";
    if (failure === "invalid-response-lost") throw new Error("Lost response after completed INVALID DDL");
    return { columns: [], rows: [], execution_error: false, error: null, messages: [] };
  });
});

afterEach(async () => {
  const requests = await import("@/lib/table/oracleTypeManagementRequest");
  const current = requests.oracleTypeManagementRequest.value;
  if (current) requests.finishOracleTypeManagementRequest(current.id, { complete: false, operation: current.operation, target: current.target });
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  disposePinia(pinia);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const unexpectedRequests = vi
    .mocked(fetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => !url.endsWith("/api/tab-runtime-cache/prune"));
  expect(unexpectedRequests).toEqual([]);
  vi.unstubAllGlobals();
});

async function mount(production = false, isCurrent = () => true, baseSource?: string, operation: "save-body" | "save-spec" = "save-body", databaseType: "oracle" | "oceanbase-oracle" = target.databaseType) {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const connectionStore = useConnectionStore();
  connectionStore.connections.push({ id: target.connectionId, name: "test", db_type: databaseType, username: "APP", is_production: production } as ConnectionConfig);
  connectionStore.connectedIds.add(target.connectionId);
  const { useQueryStore } = await import("@/stores/queryStore");
  const queryStore = useQueryStore();
  await queryStore.initOpenTabs();
  const { default: i18n, setLocale } = await import("@/i18n");
  await setLocale("zh-CN");
  const { default: Dialog } = await import("../OracleTypeManagementDialog.vue");
  const requests = await import("@/lib/table/oracleTypeManagementRequest");
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(Dialog) })
    .use(pinia)
    .use(i18n);
  app.mount(host);
  const outcome = requests.requestOracleTypeManagement({ target: { ...target, databaseType }, operation, source: operation === "save-body" ? changed : spec.replace("ID NUMBER", "ID NUMBER, LABEL VARCHAR2(40)"), baseSource, isCurrent });
  await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>("[data-source-draft]")?.disabled).toBe(false));
  return { queryStore, outcome, requests, i18n };
}

function confirm() {
  document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.click();
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;
}

describe("TYPE preview using the real component, planner and stores", () => {
  it("hides the previous final SQL after editing until the new draft is revalidated", async () => {
    const { queryStore } = await mount();
    expect([...document.querySelectorAll("pre")].filter((item) => item.textContent === changed)).toHaveLength(2);
    const editor = document.querySelector<HTMLTextAreaElement>("[data-source-draft]")!;
    const revised = changed.replace("RETURN 2", "RETURN 3");
    editor.value = revised;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(queryStore.tabs[0].typeManagementDraft?.drafts[0].source).toBe(revised);
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(true);
    expect([...document.querySelectorAll("pre")].some((item) => item.textContent === changed)).toBe(false);
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    expect([...document.querySelectorAll("pre")].filter((item) => item.textContent === revised)).toHaveLength(2);
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
  });

  it("retains successful compiler warnings in the durable execution record without classifying VALID as a failed save", async () => {
    mocks.getOracleTypeManagementSnapshot.mockImplementation(async () => {
      const value = snapshot();
      value.objects.find((object) => object.objectType === "TYPE BODY")!.errorsRead = { state: "available", reason: "Compilation warnings:\n1:1 PLW-06009: compiler warning" };
      return value;
    });
    const { queryStore, outcome } = await mount();
    confirm();
    expect((await outcome).complete).toBe(true);
    expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("confirmed");
    expect(queryStore.tabs[0].typeManagementDraft?.steps[0].message).toContain("PLW-06009");
    expect(JSON.stringify(saved)).toContain("PLW-06009");
  });
  it("shows the native Oracle route without adding a manual baseline preparation prerequisite", async () => {
    mocks.getOracleTypeManagementSnapshot.mockImplementation(async () => {
      const value = snapshot();
      value.persistentReferences = [{ owner: "APP", tableName: "DATA", columnName: "VALUE", dataTypeOwner: "APP", dataType: "T" }];
      return value;
    });
    mocks.prepareOracleTypeEvolution.mockImplementation(async (input) => ({ ...input, metadata: "verified native guards", phase: 0, statements: ['ALTER TYPE "APP"."T" ADD ATTRIBUTE (LABEL VARCHAR2(40 BYTE)) CASCADE INCLUDING TABLE DATA;'] }));
    const { queryStore, i18n } = await mount(false, () => true, undefined, "save-spec", "oracle");
    expect(document.querySelector("[data-native-type-evolution]")?.textContent).toBe(i18n.global.t("objects.typeManagementNativeEvolution"));
    expect(document.body.textContent).not.toContain(i18n.global.t("objects.typeDataTitle"));
    expect(queryStore.tabs[0].typeManagementDraft?.nativeEvolution?.phase).toBe(0);
    expect(queryStore.tabs[0].typeManagementDraft?.issues).toEqual([]);
    expect(mocks.verifyOracleTypeData).not.toHaveBeenCalled();
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
  });
  it("shows a different live definition read-only and never offers a blind resend", async () => {
    failure = "different";
    const { queryStore, i18n } = await mount();
    confirm();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("unknown"));
    expect(document.querySelector("[data-current-source] pre")?.textContent).toBe(actualBody);
    expect(document.querySelector("[data-current-source]")?.textContent).toContain(i18n.global.t("objects.typeManagementCurrentSource"));
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.issues.some((issue) => issue.code === "unknown-result")).toBe(true));
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(true);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
  });
  it("does not impose a scalar data migration on a BODY-only save even when the TYPE has stored values", async () => {
    mocks.getOracleTypeManagementSnapshot.mockImplementation(async () => {
      const value = snapshot();
      value.persistentReferences = [{ owner: "APP", tableName: "DATA", columnName: "VALUE", dataTypeOwner: "APP", dataType: "T" }];
      return value;
    });
    const { outcome, i18n } = await mount();
    expect(document.body.textContent).not.toContain(i18n.global.t("objects.typeDataTitle"));
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false);
    confirm();
    expect((await outcome).complete).toBe(true);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    expect(mocks.verifyOracleTypeData).not.toHaveBeenCalled();
  });
  it("persists a complete manual mapping, keeps SQL-editor preparation separate, and revalidates after actual data and unlink verification", async () => {
    let prepared = false;
    mocks.getOracleTypeManagementSnapshot.mockImplementation(async () => {
      const value = snapshot();
      value.objects.push({
        owner: "APP",
        name: "SRC",
        objectType: "TABLE",
        exists: !prepared,
        objectId: prepared ? null : "table-id",
        status: prepared ? null : "VALID",
        statusRead: read,
        source: null,
        sourceRead: { state: "unsupported" },
        errors: [],
        errorsRead: read,
        directPrivileges: [],
        privilegesRead: { state: "unsupported" },
      });
      if (!prepared) {
        value.persistentReferences = [{ owner: "APP", tableName: "SRC", columnName: "VALUE", dataTypeOwner: "APP", dataType: "T" }];
        value.dependencies = [{ owner: "APP", name: "SRC", objectType: "TABLE", referencedOwner: "APP", referencedName: "T", referencedType: "TYPE" }];
      }
      return value;
    });
    const projection = [
      { path: ["VALUE"], objectNull: true, dataType: "NUMBER(1,0)" },
      { path: ["VALUE", "ID"], objectNull: false, dataType: "NUMBER(38,0)" },
    ];
    const baseline = (name: string, original = false) => ({
      relation: {
        relation: { owner: "APP", name },
        objectId: name === "SRC" ? "table-id" : `${name}-id`,
        readOnly: name === "OLD" || name === "EXPECTED",
        structure: `${name}-definition`,
        projection: original
          ? projection
          : [
              { path: ["C1"], objectNull: false, dataType: "NUMBER(1,0)" },
              { path: ["C2"], objectNull: false, dataType: "NUMBER(38,0)" },
            ],
      },
      rowCount: 3,
      fingerprint: "c".repeat(64),
    });
    mocks.verifyOracleTypeData.mockImplementation(async (input) => {
      if (input.action === "describe") return { relation: baseline("SRC", true).relation };
      if (input.action === "register") return { manifest: { mapping: clone(input.mapping), original: baseline("SRC", true), old: baseline("OLD"), expected: baseline("EXPECTED"), preparedTarget: null, verifiedTarget: null } };
      if (!prepared) throw new Error("Target data and live TYPE references are not ready");
      return { manifest: { ...clone(input.manifest), verifiedTarget: baseline("RESULT") } };
    });
    const { queryStore, outcome, i18n } = await mount(false, () => true, undefined, "save-spec");
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(true);
    button(i18n.global.t("objects.typeDataReadProjection")).click();
    const carrier = () => queryStore.tabs.find((tab) => tab.typeManagementDraft)!;
    await vi.waitFor(() => expect(carrier().typeManagementDraft?.dataPreparation?.fields).toHaveLength(2));
    const change = async (input: HTMLInputElement, value: string, expected: () => unknown, wanted: unknown) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(expected()).toEqual(wanted));
    };
    for (const [index, name] of [
      [0, "OLD"],
      [1, "EXPECTED"],
      [2, "RESULT"],
    ] as const) {
      const input = document.querySelectorAll("fieldset")[index].querySelectorAll<HTMLInputElement>("input")[1];
      await change(input, name, () => carrier().typeManagementDraft?.dataPreparation?.[index === 0 ? "old" : index === 1 ? "expected" : "target"].name, name);
    }
    const pathLabel = i18n.global.t("objects.typeDataTargetPath");
    for (const index of [0, 1]) await change(document.querySelector<HTMLInputElement>(`input[aria-label='${pathLabel} ${index + 1}']`)!, JSON.stringify([`C${index + 1}`]), () => carrier().typeManagementDraft?.dataTargetPaths?.[index], JSON.stringify([`C${index + 1}`]));
    const flag = document.querySelector<HTMLInputElement>(`input[aria-label='${pathLabel} 1 IS NULL']`)!;
    flag.checked = false;
    flag.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(carrier().typeManagementDraft?.dataPreparation?.fields[0].targetObjectNull).toBe(false));
    button(i18n.global.t("objects.typeDataPrepareSql")).click();
    expect(queryStore.tabs.some((tab) => tab.sql.includes('CASE WHEN T."VALUE" IS NULL THEN 1 ELSE 0 END'))).toBe(true);
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    button(i18n.global.t("objects.typeDataRegister")).click();
    await vi.waitFor(() => expect(carrier().typeManagementDraft?.dataMappings).toHaveLength(1));
    const registered = clone(carrier().typeManagementDraft!.dataMappings[0].manifest);
    expect((saved.tabs.find((tab: any) => tab.typeManagementDraft) as any).typeManagementDraft.dataMappings[0].manifest).toEqual(registered);
    expect(registered.mapping.fields[0].targetPath).toEqual(["C1"]);
    button(i18n.global.t("objects.typeDataVerify")).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Target data and live TYPE references are not ready"));
    expect(carrier().typeManagementDraft!.dataMappings[0].manifest.old).toEqual(registered.old);
    prepared = true;
    button(i18n.global.t("objects.typeDataVerify")).click();
    await vi.waitFor(() => expect(carrier().typeManagementDraft?.dataMappings[0].manifest.verifiedTarget?.rowCount).toBe(3));
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(carrier().typeManagementDraft?.executable).toBe(true));
    expect(carrier().typeManagementDraft!.dataMappings[0].manifest.old).toEqual(registered.old);
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    button(i18n.global.t("objects.typeManagementKeepDraft")).click();
    expect((await outcome).complete).toBe(false);
    expect(carrier().typeManagementDraft?.dataMappings[0].manifest.old).toEqual(registered.old);
  });
  it("keeps the source draft durable on cancel and sends no SQL merely for preparing a preview", async () => {
    const { queryStore, outcome, i18n } = await mount();
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    expect(queryStore.tabs[0].typeManagementDraft?.drafts[0].source).toBe(changed);
    expect(document.body.textContent).toContain("TYPE BODY");
    button(i18n.global.t("objects.typeManagementKeepDraft")).click();
    expect((await outcome).complete).toBe(false);
    expect(queryStore.tabs[0].typeManagementDraft?.state).toBe("validated");
    expect((saved.tabs[0] as { typeManagementDraft: { planId: string } }).typeManagementDraft.planId).toBe(queryStore.tabs[0].typeManagementDraft?.planId);
  });

  it("writes, reads back, and only then marks a BODY save complete", async () => {
    const { queryStore, outcome } = await mount();
    confirm();
    expect((await outcome).complete).toBe(true);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    expect(mocks.executeConditionalUpdate.mock.calls[0].slice(0, 4)).toEqual([target.connectionId, target.database, changed, "APP"]);
    expect(actualBody).toBe(changed);
    expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("confirmed");
    expect(queryStore.tabs[0].typeManagementDraft?.state).toBe("complete");
    expect(queryStore.tabs[0].typeSourceEditing).toBe(false);
  });

  it("reloads a completed recovery tab so its source identity allows the next explicit edit", async () => {
    const { queryStore, outcome } = await mount();
    const tab = queryStore.tabs[0];
    const { assertSourceIdentity } = await import("@/lib/table/objectSourceIdentity");
    expect(tab.sourceLoad).toBeUndefined();
    const originalIdentity = queryStore.getObjectSourceIdentitySnapshot(tab)!;
    confirm();
    expect((await outcome).complete).toBe(true);
    await vi.waitFor(() => expect(() => assertSourceIdentity(queryStore.getObjectSourceIdentitySnapshot(tab)!)).not.toThrow());
    expect(mocks.getObjectSource).toHaveBeenCalledWith(target.connectionId, target.database, target.owner, target.name, "TYPE_BODY", undefined, undefined);
    expect(tab.sql).toBe(changed);
    expect(tab.originalSql).toBe(changed);
    expect(tab.typeSourceEditing).toBe(false);
    expect(() => assertSourceIdentity(originalIdentity)).toThrow();
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
  });

  it.each([false, true])("refreshes the completed recovery tab without handing it to another frozen source tab (dirty=%s)", async (dirty) => {
    const { queryStore, outcome } = await mount();
    const recovery = queryStore.tabs[0];
    const sourceId = queryStore.createTab(target.connectionId, target.database, "Source - T", "query", target.owner, body, undefined, { forceNew: true, sourceView: true });
    queryStore.setObjectSource(sourceId, { schema: target.owner, name: target.name, objectType: "TYPE_BODY" });
    const source = queryStore.tabs.find((tab) => tab.id === sourceId)!;
    const oldDraft = dirty ? `${body}\n-- unsaved source draft` : body;
    queryStore.updateSql(sourceId, oldDraft);
    const { assertSourceIdentity } = await import("@/lib/table/objectSourceIdentity");
    const sourceIdentity = queryStore.getObjectSourceIdentitySnapshot(source)!;
    confirm();
    expect((await outcome).complete).toBe(true);
    await vi.waitFor(() => expect(recovery.sourceLoad).toBeUndefined());
    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([recovery.id, sourceId]);
    expect(recovery.typeManagementDraft?.state).toBe("complete");
    expect(recovery.sql).toBe(changed);
    expect(recovery.originalSql).toBe(changed);
    expect(recovery.typeSourceEditing).toBe(false);
    expect(() => assertSourceIdentity(queryStore.getObjectSourceIdentitySnapshot(recovery)!)).not.toThrow();
    expect(source.sql).toBe(oldDraft);
    expect(queryStore.isTabDirty(source)).toBe(dirty);
    expect(() => assertSourceIdentity(sourceIdentity)).toThrow();
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
  });

  it("honors the actual production guard's cancellation and target recheck", async () => {
    let current = true;
    const { queryStore, outcome, i18n } = await mount(true, () => current);
    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    const safety = useProductionSafetyStore();
    confirm();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    expect(queryStore.tabs[0].typeManagementDraft?.state).toBe("validated");
    confirm();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    current = false;
    safety.confirm();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    button(i18n.global.t("objects.typeManagementKeepDraft")).click();
    expect((await outcome).complete).toBe(false);
  });

  it.each(["invalid", "invalid-response-lost"] as const)("keeps %s with zero diagnostics editable and saves the repaired per-object draft", async (outcomeFailure) => {
    failure = outcomeFailure;
    const { queryStore, outcome, i18n } = await mount();
    confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("INVALID"));
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>("[data-source-draft]")!.disabled).toBe(false));
    const editor = document.querySelector<HTMLTextAreaElement>("[data-source-draft]")!;
    expect(editor.labels?.[0]?.textContent).toContain(`${i18n.global.t("objects.typeManagementDraftLabel")} · APP.T`);
    expect(document.body.textContent).toContain(i18n.global.t("objects.typeManagementValidationPending"));
    expect(document.body.textContent).not.toContain(i18n.global.t("objects.viewRenameValidationPending"));
    const repaired = changed.replace("RETURN 2", "RETURN 3");
    editor.value = repaired;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(true);
    failure = undefined;
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    expect(document.querySelector("[data-type-execution-history]")?.textContent).toContain("INVALID");
    confirm();
    expect((await outcome).complete).toBe(true);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledTimes(2);
    expect(actualBody).toBe(repaired);
    expect(queryStore.tabs[0].sql).toBe(repaired);
    expect(queryStore.tabs[0].typeManagementDraft?.history[0].state).toBe("failed");
  });

  it("renders separate diagnostics for actual retries of the same SQL without adding attempts for validation alone", async () => {
    failure = "invalid";
    const { queryStore, outcome, i18n } = await mount();
    confirm();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("failed"));
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.history).toHaveLength(1));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    confirm();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("failed"));
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.history).toHaveLength(2));
    expect(document.querySelectorAll("[data-type-execution-history] > div")).toHaveLength(2);
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    expect(queryStore.tabs[0].typeManagementDraft?.history).toHaveLength(2);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledTimes(2);
    button(i18n.global.t("objects.typeManagementKeepDraft")).click();
    expect((await outcome).complete).toBe(false);
  });

  it("offers readback after an unknown result without replaying the statement", async () => {
    failure = "unknown";
    const { queryStore, outcome, i18n } = await mount();
    confirm();
    await vi.waitFor(() => expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("unknown"));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-validate]")!.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("previously sent"));
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(true);
    button(i18n.global.t("objects.typeManagementKeepDraft")).click();
    expect((await outcome).complete).toBe(false);
    expect(queryStore.tabs[0].typeManagementDraft?.steps[0].state).toBe("unknown");
  });

  it("shows the live original and requires revalidation when source changed after the editor loaded", async () => {
    const { outcome, i18n } = await mount(false, () => true, body.replace("RETURN 1", "RETURN 0"));
    expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("changed since it was loaded");
    expect(document.body.textContent).toContain(body);
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-type-management-confirm]")!.disabled).toBe(false));
    button(i18n.global.t("objects.typeManagementKeepDraft")).click();
    expect((await outcome).complete).toBe(false);
  });
});
