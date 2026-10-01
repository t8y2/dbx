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

describe.each(["restore", "upload"] as const)("CloudSyncSelectionDialog %s category checkboxes", (mode) => {
  it.each(["connections", "tunnelProfiles"] as const)("disables the %s parent checkbox when the category is empty", async (category) => {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(CloudSyncSelectionDialog, {
      open: true,
      mode,
      catalog: { ...catalog, [category]: [] },
    });
    app.mount(root);
    await nextTick();

    const section = root.querySelectorAll("details")[category === "connections" ? 0 : 1];
    const parent = section.querySelector<HTMLInputElement>("summary input")!;
    expect(parent.disabled).toBe(true);
    parent.click();
    await nextTick();
    expect(parent.checked).toBe(false);
    expect(section.textContent).toContain("0/0");
    expect(section.open).toBe(true);
  });

  it.each(["connections", "tunnelProfiles"] as const)("keeps the %s parent checkbox in sync after select-all clicks", async (category) => {
    const items = Array.from({ length: 5 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}` }));
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(CloudSyncSelectionDialog, {
      open: true,
      mode,
      catalog: { ...catalog, [category]: items },
    });
    app.mount(root);
    await nextTick();

    const section = root.querySelectorAll("details")[category === "connections" ? 0 : 1];
    const parent = section.querySelector<HTMLInputElement>("summary input")!;
    const children = Array.from(section.querySelectorAll<HTMLInputElement>("label input"));
    expect(parent.checked).toBe(true);

    let clickEvent: MouseEvent | undefined;
    parent.addEventListener("click", (event) => {
      clickEvent = event;
    });
    parent.click();
    await nextTick();
    // Canceling native checkbox activation rolls back checked in browsers.
    // happy-dom does not emulate that rollback, so also inspect the event.
    expect(clickEvent?.defaultPrevented).toBe(false);
    expect(section.textContent).toContain("0/5");
    expect(parent.checked).toBe(false);
    expect(children.every((child) => !child.checked)).toBe(true);
    expect(section.open).toBe(true);

    parent.click();
    await nextTick();
    expect(section.textContent).toContain("5/5");
    expect(parent.checked).toBe(true);
    expect(children.every((child) => child.checked)).toBe(true);

    children[0].click();
    await nextTick();
    expect(section.textContent).toContain("4/5");
    expect(parent.checked).toBe(false);

    parent.click();
    await nextTick();
    expect(section.textContent).toContain("5/5");
    expect(parent.checked).toBe(true);
    expect(children.every((child) => child.checked)).toBe(true);
  });
});
