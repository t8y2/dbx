// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

const source = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/QueryEditor.vue"), "utf8");

describe("QueryEditor context menu lifecycle", () => {
  it("resolves menu items after synchronizing the right-click target", () => {
    const syncStart = source.indexOf("function syncContextMenuStateAtEvent");
    const syncEnd = source.indexOf("\n}", syncStart);
    const syncSource = source.slice(syncStart, syncEnd);
    const syncIndex = source.indexOf("syncContextMenuStateAtEvent(view, e);");
    const openIndex = source.indexOf("onContextMenu(e);", syncIndex);
    const getterStart = source.indexOf("function currentContextMenuItems()");
    const getterEnd = source.indexOf("\n}", getterStart);
    const getterSource = source.slice(getterStart, getterEnd);

    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncEnd).toBeGreaterThan(syncStart);
    expect(syncSource).toContain("if (pos == null)");
    expect(syncSource).toContain("contextObjectTarget.value = null;");
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(syncIndex);
    expect(getterStart).toBeGreaterThanOrEqual(0);
    expect(getterEnd).toBeGreaterThan(getterStart);
    expect(getterSource).toContain("return contextMenuItems.value;");
    expect(getterSource).not.toContain("nextTick");
    expect(getterSource).not.toContain("setTimeout");
    expect(source).toContain(':items="currentContextMenuItems"');
    expect(source).not.toContain('<CustomContextMenu :items="contextMenuItems"');
  });

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
