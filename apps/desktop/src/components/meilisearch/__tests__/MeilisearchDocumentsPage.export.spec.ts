// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchDocuments: vi.fn(),
  fetchDocuments: vi.fn(),
  getIndexSettings: vi.fn(),
  saveTextFile: vi.fn(),
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

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@lucide/vue", () => ({
  ArrowDown: passthrough("span"),
  ArrowUp: passthrough("span"),
  Braces: passthrough("span"),
  ChevronLeft: passthrough("span"),
  ChevronRight: passthrough("span"),
  Copy: passthrough("span"),
  Download: passthrough("span"),
  LayoutGrid: passthrough("span"),
  LoaderCircle: passthrough("span"),
  Pencil: passthrough("span"),
  Save: passthrough("span"),
  Search: passthrough("span"),
  Table2: passthrough("span"),
  Trash2: passthrough("span"),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
vi.mock("@/components/ui/input", () => ({ Input: passthrough("input") }));
vi.mock("@/components/ui/label", () => ({ Label: passthrough("label") }));
vi.mock("@/components/ui/switch", () => ({ Switch: passthrough("div") }));
vi.mock("@/components/ui/popover", () => ({
  Popover: passthrough("div"),
  PopoverAnchor: passthrough("div"),
  PopoverContent: passthrough("div"),
  PopoverTrigger: passthrough("div"),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: passthrough("div"),
  DialogContent: passthrough("div"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/ui/ErrorBanner.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/QueryLoadingState.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/JsonTree.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/redis/RedisJsonEditor.vue", () => ({ default: passthrough("div") }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/export/saveTextFile", () => ({
  saveTextFile: mocks.saveTextFile,
  compactLocalTimestamp: () => "20260101-000000",
  sanitizeExportBaseName: (value: string) => value,
}));
vi.mock("@/lib/backend/api", () => ({
  meilisearchSearchDocuments: mocks.searchDocuments,
  meilisearchFetchDocuments: mocks.fetchDocuments,
  meilisearchGetIndexSettings: mocks.getIndexSettings,
}));

import MeilisearchDocumentsPage from "@/components/meilisearch/MeilisearchDocumentsPage.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  mocks.getIndexSettings.mockResolvedValue({});
  mocks.saveTextFile.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

describe("MeilisearchDocumentsPage export", () => {
  it("uses full-document pagination instead of capped displayed search hits", async () => {
    const batch = (size: number, from: number) => Array.from({ length: size }, (_, index) => ({ movie_id: from + index, title: `Movie ${from + index}`, internal_notes: `note ${from + index}` }));
    mocks.searchDocuments.mockResolvedValue({
      hits: [{ id: 0, document: { movie_id: 0, title: "Movie 0" } }],
      totalHits: 1000,
      processingTimeMs: 1,
    });
    mocks.fetchDocuments.mockImplementation((_connectionId: string, _index: string, params: { limit: number; offset: number }) => {
      if (params.offset === 0) return Promise.resolve({ documents: batch(1000, 0), total: 1300 });
      if (params.offset === 1000) return Promise.resolve({ documents: batch(300, 1000), total: 1300 });
      return Promise.resolve({ documents: [], total: 1300 });
    });

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(MeilisearchDocumentsPage, { connectionId: "c1", index: "movies" });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.searchDocuments).toHaveBeenCalledTimes(1));
    await nextTick();

    const exportButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("meilisearch.exportResults"));
    expect(exportButton?.textContent).toContain("1000");
    exportButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.saveTextFile).toHaveBeenCalledTimes(1));

    expect(mocks.searchDocuments).toHaveBeenCalledTimes(1);
    const offsets = mocks.fetchDocuments.mock.calls.map((call) => (call[2] as { offset: number }).offset);
    expect(offsets).toEqual([0, 1000]);

    const [content, fileName] = mocks.saveTextFile.mock.calls[0] as [string, string];
    expect(fileName).toBe("movies-20260101-000000.json");
    const exported = JSON.parse(content) as Array<Record<string, unknown>>;
    expect(exported).toHaveLength(1300);
    // Exported entries are the stored documents, without search metadata.
    expect(exported[0]).toEqual({ movie_id: 0, title: "Movie 0", internal_notes: "note 0" });
    expect(exported[1299]).toEqual({ movie_id: 1299, title: "Movie 1299", internal_notes: "note 1299" });
  });
});
