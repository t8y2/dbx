import { describe, expect, it } from "vitest";
import { buildSchemaDiffHighlightSegments } from "@/lib/schema/schemaDiffHighlight";

describe("schema diff character highlighting", () => {
  it("covers the full span between disjoint type and default changes", () => {
    const source = "  `next_step_prompt` longtext COLLATE utf8mb4_unicode_ci,";
    const target = "  `next_step_prompt` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,";
    const result = buildSchemaDiffHighlightSegments(source, target);

    expect(result.sourceSegments.map((segment) => segment.text).join("")).toBe(source);
    expect(result.targetSegments.map((segment) => segment.text).join("")).toBe(target);
    expect(result.sourceSegments.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(["longtext COLLATE utf8mb4_unicode_ci"]);
    expect(result.targetSegments.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(["varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL"]);
  });

  it("does not leave DEFAULT or coincidentally matched characters unhighlighted inside a changed clause", () => {
    const source = "  `context_window` int(11) NOT NULL DEFAULT '262144' COMMENT '模型上下文窗口大小 (token)，默认',";
    const target = "  `context_window` int(11) DEFAULT NULL,";
    const result = buildSchemaDiffHighlightSegments(source, target);

    expect(result.sourceSegments.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(["NOT NULL DEFAULT '262144' COMMENT '模型上下文窗口大小 (token)，默认'"]);
    expect(result.targetSegments.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(["DEFAULT NULL"]);
  });
});
