// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TableStructureEditor from "../TableStructureEditor.vue";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, ConstraintInfo } from "@/types/database";
import * as api from "@/lib/backend/api";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listDataTypes: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn(),
  listConstraints: vi.fn(),
  listIndexes: vi.fn().mockResolvedValue([]),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(""),
  getTablePartitioning: vi.fn().mockResolvedValue(null),
  buildTableStructureChangeSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
  saveHistory: vi.fn().mockResolvedValue(undefined),
  disconnectDb: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 }),
}));

const connection = { id: "ob-existing-pk", name: "OB fixture", db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", host: "fixture", port: 2881, username: "APP", database: "APP" } as ConnectionConfig;
let app: App | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  i18n.global.locale.value = "en";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`Unexpected HTTP request: ${input}`);
    }),
  );
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountExistingKey(columns: string[], databaseType = "oceanbase-oracle", disabled = false, isProduction = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ ...connection, db_type: databaseType, driver_profile: databaseType, is_production: isProduction } as ConnectionConfig];
  store.connectedIds.add(connection.id);
  vi.mocked(api.getColumns).mockResolvedValue(["ID", "V"].map((name) => ({ name, data_type: "NUMBER", is_nullable: false, is_primary_key: columns.includes(name), column_default: null })));
  vi.mocked(api.listConstraints).mockResolvedValue([{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns, definition: "", ref_columns: [], enabled: !disabled, valid: !disabled, deferrable: false, initially_deferred: false } as ConstraintInfo]);
  const container = document.createElement("div");
  document.body.append(container);
  await invalidateObjectMetadataCache({ connectionId: connection.id });
  const editor = ref<InstanceType<typeof TableStructureEditor>>();
  const context = ref({ connectionId: connection.id, database: "APP", schema: "APP", tableName: `SOURCE_${columns.join("_")}`, initialTab: "constraints" as const });
  const drafts: unknown[] = [];
  app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(TableStructureEditor, { ...context.value, ref: editor, "onUpdate:draft": (draft) => drafts.push(draft) }) }) });
  app.use(pinia);
  app.use(i18n);
  app.component("LightTooltip", LightTooltip);
  app.mount(container);
  if (["oceanbase-oracle", "oracle"].includes(databaseType)) await vi.waitFor(() => expect(container.textContent).toContain("PK_SOURCE"));
  else await vi.waitFor(() => expect(api.getColumns).toHaveBeenCalled());
  await nextTick();
  return { container, editor, context, drafts };
}

