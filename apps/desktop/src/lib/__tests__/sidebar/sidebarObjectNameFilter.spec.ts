import { describe, expect, it } from "vitest";
import { supportsSidebarObjectNameFilter } from "../../sidebar/sidebarObjectNameFilter";

describe("supportsSidebarObjectNameFilter", () => {
  it("allows only supported object groups", () => {
    const supportedTypes = ["group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions"] as const;
    expect(supportedTypes.every((type) => supportsSidebarObjectNameFilter({ type, parentType: undefined }))).toBe(true);
    expect(supportsSidebarObjectNameFilter({ type: "group-indexes", parentType: undefined })).toBe(false);
    expect(supportsSidebarObjectNameFilter({ type: "group-triggers", parentType: undefined })).toBe(false);
    expect(supportsSidebarObjectNameFilter({ type: "group-events", parentType: undefined })).toBe(false);
    expect(supportsSidebarObjectNameFilter({ type: "group-functions", parentType: "package" })).toBe(false);
  });
});
