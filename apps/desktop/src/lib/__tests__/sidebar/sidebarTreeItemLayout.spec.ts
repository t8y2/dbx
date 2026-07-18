import { describe, expect, it } from "vitest";
import { trailingCommentAvailableWidth, treeLabelWidthClass, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";

describe("sidebar tree item layout", () => {
  it("keeps a table row constrained when it displays a comment", () => {
    expect(usesFullWidthTreeLabel("table", true)).toBe(true);
    expect(usesFullWidthTreeLabel("table", true, true)).toBe(false);
  });

  it("clips a table name without adding an ellipsis when a comment is visible", () => {
    const className = treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true });

    expect(className).toBe("min-w-0 flex-auto overflow-hidden whitespace-nowrap");
    expect(className).not.toContain("truncate");
  });

  it("gives the comment only the width left after the full table name and gap", () => {
    expect(trailingCommentAvailableWidth(260, 100)).toBe(152);
    expect(trailingCommentAvailableWidth(108, 100)).toBe(0);
    expect(trailingCommentAvailableWidth(100, 100)).toBe(0);
    expect(trailingCommentAvailableWidth(99, 100)).toBe(0);
  });
});
