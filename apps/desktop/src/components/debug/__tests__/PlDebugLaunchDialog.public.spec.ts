// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugInspectResult, PlDebugReceipt, PlDebugSnapshot, PlDebugTargetSignature } from "@/lib/debug/plDebugProtocol";

const tab = vi.hoisted(() => ({ open: vi.fn(), source: vi.fn() }));
const guard = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openPlDebugTab: tab.open, openObjectSourceTabPending: tab.source }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "conn", name: "Fixture" }] }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => guard.run(options) }));

import i18n from "@/i18n";
import PlDebugLaunchDialog from "../PlDebugLaunchDialog.vue";
import { launchPlDebug, launchPlDebugAnonymous, plDebugLaunchOpen, plDebugLaunchTarget } from "../plDebugLaunch";
import { usePlDebugStore } from "@/stores/plDebugStore";

let app: App;
let pinia: ReturnType<typeof createPinia>;
let inspection: PlDebugInspectResult;
let compileResult: Record<string, unknown> | null;
let loseCompilation: boolean;
let compilationReadbackFailure: boolean;
let currentDiagnostic: string;
let compileGate: Promise<void> | null;
let snapshot: PlDebugSnapshot;
let rejectStart: boolean;
let unconfirmedStart: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
const calls: Array<{ path: string; body: Record<string, any> }> = [];
const receipts = new Map<string, PlDebugReceipt>();
const target = { connectionId: "conn", database: "APP", databaseType: "oracle" as const, schema: 'Mixed"Owner', objectType: "PROCEDURE", objectName: "Exact.Name", packageName: " A Pkg " };

