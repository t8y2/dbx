import { shallowRef } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/types/database";

const toastMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async () => 'SELECT * FROM "main"."users" LIMIT 10000'),
  executeQuery: vi.fn(),
  exportQueryResultJson: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => ({ addTask: vi.fn() }) }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "editor.duckdbDraining") return "上一个 DuckDB 查询仍在停止中，请稍后重试。";
      if (key === "grid.exportFailed") return `导出失败：${params?.message}`;
      return key;
    },
  }),
}));

import { useSidebarTreeExportRuntime } from "@/composables/useSidebarTreeExportRuntime";

describe("useSidebarTreeExportRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("translates direct executeQuery errors for sidebar JSON export", async () => {
    apiMock.executeQuery.mockRejectedValueOnce(new Error("The previous DuckDB query is still stopping. Please try again shortly."));
    const activeNode = shallowRef({ id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "main", children: [] } as TreeNode);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "duckdb" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [],
      selectedTreeNodeIds: [],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: {} as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("json");

    expect(apiMock.executeQuery).toHaveBeenCalledOnce();
    expect(toastMock).toHaveBeenCalledWith("导出失败：上一个 DuckDB 查询仍在停止中，请稍后重试。", 5000);
  });
});