async function prepareReorderedKey(rejectAdd = false, remove = false, databaseType = "oceanbase-oracle", disabled = false, isProduction = false, openOnly = false) {
  const mounted = await mountExistingKey(["ID", "V"], databaseType, disabled, isProduction);
  const oracle = databaseType === "oracle";
  const tableName = "SOURCE_ID_V";
  let keyColumns = ["ID", "V"];
  vi.mocked(api.getColumns).mockImplementation(async () => ["ID", "V"].map((name) => ({ name, data_type: "NUMBER", is_nullable: false, is_primary_key: keyColumns.includes(name), column_default: null })));
  vi.mocked(api.listConstraints).mockImplementation(async () => (keyColumns.length ? [{ name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: [...keyColumns], definition: "", ref_columns: [], enabled: !disabled, valid: !disabled, deferrable: false, initially_deferred: false }] : []));
  vi.mocked(api.listIndexes).mockImplementation(async () => (!disabled && (keyColumns.length || oracle) ? [{ name: "PK_SOURCE", columns: oracle ? ["ID", "V"] : [...keyColumns], is_primary: !!keyColumns.length, is_unique: true, index_type: "NORMAL" }] : []));
  vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (options) => ({
    statements: options.primaryKeyChange
      ? [
          `ALTER TABLE "APP"."${tableName}" DROP CONSTRAINT "PK_SOURCE"${oracle && !disabled ? " KEEP INDEX" : ""};`,
          ...(options.primaryKeyChange.columns.length ? [`ALTER TABLE "APP"."${tableName}" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("V", "ID")${disabled ? " NOT DEFERRABLE INITIALLY IMMEDIATE NORELY DISABLE NOVALIDATE" : oracle ? ' USING INDEX "APP"."PK_SOURCE"' : ""};`] : []),
        ]
      : [],
    warnings: [],
  }));
  vi.mocked(api.executeQuery).mockImplementation(async (_id, _database, sql) => {
    const result = (rows: unknown[][] = []) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
    if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "APP"]]);
    if (sql.includes("SYS.ALL_OBJECTS")) {
      const tableName = /OBJECT_NAME = '([^']+)'/.exec(sql)?.[1] ?? "SOURCE_ID_V";
      return result([["APP", tableName, 77]]);
    }
    if (sql.startsWith("SELECT RELY ")) return result([[null]]);
    if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result();
    if (sql.includes(" DROP CONSTRAINT ")) {
      keyColumns = [];
      return result();
    }
    if (sql.includes(" ADD CONSTRAINT ")) {
      if (rejectAdd) return { ...result(), execution_error: true, error: { detail: "ORA-00001: duplicate key" } };
      keyColumns = ["V", "ID"];
      return result();
    }
    if (sql.includes("R_CONSTRAINT_NAME")) return result();
    if (sql.includes("SYS.ALL_IND_COLUMNS"))
      return result([
        ["ID", 1, "ASC"],
        ["V", 2, "ASC"],
      ]);
    if (sql.includes("SYS.ALL_INDEXES")) return result([["APP", "PK_SOURCE", "NORMAL", "UNIQUE", "VALID", "VISIBLE", "NO", ...(sql.includes("PARTITIONED, TABLE_OWNER") ? ["APP", tableName] : [])]]);
    if (sql.includes("SYS.ALL_CONS_COLUMNS"))
      return result([
        ["ID", 1],
        ["V", 2],
      ]);
    if (sql.includes("SYS.ALL_TAB_COLS"))
      return result([
        ["ID", "N", "NO"],
        ["V", "N", "NO"],
      ]);
    if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]);
    if (sql.startsWith("SELECT OWNER, TABLE_NAME")) return result([["APP", tableName, "PK_SOURCE", "P"]]);
    if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["PK_SOURCE", disabled ? "DISABLED" : "ENABLED", disabled ? "NOT VALIDATED" : "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", disabled ? null : "APP", disabled ? null : "PK_SOURCE"]]);
    if (sql.startsWith("SELECT COUNT(*)")) return result([[0]]);
    throw new Error(`Unexpected query: ${sql}`);
  });
  Array.from(mounted.container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === i18n.global.t(remove ? "common.delete" : "common.edit"))!
    .click();
  await vi.waitFor(() => expect(mounted.container.querySelector("[data-existing-primary-key-editor]")).not.toBeNull());
  if (openOnly) return mounted;
  if (!remove) (mounted.container.querySelector(`[data-existing-primary-key-editor] button[title="${i18n.global.t("oceanbasePrimaryKey.moveDown")}"]`) as HTMLButtonElement).click();
  await vi.waitFor(() => {
    const apply = Array.from(mounted.container.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.global.t("structureEditor.apply"));
    expect(apply?.disabled).toBe(false);
  });
  return mounted;
}

