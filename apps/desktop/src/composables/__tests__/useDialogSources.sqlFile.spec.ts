// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import type { SqlFilePreview } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  store: {
    connections: [],
    sqlFileSource: null as { connectionId: string; database: string; filePath?: string; preview?: SqlFilePreview } | null,
  },
}));
vi.mock("@/stores/connectionStore", async () => {
  const { reactive } = await import("vue");
  mocks.store = reactive(mocks.store);
  return { useConnectionStore: () => mocks.store };
});
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useDialogSources } from "@/composables/useDialogSources";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it("hands prepared Web previews to the dialog, clears them on close, and preserves desktop paths", async () => {
  let dialogs!: ReturnType<typeof useDialogSources>;
  app = createApp(
    defineComponent({
      setup() {
        dialogs = useDialogSources();
        return () => h("div");
      },
    }),
  );
  app.mount(document.body.appendChild(document.createElement("div")));
  const preview = { fileName: "backup.sql", filePath: "/server/tmp/sql_file/restore-token/backup.sql", preview: "SELECT 1;", sizeBytes: 9, canExecuteWithoutSelectedDatabase: true, cleanupToken: "restore-token" };
  mocks.store.sqlFileSource = { connectionId: "mysql", database: "app", preview };
  await nextTick();
  expect(dialogs.showSqlFileDialog.value).toBe(true);
  expect(dialogs.sqlFilePrefillPreview.value).toEqual(preview);
  expect(dialogs.sqlFilePrefillFilePath.value).toBe("");
  expect(mocks.store.sqlFileSource).toBeNull();
  dialogs.showSqlFileDialog.value = false;
  await nextTick();
  expect(dialogs.sqlFilePrefillPreview.value).toBeUndefined();
  mocks.store.sqlFileSource = { connectionId: "mysql", database: "app", filePath: "/local/backup.sql" };
  await nextTick();
  expect(dialogs.sqlFilePrefillFilePath.value).toBe("/local/backup.sql");
  expect(dialogs.sqlFilePrefillPreview.value).toBeUndefined();
});
