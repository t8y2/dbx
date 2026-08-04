import { describe, expect, it } from "vitest";
import { dataGridTotalRowCountLabelKey } from "@/lib/dataGrid/dataGridPagination";
import DataGrid from "../DataGrid.vue";

type VuePropDefinition = { default?: unknown };
type VueComponentWithProps = { props?: Record<string, VuePropDefinition> };

describe("DataGrid total row count exactness", () => {
  it("treats totals as exact unless a caller explicitly marks them as a lower bound", () => {
    const component = DataGrid as unknown as VueComponentWithProps;
    expect(component.props?.totalRowCountIsExact?.default).toBe(true);
    expect(component.props?.inexactTotalRowCountMode?.default).toBe("at-least");
  });

  it("keeps lower-bound and estimated total labels distinct", () => {
    expect(dataGridTotalRowCountLabelKey(true, "estimated")).toBe("grid.totalRowCount");
    expect(dataGridTotalRowCountLabelKey(false, "at-least")).toBe("grid.totalRowCountAtLeast");
    expect(dataGridTotalRowCountLabelKey(false, "estimated")).toBe("grid.totalRowCountEstimated");
  });
});
