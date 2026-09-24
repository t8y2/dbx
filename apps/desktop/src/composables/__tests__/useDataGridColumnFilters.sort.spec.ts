// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, computed } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDataGridColumnFilters, type DataGridColumnFilterState, type DataGridLocalFilterDraft } from "@/composables/useDataGridColumnFilters";
import type { DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { QueryResult } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn() }));

const disposers: Array<() => void> = [];

function mountColumnFilters(rows: CellValue[][]) {
  const state: DataGridColumnFilterState = {
    localColumnFilters: ref({}),
    localFilterOpenColumn: ref<number | null>(null),
    localFilterSearch: ref(""),
    localFilterDraft: ref<DataGridLocalFilterDraft | null>(null),
    serverFilterLoading: ref(false),
    serverFilterError: ref(""),
    serverFilterOptions: ref<DataGridLocalFilterOption[]>([]),
    serverFilterLimited: ref(false),
    serverFilterValueByKey: ref(new Map()),
    serverColumnFilters: ref({}),
  };
  const result: QueryResult = { columns: ["status"], rows };
  let filters: ReturnType<typeof useDataGridColumnFilters> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        filters = useDataGridColumnFilters({
          state,
          getResult: () => result,
          getTableMeta: () => undefined,
          getConnectionId: () => undefined,
          getSchema: () => undefined,
          getExecutionDatabase: () => "",
          resolvedDatabaseType: computed(() => undefined),
          canUseWhereSearch: computed(() => false),
          canUseServerColumnFilter: computed(() => false),
          structuredFilterCount: computed(() => 0),
          hasStructuredFilters: computed(() => false),
          whereFilterInput: ref(""),
          getConnectionConfig: () => undefined,
          getIdentifierQuote: () => undefined,
          getNewRows: () => [],
          getRowData: (row) => row,
          formatValue: (value) => String(value),
          waitForTableMeta: () => Promise.resolve(null),
          applyWhereFilter: () => Promise.resolve(),
          resetGridVerticalScroll: () => {},
          emitLocalFiltersChange: () => {},
        });
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  disposers.push(() => app.unmount());
  if (!filters) throw new Error("useDataGridColumnFilters was not mounted");
  return filters;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("useDataGridColumnFilters local filter sort", () => {
  it("sorts values by count descending on the first count click and back to value ascending on the first value click", () => {
    const filters = mountColumnFilters([["beta"], ["beta"], ["beta"], ["alpha"], ["alpha"], ["zulu"]]);

    filters.openLocalFilter(0);
    expect(filters.localFilterSort.value).toEqual({ field: "value", direction: "asc" });
    expect(filters.localFilterOptions.value.map((option) => option.label)).toEqual(["alpha", "beta", "zulu"]);

    filters.toggleLocalFilterSort("count");
    expect(filters.localFilterSort.value).toEqual({ field: "count", direction: "desc" });
    expect(filters.localFilterOptions.value.map((option) => [option.label, option.count])).toEqual([
      ["beta", 3],
      ["alpha", 2],
      ["zulu", 1],
    ]);

    filters.toggleLocalFilterSort("value");
    expect(filters.localFilterSort.value).toEqual({ field: "value", direction: "asc" });
    expect(filters.localFilterOptions.value.map((option) => option.label)).toEqual(["alpha", "beta", "zulu"]);
  });

  it("flips the direction when the same sort header is clicked again", () => {
    const filters = mountColumnFilters([["beta"], ["alpha"], ["alpha"]]);

    filters.openLocalFilter(0);
    filters.toggleLocalFilterSort("count");
    expect(filters.localFilterSort.value).toEqual({ field: "count", direction: "desc" });
    expect(filters.localFilterOptions.value.map((option) => [option.label, option.count])).toEqual([
      ["alpha", 2],
      ["beta", 1],
    ]);

    filters.toggleLocalFilterSort("count");
    expect(filters.localFilterSort.value).toEqual({ field: "count", direction: "asc" });
    expect(filters.localFilterOptions.value.map((option) => [option.label, option.count])).toEqual([
      ["beta", 1],
      ["alpha", 2],
    ]);
  });

  it("ignores sort toggles while no local filter draft is open", () => {
    const filters = mountColumnFilters([["beta"], ["alpha"]]);

    filters.toggleLocalFilterSort("count");

    expect(filters.localFilterSort.value).toEqual({ field: "value", direction: "asc" });
  });
});
