// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/types/database";

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  return {
    ...(await vi.importActual<typeof import("vue-i18n")>("vue-i18n")),
    useI18n: () => ({ t: (key: string) => key, locale: ref("en") }),
  };
});
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tabs: [], openDatabaseKeys: new Set() }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({ allFiles: [], getFile: vi.fn() }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/api", () => ({
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  listEventTriggers: vi.fn().mockResolvedValue([]),
}));

let emitFilter: (node: TreeNode) => void;
const RuntimeHost = defineComponent({
  name: "SidebarTreeRuntimeHost",
  emits: ["open-table-name-filters"],
  setup: (_props, { emit }) => {
    emitFilter = (node) => emit("open-table-name-filters", node);
    return () => h("div");
  },
});
const Dialog = defineComponent({
  name: "Dialog",
  props: { open: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      h("div", props.open ? slots.default?.() : undefined),
});

describe("catalogless sidebar name filter dialog", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.doMock("../SidebarTreeRuntimeHost.vue", () => ({ default: RuntimeHost }));
    vi.doMock("../SidebarTableVGroupDialog.vue", () => ({ default: defineComponent({ render: () => h("div") }) }));
    const content = defineComponent({
      setup:
        (_props, { slots }) =>
        () =>
          h("div", slots.default?.()),
    });
    vi.doMock("@/components/ui/dialog", () => ({
      Dialog,
      DialogContent: content,
      DialogHeader: content,
      DialogTitle: content,
      DialogDescription: content,
      DialogFooter: content,
    }));
  });

  it.each(["", "HXE", undefined])("opens view filters only for an existing HANA database context '%s'", async (database) => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { default: ConnectionTree } = await import("../ConnectionTree.vue");
    const store = useConnectionStore();
    const node: TreeNode = {
      id: `hana:${database}:_SYS_BIC:__views`,
      label: "tree.views",
      type: "group-views",
      connectionId: "hana",
      database,
      schema: "_SYS_BIC",
    };
    const scope = store.tableNameFilterScopeKey({ connectionId: "hana", database, schema: "_SYS_BIC", nodeKind: "group-views" });
    store.sidebarTableNameFilters[scope] = { includePatterns: ["package/%"], excludePatterns: ["%old%"] };
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(ConnectionTree);
    app.mount(container);
    try {
      expect(container.querySelectorAll("textarea")).toHaveLength(0);
      emitFilter(node);
      await nextTick();
      const fields = container.querySelectorAll("textarea");
      if (database == null) {
        expect(fields).toHaveLength(0);
        return;
      }
      expect(fields).toHaveLength(2);
      expect(fields[0].value).toBe("package/%");
      expect(fields[1].value).toBe("%old%");
    } finally {
      app.unmount();
      container.remove();
    }
  });
});
