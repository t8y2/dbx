// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TableStructureEditor from "../TableStructureEditor.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig } from "@/types/database";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
import type { ObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";

const mocks = vi.hoisted(() => ({
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
  buildSingleColumnAlterSql: vi.fn().mockResolvedValue({ statements: ["ALTER TABLE `t` ADD COLUMN `content` text;"], warnings: [] }),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildSingleColumnAlterSql: mocks.buildSingleColumnAlterSql,
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
  getColumns: vi.fn().mockResolvedValue([]),
  listIndexes: vi.fn().mockResolvedValue([]),
  listConstraints: vi.fn().mockResolvedValue([]),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(""),
  getTablePartitioning: vi.fn().mockResolvedValue(null),
  getTableOwner: vi.fn().mockResolvedValue("app"),
  getTablePartitionStatus: vi.fn().mockResolvedValue(null),
  listPlugins: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  loadObjectDdl: vi.fn().mockResolvedValue(""),
  invalidateObjectDdl: vi.fn().mockResolvedValue(undefined),
  invalidateObjectMetadataCache: vi.fn().mockResolvedValue(undefined),
  invalidateTableMetadataCache: vi.fn().mockResolvedValue(undefined),
  getMysqlTableAutoIncrement: vi.fn().mockResolvedValue(null),
  buildMysqlAutoIncrementSql: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/lib/metadata/objectMetadataCache", () => ({
  invalidateObjectMetadataCache: vi.fn().mockResolvedValue(undefined),
  invalidateTableMetadataCache: vi.fn().mockResolvedValue(undefined),
  loadObjectMetadataFacet: vi.fn().mockResolvedValue({ value: [], cacheStatus: "remote" }),
}));

vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: mocks.copyToClipboard,
}));

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function mountMysqlStructureEditor() {
  mocks.listDataTypes.mockResolvedValue(["bigint", "varchar", "text", "datetime", "int"]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildSingleColumnAlterSql.mockResolvedValue({ statements: ["ALTER TABLE `t` ADD COLUMN `content` text;"], warnings: [] });
  mocks.copyToClipboard.mockResolvedValue(undefined);

  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = {
    id: "mysql-dropdown-focus",
    name: "MySQL",
    db_type: "mysql",
    driver_profile: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    database: "app",
  } as ConnectionConfig;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);

  const columns: EditableStructureColumn[] = [
    {
      id: "existing:id",
      name: "id",
      dataType: "bigint(20)",
      isNullable: false,
      defaultValue: "",
      comment: "pk",
      isPrimaryKey: true,
      characterSet: "",
      collation: "",
      extra: {},
      original: { name: "id", data_type: "bigint(20)", is_nullable: false, column_default: null, comment: "pk", is_primary_key: true, extra: null },
      originalPosition: 0,
      markedForDrop: false,
    },
    {
      id: "existing:content",
      name: "content",
      dataType: "text",
      isNullable: false,
      defaultValue: "",
      comment: "body",
      isPrimaryKey: false,
      characterSet: "",
      collation: "",
      extra: {},
      original: { name: "content", data_type: "text", is_nullable: false, column_default: null, comment: "body", is_primary_key: false, extra: null },
      originalPosition: 1,
      markedForDrop: false,
    },
  ];

  const root = document.createElement("div");
  document.body.append(root);
  const editorProps = {
    connectionId: connection.id,
    database: "app",
    schema: "app",
    tableName: "t",
    draft: {
      initialized: true,
      activeTab: "columns" as const,
      newTableName: "",
      tableComment: "",
      originalTableComment: "",
      columns,
      indexes: [],
      foreignKeys: [],
      triggers: [],
      loadedMetadataFacets: ["columns", "indexes", "foreign-keys", "constraints", "triggers", "partitions", "comment"] as ObjectMetadataFacet[],
    },
  };

  app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(TableStructureEditor, editorProps as any) }) });
  app.component("LightTooltip", LightTooltip);
  app.use(pinia);
  app.use(i18n);
  app.mount(root);

  await vi.waitFor(() => expect(root.querySelector(".structure-column-data-type button")).not.toBeNull(), { timeout: 3000 });
  await nextTick();
  return root;
}

function flushMacrotask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("TableStructureEditor column row dropdown focus", () => {
  it("does not steal focus to the scroller when clicking the data type SearchableSelect trigger", async () => {
    const root = await mountMysqlStructureEditor();
    const scroller = root.querySelector<HTMLElement>(".structure-column-virtual-scroller")!;
    const focusSpy = vi.spyOn(scroller, "focus");
    const row = root.querySelector<HTMLElement>('tr[data-column-id="existing:content"]')!;
    const trigger = row.querySelector<HTMLButtonElement>(".structure-column-data-type button")!;

    const pointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" });
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    trigger.dispatchEvent(pointerDown);
    trigger.dispatchEvent(mouseDown);
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    // Prevent macOS WebKit from focusing the ancestor scroller on mousedown.
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(focusSpy).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull(), { timeout: 2000 });
    await flushMacrotask();
    await nextTick();
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="popover-content"]')?.contains(document.activeElement)).toBe(true);

    // Selecting an option inside the opened dropdown updates the column type.
    const varcharOption = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button')].find((button) => button.textContent?.trim() === "varchar");
    expect(varcharOption).toBeDefined();
    varcharOption!.click();
    await vi.waitFor(() => expect(trigger.textContent?.trim()).toBe("varchar"), { timeout: 2000 });
  });

  it("keeps the default value dropdown menu and comment popover open when clicked", async () => {
    const root = await mountMysqlStructureEditor();
    const scroller = root.querySelector<HTMLElement>(".structure-column-virtual-scroller")!;
    const focusSpy = vi.spyOn(scroller, "focus");
    const row = root.querySelector<HTMLElement>('tr[data-column-id="existing:content"]')!;

    const presetTrigger = row.querySelector<HTMLButtonElement>(".structure-column-default-value button")!;
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    presetTrigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    presetTrigger.dispatchEvent(mouseDown);
    presetTrigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    presetTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(focusSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull(), { timeout: 2000 });
    await flushMacrotask();
    await nextTick();
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull();
  });

  it("does not prevent mousedown on text inputs or drag handles", async () => {
    const root = await mountMysqlStructureEditor();
    const row = root.querySelector<HTMLElement>('tr[data-column-id="existing:content"]')!;
    const nameInput = row.querySelector<HTMLInputElement>("[data-column-name-input]")!;
    const inputMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    nameInput.dispatchEvent(inputMouseDown);
    expect(inputMouseDown.defaultPrevented).toBe(false);

    const dragButton = row.querySelector<HTMLButtonElement>('button[draggable="true"]');
    if (dragButton) {
      const dragMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      dragButton.dispatchEvent(dragMouseDown);
      expect(dragMouseDown.defaultPrevented).toBe(false);
    }
  });

  it("still focuses the scroller for Cmd+C / Cmd+V when clicking a non-interactive row cell", async () => {
    const root = await mountMysqlStructureEditor();
    const scroller = root.querySelector<HTMLElement>(".structure-column-virtual-scroller")!;
    const row = root.querySelector<HTMLElement>('tr[data-column-id="existing:content"]')!;
    const ordinalSpan = row.querySelector<HTMLElement>("td:first-child span")!;

    ordinalSpan.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    ordinalSpan.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await nextTick();

    expect(document.activeElement).toBe(scroller);

    const copyEvent = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    scroller.dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});
