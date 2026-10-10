// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleTypeEditor from "@/components/admin/OracleTypeEditor.vue";
import type { ConnectionConfig, QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ executeQuery: vi.fn(), getObjectSource: vi.fn(), cancelQuery: vi.fn(), ensureConnected: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: (...args: unknown[]) => mocks.executeQuery(...args), getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args), cancelQuery: (...args: unknown[]) => mocks.cancelQuery(...args) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));
vi.mock("@/components/ui/dialog", () => {
  const box = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", { role: "dialog" }, slots.default?.()) : null,
    }),
    DialogContent: box,
    DialogFooter: box,
    DialogHeader: box,
    DialogTitle: box,
  };
});
const source = 'CREATE OR REPLACE TYPE "APP"."T" AS OBJECT (value VARCHAR2(20));';
const response = (columns: string[], rows: QueryResult["rows"]): QueryResult => ({ columns, rows, affected_rows: 0, execution_time_ms: 0 });
let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;
let status: string;
function mount() {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(OracleTypeEditor, { connection: { id: "a", name: "Oracle", db_type: "oracle", database: "svc" } as ConnectionConfig, database: "svc", initialSchema: "APP", initialName: "T" });
  app.use(createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: {} } }));
  app.mount(root);
}
async function settle() {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function click(label: string) {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
  await settle();
}
async function edit() {
  const textarea = root.querySelector("textarea")!;
  textarea.value = source.replace("20", "40");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
const writes = () => mocks.executeQuery.mock.calls.filter((args) => !String(args[2]).startsWith("SELECT "));

beforeEach(() => {
  status = "VALID";
  mocks.cancelQuery.mockReset().mockResolvedValue(true);
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.getObjectSource.mockReset().mockResolvedValue({ source });
  mocks.guard.mockReset().mockImplementation((options) => options.execute());
  mocks.executeQuery.mockReset().mockImplementation(async (_id, _database, sql: string) => {
    if (sql.includes("FROM DBA_OBJECTS")) return response(["OBJECT_TYPE", "STATUS", "OBJECT_ID", "LAST_DDL_TIME"], [["TYPE", status, "1", "2026-10-09 10:00:00"]]);
    if (sql.startsWith("CREATE ")) {
      status = "INVALID";
      return response([], []);
    }
    return response([], []);
  });
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
});

describe("OracleTypeEditor", () => {
  it("loads the complete original definition and cancels an exact preview without a write", async () => {
    mount();
    await click("Read current definitions");
    expect(root.querySelector("textarea")?.value).toBe(source);
    expect(mocks.getObjectSource).toHaveBeenCalledWith("a", "svc", "APP", "T", "TYPE");
    await edit();
    await click("Preview save");
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('CREATE OR REPLACE TYPE "APP"."T" AS OBJECT (value VARCHAR2(40));');
    await click("Cancel");
    expect(writes()).toHaveLength(0);
    expect(mocks.guard).not.toHaveBeenCalled();
  });
  it("keeps the original source and draft when readback is INVALID", async () => {
    mount();
    await click("Read current definitions");
    await edit();
    await click("Preview save");
    await click("Execute reviewed steps");
    expect(writes()).toHaveLength(1);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("not confirmed VALID");
    expect(root.querySelector('[role="status"]')?.textContent).toContain(source);
    expect(root.querySelector("textarea")?.value).toContain("VARCHAR2(40)");
    expect(root.textContent).not.toContain("All steps were read back successfully");
  });
  it("cannot prepare a write from incomplete dependency visibility", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("ORA-01031"));
    mount();
    await click("Read current definitions");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("ORA-01031");
    expect(root.querySelector("textarea")?.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it("does not execute when the production guard declines", async () => {
    mocks.guard.mockResolvedValue(undefined);
    mount();
    await click("Read current definitions");
    await edit();
    await click("Preview save");
    await click("Execute reviewed steps");
    expect(mocks.guard).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });
});
