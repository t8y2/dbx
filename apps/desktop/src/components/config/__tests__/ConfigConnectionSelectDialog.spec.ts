// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots, attrs }) {
      return () => h("div", attrs, slots.default?.());
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
      setup(_props, { slots, attrs }) {
        return () => h("div", { "data-slot": "scroll-area", ...attrs }, slots.default?.());
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

function conn(id: string, name: string, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id, name, db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "secret", ...overrides };
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

  it.each(["export", "import"] as const)("keeps long connection text in a shrinkable list for %s mode", async (mode) => {
    i18n.global.locale.value = "en";
    const longName = "very-long-connection-name-" + "x".repeat(96);
    const longHost = "very-long-hostname-or-endpoint-" + "x".repeat(76) + ".internal.example.com";
    await mountDialog({
      open: true,
      mode,
      connections: [conn("short", "Short connection"), conn("long-name", longName), conn("long-endpoint", "Long endpoint", { host: longHost, database: "long_database_name_" + "y".repeat(48) })],
    });

    const scrollArea = document.querySelector('[data-slot="scroll-area"]');
    expect(scrollArea?.classList).toContain("min-w-0");
    expect(document.querySelectorAll("label")).toHaveLength(3);
    expect(document.querySelectorAll("label > span.min-w-0.flex-1")).toHaveLength(3);
    expect(document.querySelectorAll("label .truncate")).toHaveLength(6);
    expect(document.body.textContent).toContain("3 / 3");
    expect(document.body.textContent).toContain(longName);
    expect(document.body.textContent).toContain(longHost);
    const confirm = [...document.body.querySelectorAll("button")].find((button) => (mode === "export" ? button.textContent?.includes("Next") : button.textContent?.includes("Import")));
    expect(confirm).toBeTruthy();
    expect(confirm?.disabled).toBe(false);
  });

  it("keeps the confirm action alongside many connections with long metadata", async () => {
    i18n.global.locale.value = "en";
    const longName = "many-connection-long-name-" + "x".repeat(96);
    const longHost = "many-connection-long-host-" + "y".repeat(76) + ".internal.example.com";
    const connections = Array.from({ length: 60 }, (_, index) => conn(`connection-${index}`, index === 31 ? longName : `Connection ${index + 1}`, index === 44 ? { host: longHost } : {}));
    await mountDialog({ open: true, mode: "export", connections });

    const scrollArea = document.querySelector('[data-slot="scroll-area"]');
    expect(scrollArea?.classList).toContain("min-w-0");
    expect(document.querySelectorAll("label")).toHaveLength(60);
    expect(document.body.textContent).toContain(longName);
    expect(document.body.textContent).toContain(longHost);
    expect([...document.body.querySelectorAll("button")].some((button) => button.textContent?.includes("Next"))).toBe(true);
  });

  it("selects the connections inside a group from the tree", async () => {
    i18n.global.locale.value = "en";
    const layout: SidebarLayout = {
      groups: [{ id: "production", name: "Production", collapsed: false }],
      order: [
        { type: "group", id: "production", children: [{ type: "connection", id: "a" }] },
        { type: "connection", id: "b" },
      ],
    };
    const { onConfirm } = await mountDialog({
      open: true,
      mode: "export",
      connections: [conn("a", "Alpha"), conn("b", "Beta")],
      layout,
    });

    expect(document.body.textContent).toContain("Production");
    const deselect = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Deselect all"));
    deselect?.click();
    await nextTick();
    const checkboxes = [...document.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
    expect(checkboxes).toHaveLength(3);
    checkboxes[0].click();
    await nextTick();
    expect(document.body.textContent).toContain("1 / 2");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Next"));
    confirm?.click();
    expect(onConfirm).toHaveBeenCalledWith(["a"]);
  });

  describe("search and sort", () => {
    const layout: SidebarLayout = {
      groups: [
        { id: "production", name: "Production", collapsed: false },
        { id: "staging", name: "Staging", collapsed: false },
      ],
      order: [
        { type: "connection", id: "zebra" },
        { type: "group", id: "staging", children: [{ type: "connection", id: "delta" }] },
        {
          type: "group",
          id: "production",
          children: [
            { type: "connection", id: "alpha" },
            { type: "connection", id: "beta" },
          ],
        },
        { type: "connection", id: "gamma" },
      ],
    };
    const connections = [conn("alpha", "Alpha"), conn("beta", "Beta"), conn("gamma", "Gamma"), conn("delta", "Delta"), conn("zebra", "Zebra")];

    function renderedLabels(): string[] {
      return [...document.querySelectorAll("label")].map((label) => label.querySelector("span.block.truncate")?.textContent?.trim() ?? "");
    }

    function renderedGroupNames(): string[] {
      return [...document.querySelectorAll("button[aria-label]")].map((button) => button.getAttribute("aria-label") ?? "");
    }

    async function typeSearch(value: string) {
      const input = document.querySelector<HTMLInputElement>('[data-slot="input"]');
      expect(input).toBeTruthy();
      input!.value = value;
      input!.dispatchEvent(new Event("input"));
      await nextTick();
      await nextTick();
    }

    it("filters by connection name and keeps ancestor groups for context", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout });

      expect(renderedLabels()).toHaveLength(5);
      await typeSearch("bet");

      expect(renderedLabels()).toEqual(["Beta"]);
      expect(renderedGroupNames()).toEqual(["Production"]);
    });

    it("is case-insensitive", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout });

      await typeSearch("ZEB");

      expect(renderedLabels()).toEqual(["Zebra"]);
    });

    it("shows a matching group with its entire subtree", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout });

      await typeSearch("production");

      expect(renderedGroupNames()).toEqual(["Production"]);
      expect(renderedLabels()).toEqual(["Alpha", "Beta"]);
    });

    it("shows the localized no-results message when nothing matches", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout });

      await typeSearch("does-not-exist");

      expect(renderedLabels()).toHaveLength(0);
      expect(document.body.textContent).toContain("No matching groups or connections");
    });

    it("restores the full tree after clearing the query", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout });

      await typeSearch("del");
      expect(renderedLabels()).toEqual(["Delta"]);

      await typeSearch("");

      expect(renderedLabels()).toEqual(["Zebra", "Delta", "Alpha", "Beta", "Gamma"]);
      expect(renderedGroupNames()).toEqual(["Staging", "Production"]);
      expect(document.body.textContent).not.toContain("No matching groups or connections");
    });

    it("selects all descendants from a group while a filter hides some of them", async () => {
      i18n.global.locale.value = "en";
      const { onConfirm } = await mountDialog({ open: true, mode: "export", connections, layout });

      await typeSearch("alpha");
      expect(renderedLabels()).toEqual(["Alpha"]);

      const deselect = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Deselect all"));
      deselect?.click();
      await nextTick();

      const groupCheckbox = document.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(groupCheckbox?.checked).toBe(false);
      groupCheckbox?.click();
      await nextTick();

      // The counter always reflects the full set, and the hidden sibling is selected too.
      expect(document.body.textContent).toContain("2 / 5");
      const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Next"));
      confirm?.click();
      expect(onConfirm).toHaveBeenCalledWith(["alpha", "beta"]);
    });

    it("orders sibling connections and groups ascending like the sidebar", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout, sortMode: "asc" });

      // Connection slots carry Gamma then Zebra; group slots carry Production
      // then Staging, while the slot interleaving stays as stored.
      expect(renderedGroupNames()).toEqual(["Production", "Staging"]);
      expect(renderedLabels()).toEqual(["Gamma", "Alpha", "Beta", "Delta", "Zebra"]);
    });

    it("orders sibling connections and groups descending like the sidebar", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout, sortMode: "desc" });

      expect(renderedGroupNames()).toEqual(["Staging", "Production"]);
      expect(renderedLabels()).toEqual(["Zebra", "Delta", "Beta", "Alpha", "Gamma"]);
    });

    it("keeps the layout order in manual mode", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, layout, sortMode: "manual" });

      expect(renderedGroupNames()).toEqual(["Staging", "Production"]);
      expect(renderedLabels()).toEqual(["Zebra", "Delta", "Alpha", "Beta", "Gamma"]);
    });

    it("ignores the sort mode in import mode", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "import", connections, layout, sortMode: "desc" });

      expect(renderedGroupNames()).toEqual(["Staging", "Production"]);
      expect(renderedLabels()).toEqual(["Zebra", "Delta", "Alpha", "Beta", "Gamma"]);
    });

    it("sorts a flat connection list by name in export mode without a layout", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections, sortMode: "asc" });

      expect(renderedLabels()).toEqual(["Alpha", "Beta", "Delta", "Gamma", "Zebra"]);
    });

    const partialLayout: SidebarLayout = {
      groups: [{ id: "production", name: "Production", collapsed: false }],
      order: [
        { type: "connection", id: "zulu" },
        { type: "group", id: "production", children: [{ type: "connection", id: "alpha" }] },
      ],
    };
    const partialConnections = [conn("alpha", "Alpha"), conn("aardvark", "Aardvark"), conn("zulu", "Zulu")];

    it("sorts connections missing from the layout with the sidebar slot rules", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections: partialConnections, layout: partialLayout, sortMode: "asc" });

      // Aardvark is absent from layout.order and must join the top-level
      // connection slots instead of being appended unsorted at the end.
      expect(renderedLabels()).toEqual(["Aardvark", "Alpha", "Zulu"]);
      expect(renderedGroupNames()).toEqual(["Production"]);
    });

    it("keeps a layout-missing connection in sorted position while searching", async () => {
      i18n.global.locale.value = "en";
      await mountDialog({ open: true, mode: "export", connections: partialConnections, layout: partialLayout, sortMode: "asc" });

      await typeSearch("a");

      expect(renderedLabels()).toEqual(["Aardvark", "Alpha"]);
      expect(renderedGroupNames()).toEqual(["Production"]);
    });
  });
});
