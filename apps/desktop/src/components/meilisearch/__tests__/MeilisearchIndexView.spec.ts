// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getIndexOverview: vi.fn() }));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ locale: ref("zh-CN"), t: (key: string) => key }),
}));
vi.mock("@lucide/vue", () => ({
  Copy: passthrough("span"),
  FileText: passthrough("span"),
  ListChecks: passthrough("span"),
  Settings: passthrough("span"),
}));
vi.mock("@/lib/backend/api", () => ({ meilisearchGetIndexOverview: mocks.getIndexOverview }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/tabs/tabUiState", () => ({ useTabUiState: () => ({ initialState: {}, track: () => {} }) }));
vi.mock("@/components/meilisearch/MeilisearchDocumentsPage.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/meilisearch/MeilisearchSettingsPage.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/meilisearch/MeilisearchTasksPage.vue", () => ({ default: passthrough("div") }));

import MeilisearchIndexView from "@/components/meilisearch/MeilisearchIndexView.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

async function mountIndexView() {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(MeilisearchIndexView, { connectionId: "c1", index: "report_template" });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.getIndexOverview).toHaveBeenCalledTimes(1));
  await nextTick();
  return root;
}

beforeEach(() => {
  mocks.getIndexOverview.mockReset();
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

describe("MeilisearchIndexView storage rows", () => {
  // Meilisearch >= 1.14 reports the index's own sizes, so the sidebar must show
  // them. Reporting the instance-wide `databaseSize` here made every index look
  // like it owned the whole instance (issue #9880).
  it("shows the index's own size instead of the instance-wide number", async () => {
    mocks.getIndexOverview.mockResolvedValue({
      uid: "report_template",
      primaryKey: "id",
      createdAt: "2026-09-21T06:30:00Z",
      updatedAt: "2026-09-21T06:30:46Z",
      numberOfDocuments: 256,
      isIndexing: false,
      documentSize: 309_329_920,
      avgDocumentSize: 1_208_320,
      databaseSize: 4_194_304_000,
    });

    const mounted = await mountIndexView();
    const text = mounted.textContent ?? "";

    expect(text).toContain("meilisearch.documentSize");
    expect(text).toContain("meilisearch.avgDocumentSize");
    expect(text).not.toContain("meilisearch.instanceDatabaseSize");
    expect(text).toContain("295.0 MB");
    expect(text).not.toContain("3.9 GB");
  });

  it("labels the instance-wide size as such on servers without per-index sizes", async () => {
    mocks.getIndexOverview.mockResolvedValue({
      uid: "report_template",
      primaryKey: "id",
      createdAt: null,
      updatedAt: null,
      numberOfDocuments: 256,
      isIndexing: false,
      documentSize: null,
      avgDocumentSize: null,
      databaseSize: 26_935_296,
    });

    const mounted = await mountIndexView();
    const text = mounted.textContent ?? "";

    expect(text).toContain("meilisearch.instanceDatabaseSize");
    expect(text).not.toContain("meilisearch.documentSize");
    expect(text).toContain("25.7 MB");
  });
});
