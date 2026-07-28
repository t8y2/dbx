import { describe, expect, it } from "vitest";
import { resolveDataGridHeaderSortAction } from "@/lib/dataGrid/dataGridSort";

describe("resolveDataGridHeaderSortAction", () => {
  it("keeps the existing menu action when quick sorting is disabled", () => {
    expect(
      resolveDataGridHeaderSortAction({
        enabled: false,
        configuredDirection: "desc",
        configuredMode: "database",
        currentColumnSorted: false,
        currentDirection: "asc",
        currentMode: "local",
      }),
    ).toEqual({ kind: "menu" });
  });

  it.each([
    ["local", "asc"],
    ["database", "desc"],
  ] as const)("uses the explicit %s/%s preference for an unsorted column", (configuredMode, configuredDirection) => {
    expect(
      resolveDataGridHeaderSortAction({
        enabled: true,
        configuredDirection,
        configuredMode,
        currentColumnSorted: false,
        currentDirection: "asc",
        currentMode: "database",
      }),
    ).toEqual({ kind: "sort", direction: configuredDirection, mode: configuredMode });
  });

  it("toggles an existing sort while preserving its scope", () => {
    expect(
      resolveDataGridHeaderSortAction({
        enabled: true,
        configuredDirection: "asc",
        configuredMode: "database",
        currentColumnSorted: true,
        currentDirection: "asc",
        currentMode: "local",
      }),
    ).toEqual({ kind: "sort", direction: "desc", mode: "local" });
  });
});
