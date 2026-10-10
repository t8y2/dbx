// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";

vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 14, fontFamily: "monospace" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: ref(false) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it.each([true, false])("program preview readOnly=%s controls actual editor editing and emitted SQL", async (readOnly) => {
  const update = vi.fn();
  const previewReadOnly = ref(readOnly);
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(SchemaDiffDeployStep, { deploySql: "CREATE PACKAGE P AS END;", selectedObjects: [], targetConnectionId: "target", targetDatabase: "test", targetSchema: "DST", executing: false, readOnly: previewReadOnly.value, "onUpdate:deploySql": update }) });
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: { diff: { routinePreviewReadOnly: "Program SQL is read-only" } } } }));
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull());
  const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")! as HTMLElement)!;
  expect(editor.state.facet(EditorState.readOnly)).toBe(readOnly);
  expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe(String(!readOnly));
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "edited" } });
  await nextTick();
  if (readOnly) {
    expect(update).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Program SQL is read-only");
  } else expect(update).toHaveBeenCalledWith("edited");
  previewReadOnly.value = !readOnly;
  await vi.waitFor(() => expect(editor.state.facet(EditorState.readOnly)).toBe(!readOnly));
  expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe(String(readOnly));
});

async function mountDeployStep(extraProps: Record<string, unknown> = {}, onIgnoreForeignKeyChecks?: (value: boolean) => void) {
  const state = reactive({ ignoreForeignKeyChecks: false });
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(SchemaDiffDeployStep, {
          deploySql: "ALTER TABLE users ADD COLUMN nickname varchar(64);",
          selectedObjects: [],
          targetConnectionId: "mysql-1",
          targetDatabase: "shop",
          targetSchema: "shop",
          executing: false,
          ...extraProps,
          ignoreForeignKeyChecks: state.ignoreForeignKeyChecks,
          "onUpdate:ignoreForeignKeyChecks": (value: boolean) => {
            state.ignoreForeignKeyChecks = value;
            onIgnoreForeignKeyChecks?.(value);
          },
        }),
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(container);
  await nextTick();
  await vi.waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
  return { container, state };
}

function foreignKeyCheckbox(container: HTMLElement): HTMLInputElement | null {
  const label = [...container.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.includes("diff.ignoreForeignKeyChecks"));
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

describe("SchemaDiffDeployStep foreign key check option", () => {
  it("offers the option next to the export button for a MySQL target and leaves it unchecked by default", async () => {
    const { container } = await mountDeployStep({ showIgnoreForeignKeyChecks: true });

    const checkbox = foreignKeyCheckbox(container);
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.closest("label")?.textContent).toContain("diff.ignoreForeignKeyChecks");
    expect(container.textContent).toContain("diff.exportSql");
  });

  it("keeps the option out of the footer for targets whose engine has no FOREIGN_KEY_CHECKS", async () => {
    const { container } = await mountDeployStep({ showIgnoreForeignKeyChecks: false });

    expect(foreignKeyCheckbox(container)).toBeNull();
    expect(container.textContent).not.toContain("diff.ignoreForeignKeyChecks");
  });

  it("reports the ticked and unticked states to the dialog", async () => {
    const updates: boolean[] = [];
    const { container, state } = await mountDeployStep({ showIgnoreForeignKeyChecks: true }, (value) => updates.push(value));

    const checkbox = foreignKeyCheckbox(container)!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();

    expect(updates).toEqual([true, false]);
    expect(state.ignoreForeignKeyChecks).toBe(false);
  });

  it("disables the option while a deploy is running", async () => {
    const { container } = await mountDeployStep({ showIgnoreForeignKeyChecks: true, executing: true });

    expect(foreignKeyCheckbox(container)?.disabled).toBe(true);
  });
});
