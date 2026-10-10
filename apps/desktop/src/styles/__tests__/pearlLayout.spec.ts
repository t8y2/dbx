import { describe, expect, it } from "vitest";
import { readCascadeCss } from "./cascadeCss";

const css = readCascadeCss();

function ruleBody(selector: string): string {
  const selectorStart = css.indexOf(selector);
  if (selectorStart < 0) return "";
  const bodyStart = css.indexOf("{", selectorStart);
  const bodyEnd = css.indexOf("}", bodyStart);
  return bodyStart < 0 || bodyEnd < 0 ? "" : css.slice(bodyStart + 1, bodyEnd);
}

describe("Pearl panel layout", () => {
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
    expect(sidebarHandle).not.toContain("border-right:");
    expect(ruleBody("html.theme-pearl .app-layout-classic .panel-resize-handle--left")).toContain("left: -3px;");
  });
});
