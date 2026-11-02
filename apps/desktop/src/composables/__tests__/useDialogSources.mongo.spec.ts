// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const store = reactive({
  connections: [],
  mongoImportSource: null as { connectionId: string; database: string; collection: string } | null,
  transferSource: null,
  schemaDiffSource: null,
  dataCompareSource: null,
  sqlFileSource: null,
  diagramSource: null,
  docsSource: null,
  tableImportSource: null,
  tableDataGenerateSource: null,
  fieldLineageSource: null,
  databaseSearchSource: null,
  databaseExportSource: null,
});

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => store }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useDialogSources } from "@/composables/useDialogSources";

const mountedApps: App[] = [];
let dialogs: ReturnType<typeof useDialogSources>;

async function mountDialogs() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        dialogs = useDialogSources();
        return () => h("div");
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

describe("useDialogSources mongo import/export", () => {
  beforeAll(async () => {
    await mountDialogs();
  });

  afterAll(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
  });

  it("opens the mongo import dialog from a collection source", async () => {
    store.mongoImportSource = { connectionId: "c1", database: "shop", collection: "orders" };
    await nextTick();
    expect(dialogs.showMongoImportDialog.value).toBe(true);
    expect(dialogs.mongoImportPrefillCollection.value).toBe("orders");
    expect(store.mongoImportSource).toBeNull();
  });
});
