import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TAB_TITLE_SUFFIX_MAX_LENGTH } from "@/lib/tabs/tabPresentation";

const mocks = vi.hoisted(() => ({
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

describe("queryStore tab title suffix", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    mocks.saveOpenTabsState.mockReset();
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
  });

  async function createStoreWithDataTab() {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "users", "data", "public");
    return { store, id };
  }

  it("sets, trims and clears the suffix", async () => {
    const { store, id } = await createStoreWithDataTab();

    expect(store.setTabTitleSuffix(id, "  待办  ")).toBe(true);
    expect(store.tabs[0]?.titleSuffix).toBe("待办");

    store.setTabTitleSuffix(id, "   ");
    expect(store.tabs[0]).not.toHaveProperty("titleSuffix");
  });

  it("returns false for an unknown tab", async () => {
    const { store } = await createStoreWithDataTab();

    expect(store.setTabTitleSuffix("missing", "x")).toBe(false);
  });

  it("caps the suffix length", async () => {
    const { store, id } = await createStoreWithDataTab();

    store.setTabTitleSuffix(id, "x".repeat(TAB_TITLE_SUFFIX_MAX_LENGTH + 10));

    expect(store.tabs[0]?.titleSuffix).toHaveLength(TAB_TITLE_SUFFIX_MAX_LENGTH);
  });

  it("does not copy the suffix onto a duplicated tab", async () => {
    const { store, id } = await createStoreWithDataTab();
    store.setTabTitleSuffix(id, "待办");

    store.duplicateTab(id);

    expect(store.tabs).toHaveLength(2);
    expect(store.tabs[0]?.titleSuffix).toBe("待办");
    expect(store.tabs[1]?.titleSuffix).toBeUndefined();
  });

  it("persists a suffix change on the debounced save", async () => {
    vi.useFakeTimers();
    const { store, id } = await createStoreWithDataTab();
    // Let the creation-time save settle so only the suffix change is observed.
    await vi.advanceTimersByTimeAsync(400);
    mocks.saveOpenTabsState.mockClear();

    store.setTabTitleSuffix(id, "待办");
    await vi.advanceTimersByTimeAsync(400);

    expect(mocks.saveOpenTabsState).toHaveBeenCalled();
    const payload = mocks.saveOpenTabsState.mock.calls.at(-1)?.[0] as { tabs: Array<{ id: string; titleSuffix?: string }> };
    expect(payload.tabs.find((tab) => tab.id === id)?.titleSuffix).toBe("待办");
  });

  it("stops numbering a tab once it gets a custom suffix and numbers it again after clearing", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const second = store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const numberOf = (id: string) => store.tabs.find((tab) => tab.id === id)?.titleNumber;
    expect([numberOf(first), numberOf(second)]).toEqual([1, 2]);

    store.setTabTitleSuffix(second, "待办");
    expect(numberOf(second)).toBeUndefined();

    store.setTabTitleSuffix(second, "");
    expect(numberOf(second)).toBe(2);
  });
});
