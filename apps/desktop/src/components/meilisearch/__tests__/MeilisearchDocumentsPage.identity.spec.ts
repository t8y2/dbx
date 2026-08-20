// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchDocuments: vi.fn(),
  getIndexSettings: vi.fn(),
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
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

/** Renders a confirm trigger while open, so tests drive the danger dialog. */
function confirmDialog(): Component {
  return defineComponent({
    inheritAttrs: false,
    emits: ["confirm", "update:open"],
    setup(_, { attrs, emit }) {
      return () => (attrs.open ? h("button", { "data-confirm-dialog": String(attrs.confirmLabel ?? ""), onClick: () => emit("confirm") }, "confirm") : null);
    },
  });
}

/** Editor stub that exposes the current model value as text for assertions. */
function jsonEditor(): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs }) {
      return () => h("pre", { "data-json-editor": "true" }, String(attrs.modelValue ?? ""));
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
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: confirmDialog() }));
vi.mock("@/components/ui/ErrorBanner.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/QueryLoadingState.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/JsonTree.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/redis/RedisJsonEditor.vue", () => ({ default: jsonEditor() }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/backend/api", () => ({
  meilisearchSearchDocuments: mocks.searchDocuments,
  meilisearchGetIndexSettings: mocks.getIndexSettings,
  meilisearchGetDocument: mocks.getDocument,
  documentDeleteDocument: mocks.deleteDocument,
}));

import MeilisearchDocumentsPage from "@/components/meilisearch/MeilisearchDocumentsPage.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  mocks.getIndexSettings.mockResolvedValue({});
  mocks.getDocument.mockResolvedValue('{"movie_id":"123","title":"Alien","internal_notes":"canonical only"}');
  mocks.deleteDocument.mockResolvedValue(1);
  // The search hit is partial: it lacks the `internal_notes` field.
  mocks.searchDocuments.mockResolvedValue({
    hits: [{ id: "123", document: { movie_id: "123", title: "Alien" } }],
    totalHits: 1,
    processingTimeMs: 1,
  });
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
  app = createApp(MeilisearchDocumentsPage, { connectionId: "c1", index: "movies" });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.searchDocuments).toHaveBeenCalledTimes(1));
  await nextTick();
  return root;
}

function findButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.title === title);
  if (!button) throw new Error(`button not found: ${title}`);
  return button;
}

describe("MeilisearchDocumentsPage identity and canonical documents", () => {
  it("serializes numeric-looking string ids with the store-id serializer on delete", async () => {
    const container = await mountPage();

    findButton(container, "meilisearch.deleteDocument").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const confirm = container.querySelector("[data-confirm-dialog]");
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.deleteDocument).toHaveBeenCalledTimes(1));
    // The string id "123" must not round-trip as numeric 123.
    expect(mocks.deleteDocument).toHaveBeenCalledWith("c1", "default", "movies", '__dbx_meilisearch_string_id__"123"');
  });

  it("edits the canonical document instead of the partial search hit", async () => {
    const container = await mountPage();

    findButton(container, "meilisearch.editDocument").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1));
    expect(mocks.getDocument).toHaveBeenCalledWith("c1", "movies", '__dbx_meilisearch_string_id__"123"');
    await vi.waitFor(() => {
      const editor = container.querySelector("[data-json-editor]");
      expect(editor?.textContent).toContain("internal_notes");
    });
    // The editor content comes from the canonical fetch, not the partial hit.
    const editor = container.querySelector("[data-json-editor]");
    expect(editor?.textContent).toContain('"title": "Alien"');
  });

  it("disables edit and delete when the hit has no identity", async () => {
    mocks.searchDocuments.mockResolvedValue({ hits: [{ document: { title: "No PK" } }], totalHits: 1, processingTimeMs: 1 });
    const container = await mountPage();

    expect(findButton(container, "meilisearch.editDocument").disabled).toBe(true);
    expect(findButton(container, "meilisearch.deleteDocument").disabled).toBe(true);
  });
});
