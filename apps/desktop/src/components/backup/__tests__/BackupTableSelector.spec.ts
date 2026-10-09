// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import BackupTableSelector from "../BackupTableSelector.vue";
import type { DatabaseBackupTableTarget, DatabaseBackupTableSelectionState } from "@/lib/backup/scheduledDatabaseBackup";

const apiMock = vi.hoisted(() => ({ listSchemas: vi.fn(), listTables: vi.fn() }));
vi.mock("@/lib/backend/api", () => apiMock);
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.resetAllMocks();
});
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
function mount(initial: DatabaseBackupTableTarget[] = []) {
  const scope = reactive({ connectionId: "source", databaseType: "postgres", databases: ["app"] });
  const selection = ref(initial);
  const states: DatabaseBackupTableSelectionState[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(BackupTableSelector, {
        ...scope,
        modelValue: selection.value,
        "onUpdate:modelValue": (value: DatabaseBackupTableTarget[]) => {
          selection.value = value;
        },
        onStateChange: (state: DatabaseBackupTableSelectionState) => states.push(state),
      }),
  });
  app.use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { scope, selection, states, container };
}
function button(container: HTMLElement, key: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((value) => value.textContent?.trim() === i18n.global.t(key))!;
}

describe("exact backup table selection", () => {
  it("selects literal wildcard/comma/dot names with their database and schema", async () => {
    apiMock.listSchemas.mockResolvedValue(["public", "audit", "pg_catalog", "information_schema"]);
    apiMock.listTables.mockImplementation(async (_id, _db, schema) => (schema === "public" ? [{ name: "odd*,name.with.dot" }] : [{ name: "same" }]));
    const { container, selection, states } = mount();
    await settle();
    expect(apiMock.listTables).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.ready).toBe(false);
    const row = container.querySelector<HTMLButtonElement>("[data-table-name]")!;
    const target = JSON.parse(row.getAttribute("data-table-name")!);
    row.click();
    await settle();
    expect(selection.value).toEqual([{ database: target[0], schema: target[1], table: target[2] }]);
    expect(states.at(-1)?.ready).toBe(true);
    button(container, "tableMultiSelect.selectAll").click();
    await settle();
    expect(selection.value).toHaveLength(2);
    expect(selection.value).toContainEqual({ database: "app", schema: "public", table: "odd*,name.with.dot" });
    button(container, "common.clear").click();
    await settle();
    expect(selection.value).toEqual([]);
    expect(states.at(-1)?.ready).toBe(false);
  });

  it("searches raw identifier text even when labels quote it", async () => {
    apiMock.listSchemas.mockResolvedValue(["public"]);
    apiMock.listTables.mockResolvedValue([{ name: 'a"b' }, ...Array.from({ length: 5 }, (_, index) => ({ name: `plain${index}` }))]);
    const { container, selection } = mount();
    await settle();
    const search = container.querySelector<HTMLInputElement>("input")!;
    search.value = 'a"b';
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const rows = container.querySelectorAll<HTMLButtonElement>("[data-table-name]");
    expect(rows).toHaveLength(1);
    rows[0].click();
    await settle();
    expect(selection.value).toEqual([{ database: "app", schema: "public", table: 'a"b' }]);
  });

  it("does not apply late metadata from a previous connection with the same database name", async () => {
    let resolveOld!: (rows: Array<{ name: string }>) => void;
    apiMock.listSchemas.mockResolvedValue(["public"]);
    apiMock.listTables.mockImplementation((id) =>
      id === "source"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve([{ name: "new_table" }]),
    );
    const { scope, selection, states, container } = mount([{ database: "app", schema: "public", table: "old_table" }]);
    await settle();
    scope.connectionId = "new-source";
    await settle();
    expect(selection.value).toEqual([]);
    expect(states.at(-1)?.ready).toBe(false);
    container.querySelector<HTMLButtonElement>("[data-table-name]")!.click();
    await settle();
    expect(selection.value).toEqual([{ database: "app", schema: "public", table: "new_table" }]);
    expect(states.at(-1)?.ready).toBe(true);
    resolveOld([{ name: "old_table" }]);
    await settle();
    expect(container.textContent).not.toContain("old_table");
    expect(selection.value[0].table).toBe("new_table");
    expect(JSON.parse(states.at(-1)!.scopeKey)[0]).toBe("new-source");
  });

  it("retains missing saved selections until explicitly removed and blocks execution", async () => {
    apiMock.listSchemas.mockResolvedValue(["public"]);
    apiMock.listTables.mockResolvedValue([{ name: "available" }]);
    const { container, selection, states } = mount([{ database: "app", schema: "public", table: "dropped" }]);
    await settle();
    expect(selection.value[0].table).toBe("dropped");
    expect(states.at(-1)?.ready).toBe(false);
    expect(container.textContent).toContain(i18n.global.t("databaseBackup.selectedTablesUnavailable"));
    container.querySelector<HTMLButtonElement>("button[aria-label]")!.click();
    await settle();
    expect(selection.value).toEqual([]);
    expect(states.at(-1)?.ready).toBe(false);
    container.querySelector<HTMLButtonElement>("[data-table-name]")!.click();
    await settle();
    expect(states.at(-1)?.ready).toBe(true);
  });

  it("blocks an unreadable catalog and clears selection without falling back to all tables", async () => {
    apiMock.listSchemas.mockRejectedValue(new Error("metadata unavailable"));
    const { container, selection, states } = mount([{ database: "app", schema: "public", table: "chosen" }]);
    await settle();
    expect(states.at(-1)?.ready).toBe(false);
    expect(container.textContent).toContain(i18n.global.t("databaseBackup.tableListLoadFailed"));
    expect(selection.value).toHaveLength(1);
    button(container, "common.clear").click();
    await settle();
    expect(selection.value).toEqual([]);
    expect(states.at(-1)?.ready).toBe(false);
  });
});
