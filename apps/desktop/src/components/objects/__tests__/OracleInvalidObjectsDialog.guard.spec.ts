// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleInvalidObjectsDialog from "../OracleInvalidObjectsDialog.vue";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";

const mocks = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), unlockState: vi.fn(), unlock: vi.fn(), lock: vi.fn(), finished: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.query,
  closeClientConnectionSession: mocks.close,
  connectionWriteUnlockState: mocks.unlockState,
  unlockConnectionWrites: mocks.unlock,
  lockConnectionWrites: mocks.lock,
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(",")}` : key) }) }));

function passthrough(tag: string) {
  return defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        h(tag, attrs, slots.default?.()),
  });
}
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: passthrough("div"), DialogContent: passthrough("div"), DialogHeader: passthrough("div"), DialogTitle: passthrough("div"), DialogFooter: passthrough("div") }));

const connection = { id: "invalid-real-guard", name: "Oracle guard fixture", db_type: "oceanbase-oracle" as const, host: "localhost", port: 2883, username: "APP", password: "" };
let app: App<Element> | undefined;
let root: HTMLDivElement;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  setActivePinia(createPinia());
  const objects = [
    { name: "P_ONE", id: "101", status: "INVALID" },
    { name: "P_TWO", id: "102", status: "INVALID" },
  ];
  const columns = ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "LAST_DDL_TIME"];
  const time = "2026-10-20 09:00:00";
  mocks.query.mockReset().mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
    if (sql.includes("OBJECT_ID >") || sql.includes("FROM (SELECT OWNER")) {
      const cursor = BigInt(sql.match(/OBJECT_ID > (\d+)/)?.[1] ?? "0");
      return { columns, rows: objects.filter((object) => object.status === "INVALID" && BigInt(object.id) > cursor).map((object) => ["APP", object.name, "PROCEDURE", object.id, time]) };
    }
    if (sql.startsWith("ALTER ")) {
      const name = sql.match(/\."([^"]+)"/)?.[1];
      const object = objects.find((item) => item.name === name);
      if (object) object.status = "VALID";
      return { columns: [], rows: [] };
    }
    if (sql.includes("STATUS FROM ALL_OBJECTS")) {
      const name = sql.match(/OBJECT_NAME = '([^']+)'/)?.[1];
      const object = objects.find((item) => item.name === name);
      return { columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"], rows: object ? [[object.id, time, object.status]] : [] };
    }
    return { columns: [], rows: [] };
  });
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.unlockState.mockReset().mockResolvedValue(0);
  mocks.unlock.mockReset().mockResolvedValue(60_000);
  mocks.lock.mockReset().mockResolvedValue(undefined);
  mocks.finished.mockReset();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(async () => {
  app?.unmount();
  app = undefined;
  useReadOnlyUnlockStore().cancel();
  useProductionSafetyStore().cancel();
  await useReadOnlyUnlockStore().lockNow(connection.id);
  root.remove();
  setActivePinia(undefined);
  vi.restoreAllMocks();
});

async function mount(readOnly: boolean, production: boolean) {
  app = createApp({ render: () => h(OracleInvalidObjectsDialog, { open: true, connection: { ...connection, read_only: readOnly, is_production: production }, database: "ORCL", schema: "APP", onCompileFinished: mocks.finished }) });
  app.use(createPinia());
  app.mount(root);
  await vi.waitFor(() => expect(button("batchCompileAll")?.disabled).toBe(false));
}

function button(key: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((element) => element.textContent?.includes(key));
}

function writes(): string[] {
  return mocks.query.mock.calls.map((call) => String(call[2])).filter((sql) => sql.startsWith("ALTER "));
}

describe("invalid object actions through the real production execution guard", () => {
  it("rejects a real read-only request without submitting DDL", async () => {
    await mount(true, false);
    button("batchCompileAll")!.click();
    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending?.sql).toContain('"P_ONE"'));
    expect(writes()).toEqual([]);
    useReadOnlyUnlockStore().cancel();
    await vi.waitFor(() => expect(root.textContent).toContain("batchGuardDeclined"));
    expect(writes()).toEqual([]);
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.finished).not.toHaveBeenCalled();
  });

  it("uses one real read-only authorization for the complete frozen batch", async () => {
    await mount(true, false);
    button("batchCompileAll")!.click();
    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending).toBeTruthy());
    await useReadOnlyUnlockStore().confirm(60);
    await vi.waitFor(() => expect(mocks.finished).toHaveBeenCalledOnce());
    expect(writes()).toEqual(['ALTER PROCEDURE "APP"."P_ONE" COMPILE', 'ALTER PROCEDURE "APP"."P_TWO" COMPILE']);
    expect(mocks.unlock).toHaveBeenCalledExactlyOnceWith(connection.id, 60);
    expect(useProductionSafetyStore().pending).toBeUndefined();
  });

  it("rejects the real production confirmation with zero writes", async () => {
    await mount(false, true);
    button("batchCompileAll")!.click();
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toContain('"P_TWO"'));
    expect(writes()).toEqual([]);
    useProductionSafetyStore().cancel();
    await vi.waitFor(() => expect(root.textContent).toContain("batchGuardDeclined"));
    expect(writes()).toEqual([]);
    expect(mocks.finished).not.toHaveBeenCalled();
  });

  it("reviews and executes only the selected snapshot through the real production guard", async () => {
    await mount(false, true);
    root.querySelector<HTMLInputElement>('input[aria-label="P_ONE PROCEDURE"]')!.click();
    await nextTick();
    button("batchCompileSelected")!.click();
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeTruthy());
    expect(useProductionSafetyStore().pending!.sql).toBe('ALTER PROCEDURE "APP"."P_ONE" COMPILE');
    const unselected = root.querySelector<HTMLInputElement>('input[aria-label="P_TWO PROCEDURE"]')!;
    expect(unselected.disabled).toBe(true);
    unselected.click();
    useProductionSafetyStore().confirm();
    await vi.waitFor(() => expect(mocks.finished).toHaveBeenCalledOnce());
    expect(writes()).toEqual(['ALTER PROCEDURE "APP"."P_ONE" COMPILE']);
    expect(root.querySelector('button[aria-label="P_ONE PROCEDURE"]')).toBeNull();
    expect(root.querySelector('button[aria-label="P_TWO PROCEDURE"]')).toBeTruthy();
  });

  it("freezes the filtered complete scope and disables filters while production approval is pending", async () => {
    await mount(false, true);
    const filter = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = "p_one";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    button("batchCompileFiltered:1")!.click();
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeTruthy());
    expect(useProductionSafetyStore().pending!.sql).toBe('ALTER PROCEDURE "APP"."P_ONE" COMPILE');
    expect(filter.disabled).toBe(true);
    expect(button("filterTypes")!.disabled).toBe(true);
    expect(button("clearFilters")!.disabled).toBe(true);
    expect(writes()).toEqual([]);
    useProductionSafetyStore().confirm();
    await vi.waitFor(() => expect(mocks.finished).toHaveBeenCalledOnce());
    expect(writes()).toEqual(['ALTER PROCEDURE "APP"."P_ONE" COMPILE']);
    expect(filter.value).toBe("p_one");
    expect(root.textContent).toContain("noFilterMatches");
  });

  it("still requires production approval after read-only access has been granted", async () => {
    await mount(true, true);
    button("batchCompileAll")!.click();
    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending).toBeTruthy());
    expect(useProductionSafetyStore().pending).toBeUndefined();
    await useReadOnlyUnlockStore().confirm(60);
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeTruthy());
    expect(writes()).toEqual([]);
    useProductionSafetyStore().cancel();
    await vi.waitFor(() => expect(root.textContent).toContain("batchGuardDeclined"));
    expect(writes()).toEqual([]);
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });
});
