// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, DatabaseType, ObjectSourceKind } from "@/types/database";
import ObjectSourceDialog from "../ObjectSourceDialog.vue";

const ddl = 'CREATE SEQUENCE "APP"."SEQ" START WITH 40 INCREMENT BY 1 NOCACHE;';
const alter = 'ALTER SEQUENCE "APP"."SEQ" INCREMENT BY 1 NOCACHE;';
const mocks = vi.hoisted(() => ({ getObjectSource: vi.fn(), buildEditableObjectSource: vi.fn(), buildExecutableObjectSourceStatements: vi.fn(), executeQuery: vi.fn() }));
// The Rust/backend boundary is mocked; the dialog, CodeMirror editor and shared
// save/production-guard pipeline remain real. Rust builder tests cover the SQL.
vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/api")>()), ...mocks }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
});
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text);
}
function editor() {
  const root = document.querySelector<HTMLElement>('[role="dialog"] .cm-editor');
  return root ? EditorView.findFromDOM(root) : null;
}
async function mount(options: { databaseType?: DatabaseType; initialEditing?: boolean; editable?: boolean; type?: ObjectSourceKind; source?: string } = {}) {
  const databaseType = options.databaseType ?? "oceanbase-oracle",
    objectType = options.type ?? "SEQUENCE",
    source = options.source ?? ddl;
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  vi.spyOn(store, "getConfig").mockReturnValue({ id: "ob", name: "test", db_type: databaseType } as ConnectionConfig);
  mocks.getObjectSource.mockResolvedValue({ name: "SEQ", schema: "APP", object_type: objectType, source, editable: options.editable !== false });
  mocks.buildEditableObjectSource.mockResolvedValue(objectType === "SEQUENCE" && databaseType === "oceanbase-oracle" ? alter : source);
  mocks.buildExecutableObjectSourceStatements.mockResolvedValue([objectType === "SEQUENCE" ? alter : source]);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0 });
  const saved = vi.fn();
  const state = reactive({ open: true, connectionId: "ob", database: "service", schema: "APP", name: "SEQ" });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(ObjectSourceDialog, { ...state, objectType, databaseType, dialect: "mysql", formatDialect: "plsql", initialEditing: options.initialEditing ?? false, onSaved: saved }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(editor()).not.toBeNull(), { timeout: 10_000 });
  return { saved, state };
}

describe("OceanBase sequence source through the shared Oracle object dialog", () => {
  it("previews the CREATE DDL read-only and switches to the backend ALTER draft only on edit", async () => {
    await mount();
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(true);
    expect(editor()!.state.doc.toString()).toMatch(/CREATE\s+SEQUENCE/i);
    expect(editor()!.state.doc.toString()).toMatch(/START\s+WITH\s+40/i);
    expect(mocks.buildEditableObjectSource).toHaveBeenCalledWith({ databaseType: "oceanbase-oracle", objectType: "SEQUENCE", schema: "APP", name: "SEQ", source: ddl });
    button("contextMenu.editView")!.click();
    await vi.waitFor(() => expect(editor()!.state.facet(EditorState.readOnly)).toBe(false));
    expect(editor()!.state.doc.toString()).toBe(alter);
    expect(editor()!.state.doc.toString()).not.toContain("START WITH");
  });
  it("saves only the generated ALTER and reloads the original object", async () => {
    const { saved } = await mount({ initialEditing: true });
    expect(editor()!.state.doc.toString()).toBe(alter);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.buildExecutableObjectSourceStatements).toHaveBeenCalledWith({ databaseType: "oceanbase-oracle", objectType: "SEQUENCE", schema: "APP", name: "SEQ", source: alter });
    expect(mocks.executeQuery).toHaveBeenCalledExactlyOnceWith("ob", "service", alter, "APP");
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(editor()!.state.facet(EditorState.readOnly)).toBe(true));
  });
  it.each([false, true])("leaves native Oracle sequences read-only (initialEditing=%s)", async (initialEditing) => {
    await mount({ databaseType: "oracle", initialEditing });
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(true);
    expect(editor()!.state.doc.toString()).toMatch(/CREATE\s+SEQUENCE/i);
    expect(button("contextMenu.editView")).toBeUndefined();
    expect(button("objects.saveSource")).toBeUndefined();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
  it("honors a driver-declared read-only OceanBase object", async () => {
    await mount({ editable: false, initialEditing: true });
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(true);
    expect(button("contextMenu.editView")).toBeUndefined();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
  it("does not execute a sequence save after the selected connection changes during SQL generation", async () => {
    const { saved, state } = await mount({ initialEditing: true });
    let complete!: (value: string[]) => void;
    const pending = new Promise<string[]>((resolve) => {
      complete = resolve;
    });
    mocks.buildExecutableObjectSourceStatements.mockReturnValueOnce(pending);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(mocks.buildExecutableObjectSourceStatements).toHaveBeenCalledOnce());
    state.connectionId = "another-connection";
    await nextTick();
    complete([alter]);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });
  it("keeps synonym replacement on the existing source editor path", async () => {
    const source = 'CREATE OR REPLACE SYNONYM "APP"."SEQ" FOR "APP"."TARGET";';
    const { saved } = await mount({ type: "SYNONYM", source, initialEditing: true });
    expect(editor()!.state.doc.toString()).toBe(source);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.executeQuery).toHaveBeenCalledExactlyOnceWith("ob", "service", source, "APP");
  });
});
