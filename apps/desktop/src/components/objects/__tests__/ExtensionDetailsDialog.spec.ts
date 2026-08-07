// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  const dialog = defineComponent({
    props: { open: Boolean },
    setup(props, { slots }) {
      return () => (props.open ? h("div", slots.default?.()) : null);
    },
  });
  return { Dialog: dialog, DialogContent: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup(_props, { slots }) {
        return () => h("button", slots.default?.());
      },
    }),
  };
});

import ExtensionDetailsDialog from "@/components/objects/ExtensionDetailsDialog.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ExtensionDetailsDialog", () => {
  it("shows metadata already loaded for the extension tree node", async () => {
    const node: TreeNode = {
      id: "connection:database:public:sys_stat_statements",
      label: "sys_stat_statements",
      type: "extension",
      schema: "public",
      meta: {
        name: "sys_stat_statements",
        version: "1.10",
        schema: "public",
        comment: "track planning and execution statistics",
      },
    };
    const dialog = ref<InstanceType<typeof ExtensionDetailsDialog> | null>(null);
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup() {
          return () => h(ExtensionDetailsDialog, { ref: dialog, node });
        },
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    dialog.value?.show();
    await nextTick();

    const text = document.body.textContent || "";
    expect(text).toContain("sys_stat_statements");
    expect(text).toContain("1.10");
    expect(text).toContain("public");
    expect(text).toContain("track planning and execution statistics");
  });
});
