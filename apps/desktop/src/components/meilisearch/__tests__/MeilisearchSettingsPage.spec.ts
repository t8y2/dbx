// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteIndex: vi.fn(),
  getIndexSettings: vi.fn(),
  closeTab: vi.fn(),
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

/** Renders a confirm trigger while open, so tests drive the danger dialogs. */
function confirmDialog(): Component {
  return defineComponent({
    inheritAttrs: false,
    emits: ["confirm", "update:open"],
    setup(_, { attrs, emit }) {
      return () =>
        attrs.open
          ? h(
              "button",
              {
                "data-confirm-dialog": String(attrs.confirmLabel ?? ""),
                onClick: () => emit("confirm"),
              },
              "confirm",
            )
          : null;
    },
  });
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@lucide/vue", () => ({ Save: passthrough("span") }));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: confirmDialog() }));
vi.mock("@/components/ui/ErrorBanner.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/QueryLoadingState.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/JsonTree.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/redis/RedisJsonEditor.vue", () => ({ default: passthrough("div") }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/backend/api", () => ({
  meilisearchGetIndexSettings: mocks.getIndexSettings,
  meilisearchDeleteIndex: mocks.deleteIndex,
}));

const store = reactive({
  activeTabId: "tab-a" as string | null,
  tabs: [{ id: "tab-a" }] as Array<{ id: string }>,
  closeTab: mocks.closeTab,
});

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => store }));

import MeilisearchSettingsPage from "@/components/meilisearch/MeilisearchSettingsPage.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  store.activeTabId = "tab-a";
  store.tabs = [{ id: "tab-a" }];
  mocks.getIndexSettings.mockResolvedValue({});
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

async function mountPage(): Promise<HTMLDivElement> {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(MeilisearchSettingsPage, { connectionId: "c1", index: "movies" });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.getIndexSettings).toHaveBeenCalledTimes(1));
  await nextTick();
  return root;
}

async function confirmDeleteIndex(container: HTMLDivElement) {
  const deleteButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "meilisearch.deleteIndex");
  deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
  const confirmButton = container.querySelector("[data-confirm-dialog]");
  confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("MeilisearchSettingsPage index deletion", () => {
  it("closes the tab that started the delete even after switching tabs mid-flight", async () => {
    let resolveDelete!: () => void;
    mocks.deleteIndex.mockImplementation(() => new Promise<void>((resolve) => (resolveDelete = resolve)));

    const container = await mountPage();
    await confirmDeleteIndex(container);
    await vi.waitFor(() => expect(mocks.deleteIndex).toHaveBeenCalledTimes(1));

    // The user switches to another tab while the delete is in flight.
    store.tabs.push({ id: "tab-b" });
    store.activeTabId = "tab-b";

    resolveDelete();
    await vi.waitFor(() => expect(mocks.closeTab).toHaveBeenCalledTimes(1));

    expect(mocks.closeTab).toHaveBeenCalledWith("tab-a");
    expect(mocks.closeTab).not.toHaveBeenCalledWith("tab-b");
  });

  it("does not close anything when the owning tab is already gone", async () => {
    let resolveDelete!: () => void;
    mocks.deleteIndex.mockImplementation(() => new Promise<void>((resolve) => (resolveDelete = resolve)));

    const container = await mountPage();
    await confirmDeleteIndex(container);
    await vi.waitFor(() => expect(mocks.deleteIndex).toHaveBeenCalledTimes(1));

    // The user closed the tab themselves while the delete was in flight.
    store.tabs = [];
    store.activeTabId = null;

    resolveDelete();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("meilisearch.indexDeleted"));
    await nextTick();

    expect(mocks.closeTab).not.toHaveBeenCalled();
  });
});
