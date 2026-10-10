// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 12, fontFamily: "monospace" } }),
}));

vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/lib/editor/editorThemes", () => ({
  loadEditorTheme: async () => [],
  editorFontTheme: () => [],
}));

vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));

// The deploy script preview is a CodeMirror view; the option under test lives in
// the footer, so the editor is replaced with the smallest view that still accepts
// the component's document updates.
vi.mock("@codemirror/view", () => ({
  EditorView: class {
    static scrollIntoView = vi.fn(() => ({}));
    static updateListener = { of: () => [] };
    state: { doc: { toString: () => string; length: number } };
    constructor(config: { state: { doc: { toString: () => string; length: number } } }) {
      this.state = config.state;
    }
    dispatch() {}
    destroy() {}
  },
}));

vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: (config: { doc: string }) => ({ doc: { toString: () => config.doc, length: config.doc.length } }),
  },
  Compartment: class {
    of() {
      return [];
    }
  },
}));

vi.mock("@codemirror/lang-sql", () => ({ sql: () => [] }));

vi.mock("codemirror", () => ({ basicSetup: [] }));

const mountedApps: App[] = [];

async function mountDeployStep(extraProps: Record<string, unknown> = {}, onIgnoreForeignKeyChecks?: (value: boolean) => void) {
  const state = reactive({ ignoreForeignKeyChecks: false });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
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
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { container, state };
}

function foreignKeyCheckbox(container: HTMLElement): HTMLInputElement | null {
  const label = [...container.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.includes("diff.ignoreForeignKeyChecks"));
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

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
