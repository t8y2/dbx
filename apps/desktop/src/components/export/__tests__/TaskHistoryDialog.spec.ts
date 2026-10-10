// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TaskRun, TaskRunPage } from "@/lib/backend/tauri";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean, variant: String, size: String },
      emits: ["click"],
      setup(props, { slots, emit, attrs }) {
        return () => h("button", { ...attrs, disabled: props.disabled, onClick: (event: MouseEvent) => emit("click", event) }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...original, loadTaskRuns: vi.fn() };
});

import TaskHistoryDialog from "@/components/export/TaskHistoryDialog.vue";
import * as api from "@/lib/backend/api";

const loadTaskRuns = vi.mocked(api.loadTaskRuns);
const mountedApps: App[] = [];

function run(runId: string, overrides: Partial<TaskRun> = {}, database = "shop"): TaskRun {
  return {
    runId,
    taskType: "transfer",
    lifecycleOwner: "tauri",
    status: "succeeded",
    createdAt: "2025-03-05T10:00:00.000Z",
    startedAt: "2025-03-05T10:00:00.000Z",
    finishedAt: "2025-03-05T10:00:04.000Z",
    ownerInstanceId: "instance-1",
    errorCode: null,
    safeErrorSummary: null,
    historyComplete: true,
    source: { connectionId: "src", databaseType: "mysql", database, schema: "" },
    target: { connectionId: "dst", databaseType: "postgres", database: "warehouse", schema: "public" },
    ...overrides,
  };
}

function page(items: TaskRun[], nextCursor: TaskRunPage["nextCursor"] = null): TaskRunPage {
  return { items, nextCursor };
}

