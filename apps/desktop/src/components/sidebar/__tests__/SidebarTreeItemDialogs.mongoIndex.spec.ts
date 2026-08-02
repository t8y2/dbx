// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import SidebarTreeItemDialogs from "../SidebarTreeItemDialogs.vue";

const mountedApps: ReturnType<typeof createApp>[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SidebarTreeItemDialogs MongoDB index form", () => {
  it("mounts the form and overlay from the same controlled dialog state", async () => {
    const confirmCreateMongoIndex = vi.fn();
    const closed = vi.fn();
    const controller = reactive({
      node: { id: "mongo:app:users:__indexes", label: "索引", type: "group-indexes", database: "app", tableName: "users" },
      t: (key: string) => key,
      highlight: (value: string) => value,
      showDeleteConfirm: false,
      showMoveToNewGroupDialog: false,
      showDeleteGroupConfirm: false,
      showRenameObjectDialog: false,
      showStructurePreviewDialog: false,
      showStructureDocCopyDialog: false,
      showDuplicateDialog: false,
      showPasteDialog: false,
      showCreateDatabaseDialog: false,
      showCreateDatabasePreviewDialog: false,
      showEditDatabasePropertiesDialog: false,
      showCreateNacosNamespaceDialog: false,
      showEditNacosNamespaceDialog: false,
      showRenameMongoCollectionDialog: false,
      showCreateMongoIndexDialog: false,
      mongoCreateIndexForm: { name: "", fields: [{ id: 1, path: "", type: "1" }], unique: false, sparse: false },
      mongoCreateIndexFieldOptions: ["email", "createdAt"],
      mongoCreateIndexError: `Kind: Command failed: Error code 11000 (DuplicateKey): ${"a".repeat(400)}`,
      mongoCreateIndexLoading: false,
      mongoIndexKeyTypes: ["1", "-1", "text", "hashed", "2dsphere", "2d"],
      mongoCreateIndexCanSubmit: false,
      mongoCreateIndexCanAddField: false,
      addMongoCreateIndexField: vi.fn(),
      removeMongoCreateIndexField: vi.fn(),
      confirmCreateMongoIndex,
      showRedisDatabaseAliasDialog: false,
      showCreateSchemaDialog: false,
      showEditSchemaCommentDialog: false,
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeItemDialogs, { controller, onClosed: closed }),
      }),
    );
    mountedApps.push(app);
    app.mount(document.createElement("div"));
    await nextTick();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();

    controller.showCreateMongoIndexDialog = true;
    await nextTick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const name = document.querySelector<HTMLInputElement>('[aria-label="structureEditor.indexName"]');
    const type = document.querySelector<HTMLElement>('[aria-label="structureEditor.indexType"]');
    const unique = document.querySelector<HTMLElement>('[aria-label="structureEditor.unique"]');
    expect(dialog?.getAttribute("data-state")).toBe("open");
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);
    expect(dialog?.contains(name!)).toBe(true);
    expect(dialog?.contains(type!)).toBe(true);
    expect(dialog?.contains(unique!)).toBe(true);
    expect(dialog?.textContent).not.toContain("JSON");
    const error = dialog?.querySelector<HTMLElement>(".text-destructive");
    expect(error?.classList.contains("min-w-0")).toBe(true);
    expect(error?.classList.contains("max-w-full")).toBe(true);
    expect(error?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(error?.classList.contains("break-all")).toBe(true);

    unique?.click();
    await nextTick();
    expect(controller.mongoCreateIndexForm.unique).toBe(true);

    controller.mongoCreateIndexForm.fields[0].path = "email";
    controller.mongoCreateIndexForm.name = "codex_e2e_email_1";
    controller.mongoCreateIndexCanSubmit = true;
    await nextTick();
    const createButton = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "contextMenu.createMongoIndex");
    expect(createButton?.disabled).toBe(false);
    createButton?.click();
    expect(confirmCreateMongoIndex).toHaveBeenCalledOnce();

    controller.showCreateMongoIndexDialog = false;
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    });
    expect(closed).toHaveBeenCalledOnce();
  });
});
