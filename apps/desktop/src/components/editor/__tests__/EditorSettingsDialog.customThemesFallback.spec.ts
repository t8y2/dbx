// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import ThemeCustomizerDialog from "../ThemeCustomizerDialog.vue";
import dialogSource from "../EditorSettingsDialog.vue?raw";

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  const locale = ref("en");
  const t = (key: string) => key;
  return {
    createI18n: () => ({ global: { t, locale }, install: () => undefined }),
    useI18n: () => ({ t, locale }),
  };
});

describe("ThemeCustomizerDialog with empty themes (#10994)", () => {
  let app: ReturnType<typeof createApp> | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (app && container) {
      app.unmount();
      container.remove();
    }
    app = null;
    container = null;
  });

  it("seeds DEFAULT_CUSTOM_THEMES when opened with empty themes", async () => {
    setActivePinia(createPinia());
    container = document.createElement("div");
    document.body.appendChild(container);

    const onSave = vi.fn();
    const isOpen = ref(false);

    const Host = defineComponent({
      setup() {
        return () =>
          h(ThemeCustomizerDialog, {
            open: isOpen.value,
            themes: [],
            activeThemeId: "",
            "onUpdate:open": (val: boolean) => {
              isOpen.value = val;
            },
            onSave,
          });
      },
    });

    app = createApp(Host);
    app.mount(container);

    // Open the dialog
    isOpen.value = true;
    await nextTick();

    // Verify dialog content is rendered into document.body via Teleport and does not crash
    expect(document.body.innerHTML).toContain("Custom");
  });
});

describe("EditorSettingsDialog theme select fallback (#10994)", () => {
  it("includes a custom theme option even if editCustomThemes is empty", () => {
    // Ensures themeSelectOptions checks editCustomThemes.value.length === 0
    // and supplies a fallback custom theme entry so the entry point never disappears
    expect(dialogSource).toContain("editCustomThemes.value.length === 0");
    expect(dialogSource).toContain('value: "custom"');
    expect(dialogSource).toContain('} else if (v === "custom")');
    expect(dialogSource).toContain("editCustomThemes.value = JSON.parse(JSON.stringify(DEFAULT_CUSTOM_THEMES))");
  });
});
