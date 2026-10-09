// @vitest-environment happy-dom
// Guards the settings-search "reveal" contract: the highlight must cover the
// whole setting block, not just the title row. Searching 首页 used to land on
// the label next to the help icon, which read like a rendering glitch.
import { describe, expect, it } from "vitest";
import { findSettingsSearchHighlightTarget } from "@/lib/settings/settingsSearchHighlight";

function searchRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("findSettingsSearchHighlightTarget", () => {
  it("highlights the setting block instead of the title row of a help-tooltip setting", () => {
    const root = searchRoot(`
      <div class="flex items-center gap-1">
        <label>首页</label>
        <button type="button" class="cursor-help" aria-label="首页"></button>
      </div>
      <div class="settings-appearance-choice-grid">
        <button type="button">介绍页</button>
        <button type="button">工作区</button>
      </div>
    `);

    expect(findSettingsSearchHighlightTarget(root, "首页")).toBe(root);
  });

  it("keeps highlighting a bordered setting row that owns the title", () => {
    const root = searchRoot(`
      <div class="settings-item rounded-md border">
        <div class="space-y-1">
          <label for="quit-on-close">退出时关闭</label>
          <p>关闭窗口时退出应用</p>
        </div>
        <button id="quit-on-close" role="switch"></button>
      </div>
    `);

    expect(findSettingsSearchHighlightTarget(root, "退出时关闭")).toBe(root.firstElementChild);
  });

  it("does not stop at a row that only wraps a label and its help icon", () => {
    const root = searchRoot(`
      <div class="rounded-md border">
        <div class="flex items-center gap-1">
          <label>首页</label>
          <button type="button" class="cursor-help" aria-label="首页"></button>
        </div>
        <button type="button" role="switch"></button>
      </div>
    `);

    expect(findSettingsSearchHighlightTarget(root, "首页")).toBe(root.firstElementChild);
  });

  it("falls back to the search root when the title cannot be found", () => {
    const root = searchRoot(`<div><label>其它</label></div>`);

    expect(findSettingsSearchHighlightTarget(root, "首页")).toBe(root);
  });
});
