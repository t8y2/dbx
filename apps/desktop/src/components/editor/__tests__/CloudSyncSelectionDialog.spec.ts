// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SyncSnapshotCatalog } from "@/lib/backend/api";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogDescription: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

import CloudSyncSelectionDialog from "@/components/editor/CloudSyncSelectionDialog.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

const catalog: SyncSnapshotCatalog = {
  exportedAt: "2026-09-29T00:00:00.000Z",
  appVersion: "0.6.27",
  hasEncryptedSecrets: false,
  connections: [{ id: "connection-1", label: "Local database" }],
  connectionSecrets: [],
  tunnelProfiles: [],
  tunnelSecrets: [],
  savedSqlFolders: [],
  savedSqlFiles: [],
  desktopSettings: [],
  editorSettings: [],
  aiConfigs: [],
  aiConfigsLocked: false,
  pluginUiStorage: [],
  pluginUiStorageLocked: false,
  hasSidebarLayout: false,
  hasPinnedTreeNodeIds: false,
};

describe("CloudSyncSelectionDialog", () => {
  it("emits the selected content when confirming a WebDAV backup", async () => {
    const onConfirm = vi.fn();
    const errors: unknown[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup() {
          return () => h(CloudSyncSelectionDialog, { open: true, mode: "upload", catalog, onConfirm });
        },
      }),
    );
    app.config.errorHandler = (error) => errors.push(error);
    app.use(i18n);
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    const confirm = [...container.querySelectorAll("button")].at(-1);
    confirm?.click();
    await nextTick();

    expect(errors).toEqual([]);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ connections: ["connection-1"], includeSecrets: false });
  });
});
