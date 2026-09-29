// @vitest-environment happy-dom

import { createApp, defineComponent, h, isProxy, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncSelection, SyncSnapshotCatalog } from "@/lib/backend/api";

function passthrough(tag: string) {
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
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: defineComponent({
    props: { open: Boolean },
    setup(props, { slots }) {
      return () => (props.open ? h("div", slots.default?.()) : null);
    },
  }),
  DialogContent: passthrough("div"),
  DialogDescription: passthrough("div"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));

import CloudSyncSelectionDialog from "@/components/editor/CloudSyncSelectionDialog.vue";

const catalog: SyncSnapshotCatalog = {
  exportedAt: "2026-09-29T00:00:00Z",
  appVersion: "0.6.27",
  hasEncryptedSecrets: false,
  connections: [{ id: "connection-1", label: "Primary" }],
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

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
});

describe.each([
  ["restore", "settings.syncSelectionRestoreAction"],
  ["upload", "settings.syncSelectionUploadAction"],
] as const)("CloudSyncSelectionDialog %s confirmation", (mode, actionLabel) => {
  it("emits a detached plain selection and closes", async () => {
    const confirmed: SyncSelection[] = [];
    const openUpdates: boolean[] = [];

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(
      defineComponent({
        setup() {
          const open = ref(true);
          const reactiveCatalog = ref(catalog);
          return () =>
            h(CloudSyncSelectionDialog, {
              open: open.value,
              mode,
              catalog: reactiveCatalog.value,
              "onUpdate:open": (value: boolean) => {
                openUpdates.push(value);
                open.value = value;
              },
              onConfirm: (selection: SyncSelection) => confirmed.push(selection),
            });
        },
      }),
    );
    app.mount(root);
    await nextTick();

    const confirmButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === actionLabel);
    expect(confirmButton).toBeDefined();

    confirmButton?.click();
    await nextTick();

    expect(confirmed).toHaveLength(1);
    expect(isProxy(confirmed[0])).toBe(false);
    expect(() => structuredClone(confirmed[0])).not.toThrow();
    expect(confirmed[0]).toMatchObject({ connections: ["connection-1"] });
    expect(openUpdates).toEqual([false]);
    expect(root.textContent).not.toContain(actionLabel);
  });
});
