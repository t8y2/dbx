// @vitest-environment happy-dom

import { defineComponent, h, KeepAlive, nextTick, ref, type Ref } from "vue";
import { describe, expect, it } from "vitest";
import { mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { TableInfoTab } from "@/types/database";
import { tableInfoTabForDrawerToggle } from "@/lib/table/tableInfoTabPreference";

interface CachedGridState {
  drawerOpen: Ref<boolean>;
  activeTab: Ref<TableInfoTab>;
  toggle: (requestedTab?: TableInfoTab) => void;
}

describe("tableInfoTabForDrawerToggle", () => {
  it("refreshes a cached grid on open while preserving an already-open drawer", async () => {
    const preferredTab = ref<TableInfoTab>("ddl");
    const activeGridId = ref("first");
    const grids = new Map<string, CachedGridState>();

    const CachedGrid = defineComponent({
      props: { gridId: { type: String, required: true } },
      setup(props) {
        const drawerOpen = ref(false);
        const activeTab = ref<TableInfoTab>(preferredTab.value);
        const toggle = (requestedTab?: TableInfoTab) => {
          const nextTab = tableInfoTabForDrawerToggle(drawerOpen.value, activeTab.value, preferredTab.value, requestedTab);
          if (drawerOpen.value && activeTab.value === nextTab) {
            drawerOpen.value = false;
            return;
          }
          drawerOpen.value = true;
          activeTab.value = nextTab;
          preferredTab.value = nextTab;
        };
        grids.set(props.gridId, { drawerOpen, activeTab, toggle });
        return () => h("div", props.gridId);
      },
    });
    const Host = defineComponent({
      setup() {
        return () => h(KeepAlive, { max: 2 }, [h(CachedGrid, { key: activeGridId.value, gridId: activeGridId.value })]);
      },
    });
    const mounted = mountComponent(Host, {});

    activeGridId.value = "second";
    await nextTick();
    expect(grids.get("second")?.activeTab.value).toBe("ddl");

    activeGridId.value = "first";
    await nextTick();
    grids.get("first")?.toggle("columns");
    expect(preferredTab.value).toBe("columns");

    activeGridId.value = "second";
    await nextTick();
    grids.get("second")?.toggle();
    expect(grids.get("second")?.activeTab.value).toBe("columns");

    activeGridId.value = "first";
    await nextTick();
    grids.get("first")?.toggle("indexes");
    expect(preferredTab.value).toBe("indexes");

    activeGridId.value = "second";
    await nextTick();
    expect(grids.get("second")?.activeTab.value).toBe("columns");
    grids.get("second")?.toggle();
    grids.get("second")?.toggle();
    expect(grids.get("second")?.activeTab.value).toBe("indexes");

    mounted.unmount();
  });

  it("keeps explicit tab requests authoritative", () => {
    expect(tableInfoTabForDrawerToggle(false, "ddl", "columns", "foreignKeys")).toBe("foreignKeys");
    expect(tableInfoTabForDrawerToggle(true, "ddl", "columns", "foreignKeys")).toBe("foreignKeys");
  });
});