function localMidnightIso(year: number, month: number, day: number): string {
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await nextTick();
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountDialog(open = true): Promise<{ emitted: Record<string, unknown[]> }> {
  i18n.global.locale.value = "en";
  const emitted: Record<string, unknown[]> = { "open-run": [], "update:open": [] };
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(TaskHistoryDialog, {
            open,
            "onUpdate:open": (value: boolean) => emitted["update:open"].push(value),
            "onOpen-run": (runId: string) => emitted["open-run"].push(runId),
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await settle();
  return { emitted };
}

function inputByLabel(label: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing input labelled ${label}`);
  return element;
}

function selectByLabel(label: string): HTMLSelectElement {
  const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing select labelled ${label}`);
  return element;
}

async function setInputValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  element.value = value;
  element.dispatchEvent(new Event("input"));
  element.dispatchEvent(new Event("change"));
  await nextTick();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

async function submitFilters(): Promise<void> {
  const form = document.querySelector("form");
  if (!form) throw new Error("Missing filter form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  loadTaskRuns.mockReset();
  loadTaskRuns.mockResolvedValue(page([]));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TaskHistoryDialog", () => {
  it("loads persisted transfer history when it opens and renders the saved endpoints", async () => {
    loadTaskRuns.mockResolvedValue(page([run("run-1")]));

    await mountDialog();

    expect(loadTaskRuns).toHaveBeenCalledWith({ taskType: "transfer", limit: 30, cursor: undefined });
    expect(document.body.textContent).toContain("mysql · shop");
    expect(document.body.textContent).toContain("postgres · warehouse");
    expect(document.body.textContent).toContain("Succeeded");
  });

  it("keeps the whole local day inclusive and forwards trimmed endpoint and status filters", async () => {
    await mountDialog();

    await setInputValue(inputByLabel("Started from (local date)"), "2025-03-05");
    await setInputValue(inputByLabel("Started through (local date)"), "2025-03-06");
    await setInputValue(inputByLabel("Source connection / database"), "  app_users  ");
    await setInputValue(inputByLabel("Target connection / database"), "warehouse");
    await setInputValue(selectByLabel("Status"), "partial_failed");
    await submitFilters();

    expect(loadTaskRuns).toHaveBeenLastCalledWith({
      taskType: "transfer",
      limit: 30,
      cursor: undefined,
      startedAtFrom: localMidnightIso(2025, 3, 5),
      startedAtBefore: localMidnightIso(2025, 3, 7),
      sourceQuery: "app_users",
      targetQuery: "warehouse",
      status: "partial_failed",
    });
  });

  it("rejects an inverted date range locally instead of sending it to the backend", async () => {
    await mountDialog();
    const callsAfterOpen = loadTaskRuns.mock.calls.length;

    await setInputValue(inputByLabel("Started from (local date)"), "2025-03-07");
    await setInputValue(inputByLabel("Started through (local date)"), "2025-03-05");
    await submitFilters();

    expect(loadTaskRuns.mock.calls.length).toBe(callsAfterOpen);
    expect(document.body.textContent).toContain("The start date must not be after the end date.");
  });

  it("clears every filter and reloads the unfiltered first page", async () => {
    await mountDialog();

    await setInputValue(inputByLabel("Source connection / database"), "shop");
    await setInputValue(selectByLabel("Status"), "failed");
    await submitFilters();
    expect(loadTaskRuns).toHaveBeenLastCalledWith(expect.objectContaining({ sourceQuery: "shop", status: "failed" }));

    buttonByText("Clear").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(loadTaskRuns).toHaveBeenLastCalledWith({ taskType: "transfer", limit: 30, cursor: undefined });
    expect(inputByLabel("Source connection / database").value).toBe("");
    expect(selectByLabel("Status").value).toBe("");
  });

  it("loads the next page through the returned cursor without dropping earlier runs", async () => {
    loadTaskRuns.mockResolvedValueOnce(page([run("run-1")], { createdAt: "2025-03-05T10:00:00.000Z", runId: "run-1" })).mockResolvedValueOnce(page([run("run-2", {}, "shop2")]));

    await mountDialog();
    expect(document.body.textContent).toContain("Loaded 1 run(s)");
    expect(document.body.textContent).toContain("mysql · shop");

    buttonByText("Load more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(loadTaskRuns).toHaveBeenLastCalledWith({
      taskType: "transfer",
      limit: 30,
      cursor: { createdAt: "2025-03-05T10:00:00.000Z", runId: "run-1" },
    });
    expect(document.body.textContent).toContain("Loaded 2 run(s)");
    expect(document.body.textContent).toContain("mysql · shop");
    expect(document.body.textContent).toContain("mysql · shop2");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Load more")).toBe(false);
  });

  it("separates the empty-store message from the no-filter-match message", async () => {
    await mountDialog();
    expect(document.body.textContent).toContain("No persisted transfer history");
    expect(document.body.textContent).not.toContain("No task history matches these filters");

    loadTaskRuns.mockResolvedValue(page([]));
    await setInputValue(inputByLabel("Source connection / database"), "missing");
    await submitFilters();

    expect(document.body.textContent).toContain("No task history matches these filters");
  });

  it("keeps history visible when a later page fails and retries the same query", async () => {
    loadTaskRuns
      .mockResolvedValueOnce(page([run("run-1")], { createdAt: "2025-03-05T10:00:00.000Z", runId: "run-1" }))
      .mockRejectedValueOnce(new Error("storage offline"))
      .mockResolvedValueOnce(page([run("run-2", {}, "shop2")]));

    await mountDialog();
    buttonByText("Load more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    // The already-loaded run survives a failed next page instead of being replaced by the error state.
    expect(document.body.textContent).toContain("Loaded 1 run(s)");
    expect(document.body.textContent).toContain("mysql · shop");
    expect(document.body.textContent).toContain("Could not load task history.");

    buttonByText("Retry").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(document.body.textContent).toContain("mysql · shop2");
  });

  it("asks the parent to open the selected run and closes itself", async () => {
    loadTaskRuns.mockResolvedValue(page([run("run-1")]));

    const { emitted } = await mountDialog();
    const row = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("mysql · shop"));
    expect(row).toBeDefined();
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(emitted["open-run"]).toEqual(["run-1"]);
    expect(emitted["update:open"]).toEqual([false]);
  });

  it("does not request history while closed", async () => {
    await mountDialog(false);

    expect(loadTaskRuns).not.toHaveBeenCalled();
  });
});
