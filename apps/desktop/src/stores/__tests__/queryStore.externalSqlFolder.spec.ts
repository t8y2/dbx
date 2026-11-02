import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore external SQL folders", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    setActivePinia(createPinia());
  });

  it("keeps UNC paths fully qualified when their parent folder is renamed", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    queryStore.openExternalSqlFile("", "", "\\\\server\\share\\old\\nested\\query.sql", "SELECT 1");

    queryStore.relocateExternalSqlFolderPath("\\\\server\\share\\old", "\\\\server\\share\\renamed");

    expect(queryStore.tabs.find((tab) => tab.externalSqlPath)?.externalSqlPath).toBe("\\\\server\\share\\renamed/nested/query.sql");
  });
});
