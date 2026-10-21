// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS, serializeSqlFormatterConfig } from "@/lib/sql/sqlFormatterConfig";
import { formatSqlText } from "@/lib/sql/sqlFormatter";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key}: ${values.option ?? values.message ?? ""}` : key) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: vi.fn() }));
vi.mock("@/lib/editor/codemirrorSearchKeymap", () => ({ searchKeymapWithoutModD: vi.fn() }));
vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { Upload: icon, Download: icon, RotateCcw: icon, WandSparkles: icon, Save: icon, Copy: icon };
});
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/label", async () => ({ Label: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Label", "label") }));
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const Select = defineComponent({
    props: { modelValue: { type: [String, Number], default: "" } },
    emits: ["update:modelValue"],
    setup(_props, { emit, slots }) {
      return () => h("div", { onPick: (event: CustomEvent<{ value: string }>) => emit("update:modelValue", event.detail.value) }, [slots.default?.()]);
    },
  });
  return { Select, SelectContent: createPassthroughStub("SelectContent"), SelectItem: createPassthroughStub("SelectItem", "button"), SelectTrigger: createPassthroughStub("SelectTrigger", "button"), SelectValue: createPassthroughStub("SelectValue", "span") };
});
vi.mock("@/components/ui/switch", () => ({
  Switch: defineComponent({
    props: { id: String, modelValue: Boolean },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () => h("input", { type: "checkbox", id: props.id, checked: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).checked) });
    },
  }),
}));
vi.mock("@/components/ui/tabs", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const Tabs = defineComponent({
    props: { modelValue: String },
    emits: ["update:modelValue"],
    setup(_props, { emit, slots }) {
      return () =>
        h(
          "div",
          {
            onClick: (event: MouseEvent) => {
              const trigger = (event.target as HTMLElement).closest("button");
              if (trigger?.textContent?.includes("settings.sqlFormatterJsonMode")) emit("update:modelValue", "json");
              else if (trigger?.textContent?.includes("settings.sqlFormatterFormMode")) emit("update:modelValue", "form");
            },
          },
          [slots.default?.()],
        );
    },
  });
  return { Tabs, TabsContent: createPassthroughStub("TabsContent"), TabsList: createPassthroughStub("TabsList"), TabsTrigger: createPassthroughStub("TabsTrigger", "button") };
});

import SqlFormatterSettingsPanel from "@/components/editor/SqlFormatterSettingsPanel.vue";

describe("SQL formatter settings panel rules and preview", () => {
  let app: App<Element> | null = null;
  let host: HTMLDivElement | null = null;

  function mountPanel(value = DEFAULT_SQL_FORMATTER_SETTINGS) {
    const update = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    app = createApp(SqlFormatterSettingsPanel, { modelValue: value, "onUpdate:modelValue": update });
    app.mount(host);
    return { root: host, update };
  }

  afterEach(() => {
    vi.useRealTimers();
    app?.unmount();
    app = null;
    host?.remove();
    host = null;
  });

  it("emits real rule values and keeps them when the feature is switched off", async () => {
    const current = { ...DEFAULT_SQL_FORMATTER_SETTINGS, selectListLayout: "wrap" as const, customRulesEnabled: true };
    const { root, update } = mountPanel(current);
    const selectLayout = Array.from(root.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("settings.sqlFormatterSelectListLayout"))
      ?.querySelector("select");
    expect(selectLayout).not.toBeNull();
    selectLayout!.value = "fit";
    selectLayout!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(update).toHaveBeenLastCalledWith({ ...current, selectListLayout: "fit" });

    const enabled = root.querySelector<HTMLInputElement>("#sql-formatter-custom-rules")!;
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    expect(update).toHaveBeenLastCalledWith({ ...current, customRulesEnabled: false });
    expect(selectLayout!.value).toBe("fit");
  });

  it("labels DML comma positions as comma placement and associates the width label", () => {
    const { root } = mountPanel({ ...DEFAULT_SQL_FORMATTER_SETTINGS, customRulesEnabled: true });
    const commaSelect = Array.from(root.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("settings.sqlFormatterSelectCommaPosition"))
      ?.querySelector("select");
    expect(Array.from(commaSelect!.options).map((option) => [option.value, option.textContent])).toEqual([
      ["inherit", "settings.sqlFormatterRule_inherit"],
      ["after", "settings.sqlFormatterCommaPositionAfter"],
      ["before", "settings.sqlFormatterCommaPositionBefore"],
    ]);
    expect(root.querySelector('label[for="sql-formatter-expression-width"]')?.textContent).toBe("settings.sqlFormatterExpressionWidth");
    expect(root.querySelector("#sql-formatter-expression-width")).not.toBeNull();
  });

  it("uses the new option label when JSON config contains an invalid rule value", async () => {
    const { root, update } = mountPanel();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("settings.sqlFormatterJsonMode"))
      ?.click();
    await nextTick();
    const config = JSON.parse(serializeSqlFormatterConfig(DEFAULT_SQL_FORMATTER_SETTINGS));
    config.options.selectListLayout = "invalid";
    const jsonEditor = root.querySelector<HTMLTextAreaElement>("textarea:not([aria-label]):not(#sql-formatter-param-types)")!;
    jsonEditor.value = JSON.stringify(config);
    jsonEditor.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(root.textContent).toContain("settings.sqlFormatterConfigErrorInvalidOptionValue: settings.sqlFormatterSelectListLayout");
    expect(update).not.toHaveBeenCalled();
  });

  it.each([20, 76, 500])("accepts expression width %i", async (width) => {
    const { root, update } = mountPanel();
    const input = root.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = String(width);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(update).toHaveBeenLastCalledWith({ ...DEFAULT_SQL_FORMATTER_SETTINGS, expressionWidth: width });
  });

  it.each([19, 501, 76.5])("does not emit out-of-range or fractional width %s", (width) => {
    const { root, update } = mountPanel();
    const input = root.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = String(width);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(update).not.toHaveBeenCalled();
  });

  it("previews through the production formatter and retains old output after an error, then recovers", async () => {
    vi.useFakeTimers();
    const { root } = mountPanel({ ...DEFAULT_SQL_FORMATTER_SETTINGS, customRulesEnabled: true, selectListLayout: "vertical" });
    const source = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="settings.sqlFormatterPreviewSource"]')!;
    source.value = "SELECT id, name FROM users;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    const expected = await formatSqlText(source.value, "oracle", { ...DEFAULT_SQL_FORMATTER_SETTINGS, customRulesEnabled: true, selectListLayout: "vertical" });
    await nextTick();
    expect(root.querySelector("pre")?.textContent).toBe(expected);

    source.value = "<root/>";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("settings.sqlFormatterPreviewFailed");
    expect(root.querySelector("pre")?.textContent).toBe(expected);
    expect(root.textContent).toContain("settings.sqlFormatterPreviewStale");

    source.value = "SELECT 2 FROM dual;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    expect(root.querySelector("pre")?.textContent).toBe(await formatSqlText(source.value, "oracle", { ...DEFAULT_SQL_FORMATTER_SETTINGS, customRulesEnabled: true, selectListLayout: "vertical" }));
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a fallback diagnostic for a procedure block and clears it after PostgreSQL SQL succeeds", async () => {
    vi.useFakeTimers();
    const { root } = mountPanel({ ...DEFAULT_SQL_FORMATTER_SETTINGS, customRulesEnabled: true, selectListLayout: "vertical" });
    const source = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="settings.sqlFormatterPreviewSource"]')!;
    const dialect = Array.from(root.querySelectorAll("select")).find((select) => Array.from(select.options).some((option) => option.value === "postgres"))!;
    source.value = "BEGIN\n  UPDATE users SET name = 'Ada' WHERE id = 1;\nEND;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    expect(root.querySelector('[role="status"]')?.textContent).toContain("settings.sqlFormatterFallbackNotice");

    dialect.value = "postgres";
    dialect.dispatchEvent(new Event("change", { bubbles: true }));
    source.value = "SELECT id, name FROM users;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    const expected = await formatSqlText(source.value, "postgres", { ...DEFAULT_SQL_FORMATTER_SETTINGS, customRulesEnabled: true, selectListLayout: "vertical" });
    expect(root.querySelector("pre")?.textContent).toBe(expected);
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it("takes only the latest scheduled preview and invalidates pending work on unmount", async () => {
    vi.useFakeTimers();
    const { root } = mountPanel();
    const source = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="settings.sqlFormatterPreviewSource"]')!;
    source.value = "SELECT 1 FROM dual;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    // Start the first production formatter request at its async module boundary,
    // then supersede it before the promise resolves.
    vi.advanceTimersByTime(180);
    source.value = "SELECT 2 FROM dual;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    expect(root.querySelector("pre")?.textContent).toBe(await formatSqlText(source.value, "oracle", DEFAULT_SQL_FORMATTER_SETTINGS));

    source.value = "SELECT 3 FROM dual;";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    app?.unmount();
    app = null;
    await vi.advanceTimersByTimeAsync(500);
    expect(root.textContent).not.toContain("SELECT 3");
  });
});
