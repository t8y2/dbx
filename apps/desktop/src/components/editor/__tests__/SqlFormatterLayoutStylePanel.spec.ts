// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: vi.fn() }));
vi.mock("@/lib/editor/codemirrorSearchKeymap", () => ({ searchKeymapWithoutModD: vi.fn() }));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { Upload: icon, Download: icon, RotateCcw: icon, WandSparkles: icon, Save: icon, Copy: icon };
});

vi.mock("@/components/ui/button", async () => ({
  Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button"),
}));
vi.mock("@/components/ui/label", async () => ({
  Label: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Label", "label"),
}));
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const Select = defineComponent({
    name: "Select",
    props: { modelValue: { type: [String, Number], default: "" } },
    emits: ["update:modelValue"],
    setup(props, { emit, slots }) {
      return () =>
        h(
          "div",
          {
            "data-stub": "Select",
            "data-model-value": String(props.modelValue),
            onPick: (event: CustomEvent<{ value: string }>) => emit("update:modelValue", event.detail.value),
          },
          [slots.default?.()],
        );
    },
  });
  return {
    Select,
    SelectContent: createPassthroughStub("SelectContent"),
    SelectItem: createPassthroughStub("SelectItem", "button"),
    SelectTrigger: createPassthroughStub("SelectTrigger", "button"),
    SelectValue: createPassthroughStub("SelectValue", "span"),
  };
});
vi.mock("@/components/ui/switch", async () => ({
  Switch: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Switch", "input"),
}));
vi.mock("@/components/ui/tabs", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Tabs: createPassthroughStub("Tabs"),
    TabsContent: createPassthroughStub("TabsContent"),
    TabsList: createPassthroughStub("TabsList"),
    TabsTrigger: createPassthroughStub("TabsTrigger", "button"),
  };
});

import SqlFormatterSettingsPanel from "@/components/editor/SqlFormatterSettingsPanel.vue";

describe("SQL formatter layout style panel", () => {
  let app: App<Element> | null = null;
  let host: HTMLDivElement | null = null;

  function mountPanel(modelValue: unknown, update: ReturnType<typeof vi.fn>) {
    host = document.createElement("div");
    document.body.append(host);
    app = createApp(SqlFormatterSettingsPanel, { modelValue, "onUpdate:modelValue": update });
    app.mount(host);
    return host;
  }

  afterEach(() => {
    app?.unmount();
    app = null;
    host?.remove();
    host = null;
  });

  it("selects the DBX layout by default and preserves other formatter settings", async () => {
    const update = vi.fn();
    const root = mountPanel(DEFAULT_SQL_FORMATTER_SETTINGS, update);

    const styleSelect = root.querySelector('[data-model-value="dbx"]');
    expect(styleSelect).not.toBeNull();
    const layoutOptions = Array.from(styleSelect!.querySelectorAll('[data-stub="SelectItem"]')).map((node) => node.getAttribute("value"));
    expect(layoutOptions).toEqual(["classic", "dbx"]);

    styleSelect!.dispatchEvent(new CustomEvent("pick", { detail: { value: "classic" } }));
    await nextTick();
    expect(update).toHaveBeenLastCalledWith({ ...DEFAULT_SQL_FORMATTER_SETTINGS, layoutStyle: "classic" });
  });

  it("restores the current formatter defaults", async () => {
    const update = vi.fn();
    const root = mountPanel({ ...DEFAULT_SQL_FORMATTER_SETTINGS, layoutStyle: "dbx", expressionWidth: 50 }, update);

    const restoreButton = Array.from(root.querySelectorAll("button")).find((node) => node.textContent?.includes("settings.sqlFormatterRestoreDefaults"));
    expect(restoreButton).toBeDefined();
    restoreButton!.click();
    await nextTick();

    expect(update).toHaveBeenCalledWith(DEFAULT_SQL_FORMATTER_SETTINGS);
  });
});
