// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogFooter: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean },
      setup(props, { slots, emit }) {
        return () =>
          h(
            "button",
            {
              disabled: props.disabled,
              onClick: () => emit("click"),
            },
            slots.default?.(),
          );
      },
    }),
  };
});

vi.mock("@/components/ui/scroll-area", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    ScrollArea: defineComponent({
      setup(_props, { slots }) {
        return () => h("div", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/icons/DatabaseIcon.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      setup() {
        return () => h("span");
      },
    }),
  };
});

import ConfigConnectionSelectDialog from "@/components/config/ConfigConnectionSelectDialog.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

function conn(id: string, name: string): ConnectionConfig {
  return { id, name, db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "secret" };
}

async function mountDialog(props: Record<string, unknown>, onConfirm = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(ConfigConnectionSelectDialog, { ...props, onConfirm });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return { onConfirm };
}

describe("ConfigConnectionSelectDialog", () => {
  it("defaults to all selected and confirms the current selection", async () => {
    i18n.global.locale.value = "en";
    const { onConfirm } = await mountDialog({
      open: true,
      mode: "export",
      connections: [conn("a", "Alpha"), conn("b", "Beta")],
    });

    expect(document.body.textContent).toContain("2 / 2");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Next"));
    expect(confirm).toBeTruthy();
    confirm?.click();
    expect(onConfirm).toHaveBeenCalledWith(["a", "b"]);
  });

  it("disables confirm when nothing is selected", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({
      open: true,
      mode: "import",
      connections: [conn("a", "Alpha")],
    });

    const deselect = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Deselect all"));
    deselect?.click();
    await nextTick();
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Import"));
    expect(confirm?.disabled).toBe(true);
  });

  it("disables selection controls while an import is being applied", async () => {
    i18n.global.locale.value = "en";
    const { onConfirm } = await mountDialog({
      open: true,
      mode: "import",
      busy: true,
      connections: [conn("a", "Alpha")],
    });

    const buttons = [...document.body.querySelectorAll("button")];
    const selectAll = buttons.find((button) => button.textContent?.includes("Select all"));
    const deselectAll = buttons.find((button) => button.textContent?.includes("Deselect all"));
    const confirm = buttons.find((button) => button.textContent?.includes("Import"));
    expect(selectAll?.disabled).toBe(true);
    expect(deselectAll?.disabled).toBe(true);
    expect(confirm?.disabled).toBe(true);
    expect(document.body.querySelector("input[type='checkbox']")?.hasAttribute("disabled")).toBe(true);
    confirm?.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
