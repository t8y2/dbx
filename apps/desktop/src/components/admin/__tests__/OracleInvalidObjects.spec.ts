// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleInvalidObjects from "@/components/admin/OracleInvalidObjects.vue";
import type { ConnectionConfig, QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ executeQuery: vi.fn(), cancelQuery: vi.fn(), ensureConnected: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: (...args: unknown[]) => mocks.executeQuery(...args), cancelQuery: (...args: unknown[]) => mocks.cancelQuery(...args) }));
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

const result = (columns: string[], rows: QueryResult["rows"]): QueryResult => ({ columns, rows, affected_rows: 0, execution_time_ms: 0 });
const object = (name = "程序.T") => result(["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "STATUS", "OBJECT_ID", "LAST_DDL_TIME"], [["Mixed.Owner", name, "PROCEDURE", "INVALID", "123", "2026-10-09 10:00:00"]]);
const errors = () => result(["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE", "MESSAGE_NUMBER"], [[1, 2, 4, "中文错误\n详细说明", "ERROR", 6550]]);
let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;

function mount() {
  const props = reactive({ connection: { id: "oracle-a", name: "Oracle A", db_type: "oracle", database: "svc" } as ConnectionConfig });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(OracleInvalidObjects, props) }));
  app.use(createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: {} } }));
  app.mount(root);
  return props;
}
async function settle() {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function click(label: string) {
  const button = Array.from(root.querySelectorAll("button")).find((entry) => entry.textContent?.includes(label));
  expect(button).toBeDefined();
  button!.click();
  await settle();
}
const writes = () => mocks.executeQuery.mock.calls.filter((args) => String(args[2]).startsWith("ALTER "));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.cancelQuery.mockReset().mockResolvedValue(true);
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.guard.mockReset().mockImplementation((options) => options.execute());
  mocks.executeQuery.mockReset().mockImplementation(async (_id, _database, sql: string) => {
    if (sql.includes("FROM ALL_ERRORS")) return errors();
    if (sql.includes("FROM ALL_SOURCE")) return result(["LINE", "TEXT"], [[1, "PROCEDURE T AS\n甲乙丙丁\nEND;\n"]]);
    if (sql.startsWith("ALTER ")) return result([], []);
    return object();
  });
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  vi.unstubAllGlobals();
});

describe("OracleInvalidObjects production panel", () => {
  it("loads objects over HTTP without crypto.randomUUID and cancels the generated query id", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    mocks.executeQuery.mockImplementation(() => new Promise<QueryResult>(() => {}));
    mount();
    await settle();
    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
    const id = mocks.executeQuery.mock.calls[0][4];
    expect(id).toMatch(/^oracle-invalid-[0-9a-f-]{36}$/);
    await click("Cancel");
    expect(mocks.cancelQuery).toHaveBeenCalledWith(id);
  });

  it("only reads on load, refresh, source navigation and cancelled preview", async () => {
    mount();
    await settle();
    await click("Refresh");
    await click("程序.T");
    expect(root.textContent).toContain("中文错误");
    await click("中文错误");
    expect(root.querySelector('[data-source-line="2"] mark')?.textContent).toBe("丁");
    await click("Preview compile");
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('ALTER PROCEDURE "Mixed.Owner"."程序.T" COMPILE');
    await click("Cancel");
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(writes()).toHaveLength(0);
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("reads back INVALID after a successful request and retains the earlier errors", async () => {
    mount();
    await settle();
    await click("程序.T");
    await click("Preview compile");
    await click("Compile this object");
    expect(writes()).toHaveLength(1);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("still INVALID");
    expect(root.textContent).toContain("Errors before compile");
    expect(root.textContent).not.toContain("Readback confirmed VALID");
  });

  it("does not dispatch after the production guard declines", async () => {
    mocks.guard.mockResolvedValue(undefined);
    mount();
    await settle();
    await click("程序.T");
    await click("Preview compile");
    await click("Compile this object");
    expect(mocks.guard).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it("discards old read results after switching connections", async () => {
    let resolve!: (value: QueryResult) => void;
    mocks.executeQuery.mockImplementation((id: string) =>
      id === "oracle-a"
        ? new Promise<QueryResult>((accept) => {
            resolve = accept;
          })
        : Promise.resolve(object("NEW")),
    );
    const props = mount();
    await settle();
    props.connection = { ...props.connection, id: "oracle-b" };
    await settle();
    resolve(object("OLD"));
    await settle();
    expect(root.textContent).toContain("NEW");
    expect(root.textContent).not.toContain("OLD");
  });

  it("does not send an old preview after changing connections while confirmation is pending", async () => {
    let approve!: () => Promise<unknown>;
    let release!: (value: unknown) => void;
    mocks.guard.mockImplementation((options) => {
      approve = options.execute;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const props = mount();
    await settle();
    await click("程序.T");
    await click("Preview compile");
    await click("Compile this object");
    props.connection = { ...props.connection, id: "oracle-b" };
    await settle();
    release(await approve());
    await settle();
    expect(writes()).toHaveLength(0);
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(mocks.executeQuery.mock.calls.some((args) => args[0] === "oracle-b")).toBe(true);
  });
});
