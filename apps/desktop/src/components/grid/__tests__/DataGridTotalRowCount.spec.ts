import { describe, expect, it } from "vitest";
import DataGrid from "../DataGrid.vue";

type VuePropDefinition = { default?: unknown };
type VueComponentWithProps = { props?: Record<string, VuePropDefinition> };

describe("DataGrid total row count exactness", () => {
  it("treats totals as exact unless a caller explicitly marks them as a lower bound", () => {
    const component = DataGrid as unknown as VueComponentWithProps;
    expect(component.props?.totalRowCountIsExact?.default).toBe(true);
  });
});