function candidate(id = 7): NonNullable<PlDebugInspectResult["targetPreview"]>["candidates"][number] {
  const args: PlDebugTargetSignature["arguments"] = [
    { name: "N", position: 1, sequence: 1, dataLevel: 0, mode: "IN", type: "NUMBER", typeOwner: null, typeName: null, typeSubname: null, defaulted: "N" },
    { name: "T", position: 2, sequence: 2, dataLevel: 0, mode: "IN", type: "VARCHAR2", typeOwner: null, typeName: null, typeSubname: null, defaulted: "Y" },
    { name: "R", position: 3, sequence: 3, dataLevel: 0, mode: "OUT", type: "VARCHAR2", typeOwner: null, typeName: null, typeSubname: null, defaulted: "N" },
  ];
  return { signature: { schema: target.schema, objectName: target.objectName, packageName: target.packageName, objectType: "PROCEDURE", objectId: "9007199254740993123", subprogramId: id, status: "VALID", arguments: args }, parameters: args, returnValue: null, parameterTransport: "implemented" };
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  i18n.global.locale.value = "en";
  plDebugLaunchOpen.value = false;
  plDebugLaunchTarget.value = null;
  rejectStart = false;
  unconfirmedStart = false;
  calls.length = 0;
  receipts.clear();
  tab.open.mockClear();
  tab.source.mockClear();
  compileResult = null;
  loseCompilation = false;
  compilationReadbackFailure = false;
  currentDiagnostic = "current dictionary diagnostic";
  compileGate = null;
  guard.run.mockImplementation((options: { execute: () => Promise<unknown> }) => options.execute());
  inspection = { connectionRevision: "epoch:5", capabilities: { supported: true }, targetPreview: { schema: target.schema, state: "available", candidates: [candidate()] } };
  fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    const path = url.split("/").pop()!;
    const body = JSON.parse(String(options.body));
    calls.push({ path, body });
    let result: unknown;
    if (path === "bootstrap") result = { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
    else if (path === "inspect")
      result =
        body.target?.metadataPreparation === "debug_compile"
          ? {
              connectionRevision: "epoch:5",
              capabilities: { supported: true },
              compilePreview: {
                schema: target.schema,
                objectName: target.packageName,
                objectType: "PACKAGE BODY",
                sql: 'ALTER PACKAGE "Mixed""Owner"." A Pkg " COMPILE DEBUG BODY REUSE SETTINGS',
                reusesSettings: true,
                sources: [],
                canCompile: true,
                state: "available",
                settings: { state: "unknown" },
              },
              compileObservation: { schema: target.schema, objectName: target.packageName, objectType: "PACKAGE BODY", readback: { status: "INVALID", diagnosticsComplete: true, diagnostics: [{ line: "5", position: "3", text: currentDiagnostic }] } },
            }
          : inspection;
    else if (path === "compile") {
      if (compileGate) await compileGate;
      if (compilationReadbackFailure) currentDiagnostic = "new dictionary diagnostic after DDL";
      compileResult = {
        serverEpoch: body.serverEpoch,
        operationId: body.operationId,
        connectionId: body.connectionId,
        clientSessionId: body.clientSessionId,
        target: { schema: body.preview.schema, objectName: body.preview.objectName, objectType: body.preview.objectType },
        dispatched: true,
        ddlState: "executed",
        finished: true,
        releaseState: "released",
        error: null,
        cleanupError: null,
        result: compilationReadbackFailure ? { readbackError: "initial readback lost" } : { readback: { status: "INVALID", diagnosticsComplete: true, diagnostics: [{ line: "5", position: "3", text: "PLS-00201: missing name" }] } },
      };
      if (loseCompilation) throw new Error("compile response lost");
      result = compileResult;
    } else if (path === "compile-status") result = compileResult;
    else if (path === "start") {
      if (rejectStart)
        return new Response(
          JSON.stringify({ version: 1, code: "DBX-PLDEBUG-1001", messageKey: "backendErrors.plDebug.admissionRejected", messageParams: {}, source: "legacyBackend", origin: { subsystem: "backend", adapter: "legacy" }, operationOutcome: "not_started", detail: "Refresh the stale target preview" }),
          { status: 500 },
        );
      snapshot = {
        serverEpoch: "epoch",
        sessionId: "original",
        connectionId: body.connectionId,
        clientSessionId: body.clientSessionId,
        database: body.database,
        startOperationId: body.operationId,
        generation: 1,
        revision: 2,
        stopRevision: 1,
        state: "paused",
        startState: "succeeded",
        executionOutcome: "pending",
        executionStopped: false,
        transactionOutcome: "pending",
        releaseState: "open",
        runtimeExited: false,
        closing: false,
        activeOperationId: null,
        target: body.target,
      };
      result = { serverEpoch: "epoch", sessionId: "original", operationId: body.operationId, generation: 1, revision: 2, state: "succeeded", dispatched: true, result: snapshot, error: null } satisfies PlDebugReceipt;
      if (unconfirmedStart) {
        snapshot.state = "running";
        snapshot.startState = "running";
        (result as PlDebugReceipt).state = "unknown";
      }
      receipts.set(body.operationId, result as PlDebugReceipt);
    } else if (path === "operation") result = receipts.get(body.operationId);
    else if (path === "status") result = snapshot;
    else throw new Error(`Unexpected boundary ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  pinia = createPinia();
  setActivePinia(pinia);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(PlDebugLaunchDialog);
  app.use(pinia).use(i18n).mount(root);
});

afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

async function openNamed() {
  await launchPlDebug(target);
  await vi.waitFor(() => expect(document.querySelector('input[aria-label="N"]')).not.toBeNull());
}

async function acceptRisk() {
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.includes("I understand this program"))!.click();
  await nextTick();
}

function input(name: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("public exact debugger launch dialog", () => {
  function compositeCandidate(collection = false) {
    const argument = { ...candidate().parameters[0]!, name: "X", type: "EXT", typeOwner: "S", typeName: collection ? "A" : "R", typeSubname: "P", mode: "IN OUT" as const };
    const reference = { owner: "S", packageName: "P", typeName: argument.typeName };
    const selected = candidate();
    selected.parameters = [argument];
    selected.signature = {
      ...selected.signature,
      arguments: [argument],
      signatureVersion: 2,
      metadataPreparation: "type_only",
      typeBindings: [{ sequence: 1, reference }],
      argumentDetails: [],
      targetVersion: { objects: [], source: [] },
      typeGraph: {
        versions: [],
        nodes: [
          {
            reference: { owner: "S", packageName: "P", typeName: "R" },
            definition: { TYPECODE: "PL/SQL RECORD" },
            attributes: [
              { ATTR_NAME: "N", ATTR_TYPE_NAME: "NUMBER" },
              { ATTR_NAME: "ITEMS", ATTR_TYPE_OWNER: "S", ATTR_TYPE_PACKAGE: "P", ATTR_TYPE_NAME: "A" },
            ],
            collections: [],
          },
          { reference: { owner: "S", packageName: "P", typeName: "A" }, definition: { TYPECODE: "COLLECTION" }, attributes: [], collections: [{ COLL_TYPE: "TABLE", ELEM_TYPE_NAME: "NUMBER", ...(collection ? {} : { INDEX_BY: "BINARY_INTEGER" }) }] },
        ],
      },
    };
    return selected;
  }

  it("prepares Oracle types and upgrades the matching legacy composite draft before starting", async () => {
    const prepared = compositeCandidate(true);
    const legacy = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
    delete legacy.signature.signatureVersion;
    delete legacy.signature.metadataPreparation;
    delete legacy.signature.typeGraph;
    delete legacy.signature.typeBindings;
    legacy.parameterTransport = "not_implemented";
    inspection.targetPreview!.candidates = [legacy];
    await launchPlDebug(target);
    await vi.waitFor(() => expect(button("Load parameter types").disabled).toBe(false));
    inspection = { ...inspection, targetPreview: { ...inspection.targetPreview!, candidates: [prepared] } };
    button("Load parameter types").click();
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    expect(calls.filter((call) => call.path === "inspect").at(-1)!.body.target.metadataPreparation).toBe("type_only");
    button("Add entry").click();
    await nextTick();
    input("X[1]", "7");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    const submitted = calls.find((call) => call.path === "start")!.body.target;
    expect(submitted.metadataPreparation).toBe("type_only");
    expect(submitted.targetSignature).toEqual(prepared.signature);
    expect(submitted.params[0].typedValue).toEqual({ kind: "collection", value: [{ index: "1", value: { kind: "number", value: "7" } }] });
  });

  it("edits exact record fields and sparse decimal indexes through the public launch path", async () => {
    inspection.targetPreview!.candidates = [compositeCandidate()];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X.N: Set value"]')).not.toBeNull());
    expect(document.body.textContent).toContain("field initializers or constructors");
    (document.querySelector('input[aria-label="X.N: Set value"]') as HTMLInputElement).click();
    await nextTick();
    input("X.N", "12345678901234567890123456789012345678");
    (document.querySelector('input[aria-label="X.ITEMS: Set value"]') as HTMLInputElement).click();
    await nextTick();
    button("Add entry").click();
    await nextTick();
    input("X.ITEMS[1]: Index", "-2");
    await nextTick();
    input("X.ITEMS[-2]", "7");
    await acceptRisk();
    expect(button("Start debugging").disabled).toBe(false);
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([
      {
        name: "X",
        type: "EXT",
        mode: "IN OUT",
        value: null,
        inputState: "value",
        typedValue: {
          kind: "record",
          value: [
            { name: "N", value: { kind: "number", value: "12345678901234567890123456789012345678" } },
            { name: "ITEMS", value: { kind: "collection", value: [{ index: "-2", value: { kind: "number", value: "7" } }] } },
          ],
        },
      },
    ]);
  });

  it("requires an explicit object constructor and preserves each constructor, default and NULL draft", async () => {
    const selected = compositeCandidate();
    const reference = { owner: "S", packageName: null, typeName: "T" };
    selected.parameters[0]!.typeName = "T";
    selected.parameters[0]!.typeSubname = null;
    selected.signature.typeBindings = [{ sequence: 1, reference }];
    selected.signature.typeGraph = {
      versions: [],
      nodes: [
        {
          reference,
          definition: { TYPECODE: "OBJECT", FINAL: "YES", INSTANTIABLE: "YES" },
          attributes: [],
          collections: [],
          constructorCalls: {
            state: "resolved",
            constructors: [
              { id: "user-1", origin: "user", parameters: [{ name: "N", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: false }] },
              {
                id: "user-2",
                origin: "user",
                parameters: [
                  { name: "LABEL", type: { ATTR_TYPE_NAME: "VARCHAR2" }, defaulted: false },
                  { name: "EXTRA", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: true },
                ],
              },
            ],
          },
        },
      ],
    };
    inspection.targetPreview!.candidates = [selected];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    const nullBox = () => document.querySelector<HTMLInputElement>('input[aria-label="X: SQL NULL"]')!;
    expect(nullBox().checked).toBe(true);
    nullBox().click();
    await nextTick();
    await acceptRisk();
    expect(button("Start debugging").disabled).toBe(true);
    const choose = async (id: string) => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="X: Constructor"]')!;
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTick();
    };
    await choose("user-1");
    input("X.N", "12345678901234567890123456789012345678");
    await nextTick();
    await choose("user-2");
    input("X.LABEL", "label😀");
    await nextTick();
    const defaultBox = () => document.querySelector<HTMLInputElement>('input[aria-label="X.EXTRA: Use default"]')!;
    expect(defaultBox().checked).toBe(true);
    defaultBox().click();
    await nextTick();
    input("X.EXTRA", "9");
    await nextTick();
    defaultBox().click();
    await nextTick();
    defaultBox().click();
    await nextTick();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.EXTRA"]')!.value).toBe("9");
    await choose("user-1");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.N"]')!.value).toBe("12345678901234567890123456789012345678");
    nullBox().click();
    await nextTick();
    nullBox().click();
    await nextTick();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.N"]')!.value).toBe("12345678901234567890123456789012345678");
    expect(button("Start debugging").disabled).toBe(false);
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params[0].typedValue).toEqual({ kind: "object", value: { type: reference, constructorId: "user-1", arguments: [{ name: "N", state: "value", value: { kind: "number", value: "12345678901234567890123456789012345678" } }] } });
  });

  it("retains an outdated object draft and lets the user repair renamed or retyped constructor parameters", async () => {
    const selected = compositeCandidate();
    const reference = { owner: "S", packageName: null, typeName: "T" };
    selected.parameters[0]!.typeName = "T";
    selected.parameters[0]!.typeSubname = null;
    selected.signature.typeBindings = [{ sequence: 1, reference }];
    selected.signature.typeGraph = {
      versions: [],
      nodes: [
        { reference, definition: { TYPECODE: "OBJECT", FINAL: "YES", INSTANTIABLE: "YES" }, attributes: [], collections: [], constructorCalls: { state: "resolved", constructors: [{ id: "user-1", origin: "user", parameters: [{ name: "N", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: false }] }] } },
      ],
    };
    inspection.targetPreview!.candidates = [selected];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    (document.querySelector('input[aria-label="X: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="X: Constructor"]')!;
    select.value = "user-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    input("X.N", "4");
    await nextTick();
    const refreshed = JSON.parse(JSON.stringify(selected)) as typeof selected;
    refreshed.signature.typeGraph!.nodes[0]!.constructorCalls!.constructors[0]!.parameters[0]!.name = "RENAMED";
    inspection = { ...inspection, targetPreview: { ...inspection.targetPreview!, candidates: [refreshed] } };
    button("Refresh preview").click();
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X.RENAMED"]')).not.toBeNull());
    expect(document.body.textContent).toContain("N");
    input("X.RENAMED", "9");
    await nextTick();
    await acceptRisk();
    expect(button("Start debugging").disabled).toBe(true);
    button("Remove").click();
    await nextTick();
    expect(button("Start debugging").disabled).toBe(false);
    const retyped = JSON.parse(JSON.stringify(refreshed)) as typeof selected;
    retyped.signature.typeGraph!.nodes[0]!.constructorCalls!.constructors[0]!.parameters[0]!.type.ATTR_TYPE_NAME = "VARCHAR2";
    inspection = { ...inspection, targetPreview: { ...inspection.targetPreview!, candidates: [retyped] } };
    button("Refresh preview").click();
    await vi.waitFor(() => expect(document.querySelector('button[aria-label="X.RENAMED: Clear"]')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.RENAMED"]')!.value).toBe("9");
    (document.querySelector('button[aria-label="X.RENAMED: Clear"]') as HTMLButtonElement).click();
    await nextTick();
    input("X.RENAMED", "updated");
    await nextTick();
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params[0].typedValue.value.arguments).toEqual([{ name: "RENAMED", state: "value", value: { kind: "text", value: "updated" } }]);
  });

  it("chooses a frozen subtype without rewriting the declared formal and keeps type-scoped constructor drafts", async () => {
    const selected = compositeCandidate();
    const base = { owner: "S", packageName: null, typeName: "BASE" };
    const sub = { owner: "S", packageName: null, typeName: "SUB" };
    selected.parameters[0]!.typeName = "BASE";
    selected.parameters[0]!.typeSubname = null;
    selected.signature.typeBindings = [{ sequence: 1, reference: base }];
    selected.signature.typeGraph = {
      versions: [],
      nodes: [
        {
          reference: base,
          definition: { TYPECODE: "OBJECT", FINAL: "NO", INSTANTIABLE: "YES" },
          attributes: [],
          collections: [],
          objectAccess: { state: "type_only_verified" },
          constructorCalls: { state: "resolved", constructors: [{ id: "user-1", origin: "user", parameters: [{ name: "N", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: false }] }] },
        },
        {
          reference: sub,
          definition: { TYPECODE: "OBJECT", FINAL: "YES", INSTANTIABLE: "YES", SUPERTYPE_OWNER: "S", SUPERTYPE_NAME: "BASE" },
          attributes: [],
          collections: [],
          objectAccess: { state: "type_only_verified" },
          constructorCalls: {
            state: "resolved",
            constructors: [
              {
                id: "user-1",
                origin: "user",
                parameters: [
                  { name: "N", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: false },
                  { name: "T", type: { ATTR_TYPE_NAME: "VARCHAR2" }, defaulted: false },
                ],
              },
            ],
          },
        },
      ],
    };
    inspection.targetPreview!.candidates = [JSON.parse(JSON.stringify(selected, (key, value) => (key === "packageName" && value === null ? undefined : value)))];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    const nullBox = () => document.querySelector<HTMLInputElement>('input[aria-label="X: SQL NULL"]')!;
    nullBox().click();
    await nextTick();
    const chooseConstructor = async () => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="X: Constructor"]')!;
      select.value = "user-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTick();
    };
    const chooseType = async (name: string) => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="X: Type"]')!;
      select.value = [...select.options].find((option) => option.textContent === `S.${name}`)!.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTick();
    };
    await chooseConstructor();
    input("X.N", "12345678901234567890123456789012345678");
    await nextTick();
    await chooseType("SUB");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.N"]')).toBeNull();
    await chooseConstructor();
    input("X.N", "19");
    await nextTick();
    input("X.T", "子类型😀");
    await nextTick();
    await chooseType("BASE");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.N"]')!.value).toBe("12345678901234567890123456789012345678");
    await chooseType("SUB");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.N"]')!.value).toBe("19");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.T"]')!.value).toBe("子类型😀");
    nullBox().click();
    await nextTick();
    nullBox().click();
    await nextTick();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.N"]')!.value).toBe("19");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    const request = calls.find((call) => call.path === "start")!.body.target;
    expect(request.params[0].typedValue.value.type).toEqual(sub);
    expect(request.targetSignature.typeBindings[0].reference.typeName).toBe("BASE");
    expect(Object.hasOwn(request.targetSignature.typeBindings[0].reference, "packageName")).toBe(false);
  });

  it("blocks duplicate sparse indexes locally and preserves the structured draft after a rejected start", async () => {
    inspection.targetPreview!.candidates = [compositeCandidate()];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X.ITEMS: Set value"]')).not.toBeNull());
    (document.querySelector('input[aria-label="X.ITEMS: Set value"]') as HTMLInputElement).click();
    await nextTick();
    button("Add entry").click();
    await nextTick();
    input("X.ITEMS[1]: Index", "-2");
    await nextTick();
    input("X.ITEMS[-2]", "7");
    button("Add entry").click();
    await nextTick();
    input("X.ITEMS[2]: Index", "-2");
    await nextTick();
    const values = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="X.ITEMS[-2]"]')];
    values[1]!.value = "8";
    values[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    await acceptRisk();
    expect(button("Start debugging").disabled).toBe(true);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    input("X.ITEMS[2]: Index", "100");
    await nextTick();
    rejectStart = true;
    button("Start debugging").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh the stale target preview"));
    expect(plDebugLaunchOpen.value).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.ITEMS[-2]"]')!.value).toBe("7");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X.ITEMS[100]"]')!.value).toBe("8");
    expect(tab.open).not.toHaveBeenCalled();
  });

  it("restores collection and scalar drafts when SQL NULL is switched off", async () => {
    inspection.targetPreview!.candidates = [compositeCandidate(true)];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    button("Add entry").click();
    await nextTick();
    input("X[1]", "12345678901234567890123456789012345678");
    await nextTick();
    (document.querySelector('input[aria-label="X[1]: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    (document.querySelector('input[aria-label="X[1]: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X[1]"]')!.value).toBe("12345678901234567890123456789012345678");
    (document.querySelector('input[aria-label="X: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    (document.querySelector('input[aria-label="X: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="X[1]"]')!.value).toBe("12345678901234567890123456789012345678");
  });

  it.each([false, true])("distinguishes empty and atomic NULL collections (%s)", async (isNull) => {
    inspection.targetPreview!.candidates = [compositeCandidate(true)];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    if (isNull) (document.querySelector('input[aria-label="X: SQL NULL"]') as HTMLInputElement).click();
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params[0].typedValue).toEqual({ kind: "collection", value: isNull ? null : [] });
  });

  it.each(["CLOB", "NCLOB", "BLOB", "RAW"].flatMap((type) => ["value", "empty", "null", "default"].map((state) => [type, state])))("submits %s %s without conflating empty, NULL and omitted input", async (type, state) => {
    const argument = { ...candidate().parameters[0]!, name: "L", type, defaulted: "Y" };
    inspection.targetPreview!.candidates = [
      { ...candidate(), parameters: [argument], signature: { ...candidate().signature, arguments: [argument], signatureVersion: 2, metadataPreparation: "type_only", argumentDetails: [], typeGraph: { nodes: [], versions: [] }, targetVersion: { objects: [], source: [] } } },
    ];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => {
      const field = document.querySelector('select[aria-label="L: Input mode"]');
      if (!field) throw new Error(`LOB input mode missing; locale=${i18n.global.locale.value}; labels=${JSON.stringify([...document.querySelectorAll("select")].map((element) => element.getAttribute("aria-label")))}; text=${document.body.textContent?.slice(-700)}`);
      expect(field).not.toBeNull();
    });
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="L: Input mode"]')!;
    select.value = state === "empty" ? "value" : state;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    const binary = type === "BLOB" || type === "RAW";
    const text = state === "empty" ? "" : binary ? "AAH/" : "中\n😀尾";
    if (state === "value" || state === "empty") {
      const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${binary ? "L: Base64" : "L"}"]`)!;
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    const hasValue = state === "value" || state === "empty";
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([
      { name: "L", mode: "IN", type, inputState: state === "empty" ? "value" : state, value: null, ...(hasValue ? { typedValue: binary ? { kind: type.toLowerCase(), value: { encoding: "base64", data: text } } : { kind: type.toLowerCase(), value: text } } : {}) },
    ]);
  });

  it.each(["BLOB", "RAW"])("preserves recursive %s binary drafts through NULL and submission", async (type) => {
    const selected = compositeCandidate(true);
    selected.signature.typeGraph!.nodes[1]!.collections[0]!.ELEM_TYPE_NAME = type;
    inspection.targetPreview!.candidates = [selected];
    await launchPlDebug({ ...target, databaseType: "oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    button("Add entry").click();
    await nextTick();
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="X[1]: Base64"]')!;
    field.value = "AAH/";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    (document.querySelector('input[aria-label="X[1]: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    (document.querySelector('input[aria-label="X[1]: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="X[1]: Base64"]')!.value).toBe("AAH/");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params[0].typedValue).toEqual({ kind: "collection", value: [{ index: "1", value: { kind: type.toLowerCase(), value: { encoding: "base64", data: "AAH/" } } }] });
  });

  it.each(["TIMESTAMP WITH TZ", "TIMESTAMP WITH LOCAL TZ"])("preserves recursive %s drafts through NULL and the public launch request", async (type) => {
    const selected = compositeCandidate(true);
    selected.signature.typeGraph!.nodes[1]!.collections[0]!.ELEM_TYPE_NAME = type;
    inspection.targetPreview!.candidates = [selected];
    await launchPlDebug({ ...target, databaseType: "oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="X: SQL NULL"]')).not.toBeNull());
    button("Add entry").click();
    await nextTick();
    const tz = type === "TIMESTAMP WITH TZ";
    if (tz) {
      input("X[1]: Local time", "2024-11-03T01:30:00.123456789");
      input("X[1]: UTC offset", "-04:00");
      input("X[1]: Region (optional)", "America/New_York");
    } else input("X[1]", "2024-11-03T05:30:00.123456789Z");
    await nextTick();
    (document.querySelector('input[aria-label="X[1]: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    (document.querySelector('input[aria-label="X[1]: SQL NULL"]') as HTMLInputElement).click();
    await nextTick();
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params[0].typedValue).toEqual({
      kind: "collection",
      value: [{ index: "1", value: tz ? { kind: "timestamp_tz", value: { local: "2024-11-03T01:30:00.123456789", offset: "-04:00", region: "America/New_York" } } : { kind: "timestamp_ltz", value: { instant: "2024-11-03T05:30:00.123456789Z" } } }],
    });
  });

  it.each([
    ["timestamp_tz", "value"],
    ["timestamp_tz", "null"],
    ["timestamp_tz", "default"],
    ["timestamp_ltz", "value"],
    ["timestamp_ltz", "null"],
    ["timestamp_ltz", "default"],
    ["timestamp_tz", "value", "TIMESTAMP WITH TZ"],
    ["timestamp_ltz", "value", "TIMESTAMP WITH LOCAL TZ"],
  ])("submits structured %s input in %s mode without a mixed legacy payload", async (kind, state, dictionaryType) => {
    const type = dictionaryType ?? (kind === "timestamp_tz" ? "TIMESTAMP WITH TIME ZONE" : "TIMESTAMP WITH LOCAL TIME ZONE");
    const argument = { ...candidate().parameters[0]!, name: "Z", type, defaulted: "Y" };
    inspection.targetPreview!.candidates = [
      { ...candidate(), parameters: [argument], signature: { ...candidate().signature, arguments: [argument], signatureVersion: 2, metadataPreparation: "type_only", argumentDetails: [], typeGraph: { nodes: [], versions: [] }, targetVersion: { objects: [], source: [] } } },
    ];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="Z: Input mode"]')).not.toBeNull());
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Z: Input mode"]')!;
    select.value = state;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    const value = kind === "timestamp_tz" ? { local: "2024-11-03T01:30:00.123456789", offset: "-04:00", region: "America/New_York" } : { instant: "2024-11-03T05:30:00.123456789Z" };
    if (state === "value") {
      if (kind === "timestamp_tz") {
        input("Z: local", value.local!);
        input("Z: offset", value.offset!);
        input("Z: region", value.region!);
      } else input("Z: instant", value.instant!);
    }
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([{ name: "Z", mode: "IN", type, inputState: state, value: null, ...(state === "value" ? { typedValue: { kind, value } } : {}) }]);
    expect(calls.find((call) => call.path === "start")!.body.target.metadataPreparation).toBe("type_only");
  });

  it.each(["BINARY_FLOAT", "BINARY_DOUBLE"])("preserves %s hexadecimal input without JavaScript numeric conversion", async (type) => {
    const argument = { ...candidate().parameters[0]!, name: "F", type };
    inspection.targetPreview!.candidates = [
      { ...candidate(), parameters: [argument], signature: { ...candidate().signature, arguments: [argument], signatureVersion: 2, metadataPreparation: "type_only", argumentDetails: [], typeGraph: { nodes: [], versions: [] }, targetVersion: { objects: [], source: [] } } },
    ];
    await launchPlDebug(target);
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="F"]')).not.toBeNull());
    await acceptRisk();
    input("F", "1.25");
    expect(button("Start debugging").disabled).toBe(true);
    const text = type === "BINARY_FLOAT" ? "ff800000" : "fff0000000000000";
    input("F", text);
    await nextTick();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([{ name: "F", mode: "IN", type, inputState: "value", value: null, typedValue: { kind: type.toLowerCase(), value: text } }]);
  });

  it.each(["NCHAR", "NVARCHAR2", "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND"])("submits %s using the versioned text codec", async (type) => {
    const argument = { ...candidate().parameters[0]!, name: "N", type };
    inspection.targetPreview!.candidates = [
      { ...candidate(), parameters: [argument], signature: { ...candidate().signature, arguments: [argument], signatureVersion: 2, metadataPreparation: "type_only", argumentDetails: [], typeGraph: { nodes: [], versions: [] }, targetVersion: { objects: [], source: [] } } },
    ];
    await launchPlDebug(target);
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="N"]')).not.toBeNull());
    const text = type === "INTERVAL YEAR TO MONTH" ? "+123456789-11" : type === "INTERVAL DAY TO SECOND" ? "-123456789 23:59:59.123456789" : "中文🙂  ";
    input("N", text);
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([{ name: "N", mode: "IN", type, inputState: "value", value: null, typedValue: { kind: "text", value: text } }]);
  });

  it.each(["DATE", "TIMESTAMP"])("transmits a %s wall-clock string without parsing it in the browser timezone", async (type) => {
    const text = type === "DATE" ? "2024-02-29T12:34:56" : "1969-12-31T23:59:59.876543211";
    const date = { ...candidate().parameters[0]!, name: "D", type };
    const selected = { ...candidate(), parameters: [date], signature: { ...candidate().signature, arguments: [date], signatureVersion: 2 as const, metadataPreparation: "type_only" as const, argumentDetails: [], typeGraph: { nodes: [], versions: [] }, targetVersion: { objects: [], source: [] } } };
    inspection.targetPreview!.candidates = [selected];
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="D"]')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="D"]')!.placeholder).toBe(type === "DATE" ? "YYYY-MM-DDTHH:mm:ss" : "YYYY-MM-DDTHH:mm:ss.fffffffff");
    input("D", text);
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([{ name: "D", mode: "IN", type, inputState: "value", value: null, typedValue: { kind: type === "DATE" ? "date" : "timestamp", value: text } }]);
  });

  it.each(["false", "true", "null"])("loads versioned parameter types only on request and submits boolean %s after confirmation", async (value) => {
    await launchPlDebug({ ...target, databaseType: "oceanbase-oracle" });
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="N"]')).not.toBeNull());
    expect(calls.find((call) => call.path === "inspect")!.body.target.metadataPreparation).toBeUndefined();
    const boolean = { ...candidate().parameters[0]!, name: "B", type: "PL/SQL BOOLEAN" };
    inspection = {
      ...inspection,
      targetPreview: {
        schema: target.schema,
        state: "available",
        candidates: [
          {
            ...candidate(),
            parameters: [boolean],
            signature: { ...candidate().signature, arguments: [boolean], signatureVersion: 2, metadataPreparation: "type_only", argumentDetails: [], typeGraph: { nodes: [], versions: [] }, targetVersion: { objects: [], source: [] } },
          },
        ],
      },
    };
    button("Load parameter types").click();
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="B"]')).not.toBeNull());
    expect(calls.filter((call) => call.path === "inspect").at(-1)!.body.target.metadataPreparation).toBe("type_only");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    expect(button("Start debugging").disabled).toBe(true);
    const select = document.querySelector<HTMLSelectElement>(value === "null" ? 'select[aria-label="B: Input mode"]' : 'select[aria-label="B"]')!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")!.body.target.params).toEqual([{ name: "B", mode: "IN", type: "PL/SQL BOOLEAN", inputState: value === "null" ? "null" : "value", value: null, ...(value === "null" ? {} : { typedValue: { kind: "boolean", value: value === "true" } }) }]);
  });

  it("waits for an accepted start to finish without reporting an unknown execution or starting twice", async () => {
    const boundary = fetchMock.getMockImplementation()!;
    let receiptReads = 0;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const response = await boundary(url, options);
      if (url.endsWith("/start") || (url.endsWith("/operation") && ++receiptReads === 1)) {
        const receipt = await response.json();
        return new Response(JSON.stringify({ ...receipt, state: "running", result: null }), { status: 200 });
      }
      if (url.endsWith("/status") && receiptReads < 2) return new Response(JSON.stringify({ ...snapshot, state: "starting", startState: "running" }), { status: 200 });
      return response;
    });
    await openNamed();
    input("N", "7");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain("The original debug start is not confirmed");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(receiptReads).toBeGreaterThanOrEqual(2);
    expect(usePlDebugStore().pendingStart).toBeNull();
  });

  it("restores the original unconfirmed start before opening its workspace without another start", async () => {
    unconfirmedStart = true;
    await openNamed();
    input("N", "7");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("The original debug start is not confirmed"));
    const store = usePlDebugStore();
    expect(store.pendingStart).not.toBeNull();
    expect(button("Start debugging").disabled).toBe(true);
    const operationId = calls.find((call) => call.path === "start")!.body.operationId;
    receipts.get(operationId)!.state = "succeeded";
    snapshot.state = "paused";
    snapshot.startState = "succeeded";
    const reads = calls.filter((call) => call.path === "operation").length;
    button("Restore original session").click();
    await vi.waitFor(() => expect(store.pendingStart).toBeNull());
    expect(calls.filter((call) => call.path === "operation").length).toBeGreaterThan(reads);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(tab.open).toHaveBeenCalledTimes(1);
    expect(plDebugLaunchOpen.value).toBe(false);
  });

  it("retains the original identity and parameter draft when recovery cannot read its receipt", async () => {
    unconfirmedStart = true;
    await openNamed();
    input("N", "7");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("The original debug start is not confirmed"));
    const store = usePlDebugStore();
    const original = { ...store.pendingStart! };
    const boundary = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/operation")) throw new Error("Original receipt temporarily unavailable");
      return boundary(url, options);
    });
    button("Restore original session").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Original receipt temporarily unavailable"));
    expect(store.pendingStart).toEqual(original);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')!.value).toBe("7");
    expect(button("Start debugging").disabled).toBe(true);
    expect(button("Restore original session").disabled).toBe(false);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(tab.open).not.toHaveBeenCalled();
    expect(plDebugLaunchOpen.value).toBe(true);
  });

  it("keeps exact signature, native parameter names and decimal text through explicit confirmation", async () => {
    await openNamed();
    expect(button("Start debugging").disabled).toBe(true);
    expect(calls.find((call) => call.path === "inspect")?.body).toMatchObject({ connectionId: "conn", database: "APP", target: { schema: target.schema, objectName: target.objectName, packageName: target.packageName, objectType: "PROCEDURE" } });
    input("N", "9007199254740993.123456789");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")?.body).toMatchObject({
      expectedConnectionRevision: "epoch:5",
      riskAccepted: true,
      target: {
        targetSignature: candidate().signature,
        params: [
          { name: "N", inputState: "value", value: "9007199254740993.123456789" },
          { name: "T", inputState: "default", value: null },
          { name: "R", mode: "OUT", value: null },
        ],
      },
    });
  });

  it("requires an overload choice and preserves independent drafts when switching", async () => {
    inspection.targetPreview!.candidates.push(candidate(8));
    await launchPlDebug(target);
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="Routine signature"]')?.children).toHaveLength(3));
    expect(document.querySelector('input[aria-label="N"]')).toBeNull();
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Routine signature"]')!;
    const choose = async (value: string) => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTick();
    };
    await choose("0");
    input("N", "42");
    await nextTick();
    await choose("1");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')!.value).toBe("");
    await choose("0");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')!.value).toBe("42");
    expect(button("Start debugging").disabled).toBe(true);
  });

  it("does not execute an anonymous editor block before explicit confirmation", async () => {
    const source = "\nBEGIN\n  NULL;\nEND;\n/";
    await launchPlDebugAnonymous({ ...target, selectedText: source, documentText: "SELECT 1" });
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe(source.replace(/\n\/$/, "")));
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(false));
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")?.body.target.objectType).toBe("ANONYMOUS");
  });

  it("preserves inputs on a conclusive stale-preview rejection", async () => {
    await openNamed();
    input("N", "7");
    rejectStart = true;
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh the stale target preview"));
    expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')!.value).toBe("7");
    expect(usePlDebugStore().pendingStart).toBeNull();
    expect(tab.open).not.toHaveBeenCalled();
  });

  it("retains a matching signature draft across refreshed metadata and requires risk confirmation again", async () => {
    await openNamed();
    input("N", "123.0000000000000000001");
    await acceptRisk();
    button("Refresh preview").click();
    await vi.waitFor(() => expect(calls.filter((call) => call.path === "inspect")).toHaveLength(2));
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')?.value).toBe("123.0000000000000000001"));
    expect(button("Start debugging").disabled).toBe(true);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
  });

  it("keeps SQL NULL distinct from the literal text NULL", async () => {
    await openNamed();
    const mode = document.querySelector<HTMLSelectElement>('select[aria-label="N: Input mode"]')!;
    mode.value = "null";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    const textMode = document.querySelector<HTMLSelectElement>('select[aria-label="T: Input mode"]')!;
    textMode.value = "value";
    textMode.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    input("T", "NULL");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.path === "start")?.body.target.params).toMatchObject([
      { name: "N", inputState: "null", value: null },
      { name: "T", inputState: "value", value: "NULL" },
      { name: "R", mode: "OUT" },
    ]);
  });

  it("does not replace an active debugger's capabilities with another connection preview", async () => {
    await openNamed();
    input("N", "7");
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(tab.open).toHaveBeenCalledTimes(1));
    const store = usePlDebugStore();
    expect(store.probe?.supported).toBe(true);
    inspection = { ...inspection, capabilities: { supported: false, reason: "Other engine lacks debugging" } };
    await launchPlDebug({ ...target, connectionId: "other" });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Other engine lacks debugging"));
    expect(store.probe?.supported).toBe(true);
    expect(store.sessionRef?.connectionId).toBe("conn");
  });

  it("rejects a target change during production confirmation without dispatch", async () => {
    await openNamed();
    let release!: () => Promise<unknown>;
    guard.run.mockImplementation(
      (options: { execute: () => Promise<unknown> }) =>
        new Promise((resolve, reject) => {
          release = () => options.execute().then(resolve, reject);
        }),
    );
    await acceptRisk();
    button("Start debugging").click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await launchPlDebug({ ...target, objectName: "Another" });
    await nextTick();
    await release();
    await vi.waitFor(() => expect(calls.filter((call) => call.path === "start")).toHaveLength(0));
    expect(tab.open).not.toHaveBeenCalled();
  });

  it("keeps unsupported parameter metadata visible without claiming engine incompatibility", async () => {
    inspection.targetPreview!.candidates[0].parameterTransport = "not_implemented";
    inspection.targetPreview!.candidates[0].message = "DATE transport is not yet implemented";
    await openNamed();
    expect(document.body.textContent).toContain("DATE transport is not yet implemented");
    expect(button("Start debugging").disabled).toBe(true);
  });

  it("previews exact package DDL without writes and retains drafts when cancelled", async () => {
    await openNamed();
    input("N", "123.45");
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('ALTER PACKAGE "Mixed""Owner"." A Pkg " COMPILE DEBUG BODY REUSE SETTINGS'));
    expect(document.body.textContent).toContain("entire PACKAGE BODY");
    expect(document.body.textContent).toContain("implicitly commit");
    expect(button("Compile debug information").disabled).toBe(true);
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')!.value).toBe("123.45");
  });

  it("compiles only after separate confirmation, preserves INVALID diagnostics and drafts, and never starts", async () => {
    await openNamed();
    input("N", "987.654");
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(button("Compile debug information").disabled).toBe(true));
    const confirmation = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.closest("label")?.textContent?.includes("I confirm this object"))!;
    confirmation.click();
    await nextTick();
    button("Compile debug information").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("PLS-00201: missing name"));
    await vi.waitFor(() => expect(calls.filter((call) => call.path === "inspect" && call.body.target?.metadataPreparation !== "debug_compile")).toHaveLength(2));
    expect(document.querySelector<HTMLInputElement>('input[aria-label="N"]')!.value).toBe("987.654");
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    expect(tab.open).not.toHaveBeenCalled();
    button("Edit source").click();
    expect(tab.source).toHaveBeenCalledWith(expect.objectContaining({ schema: target.schema, initialEditing: true, request: { name: target.packageName, objectType: "PACKAGE_BODY" } }));
  });

  it("recovers a compilation's lost response by the original status endpoint without replay", async () => {
    await openNamed();
    loseCompilation = true;
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("I confirm this object"));
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.closest("label")?.textContent?.includes("I confirm this object"))!.click();
    await nextTick();
    button("Compile debug information").click();
    await vi.waitFor(() => expect(usePlDebugStore().compilationRef).not.toBeNull());
    await usePlDebugStore().recoverCompilation();
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    expect(usePlDebugStore().compilationUnresolved).toBe(false);
  });

  it("invalidates compilation confirmation when its target changes during production review", async () => {
    await openNamed();
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("I confirm this object"));
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.closest("label")?.textContent?.includes("I confirm this object"))!.click();
    await nextTick();
    let release!: () => Promise<unknown>;
    guard.run.mockImplementation(
      (options: { execute: () => Promise<unknown> }) =>
        new Promise((resolve, reject) => {
          release = () => options.execute().then(resolve, reject);
        }),
    );
    button("Compile debug information").click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await launchPlDebug({ ...target, objectName: "Other" });
    await nextTick();
    await release();
    await vi.waitFor(() => expect(usePlDebugStore().compilationBusy).toBe(false));
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(0);
    expect(usePlDebugStore().compilationRef).toBeNull();
    expect(document.body.textContent).not.toContain("compilation preview changed");
  });

  it("rereads current dictionary diagnostics separately from a retained DDL readback failure", async () => {
    await openNamed();
    compilationReadbackFailure = true;
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("I confirm this object"));
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.closest("label")?.textContent?.includes("I confirm this object"))!.click();
    await nextTick();
    button("Compile debug information").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("new dictionary diagnostic after DDL"));
    expect(document.body.textContent).toContain("Current dictionary readback");
    expect(document.body.textContent).toContain("initial readback lost");
    expect(usePlDebugStore().compilationReceipt?.ddlState).toBe("executed");
    expect(usePlDebugStore().compilationReceipt?.result?.readbackError).toBe("initial readback lost");
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    const originalId = usePlDebugStore().compilationRef?.operationId;
    currentDiagnostic = "newer dictionary diagnostic";
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("newer dictionary diagnostic"));
    expect(usePlDebugStore().compilationRef?.operationId).toBe(originalId);
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(1);
  });

  it("does not query an original operation before its submission response or failure arrives", async () => {
    await openNamed();
    button("Preview debug compilation").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("I confirm this object"));
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.closest("label")?.textContent?.includes("I confirm this object"))!.click();
    await nextTick();
    let release!: () => void;
    compileGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    button("Compile debug information").click();
    await vi.waitFor(() => expect(calls.filter((call) => call.path === "compile")).toHaveLength(1));
    await nextTick();
    expect(calls.filter((call) => call.path === "compile-status")).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(usePlDebugStore().compilationReceipt?.finished).toBe(true));
    expect(calls.filter((call) => call.path === "compile")).toHaveLength(1);
  });

  it("labels another target's retained compilation and does not refresh the current target from its result", async () => {
    const store = usePlDebugStore();
    store.compilationRef = { serverEpoch: "epoch", operationId: "previous-compilation", connectionId: "conn", clientSessionId: store.clientSessionId };
    compileResult = { ...store.compilationRef, target: { schema: target.schema, objectName: "Other.Package", objectType: "PACKAGE BODY" }, dispatched: true, ddlState: "executed", finished: true, releaseState: "released", error: null, cleanupError: null, result: { readback: { status: "VALID" } } };
    await openNamed();
    await vi.waitFor(() => expect(document.body.textContent).toContain(`${target.schema}.Other.Package`));
    expect(calls.filter((call) => call.path === "inspect" && call.body.target?.metadataPreparation === "debug_compile")).toHaveLength(0);
    expect(calls.filter((call) => call.path === "compile" || call.path === "start")).toHaveLength(0);
    expect(store.compilationReceipt?.target?.objectName).toBe("Other.Package");
  });
});
