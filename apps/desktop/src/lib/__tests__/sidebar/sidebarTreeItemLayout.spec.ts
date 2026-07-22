import { describe, expect, it } from "vitest";
import { alignedSidebarCommentLabelWidths, treeLabelWidthClass, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";

describe("sidebar tree item layout", () => {
  it("keeps a table row constrained when it displays a comment", () => {
    expect(usesFullWidthTreeLabel("table", true)).toBe(true);
    expect(usesFullWidthTreeLabel("table", true, true)).toBe(false);
  });

  it("lets a table name consume the available row width before truncating", () => {
    expect(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true })).toBe("min-w-0 flex-1 truncate");
  });

  it("aligns comments to the longest sibling name without crossing parent groups", () => {
    const widths = alignedSidebarCommentLabelWidths([
      { id: "tables", depth: 1, alignable: false, hasComment: false, labelWidth: 0 },
      { id: "short", depth: 2, alignable: true, hasComment: true, labelWidth: 48 },
      { id: "long", depth: 2, alignable: true, hasComment: false, labelWidth: 136 },
      { id: "views", depth: 1, alignable: false, hasComment: false, labelWidth: 0 },
      { id: "view", depth: 2, alignable: true, hasComment: true, labelWidth: 72 },
    ]);

    expect(widths.get("short")).toBe(136);
    expect(widths.has("long")).toBe(false);
    expect(widths.get("view")).toBe(72);
  });
});
