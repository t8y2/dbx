// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TableStructureEditor from "./TableStructureEditor.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig } from "@/types/database";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";

const backend = vi.hoisted(() => ({
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
}));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...backend,
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listIndexes: vi.fn().mockResolvedValue([]),
  listConstraints: vi.fn().mockResolvedValue([]),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
  getTableOwner: vi.fn().mockResolvedValue("APP"),
  getTablePartitionStatus: vi.fn().mockResolvedValue(null),
  listPlugins: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
}));

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("filters rejected JDBC recommendations without replacing an existing nonrecommended type", async () => {
  backend.listDataTypes.mockResolvedValue(["NUMBER", "NCLOB", "Long", "LONG   RAW", "BFILE", "boolean", "VECTOR(3, FLOAT32)", "CUSTOM_OB_TYPE"]);
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "ob-type-picker", name: "OB", db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", host: "test", port: 2881, username: "APP", database: "APP" } as ConnectionConfig;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  const column: EditableStructureColumn = {
    id: "existing:C",
    name: "C",
    dataType: "NCLOB",
    isNullable: true,
    defaultValue: "",
    comment: "original comment",
    isPrimaryKey: false,
    extra: {},
    original: { name: "C", data_type: "NCLOB", is_nullable: true, column_default: null, comment: "original comment", is_primary_key: false, extra: null },
    originalPosition: 0,
    markedForDrop: false,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const editorProps = {
    connectionId: connection.id,
    database: "APP",
    schema: "APP",
    tableName: "T",
    draft: { initialized: true, activeTab: "columns" as const, newTableName: "", tableComment: "", originalTableComment: "", columns: [column], indexes: [], foreignKeys: [], triggers: [] },
  };
  app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(TableStructureEditor, editorProps) }) });
  app.component("LightTooltip", LightTooltip);
  app.use(pinia);
  app.use(i18n);
  app.mount(root);
  await vi.waitFor(() => expect(backend.listDataTypes).toHaveBeenCalled());
  await nextTick();
  const picker = root.querySelector<HTMLButtonElement>(".structure-column-data-type button");
  expect(picker?.textContent?.trim()).toBe("NCLOB");
  picker!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("CUSTOM_OB_TYPE"));
  const choices = Array.from(document.querySelectorAll('[data-slot="popover-content"] button')).map((button) => button.textContent?.trim());
  expect(choices).toContain("CUSTOM_OB_TYPE");
  expect(choices).toContain("NUMBER");
  for (const rejected of ["NCLOB", "Long", "LONG   RAW", "BFILE", "boolean", "VECTOR(3, FLOAT32)"]) expect(choices).not.toContain(rejected);
  picker!.click();
  const comment = Array.from(root.querySelectorAll("input")).find((input) => input.value === "original comment");
  expect(comment).toBeDefined();
  comment!.value = "changed comment";
  comment!.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(backend.buildTableStructureChangeSql).toHaveBeenLastCalledWith(expect.objectContaining({ columns: [expect.objectContaining({ dataType: "NCLOB", comment: "changed comment", original: expect.objectContaining({ data_type: "NCLOB" }) })] })));
});
