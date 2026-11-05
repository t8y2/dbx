// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, computed } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDataGridColumnFilters, type DataGridColumnFilterState, type DataGridLocalFilterDraft } from "@/composables/useDataGridColumnFilters";
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
          scopeIdentity: computed(() => "test"),
          resolvedDatabaseType: computed(() => undefined),
          canUseWhereSearch: computed(() => false),
          canUseServerColumnFilter: computed(() => false),
          structuredFilterCount: computed(() => 0),
          hasStructuredFilters: computed(() => false),
          whereFilterInput: ref(""),
          getConnectionConfig: () => undefined,
          getIdentifierQuote: () => undefined,
          getGlobalQueryTimeoutSecs: () => undefined,
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
  return Object.assign(filters, { state });
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

  it("filters local filter options by count query (>1, =1, count>1)", () => {
    const filters = mountColumnFilters([["beta"], ["beta"], ["beta"], ["alpha"], ["alpha"], ["zulu"]]);

    filters.openLocalFilter(0);
    expect(filters.localFilterOptions.value.map((opt) => [opt.label, opt.count])).toEqual([
      ["alpha", 2],
      ["beta", 3],
      ["zulu", 1],
    ]);

    // Filter duplicates (>1)
    filters.state.localFilterSearch.value = ">1";
    expect(filters.localFilterOptions.value.map((opt) => opt.label)).toEqual(["alpha", "beta"]);

    // Filter unique (=1)
    filters.state.localFilterSearch.value = "=1";
    expect(filters.localFilterOptions.value.map((opt) => opt.label)).toEqual(["zulu"]);

    // Filter by count with prefix: count >= 3
    filters.state.localFilterSearch.value = "count >= 3";
    expect(filters.localFilterOptions.value.map((opt) => opt.label)).toEqual(["beta"]);

    // Clear draft values, then toggle to select only visible filtered options
    filters.state.localFilterDraft.value!.values.clear();
    filters.toggleAllLocalFilterOptions();
    expect([...filters.state.localFilterDraft.value!.values]).toEqual(["str:beta"]);

    // Bare number searches by label substring, not count
    filters.state.localFilterSearch.value = "bet";
    expect(filters.localFilterOptions.value.map((opt) => opt.label)).toEqual(["beta"]);
  });

  it("treats count queries as non-typeable where filter values", () => {
    const filters = mountColumnFilters([["beta"]]);
    filters.openLocalFilter(0);

    filters.state.localFilterSearch.value = ">1";
    expect(filters.canApplyTypedLocalFilterValue.value).toBe(false);

    filters.state.localFilterSearch.value = "count>1";
    expect(filters.canApplyTypedLocalFilterValue.value).toBe(false);
  });
});
