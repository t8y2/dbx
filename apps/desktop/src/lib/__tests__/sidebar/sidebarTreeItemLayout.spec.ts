import { describe, expect, it } from "vitest";
import { trailingCommentAvailableWidth, treeLabelWidthClass, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";

describe("sidebar tree item layout", () => {
  it("keeps a table row constrained when it displays a comment", () => {
    expect(usesFullWidthTreeLabel("table", true)).toBe(true);
    expect(usesFullWidthTreeLabel("table", true, true)).toBe(false);
  });

  it("lets a table name consume the available row width before truncating", () => {
    expect(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true })).toBe("min-w-0 flex-1 truncate");
  });

  it("gives the comment only the width left after the full table name and gap", () => {
    expect(trailingCommentAvailableWidth(260, 100)).toBe(152);
    expect(trailingCommentAvailableWidth(108, 100)).toBe(0);
    expect(trailingCommentAvailableWidth(100, 100)).toBe(0);
    expect(trailingCommentAvailableWidth(99, 100)).toBe(0);
  });
});
