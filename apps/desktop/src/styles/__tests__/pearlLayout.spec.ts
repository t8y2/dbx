import { describe, expect, it } from "vitest";
import { readCascadeCss } from "./cascadeCss";

const css = readCascadeCss();

function ruleBody(selector: string): string {
  let selectorStart = css.indexOf(selector);
  while (selectorStart >= 0) {
    const startsAtRule = selectorStart === 0 || css[selectorStart - 1] === "\n";
    const nextCharacter = css[selectorStart + selector.length];
    const endsAtSelector = nextCharacter === undefined || /[\s,{]/.test(nextCharacter);
    if (startsAtRule && endsAtSelector) break;
    selectorStart = css.indexOf(selector, selectorStart + selector.length);
  }
  if (selectorStart < 0) return "";
  const bodyStart = css.indexOf("{", selectorStart + selector.length);
  const bodyEnd = css.indexOf("}", bodyStart);
  return bodyStart < 0 || bodyEnd < 0 ? "" : css.slice(bodyStart + 1, bodyEnd);
}

describe("Pearl panel layout", () => {
  it("preserves classic resize handles and divider borders for other themes", () => {
    expect(ruleBody(".app-layout-classic .panel-resize-handle")).toContain("width: 3px;");

    const rightHandle = ruleBody(".app-layout-classic .panel-resize-handle--right");
    expect(rightHandle).toContain("right: 0;");
    expect(rightHandle).toContain("border-right: 1px solid var(--border);");

    const leftHandle = ruleBody(".app-layout-classic .panel-resize-handle--left");
    expect(leftHandle).toContain("left: 0;");
    expect(leftHandle).toContain("border-left: 1px solid var(--border);");
  });

  it("uses square panels with 4px horizontal gaps", () => {
    expect(ruleBody("html.theme-pearl .app-panel-gutter")).toContain("column-gap: 4px;");
    expect(ruleBody("html.theme-pearl .app-panel-gutter > [data-app-sidebar]")).toContain("margin-right: 0;");
    expect(ruleBody("html.theme-pearl .app-layout-classic > [data-app-sidebar]")).toContain("margin-right: 4px;");
    expect(ruleBody("html.theme-pearl .app-panel-gutter > [data-app-sidebar],")).toContain("border-radius: 0;");
    expect(ruleBody("html.theme-pearl .app-layout-classic > [data-app-sidebar],")).toContain("border-radius: 0;");
  });

  it("places the classic sidebar resize target over the full divider gap", () => {
    expect(ruleBody("html.theme-pearl .app-layout-classic .panel-resize-handle")).toContain("width: 6px;");
    const sidebarHandle = ruleBody("html.theme-pearl .app-layout-classic .panel-resize-handle--right");
    expect(sidebarHandle).toContain("right: -6px;");
    expect(sidebarHandle).toContain("border-right: 0;");

    const leftHandle = ruleBody("html.theme-pearl .app-layout-classic .panel-resize-handle--left");
    expect(leftHandle).toContain("left: -3px;");
    expect(leftHandle).toContain("border-left: 0;");
  });
});
