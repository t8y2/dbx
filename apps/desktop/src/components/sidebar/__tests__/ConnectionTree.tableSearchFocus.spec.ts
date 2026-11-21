// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollTopForSidebarNode } from "@/lib/sidebar/sidebarActiveTabTarget";
import { isSidebarTableSearchControlNode } from "@/lib/sidebar/sidebarTableSearchControl";

const source = parse(readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);
const restoreSource = script.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "restoreTableSearchInput")!.getText(script);
const compiled = ts.transpileModule(restoreSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(virtual: boolean, rowHeight = 28) {
  const root = document.createElement("div");
  document.body.append(root);
  const input = document.createElement("input");
  input.dataset.sidebarTableSearchParentId = "A";
  input.value = "orders";
  const scroller = { scrollTop: 500 * rowHeight, clientHeight: 20 * rowHeight, scrollHeight: 1007 * rowHeight };
  const refresh = vi.fn(() => root.append(input));
  if (!virtual) root.append(input);
  const pinned = { value: { node: { tableSearchParentId: "B" } } };
  const current = { value: true };
  const nodes = { value: [{ node: { type: "connection" } }, { node: { type: "database", id: "A" } }, { node: { type: "table-search-control", tableSearchParentId: "A" } }] };
  const bindings = {
    nextTick,
    document,
    HTMLInputElement,
    isCurrentTableSearchInteraction: () => current.value,
    rootRef: { value: root },
    stickyTableSearchNode: pinned,
    stickyHeaderStyle: { value: {} },
    flatNodes: nodes,
    isSidebarTableSearchControlNode,
    currentTreeScroller: () => scroller,
    scrollTopForSidebarNode,
    sidebarTreeRowHeight: { value: rowHeight },
    updateSidebarScrollMetrics: vi.fn(),
    useVirtualTree: { value: virtual },
    treeScrollerRef: { value: { updateVisibleItems: refresh } },
  };
  const restore = new Function(...Object.keys(bindings), `${compiled}; return restoreTableSearchInput;`)(...Object.values(bindings));
  const run = async () => {
    restore({ parentNodeId: "A", shouldRestoreFocus: true, selection: { start: 2, end: 4, direction: "forward" } });
    await nextTick();
    await nextTick();
  };
  return { root, input, scroller, refresh, pinned, nodes, current, run };
}

afterEach(() => document.body.replaceChildren());

describe("table search focus after results shrink into a later database", () => {
  for (const virtual of [false, true]) {
    it.each([24, 28])(`reveals A and restores the caret (virtual=${virtual}, row height=%i)`, async (rowHeight) => {
      const { input, scroller, refresh, run } = fixture(virtual, rowHeight);
      await run();
      expect(scroller.scrollTop).toBe(rowHeight);
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
      expect(refresh).toHaveBeenCalledTimes(virtual ? 1 : 0);
    });
  }

  it("keeps the current scroll position and selection when A is still pinned", async () => {
    const { root, input, pinned, scroller, run } = fixture(false);
    const overlay = document.createElement("div");
    overlay.className = "sticky-database-header";
    root.append(overlay);
    overlay.append(input);
    pinned.value.node.tableSearchParentId = "A";
    input.focus();
    input.setSelectionRange(1, 1);
    await run();
    expect(scroller.scrollTop).toBe(14000);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);
  });

  it("does not scroll or steal focus after the user selects another control", async () => {
    const { scroller, refresh, run } = fixture(true);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    await run();
    expect(scroller.scrollTop).toBe(14000);
    expect(refresh).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it("ignores an obsolete search response", async () => {
    const { current, scroller, refresh, run } = fixture(true);
    current.value = false;
    await run();
    expect(scroller.scrollTop).toBe(14000);
    expect(refresh).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not restore a search control removed by collapse or disabling search", async () => {
    const { nodes, scroller, refresh, run } = fixture(true);
    nodes.value = [];
    await run();
    expect(scroller.scrollTop).toBe(14000);
    expect(refresh).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
