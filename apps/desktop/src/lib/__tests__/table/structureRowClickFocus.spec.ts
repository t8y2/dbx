// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { structureRowClickTargetOwnsFocus } from "@/lib/table/structureRowClickFocus";

function element(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  const node = host.firstElementChild;
  if (!node) throw new Error("no element");
  return node;
}

describe("structureRowClickTargetOwnsFocus (#15585)", () => {
  it("keeps focus for the column editor controls that open overlays", () => {
    // Type picker (SearchableSelect trigger), default-value preset button and
    // comment editor button all render as buttons inside the row.
    expect(structureRowClickTargetOwnsFocus(element("<button><span>VARCHAR2</span></button>").firstElementChild)).toBe(true);
    expect(structureRowClickTargetOwnsFocus(element("<button aria-haspopup='dialog'><svg></svg></button>"))).toBe(true);
    expect(structureRowClickTargetOwnsFocus(element("<div role='combobox' tabindex='0'><span>BYTE</span></div>"))).toBe(true);
    expect(structureRowClickTargetOwnsFocus(element("<input type='checkbox' />"))).toBe(true);
    expect(structureRowClickTargetOwnsFocus(element("<label><input type='checkbox' /><span>YES</span></label>").firstElementChild)).toBe(true);
  });

  it("lets inert cell content hand focus to the scroller even inside a focusable scroller ancestor", () => {
    const wrapper = element("<div tabindex='0'><table><tbody><tr><td class='cell'><span>REGNO</span></td><td tabindex='-1'>REGNO</td><td>REGNO</td></tr></tbody></table></div>");
    const row = wrapper.querySelector("tr");
    const cells = row?.querySelectorAll("td") ?? [];

    expect(structureRowClickTargetOwnsFocus(cells[0])).toBe(false);
    expect(structureRowClickTargetOwnsFocus(cells[0]?.firstElementChild)).toBe(false);
    expect(structureRowClickTargetOwnsFocus(cells[1])).toBe(false);
    expect(structureRowClickTargetOwnsFocus(cells[2])).toBe(false);
    expect(structureRowClickTargetOwnsFocus(element("<div class='tabular-nums'>3</div>"))).toBe(false);
  });

  it("handles label text and text-node click targets", () => {
    const label = element("<label><input type='checkbox' /><span>Virtual</span></label>");
    const span = label.querySelector("span")!;
    expect(structureRowClickTargetOwnsFocus(span)).toBe(true);
    expect(structureRowClickTargetOwnsFocus(span.firstChild)).toBe(true);
  });

  it("tolerates targets that are not elements", () => {
    expect(structureRowClickTargetOwnsFocus(null)).toBe(false);
    expect(structureRowClickTargetOwnsFocus(document)).toBe(false);
    expect(structureRowClickTargetOwnsFocus(new EventTarget())).toBe(false);
  });
});
