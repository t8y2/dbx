import { describe, expect, it } from "vitest";
import { alignedCommentLeadingWidth, alignedSidebarCommentLabelWidths, canTreeNodeShowExpander, sidebarTreeNaturalContentWidth, trailingCommentAvailableWidth, treeLabelWidthClass, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";

describe("sidebar tree item layout", () => {
  it("keeps a table row constrained when it displays a comment", () => {
    expect(usesFullWidthTreeLabel("table", true)).toBe(true);
    expect(usesFullWidthTreeLabel("table", true, true)).toBe(false);
  });

  it("lets a table name consume the available row width before truncating", () => {
    expect(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true })).toBe("min-w-0 flex-1 truncate");
  });

  it("keeps a pinned action next to the name while preserving the aligned comment column", () => {
    expect(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true, hasInlineAction: true })).toBe("min-w-0 shrink truncate");
    expect(alignedCommentLeadingWidth(100, true)).toBe(124);
    expect(alignedCommentLeadingWidth(100, false)).toBe(100);
    expect(alignedCommentLeadingWidth(undefined, true)).toBeUndefined();
  });

  it("renders etcd Keys and Dashboard as aligned leaf actions", () => {
    expect(canTreeNodeShowExpander({ type: "etcd-root", childCount: 0 })).toBe(false);
    expect(canTreeNodeShowExpander({ type: "etcd-dashboard", childCount: 0 })).toBe(false);
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

  it("limits right-aligned comments to the space after the complete name and gap", () => {
    expect(trailingCommentAvailableWidth(260, 100)).toBe(152);
    expect(trailingCommentAvailableWidth(108, 100)).toBe(0);
    expect(trailingCommentAvailableWidth(100, 100)).toBe(0);
    expect(trailingCommentAvailableWidth(99, 100)).toBe(0);
  });

  it("keeps the natural width of the widest node in the complete virtual tree", () => {
    const width = sidebarTreeNaturalContentWidth(
      [
        { depth: 1, label: "visible", usesNaturalWidth: true },
        { depth: 4, label: "widest-node-outside-the-mounted-window", usesNaturalWidth: true, trailingWidth: 20 },
        { depth: 8, label: "constrained metadata row", usesNaturalWidth: false },
      ],
      (text) => text.length * 7,
    );

    expect(width).toBe(4 * 16 + 8 + 54 + "widest-node-outside-the-mounted-window".length * 7 + 20);
  });

  it("returns zero when no tree row uses natural width", () => {
    expect(sidebarTreeNaturalContentWidth([{ depth: 2, label: "commented", usesNaturalWidth: false }], (text) => text.length * 7)).toBe(0);
  });
});
