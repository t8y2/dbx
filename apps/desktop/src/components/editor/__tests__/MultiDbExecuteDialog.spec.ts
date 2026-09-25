// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import MultiDbExecuteDialog from "../MultiDbExecuteDialog.vue";
import type { MultiDbExecutionAdapter } from "@/composables/useMultiDbExecution";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/stores/sqlExecutionTargetGroupStore", () => ({ useSqlExecutionTargetGroupStore: () => ({ getGroupsByDatabaseType: () => [], getGroup: () => undefined }) }));
vi.mock("@/composables/useExportTracker", () => ({ formatDataTransferDuration: String, useExportTracker: () => ({ addMultiDbExecutionTask: vi.fn(), updateMultiDbExecutionTask: vi.fn(), registerTaskCancelHandler: vi.fn(), unregisterTaskCancelHandler: vi.fn() }) }));
vi.mock("@/composables/useMultiDbTargetSelection", () => ({
  useMultiDbTargetSelection: () => ({
    compatibleConnections: computed(() => []),
    connection: () => ({ id: "test", name: "Test", db_type: "oceanbase-oracle" }),
    loadConnection: vi.fn().mockResolvedValue(undefined),
    validateTarget: async () => ({ state: "valid" }),
    validateTargets: async (targets: unknown[]) => targets.map((target) => ({ target, state: "valid" })),
  }),
}));

let app: App | undefined;
const onOpenChange = vi.fn();
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  onOpenChange.mockClear();
});

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function openDialog(executeTarget: MultiDbExecutionAdapter["executeTarget"]) {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(MultiDbExecuteDialog, { open: true, "onUpdate:open": onOpenChange, sql: "INSERT INTO t VALUES (1)", sourceTabId: "source", databaseType: "oceanbase-oracle", initialTargets: [{ connectionId: "test", database: "test" }], launchId: 1, initialManualTransaction: true, executeTarget });
  app.use(createPinia());
  app.mount(root);
  await flushPromises();
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox?.checked).toBe(true);
  button("multiDbExecute.execute").click();
  await flushPromises();
}

function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}

describe("manual multi-database dialog", () => {
  it("shows pending changes, commits only on click, and clears transaction controls", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async () => ({ status: "pending_commit" as const, transaction: { canCommit: true, finish } }));
    await openDialog(execute);
    expect(execute.mock.calls[0][0].context.manualTransaction).toBe(true);
    expect(document.body.textContent).toContain("multiDbExecute.pendingCommit");
    expect(finish).not.toHaveBeenCalled();
    button("multiDbExecute.commit").click();
    await flushPromises();
    expect(finish).toHaveBeenCalledExactlyOnceWith("commit");
    expect([...document.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "multiDbExecute.commit")).toBe(false);
  });

  it("keeps the dialog open until pending changes are explicitly discarded", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await openDialog(vi.fn(async () => ({ status: "pending_commit" as const, transaction: { canCommit: true, finish } })));
    button("common.close").click();
    await flushPromises();
    expect(document.body.textContent).toContain("multiDbExecute.discardTitle");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    button("multiDbExecute.rollbackAndClose").click();
    await flushPromises();
    expect(finish).toHaveBeenCalledExactlyOnceWith("rollback");
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps rollback available after failed cleanup", async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await openDialog(vi.fn(async () => ({ status: "failed" as const, transaction: { canCommit: false, finish } })));
    expect(button("multiDbExecute.commit").disabled).toBe(true);
    button("multiDbExecute.rollback").click();
    await flushPromises();
    expect(document.body.textContent).toContain("offline");
    expect(button("multiDbExecute.rollback").disabled).toBe(false);
    button("multiDbExecute.rollback").click();
    await flushPromises();
    expect(document.body.textContent).toContain("multiDbExecute.rolledBack");
  });
});
