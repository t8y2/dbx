// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createSqlSignatureTooltipDom } from "@/lib/editor/sqlSignatureTooltip";

describe("SQL signature tooltip", () => {
  it("renders every overload and highlights the active parameter in each one", () => {
    const dom = createSqlSignatureTooltipDom({
      name: "toStartOfInterval",
      activeOverload: 0,
      overloads: [
        {
          signature: "toStartOfInterval(value, interval)",
          parameterGroups: [["value", "interval"]],
          activeGroup: 0,
          activeParameter: 1,
        },
        {
          signature: "toStartOfInterval(value, interval, time_zone)",
          parameterGroups: [["value", "interval", "time_zone"]],
          activeGroup: 0,
          activeParameter: 1,
        },
      ],
    });

    expect(dom.textContent).toContain("1/2");
    expect(dom.textContent).toContain("2/2");
    expect(dom.textContent).toContain("time_zone");
    expect(dom.querySelectorAll("[data-active-parameter='true']")).toHaveLength(2);
  });
});
