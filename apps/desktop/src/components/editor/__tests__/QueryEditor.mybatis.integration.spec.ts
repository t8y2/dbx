// @vitest-environment happy-dom

import { createApp, h, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import QueryEditor from "../QueryEditor.vue";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe("mounted QueryEditor MyBatis settings", () => {
  it("updates comment parsing when global or per-database substitution changes", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settings = useSettingsStore();
    settings.editorSettings.sqlVariableSubstitutionEnabled = true;
    settings.editorSettings.sqlVariableSyntaxOverrides = {};
    const state = reactive({ sql: "SELECT * FROM t WHERE id = #{工厂编号} AND active = 1 # real comment" });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(QueryEditor, {
          modelValue: state.sql,
          tabId: "mybatis-integration",
          databaseType: "mysql",
          dialect: "mysql",
          autoFocus: false,
          "onUpdate:modelValue": (value: string) => {
            state.sql = value;
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
    await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    const at = (text: string) => ensureSyntaxTree(view.state, view.state.doc.length, 500)!.resolveInner(state.sql.indexOf(text) + 1).name;
    expect(at("AND")).toBe("Keyword");
    expect(at("real comment")).toBe("LineComment");
    settings.editorSettings.sqlVariableSyntaxOverrides = { mysql: { mybatis: false } };
    await vi.waitFor(() => expect(at("AND")).toBe("LineComment"));
    settings.editorSettings.sqlVariableSyntaxOverrides = {};
    await vi.waitFor(() => expect(at("AND")).toBe("Keyword"));
    settings.editorSettings.sqlVariableSubstitutionEnabled = false;
    await vi.waitFor(() => expect(at("AND")).toBe("LineComment"));
    settings.editorSettings.sqlVariableSubstitutionEnabled = true;
    await vi.waitFor(() => expect(at("AND")).toBe("Keyword"));
    expect(view.state.doc.toString()).toBe(state.sql);
  });
});
