// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { constrainSqlHoverLayout } from "@/lib/editor/sqlHoverLayout";

describe("constrainSqlHoverLayout", () => {
  it("caps table structure hovers and scrolls oversized DDL inside the content area", () => {
    const root = document.createElement("div");
    const content = document.createElement("div");

    constrainSqlHoverLayout(root, content);

    expect(root.dataset.sqlStructureHover).toBe("true");
    expect(root.style.width).toBe("760px");
    expect(root.style.maxWidth).toBe("calc(100vw - 24px)");
    expect(root.style.maxHeight).toBe("65vh");
    expect(root.style.overflow).toBe("hidden");
    expect(content.dataset.sqlStructureHoverContent).toBe("true");
    expect(content.style.flex).toBe("0 1 auto");
    expect(content.style.maxHeight).toBe("480px");
    expect(content.style.maxWidth).toBe("100%");
    expect(content.style.overflow).toBe("auto");
    expect(content.style.overscrollBehavior).toBe("contain");
  });
});