describe("OceanBase existing primary key in the structure editor", () => {
  it("previews and saves a disabled Oracle key without offering a nonexistent index policy", async () => {
    const { editor, drafts, container } = await prepareReorderedKey(false, false, "oracle", true);
    expect(container.querySelector("[data-primary-key-index-identity]")?.textContent).toBe(i18n.global.t("oceanbasePrimaryKey.noIndex"));
    expect(container.querySelector("[data-existing-primary-key-editor]")?.parentElement?.classList.contains("opacity-60")).toBe(false);
    expect(container.textContent).not.toContain(i18n.global.t("oceanbasePrimaryKey.oracleImpact"));
    expect(container.querySelector(`[aria-label="${i18n.global.t("oceanbasePrimaryKey.indexPolicy")}"]`)).toBeNull();
    expect(container.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.preserveState"));
    expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.at(-1)?.[0].primaryKeyChange).toMatchObject({ oracleIndex: { policy: "none", name: "" }, oracleState: { enabled: false, validated: false, deferrable: false, initiallyDeferred: false, rely: false } });
    await expect(editor.value!.applyChanges()).resolves.toBe(true);
    expect(drafts.at(-1)).toMatchObject({ dirty: false, existingPrimaryKey: undefined });
    expect(
      vi
        .mocked(api.executeQuery)
        .mock.calls.filter((call) => call[2].startsWith("ALTER "))
        .map((call) => call[2]),
    ).toEqual(['ALTER TABLE "APP"."SOURCE_ID_V" DROP CONSTRAINT "PK_SOURCE"', 'ALTER TABLE "APP"."SOURCE_ID_V" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("V", "ID") NOT DEFERRABLE INITIALLY IMMEDIATE NORELY DISABLE NOVALIDATE']);
  });
  it("offers the existing primary key editor for native Oracle", async () => {
    const { container } = await mountExistingKey(["ID", "V"], "oracle");
    const name = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "PK_SOURCE")!;
    const card = name.parentElement!.parentElement!;
    const edit = Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.global.t("common.edit"));
    expect(edit, "Native Oracle must expose the existing primary key editor").toBeDefined();
    edit!.click();
    await vi.waitFor(() => expect(container.querySelector("[data-existing-primary-key-editor]")).not.toBeNull());
    expect(api.executeQuery).toHaveBeenCalled();
    expect(api.executeQuery.mock.calls.filter(([, , sql]) => /^(?:ALTER|CREATE|DROP)\b/i.test(sql.trim()))).toHaveLength(0);
  });

  it.each([{ columns: ["ID"] }, { columns: ["V", "ID"] }])("offers editing for the existing ordered key $columns in its constraint card", async ({ columns }) => {
    const { container } = await mountExistingKey(columns);
    const name = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "PK_SOURCE")!;
    const card = name.parentElement!.parentElement!;
    expect(card.textContent).toContain(columns.join(", "));
    const edit = Array.from(card.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.global.t("common.edit"));
    expect(edit, "Existing primary keys must be editable from their current constraint card").toBeDefined();
    expect(edit!.disabled).toBe(false);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["saphana", "mysql"])("does not expose the Oracle-family key editor for %s", async (databaseType) => {
    const { container } = await mountExistingKey(["ID"], databaseType);
    const name = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "PK_SOURCE");
    if (name) {
      const card = name.parentElement!.parentElement!;
      expect(Array.from(card.querySelectorAll("button")).some((button) => button.textContent?.trim() === i18n.global.t("common.edit"))).toBe(false);
    }
    expect(container.querySelector("[data-existing-primary-key-editor]")).toBeNull();
  });

  it("keeps an ordered primary key draft in the existing unsaved-change contract", async () => {
    const { container, drafts } = await mountExistingKey(["ID", "V"]);
    const edit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.global.t("common.edit"))!;
    edit.click();
    await vi.waitFor(() => expect(container.querySelector("[data-existing-primary-key-editor]")).not.toBeNull());
    const down = container.querySelector(`[data-existing-primary-key-editor] button[title="${i18n.global.t("oceanbasePrimaryKey.moveDown")}"]`) as HTMLButtonElement;
    down.click();
    await nextTick();
    await vi.waitFor(() => expect(drafts.at(-1)).toMatchObject({ dirty: true, existingPrimaryKey: { name: "PK_SOURCE", originalColumns: ["ID", "V"], columns: ["V", "ID"] } }));
    expect(api.executeQuery.mock.calls.filter(([, , sql]) => /^(?:ALTER|CREATE|DROP)\b/i.test(sql.trim()))).toHaveLength(0);
  });

  it("previews and applies the ordered key through the existing save entry", async () => {
    const { editor, drafts, container } = await prepareReorderedKey();
    expect(container.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.impact"));
    expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.at(-1)?.[0].primaryKeyChange).toEqual({ name: "PK_SOURCE", originalColumns: ["ID", "V"], columns: ["V", "ID"] });
    await expect(editor.value!.applyChanges()).resolves.toBe(true);
    expect(
      vi
        .mocked(api.executeQuery)
        .mock.calls.filter((call) => call[2].startsWith("ALTER "))
        .map((call) => call.slice(0, 2)),
    ).toEqual([
      [connection.id, "APP"],
      [connection.id, "APP"],
    ]);
    expect(vi.mocked(api.saveHistory).mock.calls).toHaveLength(2);
    expect(drafts.at(-1)).toMatchObject({ dirty: false, existingPrimaryKey: undefined });
  });

  it("previews and saves native Oracle with an explicit retained index through the same entry", async () => {
    const { editor, drafts, container } = await prepareReorderedKey(false, false, "oracle");
    expect(container.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.oracleImpact"));
    expect(container.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.keepIndex"));
    expect(container.querySelector("[data-primary-key-index-identity]")?.textContent).toBe("APP.PK_SOURCE");
    expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.at(-1)?.[0].primaryKeyChange).toEqual({
      name: "PK_SOURCE",
      originalColumns: ["ID", "V"],
      columns: ["V", "ID"],
      oracleIndex: { policy: "keep", owner: "APP", name: "PK_SOURCE" },
      oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false },
    });
    await expect(editor.value!.applyChanges()).resolves.toBe(true);
    expect(
      vi
        .mocked(api.executeQuery)
        .mock.calls.filter((call) => call[2].startsWith("ALTER "))
        .map((call) => call[2]),
    ).toEqual(['ALTER TABLE "APP"."SOURCE_ID_V" DROP CONSTRAINT "PK_SOURCE" KEEP INDEX', 'ALTER TABLE "APP"."SOURCE_ID_V" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("V", "ID") USING INDEX "APP"."PK_SOURCE"']);
    expect(drafts.at(-1)).toMatchObject({ dirty: false, existingPrimaryKey: undefined });
  });

  it("hides the verified Oracle index identity when the draft no longer matches its plan", async () => {
    const { container } = await prepareReorderedKey(false, false, "oracle");
    expect(container.querySelector("[data-primary-key-index-identity]")).not.toBeNull();
    (container.querySelector(`[data-existing-primary-key-editor] button[title="${i18n.global.t("oceanbasePrimaryKey.moveDown")}"]`) as HTMLButtonElement).click();
    await nextTick();
    expect(container.querySelector("[data-primary-key-index-identity]")).toBeNull();
  });

  it("shows the committed DROP and rejected ADD together with manual recovery", async () => {
    const { editor } = await prepareReorderedKey(true);
    await expect(editor.value!.applyChanges()).resolves.toBe(false);
    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("ORA-00001");
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.committed"));
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.rejected"));
    expect(dialog?.textContent).toContain('PRIMARY KEY ("ID", "V")');
    expect(dialog?.querySelector("details")?.open).toBe(false);
  });

  it("deletes an existing key from its constraint card and reloads the keyless table", async () => {
    const { editor, container, drafts } = await prepareReorderedKey(false, true);
    expect(container.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.removeKey"));
    expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.at(-1)?.[0].primaryKeyChange).toEqual({ name: "PK_SOURCE", originalColumns: ["ID", "V"], columns: [] });
    await expect(editor.value!.applyChanges()).resolves.toBe(true);
    const statements = vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "));
    expect(statements.map((call) => call[2])).toEqual(['ALTER TABLE "APP"."SOURCE_ID_V" DROP CONSTRAINT "PK_SOURCE"']);
    expect(container.textContent).not.toContain("PK_SOURCE");
    expect(drafts.at(-1)).toMatchObject({ dirty: false, existingPrimaryKey: undefined });
    expect(api.saveHistory).toHaveBeenCalledTimes(1);
    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(i18n.global.t("structureEditor.saved"));
    expect(dialog?.textContent).not.toContain(i18n.global.t("oceanbasePrimaryKey.executionFailed"));
    expect(dialog?.textContent).toContain('ALTER TABLE "APP"."SOURCE_ID_V" ADD CONSTRAINT "PK_SOURCE" PRIMARY KEY ("ID", "V");');
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.recoveryNotice"));
    expect(dialog?.querySelector("details")?.open).toBe(false);
  });

  it("reports editor refresh failure after committed DDL without losing the execution result", async () => {
    const { editor } = await prepareReorderedKey();
    const readColumns = vi.mocked(api.getColumns).getMockImplementation()!;
    let postDdlReads = 0;
    vi.mocked(api.getColumns).mockImplementation(async (...args) => {
      const added = vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].includes(" ADD CONSTRAINT "));
      if (added && ++postDdlReads === 2) throw new Error("column refresh unavailable");
      return readColumns(...args);
    });
    const saved = await editor.value!.applyChanges();
    expect(postDdlReads).toBe(2);
    expect(saved).toBe(false);
    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("column refresh unavailable");
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.committed"));
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "))).toHaveLength(2);
  });

  it.each(["cancel", "switch", "unmount"])("does not execute DDL after production confirmation %s", async (action) => {
    const { editor, context } = await prepareReorderedKey(false, false, "oceanbase-oracle", false, true);
    const pending = editor.value!.applyChanges();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    if (action === "cancel") safety.cancel();
    if (action === "switch") {
      context.value = { ...context.value, tableName: "OTHER" };
      await nextTick();
    }
    if (action === "unmount") {
      app!.unmount();
      app = undefined;
    }
    await expect(pending).resolves.toBe(false);
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].startsWith("ALTER "))).toBe(false);
    expect(safety.pending).toBeUndefined();
  });

  it("keeps an in-flight DDL sequence and its history on the captured table after switching", async () => {
    const { editor, context, drafts } = await prepareReorderedKey();
    const execute = vi.mocked(api.executeQuery).getMockImplementation()!;
    let releaseDrop!: () => void;
    const dropGate = new Promise<void>((resolve) => {
      releaseDrop = resolve;
    });
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].includes(" DROP CONSTRAINT ")) await dropGate;
      return execute(...args);
    });
    const pending = editor.value!.applyChanges();
    await vi.waitFor(() => expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].includes(" DROP CONSTRAINT "))).toBe(true));
    context.value = { ...context.value, tableName: "OTHER" };
    await nextTick();
    releaseDrop();
    await expect(pending).resolves.toBe(true);
    const statements = vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "));
    expect(statements).toHaveLength(2);
    expect(statements.every((call) => call[2].includes('"APP"."SOURCE_ID_V"'))).toBe(true);
    expect(vi.mocked(api.saveHistory).mock.calls).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(api.saveHistory).mock.calls)).not.toContain('"target":"OTHER"');
    expect(drafts.at(-1)).toMatchObject({ dirty: false, existingPrimaryKey: undefined });
  });

  it("discards late primary key preview if connection state revision changes while query is pending", async () => {
    let releaseBuild!: () => void;
    let buildStarted!: () => void;
    const buildStartedPromise = new Promise<void>((resolve) => {
      buildStarted = resolve;
    });
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const { container, editor } = await prepareReorderedKey(false, false, "oceanbase-oracle", false, false, true);
    const store = useConnectionStore();
    const originalBuild = vi.mocked(api.buildTableStructureChangeSql).getMockImplementation()!;
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (...args) => {
      buildStarted();
      await buildGate;
      return originalBuild(...args);
    });

    // Trigger preview computation by clicking moveDown
    (container.querySelector(`[data-existing-primary-key-editor] button[title="${i18n.global.t("oceanbasePrimaryKey.moveDown")}"]`) as HTMLButtonElement).click();
    await buildStartedPromise;

    // While query is pending, bump connection state revision
    await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
    store.connectedIds.add(connection.id);

    releaseBuild();
    await vi.waitFor(() => expect(container.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.refreshRequired")));
    expect(await editor.value!.applyChanges()).toBe(false);
  });

  it.each(["after-preview", "during-confirmation", "during-preflight-snapshot"])("issues zero DDL when connection state changes %s", async (phase) => {
    const { editor } = await prepareReorderedKey(false, false, "oceanbase-oracle", false, phase === "during-confirmation");
    const store = useConnectionStore();

    if (phase === "after-preview") {
      await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
      store.connectedIds.add(connection.id);
      await expect(editor.value!.applyChanges()).resolves.toBe(false);
    } else if (phase === "during-confirmation") {
      const pending = editor.value!.applyChanges();
      const safety = useProductionSafetyStore();
      await vi.waitFor(() => expect(safety.pending).toBeDefined());
      await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
      store.connectedIds.add(connection.id);
      safety.confirm();
      await expect(pending).resolves.toBe(false);
    } else if (phase === "during-preflight-snapshot") {
      let releaseSnapshot!: () => void;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      const originalExecute = vi.mocked(api.executeQuery).getMockImplementation()!;
      let intercepted = false;
      vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
        if (!intercepted && args[2].includes("FROM SYS.ALL_CONSTRAINTS WHERE OWNER = 'APP' AND TABLE_NAME = 'SOURCE_ID_V' AND CONSTRAINT_TYPE = 'P'")) {
          intercepted = true;
          await snapshotGate;
        }
        return originalExecute(...args);
      });
      const pending = editor.value!.applyChanges();
      await vi.waitFor(() => expect(intercepted).toBe(true));
      await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
      store.connectedIds.add(connection.id);
      releaseSnapshot();
      await expect(pending).resolves.toBe(false);
    }

    const statements = vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "));
    expect(statements).toHaveLength(0);
  });

  it("marks in-flight DROP as unknown, skips ADD, and omits recovery SQL when connection is disconnected/reconfigured while DROP is pending", async () => {
    const { editor } = await prepareReorderedKey();
    const store = useConnectionStore();
    const execute = vi.mocked(api.executeQuery).getMockImplementation()!;
    let releaseDrop!: () => void;
    const dropGate = new Promise<void>((resolve) => {
      releaseDrop = resolve;
    });

    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2].includes(" DROP CONSTRAINT ")) {
        await dropGate;
      }
      return execute(...args);
    });

    const pending = editor.value!.applyChanges();
    await vi.waitFor(() => expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2].includes(" DROP CONSTRAINT "))).toBe(true));

    // While DROP is pending in database, connection disconnects / bumps revision
    await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
    store.connectedIds.add(connection.id);

    releaseDrop();
    await expect(pending).resolves.toBe(false);

    const statements = vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "));
    expect(statements).toHaveLength(1);
    expect(statements[0]![2]).toContain("DROP CONSTRAINT");

    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.unknown"));
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.notExecuted"));
    expect(dialog?.textContent).not.toContain(i18n.global.t("oceanbasePrimaryKey.recoveryNotice"));
    expect(dialog?.textContent).not.toContain(i18n.global.t("structureEditor.saved"));
  });

  it("keeps DROP committed and skips ADD when connection becomes invalid after DROP returns", async () => {
    const { editor } = await prepareReorderedKey();
    const store = useConnectionStore();
    const execute = vi.mocked(api.executeQuery).getMockImplementation()!;

    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      const res = await execute(...args);
      if (args[2].includes(" DROP CONSTRAINT ")) {
        setTimeout(async () => {
          await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
          store.connectedIds.add(connection.id);
        }, 0);
      }
      return res;
    });

    await expect(editor.value!.applyChanges()).resolves.toBe(false);

    const statements = vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "));
    expect(statements).toHaveLength(1);
    expect(statements[0]![2]).toContain("DROP CONSTRAINT");

    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.committed"));
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.notExecuted"));
    expect(dialog?.textContent).not.toContain(i18n.global.t("oceanbasePrimaryKey.recoveryNotice"));
  });

  it("fails save and rejects readback if connection changes during post-DDL readback", async () => {
    const { editor } = await prepareReorderedKey();
    const store = useConnectionStore();
    const readConstraints = vi.mocked(api.listConstraints).getMockImplementation()!;

    let ddlComplete = false;
    vi.mocked(api.listConstraints).mockImplementation(async (...args) => {
      if (ddlComplete) {
        await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
        store.connectedIds.add(connection.id);
      }
      return readConstraints(...args);
    });

    const originalExecute = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      const res = await originalExecute(...args);
      if (args[2].includes(" ADD CONSTRAINT ")) {
        ddlComplete = true;
      }
      return res;
    });

    await expect(editor.value!.applyChanges()).resolves.toBe(false);

    const statements = vi.mocked(api.executeQuery).mock.calls.filter((call) => call[2].startsWith("ALTER "));
    expect(statements).toHaveLength(2);

    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(i18n.global.t("oceanbasePrimaryKey.readbackFailed"));
    expect(dialog?.textContent).not.toContain(i18n.global.t("structureEditor.saved"));
  });
});
