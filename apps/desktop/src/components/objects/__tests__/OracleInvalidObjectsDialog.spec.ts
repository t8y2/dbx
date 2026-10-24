// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import OracleInvalidObjectsDialog from "@/components/objects/OracleInvalidObjectsDialog.vue";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  compileFinished: vi.fn(),
  guard: vi.fn(),
  executeAllowed: true,
  guardGate: null as null | (() => Promise<void>),
  identityChangedAfterGuard: false,
  failStatusReadback: false,
  statusReadbackErrorMode: "throw" as "throw" | "result",
  statusMissingAfterCompile: false,
  truncateBatchStatusBefore: false,
  truncateBatchStatusAfter: false,
  truncateSingleIdentity: false,
  truncateSingleStatusAfter: false,
  compileGate: null as null | (() => Promise<void>),
  batchStatusGate: null as null | (() => Promise<void>),
  batchPageGate: null as null | (() => Promise<void>),
  diagnosticGate: null as null | (() => Promise<void>),
  listGate: null as null | (() => Promise<void>),
  diagnosticTexts: {} as Record<string, string>,
  definiteBatchFailureName: "",
  definiteBatchFailureMode: "result" as "result" | "throw",
  batchObjects: [] as unknown[][],
  batchMode: false,
  batchStatuses: {} as Record<string, string>,
  missingBatchStatusName: "",
  batchObjectIds: {} as Record<string, string>,
  batchTimes: {} as Record<string, string>,
  failBatchPage: false,
  failRemainingAfterWrite: false,
  batchDdlSubmitted: false,
  failBatchCompileName: "",
  unknownBatchCompileName: "",
  unknownBatchCompileResultName: "",
  truncatedErrors: false,
  failCompile: false,
  failInvalidObjectList: false,
  postCompileListGate: null as null | (() => Promise<void>),
  singlePreflightSeen: false,
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key}:${Object.values(values).join(",")}`) }) }));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return { AlertTriangle: Icon, CheckIcon: Icon, ChevronDown: Icon, Circle: Icon, CircleHelp: Icon, CircleMinus: Icon, CircleX: Icon, Clock: Icon, Loader2: Icon, RefreshCw: Icon, Wrench: Icon };
});
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: passthrough("div"), DialogContent: passthrough("div"), DialogFooter: passthrough("div"), DialogHeader: passthrough("div"), DialogTitle: passthrough("div") }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, closeClientConnectionSession: mocks.closeClientConnectionSession }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: async (options: { execute: () => Promise<unknown> }) => {
    mocks.guard(options);
    if (mocks.guardGate) await mocks.guardGate();
    return mocks.executeAllowed ? options.execute() : undefined;
  },
}));

const connection: ConnectionConfig = { id: "oracle-invalid-1", name: "Oracle", db_type: "oracle", host: "localhost", port: 1521, username: "APP", password: "" };
let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;
let compiled = false;
let compileStatus = "VALID";
let objectIdAfterCompile = "9";
let errorsReloadedAfterCompile = false;

beforeEach(() => {
  // Geometry is the external browser boundary; the installed virtual scroller stays real.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  compiled = false;
  mocks.singlePreflightSeen = false;
  compileStatus = "VALID";
  objectIdAfterCompile = "9";
  errorsReloadedAfterCompile = false;
  mocks.guardGate = null;
  mocks.identityChangedAfterGuard = false;
  mocks.failStatusReadback = false;
  mocks.statusReadbackErrorMode = "throw";
  mocks.statusMissingAfterCompile = false;
  mocks.truncateBatchStatusBefore = false;
  mocks.truncateBatchStatusAfter = false;
  mocks.truncateSingleIdentity = false;
  mocks.truncateSingleStatusAfter = false;
  mocks.compileGate = null;
  mocks.batchStatusGate = null;
  mocks.batchPageGate = null;
  mocks.diagnosticGate = null;
  mocks.listGate = null;
  mocks.diagnosticTexts = {};
  mocks.definiteBatchFailureName = "";
  mocks.definiteBatchFailureMode = "result";
  mocks.batchObjects = [
    ["APP", "P_OK", "PROCEDURE", "8", "2026-10-20 09:00:00"],
    ["APP", "P_BAD", "PROCEDURE", "9", "2026-10-20 09:00:00"],
    ["APP", "V_SKIP", "VIEW", "10", "2026-10-20 09:00:00"],
  ];
  mocks.batchMode = false;
  mocks.batchStatuses = {};
  mocks.missingBatchStatusName = "";
  mocks.batchObjectIds = {};
  mocks.batchTimes = {};
  mocks.failBatchPage = false;
  mocks.failRemainingAfterWrite = false;
  mocks.batchDdlSubmitted = false;
  mocks.failBatchCompileName = "";
  mocks.unknownBatchCompileName = "";
  mocks.unknownBatchCompileResultName = "";
  mocks.truncatedErrors = false;
  mocks.failCompile = false;
  mocks.failInvalidObjectList = false;
  mocks.postCompileListGate = null;
  mocks.executeAllowed = true;
  mocks.guard.mockReset();
  mocks.closeClientConnectionSession.mockReset().mockResolvedValue(undefined);
  mocks.compileFinished.mockReset();
  mocks.executeQuery.mockReset().mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
    const dictionaryRows = () =>
      mocks.batchObjects.flatMap((row) => {
        const name = String(row[1]);
        const typeKey = `${name}:${row[2]}`;
        const status = compiled && name === "P_BAD" ? compileStatus : (mocks.batchStatuses[typeKey] ?? mocks.batchStatuses[name] ?? "INVALID");
        if (status !== "INVALID" || (compiled && name === "P_BAD" && mocks.statusMissingAfterCompile)) return [];
        return [[row[0], row[1], row[2], compiled && name === "P_BAD" ? objectIdAfterCompile : (mocks.batchObjectIds[typeKey] ?? mocks.batchObjectIds[name] ?? row[3]), compiled && name === "P_BAD" ? "2026-10-20 09:01:00" : (mocks.batchTimes[typeKey] ?? mocks.batchTimes[name] ?? row[4])]];
      });
    if (sql.includes("OBJECT_ID >")) {
      if (mocks.batchPageGate) {
        const gate = mocks.batchPageGate;
        mocks.batchPageGate = null;
        await gate();
      }
      mocks.batchMode = true;
      const cursor = BigInt(sql.match(/OBJECT_ID > (\d+)/)?.[1] ?? "0");
      if (mocks.failRemainingAfterWrite && mocks.batchDdlSubmitted) throw new Error("remaining list denied");
      if (mocks.failBatchPage && cursor > 0n) throw new Error("middle page failed");
      return {
        columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "LAST_DDL_TIME"],
        rows: dictionaryRows()
          .filter((row) => BigInt(String(row[3])) > cursor)
          .sort((a, b) => (BigInt(String(a[3])) < BigInt(String(b[3])) ? -1 : 1))
          .slice(0, 500),
      };
    }
    if (sql.includes("FROM (SELECT OWNER")) {
      if (mocks.listGate) {
        const gate = mocks.listGate;
        mocks.listGate = null;
        await gate();
      }
      if (compiled && mocks.postCompileListGate) {
        const gate = mocks.postCompileListGate;
        mocks.postCompileListGate = null;
        await gate();
      }
      if (mocks.failInvalidObjectList) throw new Error("ORA-01031: insufficient privileges");
      const rows = dictionaryRows();
      return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "LAST_DDL_TIME"], rows: rows.slice(0, 501) };
    }
    if (sql.includes("FROM ALL_ERRORS")) {
      if (mocks.diagnosticGate) {
        const gate = mocks.diagnosticGate;
        mocks.diagnosticGate = null;
        await gate();
        return { columns: [], rows: [[1, 3, 7, "late A diagnostics"]] };
      }
      if (compiled) errorsReloadedAfterCompile = true;
      const name = sql.match(/NAME = '([^']+)'/)?.[1] ?? "";
      return { columns: [], rows: mocks.truncatedErrors ? Array.from({ length: 1000 }, (_, index) => [index + 1, index + 1, 1, "invalid identifier"]) : [[1, 3, 7, mocks.diagnosticTexts[name] ?? (compiled ? "still invalid after compile" : "invalid identifier")]] };
    }
    if (sql.includes("STATUS = 'INVALID'")) {
      mocks.singlePreflightSeen = true;
      return { columns: [], rows: [[mocks.identityChangedAfterGuard ? 10 : 9, "2026-10-20 09:00:00"]], truncated: mocks.truncateSingleIdentity };
    }
    if (sql.includes("ALTER PROCEDURE") && mocks.singlePreflightSeen) {
      if (mocks.failCompile) throw new Error("ORA-01031: insufficient privileges");
      if (mocks.compileGate) await mocks.compileGate();
      compiled = true;
      return { columns: [], rows: [] };
    }
    if (sql.startsWith("ALTER ")) {
      const name = sql.match(/\."([^"]+)"/)?.[1] ?? "";
      const rejectedBackendError = {
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: {},
        source: "jdbcAgent",
        operationOutcome: "not_started",
        detail: "Request rejected before database execution",
      };
      if (name === mocks.definiteBatchFailureName) {
        if (mocks.definiteBatchFailureMode === "throw") throw { name: "BackendErrorException", backendError: rejectedBackendError };
        return { columns: ["Error"], rows: [["request rejected"]], execution_error: true, error: rejectedBackendError };
      }
      if (name === mocks.unknownBatchCompileName) throw new Error("connection lost during DDL");
      if (name === mocks.unknownBatchCompileResultName) return { columns: ["Error"], rows: [["result unavailable"]], execution_error: true, error: { detail: "result unavailable", operationOutcome: "unknown" } };
      if (name === mocks.failBatchCompileName) return { columns: ["Error"], rows: [["ORA-01031: insufficient privileges"]], execution_error: true, error: { detail: "ORA-01031: insufficient privileges", operationOutcome: "not_started" } };
      if (mocks.compileGate) await mocks.compileGate();
      if (mocks.singlePreflightSeen) {
        compiled = true;
        mocks.singlePreflightSeen = false;
      } else {
        const matches = mocks.batchObjects.filter((row) => row[1] === name);
        const target = matches.find((row) => String(row[2]).endsWith(" BODY") === /\bCOMPILE BODY\b/.test(sql));
        const key = matches.length > 1 ? `${name}:${target?.[2]}` : name;
        mocks.batchStatuses[key] = name === "P_BAD" ? "INVALID" : "VALID";
        mocks.batchTimes[key] = "2026-10-20 09:01:00";
      }
      mocks.batchDdlSubmitted = true;
      return { columns: [], rows: [] };
    }
    if (sql.includes("STATUS FROM ALL_OBJECTS")) {
      const targetName = sql.match(/OBJECT_NAME = '([^']+)'/)?.[1] ?? "";
      if (compiled && targetName === "P_BAD") {
        if (mocks.failStatusReadback) {
          if (mocks.statusReadbackErrorMode === "result") return { columns: ["Error"], rows: [["ORA-01031: insufficient privileges"]], execution_error: true, error: { detail: "ORA-01031: insufficient privileges" } };
          throw new Error("ORA-01031: insufficient privileges while reading status");
        }
        return { columns: [], rows: mocks.statusMissingAfterCompile ? [] : [[objectIdAfterCompile, "2026-10-20 09:01:00", compileStatus]], truncated: mocks.truncateSingleStatusAfter };
      }
      if (mocks.batchMode) {
        const name = sql.match(/OBJECT_NAME = '([^']+)'/)?.[1] ?? "";
        if (mocks.batchStatusGate) {
          const gate = mocks.batchStatusGate;
          mocks.batchStatusGate = null;
          await gate();
        }
        const type = sql.match(/OBJECT_TYPE = '([^']+)'/)?.[1] ?? "";
        const item = mocks.batchObjects.find((row) => row[1] === name && row[2] === type);
        if (!item || name === mocks.missingBatchStatusName) return { columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"], rows: [] };
        return {
          columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"],
          rows: [[mocks.batchObjectIds[`${name}:${type}`] ?? mocks.batchObjectIds[name] ?? item[3], mocks.batchTimes[`${name}:${type}`] ?? mocks.batchTimes[name] ?? item[4], mocks.batchStatuses[`${name}:${type}`] ?? mocks.batchStatuses[name] ?? "INVALID"]],
          truncated: mocks.batchDdlSubmitted ? mocks.truncateBatchStatusAfter : mocks.truncateBatchStatusBefore,
        };
      }
      const name = sql.match(/OBJECT_NAME = '([^']+)'/)?.[1] ?? "";
      const item = mocks.batchObjects.find((row) => row[1] === name);
      if (!item) return { columns: [], rows: [] };
      return { columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"], rows: [[item[3], item[4], mocks.batchStatuses[name] ?? "INVALID"]] };
    }
    return { columns: [], rows: [] };
  });
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function dialogButtons(): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll("button") ?? []);
}

function listRow(name: string, type = "PROCEDURE"): HTMLElement | null {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>(`button[aria-label="${name} ${type}"]`) ?? []).find((button) => !button.closest("[inert]"))?.parentElement ?? null;
}

function statusLabels(): string[] {
  return Array.from(root?.querySelectorAll('[role="img"][aria-label]') ?? [])
    .filter((element) => !element.closest("[inert]"))
    .map((element) => element.getAttribute("aria-label")!);
}

async function openDetails(name: string, type = "PROCEDURE") {
  const button = root?.querySelector<HTMLButtonElement>(`button[aria-label="${name} ${type}"]`);
  expect(button).toBeTruthy();
  button!.click();
  await nextTick();
}

async function filterByName(value: string) {
  const input = root?.querySelector<HTMLInputElement>('input[aria-label="processList.oracleInvalidObjects.filterName"]');
  expect(input).toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await nextTick();
}

async function scrollToRow(index: number, name: string) {
  const scroller = root?.querySelector<HTMLElement>("[data-object-scroller]");
  expect(scroller).toBeTruthy();
  scroller!.scrollTop = index * 44;
  scroller!.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(listRow(name)).not.toBeNull());
}

async function setTypeOption(type: string, checked: boolean) {
  let option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')).find((element) => element.textContent?.trim() === type);
  if (!option) {
    const trigger = dialogButtons().find((button) => button.textContent?.includes("filterTypes"));
    expect(trigger).toBeTruthy();
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => {
      option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')).find((element) => element.textContent?.trim() === type);
      expect(option).toBeTruthy();
    });
  }
  if ((option!.getAttribute("aria-checked") === "true") !== checked) option!.click();
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function closeTypeMenu() {
  document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await nextTick();
}

async function waitForBatch() {
  await nextTick();
  await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
  await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
}

async function mountDialog(connectionState = ref(connection), databaseState = ref("ORCL"), initiallyOpen = true, schemaState = ref("APP"), waitForFullRead = true) {
  const open = ref(initiallyOpen);
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h("div", [
          h(
            "button",
            {
              "data-test-open": true,
              onClick: () => {
                open.value = true;
              },
            },
            "reopen",
          ),
          h(
            "button",
            {
              "data-test-close": true,
              onClick: () => {
                open.value = false;
              },
            },
            "dismiss",
          ),
          h(OracleInvalidObjectsDialog, {
            open: open.value,
            connection: connectionState.value,
            database: databaseState.value,
            schema: schemaState.value,
            onCompileFinished: mocks.compileFinished,
            "onUpdate:open": (value: boolean) => {
              open.value = value;
            },
          }),
        ]);
    },
  });
  app = createApp(Wrapper);
  app.mount(root!);
  if (initiallyOpen) {
    await vi.waitFor(() => expect(root?.textContent?.includes(String(mocks.batchObjects[0]?.[1] ?? "P_BAD")) || root?.textContent?.includes("ORA-01031")).toBe(true));
    if (waitForFullRead && !mocks.failBatchPage && !mocks.failInvalidObjectList) await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileAll"))).toBeTruthy());
  }
  return { open, connectionState, databaseState };
}

describe("OracleInvalidObjectsDialog production flow", () => {
  it.each(["INDEX", "JAVA CLASS"])("keeps %s diagnostics but does not offer an unsupported source editor", async (type) => {
    mocks.batchObjects = [["APP", "UNSUPPORTED_OBJECT", type, "11", "time"]];
    await mountDialog();
    await openDetails("UNSUPPORTED_OBJECT", type);
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    expect(dialogButtons().find((button) => button.textContent?.includes("oracleInvalidObjects.openSource"))).toBeUndefined();
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.unsupportedType");
  });

  it("keeps a supported source action independent of engine compile support", async () => {
    mocks.batchObjects = [["APP", "V_ONLY", "VIEW", "11", "time"]];
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    await openDetails("V_ONLY", "VIEW");
    const source = dialogButtons().find((button) => button.textContent?.includes("oracleInvalidObjects.openSource"));
    expect(source).toBeDefined();
    expect(source?.disabled).toBe(false);
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.unsupportedOnEngine");
  });

  it("filters names without case sensitivity and compiles only the complete matching scope", async () => {
    mocks.batchObjects = [
      ["APP", "P_KEEP_FIRST", "PROCEDURE", "11", "time"],
      ["APP", "P_KEEP_SECOND", "PROCEDURE", "12", "time"],
      ["APP", "P_OTHER", "PROCEDURE", "13", "time"],
    ];
    await mountDialog();
    root?.querySelector<HTMLInputElement>('input[aria-label="P_OTHER PROCEDURE"]')?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:1");
    await filterByName("p_keep");
    expect(root?.textContent).toContain("batchSelectedCount:0");
    expect(listRow("P_OTHER")).toBeNull();
    expect(listRow("P_KEEP_FIRST")).not.toBeNull();
    expect(dialogButtons().some((button) => button.textContent?.includes("batchNextPage"))).toBe(false);
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileFiltered:2"))
      ?.click();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]))).toEqual(['ALTER PROCEDURE "APP"."P_KEEP_FIRST" COMPILE REUSE SETTINGS', 'ALTER PROCEDURE "APP"."P_KEEP_SECOND" COMPILE REUSE SETTINGS']);
  });

  it.each(["%", "_", "[", " "])("treats %s in the name filter as literal text and clears an empty result without querying", async (literal) => {
    mocks.batchObjects = [
      ["APP", `P${literal}MATCH`, "PROCEDURE", "11", "time"],
      ["APP", "PXMATCH", "PROCEDURE", "12", "time"],
    ];
    await mountDialog();
    const queriesBefore = mocks.executeQuery.mock.calls.length;
    await filterByName(literal);
    expect(listRow(`P${literal}MATCH`)).not.toBeNull();
    expect(listRow("PXMATCH")).toBeNull();
    await filterByName("missing-name");
    expect(root?.textContent).toContain("noFilterMatches");
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileFiltered:0"))?.disabled).toBe(true);
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.clearFilters")
      ?.click();
    await nextTick();
    expect(listRow(`P${literal}MATCH`)).not.toBeNull();
    expect(listRow("PXMATCH")).not.toBeNull();
    expect(root?.textContent).toContain("batchSelectedCount:0");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(queriesBefore);
  });

  it("intersects name and type filters, treats zero types as empty and compiles only the package body", async () => {
    mocks.batchObjects = [
      ["APP", "PKG_KEEP", "PACKAGE", "11", "time"],
      ["APP", "PKG_KEEP", "PACKAGE BODY", "12", "time"],
      ["APP", "P_OTHER", "PROCEDURE", "13", "time"],
      ["APP", "V_SKIP", "VIEW", "14", "time"],
    ];
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    await filterByName("pkg");
    await setTypeOption("processList.oracleInvalidObjects.allTypes", false);
    expect(root?.textContent).toContain("noFilterMatches");
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileFiltered:0"))?.disabled).toBe(true);
    await setTypeOption("PACKAGE BODY", true);
    await closeTypeMenu();
    expect(listRow("PKG_KEEP", "PACKAGE")).toBeNull();
    expect(listRow("PKG_KEEP", "PACKAGE BODY")).not.toBeNull();
    expect(root?.textContent).toContain("filterCount:1,4");
    root?.querySelector<HTMLInputElement>('label input[type="checkbox"]')?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:1");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileFiltered:1"))
      ?.click();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]))).toEqual(['ALTER PACKAGE "APP"."PKG_KEEP" COMPILE BODY']);
  });

  it.each([false, true])("keeps a newly discovered type within the user's explicit type intent (%s)", async (explicit) => {
    mocks.batchObjects = [["APP", "P_ONLY", "PROCEDURE", "11", "time"]];
    let release!: () => void;
    mocks.batchPageGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountDialog(ref(connection), ref("ORCL"), true, ref("APP"), false);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (explicit) {
      await setTypeOption("processList.oracleInvalidObjects.allTypes", false);
      await setTypeOption("PROCEDURE", true);
      await closeTypeMenu();
    }
    mocks.batchObjects.push(["APP", "F_NEW", "FUNCTION", "12", "time"]);
    release();
    await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.includes(explicit ? "batchCompileFiltered:1" : "batchCompileAll:2"))?.disabled).toBe(false));
    expect(!!listRow("F_NEW", "FUNCTION")).toBe(!explicit);
    expect(root?.textContent).toContain("batchSelectedCount:0");
  });

  it("selects every matching executable object across virtual windows without selecting hidden names", async () => {
    mocks.batchObjects = [...Array.from({ length: 201 }, (_, index) => ["APP", `P_MATCH_${index}`, "PROCEDURE", String(index + 1), "time"]), ["APP", "P_OTHER", "PROCEDURE", "999", "time"]];
    mocks.executeAllowed = false;
    await mountDialog();
    await filterByName("P_MATCH_");
    expect(root?.querySelectorAll("[data-row-key]").length).toBeLessThan(100);
    root?.querySelector<HTMLInputElement>('label input[type="checkbox"]')?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:201");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected:201"))
      ?.click();
    await waitForBatch();
    expect(mocks.guard).toHaveBeenCalledOnce();
    const audit = (mocks.guard.mock.calls[0]![0] as { sql: string }).sql;
    expect(audit.split(";\n")).toHaveLength(201);
    expect(audit).toContain('"P_MATCH_200"');
    expect(audit).not.toContain('"P_OTHER"');
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
  });

  it("preserves filters on refresh but resets them on a new scope", async () => {
    const schema = ref("APP");
    await mountDialog(ref(connection), ref("ORCL"), true, schema);
    await filterByName("P_OK");
    await setTypeOption("processList.oracleInvalidObjects.allTypes", false);
    await setTypeOption("PROCEDURE", true);
    await closeTypeMenu();
    listRow("P_OK")?.querySelector<HTMLInputElement>("input")?.click();
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileFiltered:1"))?.disabled).toBe(false));
    expect(root?.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("P_OK");
    expect(root?.textContent).toContain("batchSelectedCount:0");
    mocks.batchObjects = mocks.batchObjects.map((row) => ["OTHER", ...row.slice(1)]);
    schema.value = "OTHER";
    await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileAll:3"))?.disabled).toBe(false));
    expect(root?.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
    expect(root?.textContent).toContain("batchSelectedCount:0");
  });

  it("keeps filtered all disabled during incomplete reads while allowing the selected loaded target", async () => {
    let release!: () => void;
    mocks.batchPageGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountDialog(ref(connection), ref("ORCL"), true, ref("APP"), false);
    await filterByName("P_OK");
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compileFiltered")?.disabled).toBe(true);
    expect(root?.textContent).toContain("currentlyLoaded");
    listRow("P_OK")?.querySelector<HTMLInputElement>("input")?.click();
    await nextTick();
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileSelected:1"))?.disabled).toBe(false);
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected:1"))
      ?.click();
    await nextTick();
    expect(mocks.guard).not.toHaveBeenCalled();
    release();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]))).toEqual(['ALTER PROCEDURE "APP"."P_OK" COMPILE REUSE SETTINGS']);
  });

  it("retains the explicit selected type when its last matching object becomes valid", async () => {
    mocks.batchObjects = [
      ["APP", "P_ONLY", "PROCEDURE", "11", "time"],
      ["APP", "F_OTHER", "FUNCTION", "12", "time"],
    ];
    await mountDialog();
    await setTypeOption("processList.oracleInvalidObjects.allTypes", false);
    await setTypeOption("PROCEDURE", true);
    await closeTypeMenu();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileFiltered:1"))
      ?.click();
    await waitForBatch();
    expect(root?.textContent).toContain("noFilterMatches");
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileFiltered:0"))?.disabled).toBe(true);
    await setTypeOption("PROCEDURE", true);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
        .find((element) => element.textContent?.trim() === "PROCEDURE")
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    await closeTypeMenu();
    expect(listRow("F_OTHER", "FUNCTION")).toBeNull();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.clearFilters")
      ?.click();
    await vi.waitFor(() => expect(listRow("F_OTHER", "FUNCTION")).not.toBeNull());
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
  });

  it("returns from a deep detail to the same scroll position and original name focus", async () => {
    mocks.batchObjects = Array.from({ length: 601 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    await mountDialog();
    await scrollToRow(400, "P_400");
    const previousTop = root!.querySelector<HTMLElement>("[data-object-scroller]")!.scrollTop;
    listRow("P_400")!.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await vi.waitFor(() => expect((document.activeElement as HTMLElement)?.dataset.objectKey).toBe("APP:401"));
    expect(root!.querySelector<HTMLElement>("[data-object-scroller]")!.scrollTop).toBe(previousTop);
    expect(document.activeElement?.closest("[inert]")).toBeNull();
  });

  it("tabs across the recycled window edge to the next logical checkbox without selecting it", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, optionsOrX?: ScrollToOptions | number, y?: number) {
      this.scrollTop = typeof optionsOrX === "number" ? (y ?? 0) : (optionsOrX?.top ?? this.scrollTop);
      this.scrollLeft = typeof optionsOrX === "number" ? optionsOrX : (optionsOrX?.left ?? this.scrollLeft);
      // Simulate the browser scroll event, which happy-dom does not dispatch.
      this.dispatchEvent(new Event("scroll"));
    });
    mocks.batchObjects = Array.from({ length: 601 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    await mountDialog();
    const activeIndexes = Array.from(root!.querySelectorAll<HTMLButtonElement>("[data-row-key]:not([inert]) button")).map((button) => Number(button.textContent!.replace("P_", "")));
    const last = Math.max(...activeIndexes);
    expect(last).toBeLessThan(600);
    expect(listRow(`P_${last + 1}`)).toBeNull();
    const button = listRow(`P_${last}`)!.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe(`P_${last + 1} PROCEDURE`));
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(document.activeElement?.closest("[inert]")).toBeNull();
    expect((document.activeElement as HTMLInputElement).checked).toBe(false);
    expect(root?.textContent).toContain("batchSelectedCount:0");
  });

  it("separates opening object details from selection and exposes a zero-selection disabled action", async () => {
    await mountDialog();
    const checkboxes = Array.from(root?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []);
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes[0]?.checked).toBe(false);
    expect(dialogButtons().some((button) => button.textContent?.includes("batchCompileSelected") && button.disabled)).toBe(true);
    checkboxes[0]?.click();
    await nextTick();
    expect(root?.textContent).not.toContain("invalid identifier");
    expect(dialogButtons().some((button) => button.textContent?.includes("batchCompileSelected") && !button.disabled)).toBe(true);
  });

  it("preserves selected identities across virtual windows and compiles only checked objects", async () => {
    mocks.batchObjects = Array.from({ length: 101 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    await mountDialog();
    root?.querySelector<HTMLInputElement>('input[aria-label="P_0 PROCEDURE"]')?.click();
    await scrollToRow(100, "P_100");
    listRow("P_100")?.querySelector<HTMLInputElement>("input")?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:2");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected"))
      ?.click();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    const submitted = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]));
    expect(submitted).toHaveLength(2);
    expect(submitted.join("\n")).toContain('"P_0"');
    expect(submitted.join("\n")).toContain('"P_100"');
    expect(submitted.join("\n")).not.toContain('"P_1"');
  });

  it("orders selected targets by the current full collection, not click order", async () => {
    mocks.batchObjects = [
      ["APP", "P_FIRST", "PROCEDURE", "11", "time"],
      ["APP", "P_SECOND", "PROCEDURE", "12", "time"],
    ];
    await mountDialog();
    root?.querySelector<HTMLInputElement>('input[aria-label="P_SECOND PROCEDURE"]')?.click();
    root?.querySelector<HTMLInputElement>('input[aria-label="P_FIRST PROCEDURE"]')?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    const submitted = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]));
    expect(submitted).toEqual(['ALTER PROCEDURE "APP"."P_FIRST" COMPILE REUSE SETTINGS', 'ALTER PROCEDURE "APP"."P_SECOND" COMPILE REUSE SETTINGS']);
  });

  it("orders all targets by the displayed collection rather than the dictionary ID cursor", async () => {
    mocks.batchObjects = [
      ["APP", "P_FIRST", "PROCEDURE", "12", "time"],
      ["APP", "P_SECOND", "PROCEDURE", "11", "time"],
    ];
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]))).toEqual(['ALTER PROCEDURE "APP"."P_FIRST" COMPILE REUSE SETTINGS', 'ALTER PROCEDURE "APP"."P_SECOND" COMPILE REUSE SETTINGS']);
  });

  it.each(["detail", "list"])("keeps a single compile's diagnostics with its frozen object after navigating to another %s", async (view) => {
    let release!: () => void;
    compileStatus = "INVALID";
    mocks.diagnosticTexts = { P_BAD: "A diagnostic", P_OK: "B diagnostic" };
    await mountDialog();
    await openDetails("P_BAD");
    await vi.waitFor(() => expect(root?.textContent).toContain("A diagnostic"));
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    await openDetails("P_OK");
    if (view === "list") {
      dialogButtons()
        .find((button) => button.textContent?.includes("batchCurrentList"))
        ?.click();
      await nextTick();
    }
    mocks.compileGate = null;
    release();
    if (view === "detail") {
      await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(false));
      expect(root?.textContent).not.toContain("compileStillInvalid");
      expect(root?.textContent).not.toContain("A diagnostic");
      dialogButtons()
        .find((button) => button.textContent?.includes("batchCurrentList"))
        ?.click();
      await nextTick();
    } else {
      await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
      expect(root?.querySelector("section[aria-label]")).not.toBeNull();
    }
    await openDetails("P_BAD");
    await vi.waitFor(() => expect(root?.textContent).toContain("compileStillInvalid"));
    expect(root?.textContent).toContain("A diagnostic");
    expect(root?.textContent).not.toContain("B diagnostic");
  });

  it("does not let the first diagnostic request overwrite the latest A result after A-B-A navigation", async () => {
    let release!: () => void;
    mocks.batchObjects = [
      ["APP", "P_A", "PROCEDURE", "11", "time"],
      ["APP", "P_B", "PROCEDURE", "12", "time"],
    ];
    mocks.diagnosticGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountDialog();
    root?.querySelector<HTMLButtonElement>('[data-object-key="APP:11"]')?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    root?.querySelector<HTMLButtonElement>('[data-object-key="APP:12"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    root?.querySelector<HTMLButtonElement>('[data-object-key="APP:11"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root?.textContent).not.toContain("late A diagnostics");
  });

  it("allows a resolved target again after an explicit refresh confirms it is still invalid", async () => {
    const { databaseState } = await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("compileValid"));
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(true);

    compileStatus = "INVALID";
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.title === "common.refresh")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("P_BAD"));
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(false));
    expect(databaseState.value).toBe("ORCL");
  });

  it("clears a resolved-target disable when the execution scope changes", async () => {
    const { databaseState } = await mountDialog();
    await openDetails("P_BAD");
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("compileValid"));

    compileStatus = "INVALID";
    databaseState.value = "ORCL2";
    await vi.waitFor(() => expect(root?.querySelector('button[aria-label="P_BAD PROCEDURE"]')).toBeTruthy());
    await openDetails("P_BAD");
    await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(false));
  });

  it("keeps detail navigation separate and restores selection and focus through the real scroller", async () => {
    await mountDialog();
    const checkbox = root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]');
    checkbox?.click();
    const nameButton = root?.querySelector<HTMLButtonElement>('[data-object-key="APP:8"]');
    nameButton?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    expect(root?.querySelector<HTMLInputElement>('input[type="checkbox"]')).toBeNull();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.checked).toBe(true);
    await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.objectKey).toBe("APP:8"));
  });

  it("updates the original rows in place and keeps the frozen queue intact as VALID rows disappear", async () => {
    mocks.batchObjects.push(["APP", "P_LATER", "PROCEDURE", "11", "2026-10-20 09:00:00"]);
    const releases: Array<() => void> = [];
    mocks.compileGate = () => new Promise<void>((resolve) => releases.push(resolve));
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.click();
    root?.querySelector<HTMLInputElement>('input[aria-label="P_BAD PROCEDURE"]')?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected"))
      ?.click();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(listRow("P_OK")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("running");
    expect(listRow("P_BAD")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("pending");
    expect(listRow("P_LATER")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("INVALID");
    expect(root?.querySelectorAll("section[aria-label]")).toHaveLength(1);
    expect(root?.textContent).not.toContain("batchResults");
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(listRow("P_OK")).toBeNull();
    expect(root?.textContent).toContain("batchProgress:1,2,APP.P_BAD");
    expect(listRow("P_OK")).toBeNull();
    expect(listRow("P_BAD")).not.toBeNull();
    expect(listRow("P_LATER")).not.toBeNull();
    expect(listRow("V_SKIP", "VIEW")).not.toBeNull();
    mocks.compileGate = null;
    releases[1]!();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(mocks.compileFinished).toHaveBeenCalledOnce();
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.still-invalid");
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_BAD PROCEDURE"]')?.disabled).toBe(false);
  });

  it("keeps an unknown row absent from INVALID results until explicit read-only refresh confirms VALID", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    mocks.truncateBatchStatusAfter = true;
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await waitForBatch();
    expect(listRow("P_OK")).not.toBeNull();
    expect(listRow("P_OK")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("unknown");
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.disabled).toBe(true);
    expect(root?.textContent).toContain("batchCompileAll:1");
    root?.querySelector<HTMLInputElement>('label input[type="checkbox"]')?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:1");
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.checked).toBe(false);
    mocks.truncateBatchStatusAfter = false;
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(listRow("P_OK")).toBeNull());
    expect(listRow("P_BAD")).not.toBeNull();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(mocks.compileFinished).toHaveBeenCalledOnce();
  });

  it("retains a single unknown row when complete INVALID results omit it and does not retry its write", async () => {
    mocks.failStatusReadback = true;
    await mountDialog();
    await openDetails("P_BAD");
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("compileUnknown"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    expect(listRow("P_BAD")).not.toBeNull();
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_BAD PROCEDURE"]')?.disabled).toBe(true);
    mocks.failStatusReadback = false;
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(listRow("P_BAD")).toBeNull());
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
  });

  it("keeps another unresolved row's diagnostic when a later selection starts a new batch", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    mocks.unknownBatchCompileName = "P_OK";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await waitForBatch();
    mocks.unknownBatchCompileName = "";
    root?.querySelector<HTMLInputElement>('input[aria-label="P_BAD PROCEDURE"]')?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected"))
      ?.click();
    await waitForBatch();
    expect(root?.textContent).toContain("batchSummary:0,1,0,0");
    expect(listRow("P_OK")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("unknown");
    await openDetails("P_OK");
    expect(root?.textContent).toContain("connection lost during DDL");
  });

  it("keeps more than 501 objects during execution and restores the neighboring virtual row after removal", async () => {
    mocks.batchObjects = Array.from({ length: 601 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountDialog();
    await scrollToRow(600, "P_600");
    listRow("P_600")?.querySelector<HTMLInputElement>("input")?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(root?.textContent).toContain("listCount:601");
    expect(root?.querySelectorAll("[data-row-key]:not([inert])").length).toBeLessThan(50);
    const diagnosticsBefore = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM ALL_ERRORS")).length;
    await openDetails("P_600");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM ALL_ERRORS"))).toHaveLength(diagnosticsBefore);
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(true);
    release();
    await vi.waitFor(() => expect(mocks.compileFinished).toHaveBeenCalledOnce());
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(listRow("P_599")).not.toBeNull());
    expect(listRow("P_600")).toBeNull();
    await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.objectKey).toBe("APP:600"));
  });

  it("shows the same ID as a new unselected INVALID observation if it becomes invalid again after a VALID read", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    await mountDialog();
    let release!: () => void;
    mocks.batchPageGate = () => new Promise<void>((resolve) => (release = resolve));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(listRow("P_OK")).toBeNull();
    mocks.batchStatuses.P_OK = "INVALID";
    release();
    await waitForBatch();
    expect(listRow("P_OK")).not.toBeNull();
    expect(listRow("P_OK")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("INVALID");
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.checked).toBe(false);
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.disabled).toBe(false);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
  });

  it("distinguishes same-name package specification and body for accessible controls", async () => {
    mocks.batchObjects = [
      ["APP", "P_SHARED", "PACKAGE", "31", "time"],
      ["APP", "P_SHARED", "PACKAGE BODY", "32", "time"],
    ];
    await mountDialog();

    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_SHARED PACKAGE"]')).toBeTruthy();
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_SHARED PACKAGE BODY"]')).toBeTruthy();
    expect(root?.querySelector<HTMLButtonElement>('button[aria-label="P_SHARED PACKAGE"]')).toBeTruthy();
    expect(root?.querySelector<HTMLButtonElement>('button[aria-label="P_SHARED PACKAGE BODY"]')).toBeTruthy();
  });

  it("drains both the pending full-read page and diagnostic query before a single-object write", async () => {
    let releasePage!: () => void;
    let releaseErrors!: () => void;
    mocks.batchPageGate = () => new Promise<void>((resolve) => (releasePage = resolve));
    mocks.diagnosticGate = () => new Promise<void>((resolve) => (releaseErrors = resolve));
    await mountDialog(ref(connection), ref("ORCL"), true, ref("APP"), false);
    await vi.waitFor(() => expect(releasePage).toBeTypeOf("function"));
    root?.querySelector<HTMLButtonElement>('[data-object-key="APP:9"]')?.click();
    await vi.waitFor(() => expect(releaseErrors).toBeTypeOf("function"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.guard).not.toHaveBeenCalled();
    releasePage();
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    releaseErrors();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileValid"));
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
  });

  it("does not let a pending refresh start another diagnostic query after an action begins draining", async () => {
    let releaseList!: () => void;
    let releaseCompile!: () => void;
    await mountDialog();
    await openDetails("P_BAD");
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    mocks.listGate = () => new Promise<void>((resolve) => (releaseList = resolve));
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(releaseList).toBeTypeOf("function"));
    const diagnosticCount = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM ALL_ERRORS")).length;
    root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.click();
    await nextTick();
    mocks.compileGate = () => new Promise<void>((resolve) => (releaseCompile = resolve));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileSelected"))
      ?.click();
    await nextTick();
    expect(mocks.guard).not.toHaveBeenCalled();
    releaseList();
    await vi.waitFor(() => expect(releaseCompile).toBeTypeOf("function"));
    try {
      expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM ALL_ERRORS"))).toHaveLength(diagnosticCount);
    } finally {
      mocks.compileGate = null;
      releaseCompile();
    }
    await waitForBatch();
  });

  it("shows a dictionary read denial instead of treating it as an empty list", async () => {
    mocks.failInvalidObjectList = true;
    await mountDialog();
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.empty");
    expect(dialogButtons().some((button) => button.title === "common.refresh")).toBe(true);
  });

  it("uses one managed client session, closes it, and rotates it when the dialog reopens", async () => {
    await mountDialog();
    const sessionIds = mocks.executeQuery.mock.calls.map((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId);
    expect(new Set(sessionIds).size).toBe(1);
    const sessionId = sessionIds[0];
    expect(sessionId).toMatch(/^invalid-objects:/);
    root?.querySelector<HTMLButtonElement>("[data-test-close]")?.click();
    await nextTick();
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", sessionId);
    const listCallsBeforeReopen = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    root?.querySelector<HTMLButtonElement>("[data-test-open]")?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(listCallsBeforeReopen));
    const reopenedListCall = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).at(-1);
    expect((reopenedListCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId).not.toBe(sessionId);
  });

  it("does not create or close a client session when the hidden dialog context changes", async () => {
    const connectionState = ref({ ...connection });
    const databaseState = ref("ORCL");
    const { open } = await mountDialog(connectionState, databaseState, false);

    connectionState.value = { ...connection, host: "replacement-host" };
    databaseState.value = "ORCL2";
    await nextTick();

    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    open.value = true;
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalled());
    expect(mocks.executeQuery.mock.calls[0]).toEqual(expect.arrayContaining([connection.id, "ORCL2"]));
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("reads the complete batch in the background and compiles all with one click", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.truncatedErrors = true;
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    const compileAll = dialogButtons().find((button) => button.textContent?.includes("batchCompileAll"));
    expect(compileAll?.disabled).toBe(false);
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="V_SKIP VIEW"]')?.disabled).toBe(true);
    compileAll?.click();
    await nextTick();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("OBJECT_ID >"))).toBe(true));
    expect(root?.textContent).toContain("V_SKIP");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.running");
    mocks.compileGate = null;
    release();
    await waitForBatch();
    expect(mocks.guard).toHaveBeenCalledOnce();
    const sessionIds = mocks.executeQuery.mock.calls.map((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId);
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).toMatch(/^invalid-objects:/);
    const options = mocks.guard.mock.calls[0]?.[0] as { sql: string };
    expect(options.sql).toContain('ALTER PROCEDURE "APP"."P_OK" COMPILE');
    expect(options.sql).toContain('ALTER PROCEDURE "APP"."P_BAD" COMPILE');
    expect(options.sql).not.toContain("V_SKIP");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.still-invalid");
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.unsupported");
    expect(listRow("P_OK")).toBeNull();
    expect(listRow("P_BAD")).not.toBeNull();
    await openDetails("P_BAD");
    expect(root?.textContent).toContain("errorsTruncated");
    expect(root?.querySelectorAll("tbody tr")).toHaveLength(1000);
  });

  it("does not submit a partial plan when a middle batch page fails", async () => {
    mocks.batchObjects = Array.from({ length: 501 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    mocks.failBatchPage = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchReadFailed"));
    expect(root?.textContent).toContain("middle page failed");
    expect(root?.textContent).not.toContain("batchSummary");
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
  });

  it("does not compile an object when its preflight status result is truncated", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    mocks.truncateBatchStatusBefore = true;
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(0);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.unknown");
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.disabled).toBe(true);
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileAll:0"))?.disabled).toBe(true);
    await openDetails("P_OK");
    expect(root?.textContent).toContain("batchIdentityUnknown");
    expect(root?.textContent).not.toContain("compileUnknown");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    mocks.truncateBatchStatusBefore = false;
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileAll:1"))?.disabled).toBe(false));
    expect(root?.querySelector<HTMLInputElement>('input[aria-label="P_OK PROCEDURE"]')?.disabled).toBe(false);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(0);
  });

  it("does not compile a single object when its identity preflight is truncated", async () => {
    mocks.truncateSingleIdentity = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.batchIdentityUnknown"));
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileUnknown");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(0);
  });

  it("stops the batch with unknown status when post-compile readback is truncated", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    mocks.truncateBatchStatusAfter = true;
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.unknown");
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.not-run");
    await openDetails("P_OK");
    expect(root?.textContent).toContain("compileUnknown");
    expect(root?.textContent).not.toContain("batchIdentityUnknown");
  });

  it("cancels batch confirmation without compiling or refreshing the remaining list", async () => {
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    mocks.executeAllowed = false;
    await vi.waitFor(() => expect(root?.textContent).toContain("batchGuardDeclined"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.compileFinished).not.toHaveBeenCalled();
  });

  it("stops before the next object when the user requests it during a submitted compile", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(root?.querySelector('[role="status"]')?.textContent).not.toContain("batchStopping");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchStop"))
      ?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchStopping");
    const stopButton = dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.batchStop");
    expect(stopButton?.disabled).toBe(true);
    expect(root?.textContent?.split("batchStopping")).toHaveLength(2);
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.not-run");
  });

  it("stops before the first DDL when requested while production confirmation is pending", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(root?.querySelector('[role="status"]')?.textContent).not.toContain("batchStopping");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchStop"))
      ?.click();
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.not-run");
  });

  it("stops before DDL when requested while the first object's identity preflight is pending", async () => {
    let release!: () => void;
    mocks.batchStatusGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchStop"))
      ?.click();
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.not-run");
  });

  it("does not send a confirmed batch to a replacement connection configuration", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    const connectionState = ref(connection);
    await mountDialog(connectionState);
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    connectionState.value = { ...connection, host: "replacement-host" };
    await nextTick();
    release();
    await nextTick();

    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.compileFinished).not.toHaveBeenCalled();
  });

  it("does not send a confirmed batch after the selected schema changes", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    const schemaState = ref("APP");
    await mountDialog(ref(connection), ref("ORCL"), true, schemaState);
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    schemaState.value = "OTHER_SCHEMA";
    await nextTick();
    release();
    await nextTick();

    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.compileFinished).not.toHaveBeenCalled();
  });

  it("drains a submitted batch on its original session and reports completion only for its frozen scope", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    const databaseState = ref("ORCL");
    await mountDialog(ref(connection), databaseState);
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const ddlCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("ALTER "));
    const sessionId = (ddlCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(sessionId).toBeTruthy();

    databaseState.value = "ORCL2";
    await nextTick();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", sessionId));
    expect(mocks.compileFinished).toHaveBeenCalledWith({ connectionId: connection.id, database: "ORCL", schema: "APP" });
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).every((call) => call[1] === "ORCL")).toBe(true);
  });

  it("removes confirmed VALID rows but preserves unresolved rows and diagnostics when remaining refresh fails", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    mocks.failRemainingAfterWrite = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("remaining list denied"));
    expect(listRow("P_OK")).toBeNull();
    expect(listRow("P_BAD")).not.toBeNull();
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.still-invalid");
    expect(root?.textContent).toContain("batchRemainingUnknown");
    await openDetails("P_BAD");
    expect(root?.textContent).toContain("invalid identifier");
  });

  it("stops after an unknown write outcome and leaves later items unsubmitted", async () => {
    mocks.unknownBatchCompileName = "P_OK";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.not-run");
    await openDetails("P_OK");
    expect(root?.textContent).toContain("connection lost during DDL");
  });

  it("stops after an unknown execution_error result object", async () => {
    mocks.unknownBatchCompileResultName = "P_OK";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await waitForBatch();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.unknown");
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.not-run");
    await openDetails("P_OK");
    expect(root?.textContent).toContain("result unavailable");
  });

  it("allows a later object when an earlier DDL is explicitly rejected before start", async () => {
    mocks.failBatchCompileName = "P_OK";
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.failed");
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.still-invalid");
    await openDetails("P_OK");
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
  });

  it.each(["result", "throw"] as const)("continues the batch after a structured not_started rejection (%s)", async (mode) => {
    mocks.definiteBatchFailureName = "P_OK";
    mocks.definiteBatchFailureMode = mode;
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.failed");
    expect(statusLabels()).not.toContain("processList.oracleInvalidObjects.batchStatus.not-run");
  });

  it("skips an already-valid object and blocks an object whose identity changed", async () => {
    await mountDialog();
    mocks.batchStatuses.P_OK = "VALID";
    mocks.batchTimes.P_OK = "2026-10-20 09:01:00";
    mocks.batchObjectIds.P_BAD = "999";
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    const ddlNames = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]));
    expect(ddlNames).not.toContainEqual(expect.stringContaining('"P_OK"'));
    expect(ddlNames).not.toContainEqual(expect.stringContaining('"P_BAD"'));
    expect(listRow("P_OK")).toBeNull();
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.target-changed");
  });

  it("classifies missing and unexpected preflight states without submitting DDL", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    mocks.missingBatchStatusName = "P_OK";
    mocks.batchStatuses.P_BAD = "UNKNOWN_STATUS";
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.deleted");
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.unknown");
  });

  it("blocks an object whose DDL time changed after the plan was read", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(1, 2);
    await mountDialog();
    mocks.batchTimes.P_BAD = "2026-10-20 09:01:00";
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchSummary"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.target-changed");
  });

  it("browses the first middle and last of 5001 objects with a real bounded virtual pool", async () => {
    mocks.batchObjects = Array.from({ length: 5001 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    await mountDialog();
    expect(listRow("P_0")).not.toBeNull();
    expect(listRow("P_5000")).toBeNull();
    await scrollToRow(2500, "P_2500");
    await scrollToRow(5000, "P_5000");
    expect(root?.querySelectorAll("[data-row-key]").length).toBeLessThan(100);
    expect(root?.textContent).toContain("listCount:5001");
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileAll:5001"))?.disabled).toBe(false);
  });

  it("disables compile all when the engine has no supported compile type", async () => {
    mocks.batchObjects = [["APP", "V_ONLY", "VIEW", "201", "time"]];
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    const compileAll = dialogButtons().find((button) => button.textContent?.includes("batchCompileAll"));
    expect(compileAll?.disabled).toBe(true);
    expect(statusLabels()).toContain("processList.oracleInvalidObjects.batchStatus.unsupported");
    await openDetails("V_ONLY", "VIEW");
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.unsupportedOnEngine");
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("loads diagnostics and compiles a single object with one guarded click", async () => {
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileValid"));
    expect(root?.textContent).not.toContain("singleConfirmTitle");
    expect(root?.querySelector("details")?.open).toBe(false);
    expect(root?.querySelector("details pre")?.textContent).toContain('ALTER PROCEDURE "APP"."P_BAD" COMPILE REUSE SETTINGS');
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(compiled).toBe(true);
    expect(mocks.compileFinished).toHaveBeenCalledWith({ connectionId: connection.id, database: "ORCL", schema: "APP" });
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ database: "APP", sql: 'ALTER PROCEDURE "APP"."P_BAD" COMPILE REUSE SETTINGS' }));
    const compileCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("ALTER PROCEDURE"));
    const clientSessionId = (compileCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(clientSessionId).toBeTruthy();
    expect(mocks.executeQuery.mock.calls.every((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId === clientSessionId)).toBe(true);
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(true);
  });

  it("keeps compile unexecuted when production confirmation is declined", async () => {
    mocks.executeAllowed = false;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());
    expect(compiled).toBe(false);
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(false);
  });

  it("keeps the object selected and reloads diagnostics when compilation changes LAST_DDL_TIME but remains invalid", async () => {
    compileStatus = "INVALID";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();

    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileStillInvalid"));
    expect(root?.textContent).toContain("still invalid after compile");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.targetChanged");
    expect(errorsReloadedAfterCompile).toBe(true);
  });

  it("keeps a confirmed INVALID status separate from a diagnostic read failure", async () => {
    compileStatus = "INVALID";
    await mountDialog();
    await openDetails("P_BAD");
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    const original = mocks.executeQuery.getMockImplementation()!;
    mocks.executeQuery.mockImplementation(async (...args) => {
      if (compiled && String(args[2]).includes("FROM ALL_ERRORS")) throw new Error("diagnostics denied");
      return original(...args);
    });
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("compileStillInvalid"));
    expect(root?.textContent).toContain("diagnostics denied");
    expect(root?.textContent).not.toContain("compileUnknown");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCurrentList"))
      ?.click();
    await nextTick();
    expect(listRow("P_BAD")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("still-invalid");
    await openDetails("P_BAD");
    expect(root?.textContent).toContain("diagnostics denied");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
  });

  it("does not report a replacement object as the compiled target", async () => {
    objectIdAfterCompile = "10";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();

    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.targetChanged"));
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileValid");
  });

  it("refreshes when the user clicks the refresh control", async () => {
    await mountDialog();
    const count = () => mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    const before = count();
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
  });

  it("replaces an in-flight background page on refresh and publishes only the fresh complete list", async () => {
    let release!: () => void;
    mocks.batchPageGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountDialog(ref(connection), ref("ORCL"), true, ref("APP"), false);
    const listCount = () => mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    const before = listCount();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(listCount()).toBeGreaterThan(before));
    release();
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(root?.textContent).not.toContain("batchReading");
    expect(root?.textContent).not.toContain("batchConfirmTitle");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(0);
  });

  it("manual refresh clears selection and rereads the full list without compiling", async () => {
    await mountDialog();
    const checkbox = root?.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="P_OK PROCEDURE"]');
    expect(checkbox).toBeTruthy();
    checkbox?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:1");
    const beforeRefresh = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(beforeRefresh));
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(root?.textContent).toContain("batchSelectedCount:0");
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
  });

  it("keeps actions scoped to the entire collection without pagination controls", async () => {
    mocks.batchObjects = Array.from({ length: 101 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    await mountDialog();
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.title · Oracle · APP");
    expect(dialogButtons().find((button) => button.textContent?.includes("batchCompileAll:101"))?.disabled).toBe(false);
    expect(dialogButtons().some((button) => /batchPreviousPage|batchNextPage/.test(button.textContent ?? ""))).toBe(false);
    root?.querySelector<HTMLInputElement>('label input[type="checkbox"]')?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchSelectedCount:101");
    expect(listRow("P_0")).not.toBeNull();
  });

  it("shows the diagnostics truncation warning alongside the fetched error rows", async () => {
    mocks.truncatedErrors = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.errorsTruncated"));
    expect(root?.querySelectorAll("tbody tr").length).toBe(1000);
  });

  it("reports a removed object separately after compile", async () => {
    mocks.statusMissingAfterCompile = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileGone"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileGone");
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(true);
  });

  it("preserves status readback diagnostics when compile outcome is unknown", async () => {
    mocks.failStatusReadback = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: insufficient privileges while reading status"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown");
  });

  it.each(["throw", "result"] as const)("keeps submitted single compile unknown when status readback is denied (%s)", async (mode) => {
    mocks.failStatusReadback = true;
    mocks.statusReadbackErrorMode = mode;
    compileStatus = "INVALID";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown"));
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("ALTER PROCEDURE"))).toHaveLength(1);
    expect(mocks.compileFinished).toHaveBeenCalledWith({ connectionId: connection.id, database: "ORCL", schema: "APP" });
    expect(root?.querySelector("button")?.textContent).not.toContain("confirmCompile");
  });

  it("keeps single compile status unknown when the readback is truncated", async () => {
    mocks.truncateSingleStatusAfter = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("ALTER PROCEDURE"))).toHaveLength(1);
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileValid");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.batchIdentityUnknown");
  });

  it("preserves a definite compile permission denial", async () => {
    mocks.failCompile = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: insufficient privileges"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileFailed");
  });

  it("rechecks identity after production confirmation", async () => {
    let release!: () => void;
    mocks.guardGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());
    mocks.identityChangedAfterGuard = true;
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.targetChanged"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(false);
  });

  it("does not submit compile after the connection configuration changes behind the confirmation", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    const connectionState = ref(connection);
    await mountDialog(connectionState);
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());

    connectionState.value = { ...connection, host: "replacement-host" };
    await nextTick();
    release();
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER PROCEDURE"))).toBe(false);
  });

  it("uses a fresh session after close while a submitted compile drains, without leaving the reopened dialog stuck", async () => {
    let release!: () => void;
    mocks.compileGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(true));
    const compileCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("ALTER PROCEDURE"));
    const compileSessionId = (compileCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    dialogButtons()
      .find((button) => button.hasAttribute("data-test-close"))
      ?.click();
    await nextTick();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    dialogButtons()
      .find((button) => button.hasAttribute("data-test-open"))
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(1));
    const reopenedListCall = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).at(-1);
    const reopenedSessionId = (reopenedListCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(reopenedSessionId).not.toBe(compileSessionId);
    release();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", compileSessionId));
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    // The old physical DDL can make P_BAD VALID. Check the unaffected current target.
    dialogButtons()
      .find((button) => button.textContent?.includes("P_OK"))
      ?.click();
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(false);
  });

  it("does not write a late compile outcome into the reopened dialog after readback refresh", async () => {
    let release!: () => void;
    mocks.postCompileListGate = () => new Promise<void>((resolve) => (release = resolve));
    const { open } = await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    open.value = false;
    await nextTick();
    open.value = true;
    await nextTick();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(2));
    release();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("P_OK"));
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileValid");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileGone");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileUnknown");
  });

  it("drains a submitted batch session after the dialog unmounts", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchCompileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const ddlCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("ALTER "));
    const sessionId = (ddlCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(sessionId).toBeTruthy();

    app?.unmount();
    app = null;
    release();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", sessionId));
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledTimes(1);
  });
});
