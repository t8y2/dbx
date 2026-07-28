import { createPinia, setActivePinia, storeToRefs } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarLayout } from "@/types/database";

const groupedLayout: SidebarLayout = {
  groups: [{ id: "project", name: "Project", collapsed: false }],
  order: [
    {
      type: "group",
      id: "project",
      children: [{ type: "connection", id: "grouped" }],
    },
    { type: "connection", id: "root" },
  ],
};

describe("connectionStore connection group paths", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("shares one cached path map across store consumers", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = groupedLayout;

    const firstConsumer = storeToRefs(store).connectionGroupPaths;
    const secondConsumer = storeToRefs(store).connectionGroupPaths;

    expect(firstConsumer.value).toBe(secondConsumer.value);
    expect(firstConsumer.value.get("grouped")).toEqual(["Project"]);
    expect(firstConsumer.value.get("root")).toEqual([]);
  });

  it("rebuilds the shared map when the sidebar layout changes", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = groupedLayout;
    const previousPaths = store.connectionGroupPaths;

    store.sidebarLayout = {
      groups: [],
      order: [{ type: "connection", id: "grouped" }],
    };

    expect(store.connectionGroupPaths).not.toBe(previousPaths);
    expect(store.connectionGroupPaths.get("grouped")).toEqual([]);
  });
});
