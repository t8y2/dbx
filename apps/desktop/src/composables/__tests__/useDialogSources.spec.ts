// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  store: {
    connections: [] as ConnectionConfig[],
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
    readImportFile: vi.fn(),
    parseConnectionsImport: vi.fn(),
    applyConnectionsImport: vi.fn(),
    applyDataGripKeychainPasswords: vi.fn(),
    exportConnectionsToFile: vi.fn(),
  },
}));

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { useDialogSources } from "@/composables/useDialogSources";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  vi.clearAllMocks();
});

function conn(id: string): ConnectionConfig {
  return { id, name: "Imported", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "secret" };
}

async function mountDialogs() {
  let dialogs!: ReturnType<typeof useDialogSources>;
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
  return dialogs;
}

describe("useDialogSources", () => {
  it("runs the final import confirmation as a single flight", async () => {
    let resolveApply!: (value: { count: number }) => void;
    const applyPromise = new Promise<{ count: number }>((resolve) => {
      resolveApply = resolve;
    });
    mocks.store.readImportFile.mockResolvedValue({ content: "{}", encrypted: false });
    mocks.store.parseConnectionsImport.mockResolvedValue({ connections: [conn("imported")] });
    mocks.store.applyConnectionsImport.mockReturnValue(applyPromise);

    const dialogs = await mountDialogs();
    await dialogs.onImportClick("dbx");
    dialogs.onConfigConnectionSelectConfirm(["imported"]);
    dialogs.onConfigConnectionSelectConfirm(["imported"]);

    expect(mocks.store.applyConnectionsImport).toHaveBeenCalledTimes(1);

    resolveApply({ count: 1 });
    await applyPromise;
    await nextTick();
  });
});
