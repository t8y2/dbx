// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renderCodeSnapshotHtmlMock } = vi.hoisted(() => ({
  renderCodeSnapshotHtmlMock: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/composables/useTheme", async () => {
  const { ref } = await import("vue");
  return { useTheme: () => ({ isDark: ref(false) }) };
});

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/codeSnapshot/codeSnapshot", () => ({
  renderCodeSnapshotHtml: renderCodeSnapshotHtmlMock,
  snapshotElementToPng: vi.fn(),
  copyPngDataUrlToClipboard: vi.fn(),
  savePngDataUrlToFile: vi.fn(),
}));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      setup(_props, { attrs }) {
        return () => h("input", attrs);
      },
    }),
  };
});

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/switch", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Switch: defineComponent({
      props: { modelValue: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("button", {
            class: "switch-stub",
            "data-model-value": String(props.modelValue),
            onClick: () => emit("update:modelValue", false),
          });
      },
    }),
  };
});

vi.mock("@lucide/vue", async () => {
  const { defineComponent } = await import("vue");
  const Icon = defineComponent({ template: "<span />" });
  return { Camera: Icon, Check: Icon, ClipboardCopy: Icon, Download: Icon, Moon: Icon, Sun: Icon };
});

import CodeSnapshotDialog from "@/components/codeSnapshot/CodeSnapshotDialog.vue";

const mountedApps: App[] = [];

async function mountDialog() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(CodeSnapshotDialog, {
    open: true,
    source: { code: "SELECT 1", lang: "sql" },
  });
  mountedApps.push(app);
  app.mount(container);
  await vi.waitFor(() => expect(renderCodeSnapshotHtmlMock).toHaveBeenCalled());
  return container;
}

beforeEach(() => {
  localStorage.clear();
  renderCodeSnapshotHtmlMock.mockReset().mockResolvedValue('<div class="dbx-code-snapshot">SELECT 1</div>');
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("CodeSnapshotDialog option switches", () => {
  it("rerenders and persists when window controls are disabled", async () => {
    const container = await mountDialog();
    const switches = container.querySelectorAll<HTMLButtonElement>(".switch-stub");

    switches.item(0).click();
    await nextTick();

    await vi.waitFor(() => {
      expect(renderCodeSnapshotHtmlMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ showTrafficLights: false, showLineNumbers: true }));
    });
    expect(JSON.parse(localStorage.getItem("dbx:code-snapshot-settings") ?? "null")).toMatchObject({ showTrafficLights: false, showLineNumbers: true });
  });

  it("rerenders and persists when line numbers are disabled", async () => {
    const container = await mountDialog();
    const switches = container.querySelectorAll<HTMLButtonElement>(".switch-stub");

    switches.item(1).click();
    await nextTick();

    await vi.waitFor(() => {
      expect(renderCodeSnapshotHtmlMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ showTrafficLights: true, showLineNumbers: false }));
    });
    expect(JSON.parse(localStorage.getItem("dbx:code-snapshot-settings") ?? "null")).toMatchObject({ showTrafficLights: true, showLineNumbers: false });
  });
});
