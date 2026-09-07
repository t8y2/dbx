import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectionTreeSource = readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8");

function focusSidebarTreeNodeBody(): string {
  const match = connectionTreeSource.match(/^async function focusSidebarTreeNode[\s\S]*?^}/m);
  expect(match).not.toBeNull();
  return match![0]!;
}

describe("ConnectionTree arrow focus", () => {
  it("scrolls before querying the row so out-of-window virtual rows materialize first", () => {
    const body = focusSidebarTreeNodeBody();
    const scroll = body.indexOf("await scrollToSidebarNode(nodeId);");
    const renderWait = body.indexOf("await waitForSidebarRenderFrame();");
    const query = body.indexOf('root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`)');
    const missingRowGuard = body.indexOf("if (!row) return;");
    const focus = body.indexOf("row.focus({ preventScroll: true });");

    // RecycleScroller only keeps the materialized window in the DOM, so the
    // index-driven scroll must run (no-op when already visible) and one render
    // frame must pass before the row can be queried and focused.
    for (const position of [scroll, renderWait, query, missingRowGuard, focus]) expect(position).toBeGreaterThan(-1);
    expect(scroll).toBeLessThan(renderWait);
    expect(renderWait).toBeLessThan(query);
    expect(query).toBeLessThan(missingRowGuard);
    expect(missingRowGuard).toBeLessThan(focus);
  });

  it("keeps focus a no-op when the row is still not rendered after the scroll", () => {
    const body = focusSidebarTreeNodeBody();
    expect(body).toContain("if (!row) return;");
  });
});
