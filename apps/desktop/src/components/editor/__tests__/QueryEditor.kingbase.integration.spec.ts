// @vitest-environment happy-dom

import { createApp, h, nextTick, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { syntaxTree } from "@codemirror/language";
import { EditorView, showTooltip } from "@codemirror/view";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { afterEach, describe, expect, it } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function mountEditor(mode?: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.editorSettings.showExecutionTargetPicker = false;
  settings.editorSettings.completionTriggerMode = "manual";
  settings.editorSettings.sqlSemanticDiagnosticsEnabled = false;
  const store = useConnectionStore();
  store.connections.push({ id: "kingbase-synthetic", name: "Synthetic Kingbase", db_type: "kingbase", host: "example.test", port: 54321, username: "synthetic", password: "", database_info: { compatibilityMode: mode } });
  const sql = shallowRef("SELECT ");
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: sql.value,
        connectionId: "kingbase-synthetic",
        databaseType: "kingbase",
        dialect: "postgres",
        autoFocus: false,
        "onUpdate:modelValue": (value: string) => {
          sql.value = value;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await expect.poll(() => host.querySelector(".cm-editor")).not.toBeNull();
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { view, store, host, sql };
}

function signatureText(view: EditorView): string {
  return view.state
    .facet(showTooltip)
    .flatMap((tooltip) => (tooltip ? [tooltip.create(view).dom.textContent ?? ""] : []))
    .join("\n");
}

describe("Kingbase editor mode integration (synthetic metadata)", () => {
  it("invalidates active completion results when the reported mode changes", async () => {
    const { view, store, sql } = await mountEditor("pg");
    sql.value = "SELECT IF";
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state).map((option) => option.label)).not.toContain("IFNULL");
    store.getConfig("kingbase-synthetic")!.database_info = { compatibilityMode: "mysql" };
    await nextTick();
    startCompletion(view);
    await expect.poll(() => currentCompletions(view.state).map((option) => option.label)).toContain("IFNULL");
  });

  it.each([
    ["pg", "JSONB_BUILD_OBJECT"],
    ["oracle", "NVL"],
    ["mysql", "IFNULL"],
    ["sqlserver", "GETDATE"],
  ])("uses %s function completion and signatures without changing the native connection", async (mode, functionName) => {
    const { view, store, sql } = await mountEditor(mode);
    sql.value = `SELECT ${functionName.slice(0, 3)}`;
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(startCompletion(view)).toBe(true);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state).map((option) => option.label)).toContain(functionName);
    sql.value = `SELECT ${functionName}(`;
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await expect.poll(() => signatureText(view)).toContain(`${functionName}(`);
    expect(store.getConfig("kingbase-synthetic")?.db_type).toBe("kingbase");
  });

  it("removes a previous mode's function signature when the mode changes", async () => {
    const { view, store, sql } = await mountEditor("mysql");
    sql.value = "SELECT IFNULL(";
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await expect.poll(() => signatureText(view)).toContain("IFNULL(");
    store.getConfig("kingbase-synthetic")!.database_info = { compatibilityMode: "pg" };
    await nextTick();
    await expect.poll(() => signatureText(view)).not.toContain("IFNULL(");
  });

  it("reconfigures the same mounted editor when mode metadata arrives and changes", async () => {
    const { view, store, host, sql } = await mountEditor();
    sql.value = "SELECT `name` FROM t";
    await nextTick();
    const tokenStart = sql.value.indexOf("`name`") + 1;
    expect(syntaxTree(view.state).resolveInner(tokenStart).name).not.toBe("QuotedIdentifier");
    store.getConfig("kingbase-synthetic")!.database_info = { compatibilityMode: "mysql" };
    await nextTick();
    expect(syntaxTree(view.state).resolveInner(tokenStart).name).toBe("QuotedIdentifier");
    store.getConfig("kingbase-synthetic")!.database_info = { compatibilityMode: "sqlserver" };
    sql.value = "SELECT [name] FROM #temp";
    await nextTick();
    expect(syntaxTree(view.state).resolveInner(sql.value.indexOf("#temp") + 1).name).toBe("SpecialVar");
    const word = view.state.wordAt(sql.value.indexOf("#temp") + 1)!;
    expect(view.state.sliceDoc(word.from, word.to)).toBe("#temp");
    expect(host.querySelector(".cm-editor")).toBe(view.dom);
  });
});
