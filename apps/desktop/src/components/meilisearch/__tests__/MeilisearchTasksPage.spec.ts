// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTasks: vi.fn(),
  getTask: vi.fn(),
  cancelTasks: vi.fn(),
  deleteTasks: vi.fn(),
  listIndexes: vi.fn(),
  toast: vi.fn(),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

function inputComponent(): Component {
  return defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: [String, Number], default: "" } },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () => h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
    },
  });
}

function selectComponent(): Component {
  return defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: String, default: "" }, disabled: Boolean },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit, slots }) {
      return () => h("select", { ...attrs, disabled: props.disabled, value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) }, slots.default?.());
    },
  });
}

function fragmentComponent(): Component {
  return defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
}

function selectItemComponent(): Component {
  return defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      return () => h("option", { value: props.value }, slots.default?.());
    },
  });
}

function confirmDialog(): Component {
  return defineComponent({
    inheritAttrs: false,
    emits: ["confirm", "update:open"],
    setup(_, { attrs, emit }) {
      return () => (attrs.open ? h("button", { "data-confirm": "", "data-message": String(attrs.message), "data-selector": String(attrs.details), onClick: () => emit("confirm") }, "confirm") : null);
    },
  });
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ locale: ref("zh-CN"), t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));
vi.mock("@lucide/vue", () => ({
  ArrowDown: passthrough("span"),
  ArrowUp: passthrough("span"),
  Ban: passthrough("span"),
  ChevronLeft: passthrough("span"),
  ChevronRight: passthrough("span"),
  Eye: passthrough("span"),
  Loader2: passthrough("span"),
  RefreshCcw: passthrough("span"),
  Search: passthrough("span"),
  Settings2: passthrough("span"),
  Trash2: passthrough("span"),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/input", () => ({ Input: inputComponent() }));
vi.mock("@/components/ui/select", () => ({ Select: selectComponent(), SelectContent: fragmentComponent(), SelectItem: selectItemComponent(), SelectTrigger: fragmentComponent(), SelectValue: defineComponent({ setup: () => () => null }) }));
vi.mock("@/components/ui/popover", () => ({ Popover: passthrough("div"), PopoverContent: passthrough("div"), PopoverTrigger: passthrough("div") }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: passthrough("div"), DialogContent: passthrough("div"), DialogFooter: passthrough("div"), DialogHeader: passthrough("div"), DialogTitle: passthrough("div") }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: confirmDialog() }));
vi.mock("@/components/ui/ErrorBanner.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/QueryLoadingState.vue", () => ({ default: passthrough("div") }));
vi.mock("@/lib/backend/api", () => ({
  meilisearchGetTasks: mocks.getTasks,
  meilisearchGetTask: mocks.getTask,
  meilisearchCancelTasks: mocks.cancelTasks,
  meilisearchDeleteTasks: mocks.deleteTasks,
  meilisearchListIndexes: mocks.listIndexes,
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ read_only: false }) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import MeilisearchTasksPage from "@/components/meilisearch/MeilisearchTasksPage.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  localStorage.removeItem("dbx:meilisearch:task-columns:v1");
  mocks.getTasks.mockResolvedValue({ results: [], total: 7, limit: 20, from: null, next: null });
  mocks.getTask.mockResolvedValue({ uid: 1, indexUid: "movies", status: "failed", type: "futureType", enqueuedAt: "2026-01-01T00:00:00Z" });
  mocks.cancelTasks.mockImplementation(() => new Promise(() => {}));
  mocks.listIndexes.mockResolvedValue(["movies", "books"]);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

async function mountPage(props: { fixedIndexUid?: string } = {}) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(MeilisearchTasksPage, { connectionId: "c1", ...props });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(1));
  await nextTick();
  return root;
}

