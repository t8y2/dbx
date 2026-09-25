// @vitest-environment happy-dom

import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

describe("QueryEditor context menu lifecycle", () => {
  it("uses the target synchronized in the current context-menu event", async () => {
    const target = ref<string | null>(null);
    const openedTargets: string[] = [];
    const items = computed<ContextMenuItem[]>(() => [
      {
        label: target.value ? `Inspect ${target.value}` : "Inspect",
        disabled: !target.value,
        action: () => {
          if (target.value) openedTargets.push(target.value);
        },
      },
    ]);
    const root = defineComponent({
      setup() {
        const currentItems = () => items.value;
        const contextTarget = (id: string, value: string | null) =>
          h(
            "div",
            {
              id,
              onContextmenu: (event: MouseEvent) => {
                target.value = value;
                onContextMenu(event);
              },
            },
            id,
          );
        let onContextMenu = (_event: MouseEvent) => {};
        return () =>
          h(
            CustomContextMenu,
            { items: currentItems },
            {
              default: (slot: { onContextMenu: (event: MouseEvent) => void }) => {
                onContextMenu = slot.onContextMenu;
                return [contextTarget("table-a", "table_a"), contextTarget("table-b", "table_b"), contextTarget("empty", null)];
              },
            },
          );
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(root);
    app.mount(container);

    const open = async (id: string) => {
      container.querySelector(`#${id}`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await nextTick();
      return document.querySelector<HTMLButtonElement>("[data-dbx-context-menu] button");
    };

    expect(await open("table-a")).toMatchObject({ disabled: false, textContent: "Inspect table_a" });
    expect(await open("table-a")).toMatchObject({ disabled: false, textContent: "Inspect table_a" });
    const tableBItem = await open("table-b");
    expect(tableBItem).toMatchObject({ disabled: false, textContent: "Inspect table_b" });
    tableBItem?.click();
    expect(openedTargets).toEqual(["table_b"]);
    expect(await open("empty")).toMatchObject({ disabled: true, textContent: "Inspect" });

    app.unmount();
    container.remove();
  });
});
