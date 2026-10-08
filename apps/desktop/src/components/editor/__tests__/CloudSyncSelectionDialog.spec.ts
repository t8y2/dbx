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
    section.querySelector("summary")!.click();
    await nextTick();
    expect(section.open).toBe(true);
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
    section.querySelector("summary")!.click();
    await nextTick();
    expect(section.open).toBe(true);
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

describe.each(["restore", "upload"] as const)("CloudSyncSelectionDialog %s group controls", (mode) => {
  function mount(extra: Partial<SyncSnapshotCatalog> = {}, componentProps: Record<string, unknown> = {}) {
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(CloudSyncSelectionDialog, {
      open: true,
      mode,
      catalog: { ...catalog, ...extra },
      ...componentProps,
    });
    app.mount(root);
    return nextTick();
  }

  function toolbarButton(label: string) {
    return Array.from(root!.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
  }

  it("starts collapsed, toggles a group via its summary, and expands/collapses all from the toolbar", async () => {
    await mount();
    const sections = Array.from(root!.querySelectorAll("details"));
    expect(sections).toHaveLength(6);
    expect(sections.every((section) => !section.open)).toBe(true);

    const summary = sections[0].querySelector("summary")!;
    summary.click();
    await nextTick();
    expect(sections[0].open).toBe(true);

    summary.click();
    await nextTick();
    expect(sections[0].open).toBe(false);

    toolbarButton("settings.syncSelectionExpandAll")?.click();
    await nextTick();
    expect(sections.every((section) => section.open)).toBe(true);

    toolbarButton("settings.syncSelectionCollapseAll")?.click();
    await nextTick();
    expect(sections.every((section) => !section.open)).toBe(true);
  });

  it("keeps the group open state when the summary checkbox is clicked", async () => {
    await mount({ tunnelProfiles: [{ id: "tunnel-1", label: "Tunnel" }] });
    const sections = Array.from(root!.querySelectorAll("details"));

    sections[1].querySelector<HTMLInputElement>("summary input")!.click();
    await nextTick();
    expect(sections[1].open).toBe(false);
    expect(sections[1].textContent).toContain("0/1");

    sections[1].querySelector("summary")!.click();
    await nextTick();
    expect(sections[1].open).toBe(true);

    sections[1].querySelector<HTMLInputElement>("summary input")!.click();
    await nextTick();
    expect(sections[1].open).toBe(true);
    expect(sections[1].textContent).toContain("1/1");
  });

  it("shows aggregate counts on group headers and updates them from the toolbar", async () => {
    await mount({
      savedSqlFolders: [{ id: "folder-1", label: "Folder" }],
      savedSqlFiles: [{ id: "sql-1", label: "Query" }],
      hasSidebarLayout: true,
      hasPinnedTreeNodeIds: true,
    });
    const sections = Array.from(root!.querySelectorAll("details"));
    expect(sections[0].querySelector("summary")!.textContent).toContain("1/1");
    expect(sections[2].querySelector("summary")!.textContent).toContain("2/2");
    expect(sections[5].querySelector("summary")!.textContent).toContain("2/2");

    toolbarButton("settings.syncSelectionDeselectAll")?.click();
    await nextTick();
    expect(sections[0].querySelector("summary")!.textContent).toContain("0/1");
    expect(sections[2].querySelector("summary")!.textContent).toContain("0/2");
    expect(sections[5].querySelector("summary")!.textContent).toContain("0/2");

    toolbarButton("settings.syncSelectionSelectAll")?.click();
    await nextTick();
    expect(sections[0].querySelector("summary")!.textContent).toContain("1/1");
    expect(sections[2].querySelector("summary")!.textContent).toContain("2/2");
    expect(sections[5].querySelector("summary")!.textContent).toContain("2/2");
  });

  it("shows an indeterminate state on group checkboxes when partially selected", async () => {
    await mount({
      connections: [
        { id: "connection-1", label: "Primary" },
        { id: "connection-2", label: "Secondary" },
      ],
      savedSqlFiles: [{ id: "sql-1", label: "Query" }],
    });
    const sections = Array.from(root!.querySelectorAll("details"));
    const connectionsMaster = sections[0].querySelector<HTMLInputElement>("summary input")!;
    expect(connectionsMaster.checked).toBe(true);
    expect(connectionsMaster.indeterminate).toBe(false);

    const children = Array.from(sections[0].querySelectorAll<HTMLInputElement>("label input"));
    children[0].click();
    await nextTick();
    expect(connectionsMaster.checked).toBe(false);
    expect(connectionsMaster.indeterminate).toBe(true);

    // The saved-sql group header checkbox covers folders and files together.
    const savedSqlMaster = sections[2].querySelector<HTMLInputElement>("summary input")!;
    expect(savedSqlMaster.checked).toBe(true);
    savedSqlMaster.click();
    await nextTick();
    expect(savedSqlMaster.checked).toBe(false);
    expect(savedSqlMaster.indeterminate).toBe(false);
    expect(sections[2].querySelector("summary")!.textContent).toContain("0/1");
    savedSqlMaster.click();
    await nextTick();
    expect(sections[2].querySelector("summary")!.textContent).toContain("1/1");
  });

  it("reflects a secrets child on the encrypted group checkbox", async () => {
    await mount({ connectionSecrets: ["connection-1"] }, { secretsPassphraseAvailable: true });
    const sections = Array.from(root!.querySelectorAll("details"));
    const secretsMaster = sections[4].querySelector<HTMLInputElement>("summary input")!;
    expect(secretsMaster.checked).toBe(false);

    const secretChild = sections[0].querySelectorAll<HTMLInputElement>("input")[2];
    expect(secretChild.disabled).toBe(false);
    secretChild.click();
    await nextTick();
    // One of two encrypted items selected shows a partial state on the group.
    expect(secretsMaster.checked).toBe(false);
    expect(secretsMaster.indeterminate).toBe(true);
    expect(secretChild.checked).toBe(true);
    expect(sections[4].querySelector("summary")!.textContent).toContain("1/2");

    secretChild.click();
    await nextTick();
    expect(secretsMaster.checked).toBe(false);
    expect(secretsMaster.indeterminate).toBe(false);
    expect(secretChild.checked).toBe(false);
  });

  it("keeps the secrets child off and shows the passphrase hint when no passphrase is available", async () => {
    await mount({ connectionSecrets: ["connection-1"] }, { secretsPassphraseAvailable: false });
    const sections = Array.from(root!.querySelectorAll("details"));
    const secretsMaster = sections[4].querySelector<HTMLInputElement>("summary input")!;
    const secretChild = sections[0].querySelectorAll<HTMLInputElement>("input")[2];
    expect(secretsMaster.checked).toBe(false);

    secretChild.click();
    await nextTick();
    expect(secretsMaster.checked).toBe(false);
    expect(secretChild.checked).toBe(false);
    expect(sections[4].textContent).toContain("settings.localBackupSecretsPassphraseRequiredHint");
  });

  it("disables the confirm action while nothing is selected", async () => {
    await mount();
    const actionKey = mode === "restore" ? "settings.syncSelectionRestoreAction" : "settings.syncSelectionUploadAction";
    const confirm = () => toolbarButton(actionKey) as HTMLButtonElement;
    expect(confirm()?.disabled).toBe(false);

    toolbarButton("settings.syncSelectionDeselectAll")?.click();
    await nextTick();
    expect(confirm()?.disabled).toBe(true);

    toolbarButton("settings.syncSelectionSelectAll")?.click();
    await nextTick();
    expect(confirm()?.disabled).toBe(false);
  });

  it("keeps the encrypted group checkbox linked to its items", async () => {
    await mount({ aiConfigs: [{ id: "ai-1", label: "AI" }] }, { secretsPassphraseAvailable: true });
    const sections = Array.from(root!.querySelectorAll("details"));
    const secretsMaster = sections[4].querySelector<HTMLInputElement>("summary input")!;
    const summaryText = () => sections[4].querySelector("summary")!.textContent;

    toolbarButton("settings.syncSelectionDeselectAll")?.click();
    await nextTick();
    expect(secretsMaster.checked).toBe(false);
    expect(secretsMaster.indeterminate).toBe(false);
    expect(summaryText()).toContain("0/2");

    // Checking one child turns the group on with an indeterminate state.
    sections[4].querySelectorAll<HTMLInputElement>("label input")[0].click();
    await nextTick();
    expect(secretsMaster.checked).toBe(false);
    expect(secretsMaster.indeterminate).toBe(true);
    expect(summaryText()).toContain("1/2");

    // Checking the group selects every child; unchecking clears them all.
    secretsMaster.click();
    await nextTick();
    expect(secretsMaster.checked).toBe(true);
    expect(summaryText()).toContain("2/2");

    secretsMaster.click();
    await nextTick();
    expect(secretsMaster.checked).toBe(false);
    expect(summaryText()).toContain("0/2");
  });

  it("groups plugin data under per-plugin checkboxes", async () => {
    await mount(
      {
        pluginUiStorage: [
          { pluginId: "devtools", key: "devtools:favorites", pluginName: "Dev Tools" },
          { pluginId: "devtools", key: "devtools:recent", pluginName: "Dev Tools" },
          { pluginId: "other", key: "other:flag" },
        ],
      },
      { secretsPassphraseAvailable: true },
    );
    const secretsSection = Array.from(root!.querySelectorAll("details"))[4];
    const headerLabel = Array.from(secretsSection.querySelectorAll("label")).find((label) => label.textContent?.includes("Dev Tools"))!;
    const groupDiv = headerLabel.parentElement!;
    const [groupBox, favoritesBox] = Array.from(groupDiv.querySelectorAll("input"));
    const headerText = () => headerLabel.textContent;

    expect(headerText()).toContain("Dev Tools (2/2)");
    expect(groupBox.checked).toBe(true);

    // Unchecking one child leaves the plugin box in an indeterminate state.
    favoritesBox.click();
    await nextTick();
    expect(groupBox.checked).toBe(false);
    expect(groupBox.indeterminate).toBe(true);
    expect(headerText()).toContain("Dev Tools (1/2)");

    // Checking the plugin box selects all its items; unchecking clears them.
    groupBox.click();
    await nextTick();
    expect(headerText()).toContain("Dev Tools (2/2)");
    groupBox.click();
    await nextTick();
    expect(headerText()).toContain("Dev Tools (0/2)");
    expect(groupBox.checked).toBe(false);
    expect(groupBox.indeterminate).toBe(false);
  });

  it("does not count saved secret ids that are missing from the catalog", async () => {
    // The export catalog lists every connection as secret-eligible, but the snapshot only carries
    // secrets that were actually stored, so a saved selection can keep ids that are not restorable.
    await mount(
      {
        connectionSecrets: ["connection-1"],
        selection: { connectionSecrets: ["connection-1", "gone-connection"], includeSecrets: true },
      },
      { secretsPassphraseAvailable: true },
    );
    const summary = Array.from(root!.querySelectorAll("details"))[4].querySelector("summary")!;
    expect(summary.textContent).toContain("1/2");
    expect(summary.textContent).not.toContain("2/2");
  });
});