function setInput(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(input: HTMLInputElement) {
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
}

function setSelect(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("MeilisearchTasksPage mutation safety", () => {
  it("counts, displays, and submits the same frozen selector for a single task", async () => {
    mocks.getTasks.mockResolvedValueOnce({ results: [{ uid: 9, indexUid: "movies", status: "processing", type: "futureType", enqueuedAt: "2026-01-01T00:00:00Z" }], total: 1, limit: 20, from: null, next: null });
    const container = await mountPage();

    mocks.getTasks.mockResolvedValueOnce({ results: [], total: 2, limit: 1, from: null, next: null });
    container.querySelector<HTMLButtonElement>('button[title="meilisearch.cancelTask"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(2));

    const frozen = { uids: [9], statuses: ["enqueued", "processing"] };
    expect(mocks.getTasks).toHaveBeenLastCalledWith("c1", { selector: frozen, from: null, limit: 1 });
    await vi.waitFor(() => expect(container.querySelector("[data-confirm]")).not.toBeNull());
    const confirm = container.querySelector<HTMLButtonElement>("[data-confirm]")!;
    expect(confirm.dataset.selector).toBe(JSON.stringify(frozen, null, 2));
    expect(confirm.dataset.message).toContain('"count":2');

    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.cancelTasks).toHaveBeenCalledTimes(1));
    expect(mocks.cancelTasks).toHaveBeenCalledWith("c1", frozen);
  });

  it("blocks another task mutation while its management task is still being polled", async () => {
    mocks.getTasks.mockResolvedValueOnce({
      results: [
        { uid: 9, indexUid: "movies", status: "processing", type: "futureType", enqueuedAt: "2026-01-01T00:00:00Z" },
        { uid: 10, indexUid: "movies", status: "processing", type: "futureType", enqueuedAt: "2026-01-01T00:00:00Z" },
      ],
      total: 2,
      limit: 20,
      from: null,
      next: null,
    });
    mocks.cancelTasks.mockResolvedValueOnce({ taskUid: 99, indexUid: null, status: "enqueued", type: "taskCancelation", enqueuedAt: "2026-01-01T00:00:00Z" });
    const container = await mountPage();

    mocks.getTasks.mockResolvedValueOnce({ results: [], total: 1, limit: 1, from: null, next: null });
    container.querySelectorAll<HTMLButtonElement>('button[title="meilisearch.cancelTask"]')[0].click();
    await vi.waitFor(() => expect(container.querySelector("[data-confirm]")).not.toBeNull());
    container.querySelector<HTMLButtonElement>("[data-confirm]")!.click();
    await vi.waitFor(() => expect(mocks.cancelTasks).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => {
      const buttons = container.querySelectorAll<HTMLButtonElement>('button[title="meilisearch.cancelTask"]');
      expect(Array.from(buttons).every((button) => button.disabled)).toBe(true);
    });
  });

  it("runs a UID search only when the user presses Enter", async () => {
    const container = await mountPage();
    const input = container.querySelectorAll("input")[0] as HTMLInputElement;
    setInput(input, "9, 10");
    await nextTick();
    expect(mocks.getTasks).toHaveBeenCalledTimes(1);

    pressEnter(input);
    await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(2));
    expect(mocks.getTasks).toHaveBeenLastCalledWith("c1", { selector: { uids: [9, 10] }, from: null, limit: 20 });
  });

  it("loads accessible indexes and applies the selected index and status", async () => {
    const container = await mountPage();
    await vi.waitFor(() => expect(mocks.listIndexes).toHaveBeenCalledWith("c1"));
    const selects = container.querySelectorAll("select");
    expect(Array.from(selects[0].options).map((option) => option.value)).toEqual(["__all__", "books", "movies"]);

    setSelect(selects[0], "movies");
    await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(2));
    setSelect(selects[1], "succeeded");

    await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(3));
    expect(mocks.getTasks).toHaveBeenLastCalledWith("c1", {
      selector: { indexUids: ["movies"], statuses: ["succeeded"] },
      from: null,
      limit: 20,
    });
  });

  it("keeps compact filters visible and removes bulk actions and unsupported sorting", async () => {
    const container = await mountPage();
    expect(container.querySelector('input[aria-label="meilisearch.uidFilter"]')).not.toBeNull();
    expect(container.querySelector('input[placeholder="meilisearch.searchUid"]')).not.toBeNull();
    expect(container.textContent).not.toContain("meilisearch.cancelFilteredTasks");
    expect(container.textContent).not.toContain("meilisearch.deleteFilteredHistory");
    expect(container.querySelector('button[title="meilisearch.sortOldestFirst"]')).toBeNull();
    expect(container.querySelector('button[title="meilisearch.sortNewestFirst"]')).toBeNull();
    const reset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("meilisearch.resetFilters"));
    expect(reset?.parentElement?.className).toContain("items-center");
    expect(mocks.getTasks).toHaveBeenLastCalledWith("c1", { selector: {}, from: null, limit: 20 });
  });

  it("passes the fixed index to the backend task-detail guard", async () => {
    mocks.getTasks.mockResolvedValueOnce({ results: [{ uid: 1, indexUid: "movies", status: "failed", type: "futureType", enqueuedAt: "2026-01-01T00:00:00Z" }], total: 1, limit: 20, from: null, next: null });
    const container = await mountPage({ fixedIndexUid: "movies" });
    container.querySelector<HTMLButtonElement>('button[title="common.view"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.getTask).toHaveBeenCalledTimes(1));
    expect(mocks.getTask).toHaveBeenCalledWith("c1", 1, "movies");
  });

  it("renders task status, enqueue time, and duration in readable form", async () => {
    mocks.getTasks.mockResolvedValueOnce({
      results: [{ uid: 8, indexUid: "movies", status: "failed", type: "futureType", details: { receivedDocuments: 8, indexedDocuments: 8 }, enqueuedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:01Z", finishedAt: "2026-01-01T00:00:02Z", duration: "PT2.16344321S" }],
      total: 1,
      limit: 20,
      from: null,
      next: null,
    });
    const container = await mountPage();

    expect(container.textContent).toContain("❌ Failed");
    expect(container.textContent).toContain("meilisearch.receivedDocuments: 8 · meilisearch.indexedDocuments: 8");
    expect(container.textContent).toContain("meilisearch.startedAt");
    expect(container.textContent).toContain("meilisearch.finishedAt");
    expect(container.textContent).toContain("2.16");
    expect(container.textContent).not.toContain("PT2.16344321S");
    expect(container.textContent).not.toContain("2026-01-01T00:00:00Z");
    expect(container.querySelector('[data-testid="tasks-header"]')?.className).not.toContain("sticky");
    expect(container.querySelector('[data-testid="tasks-body"]')?.className).toContain("overflow-y-auto");
  });

  it("persists task column visibility changes", async () => {
    const container = await mountPage();
    expect(container.querySelector('[data-testid="tasks-header"] button[aria-label="meilisearch.columnSettings"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tasks-grid"]')?.className).toContain("overflow-hidden");
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(9);

    checkboxes[4].checked = false;
    checkboxes[4].dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    const stored = JSON.parse(localStorage.getItem("dbx:meilisearch:task-columns:v1") || "null");
    expect(stored.visible).not.toContain("details");
    expect(container.querySelector('[role="columnheader"][data-column="details"]')).toBeNull();
  });
});
