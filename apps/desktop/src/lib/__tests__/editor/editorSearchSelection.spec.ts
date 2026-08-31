import { readFileSync } from "node:fs";
import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { appendSearchMatchSelection, findSearchMatch, isSearchAddSelectionModifier, selectionRangesForSearchMatches } from "@/lib/editor/editorSearchSelection";

const searchPanelSource = readFileSync(new URL("../../../components/editor/EditorSearchPanel.vue", import.meta.url), "utf8");
const ddlViewSource = readFileSync(new URL("../../../components/objects/DdlViewDialog.vue", import.meta.url), "utf8");
const nacosSource = readFileSync(new URL("../../../components/nacos/NacosAdminConsole.vue", import.meta.url), "utf8");

const matches = [
  { from: 0, to: 3 },
  { from: 6, to: 9 },
  { from: 12, to: 15 },
];

describe("editorSearchSelection", () => {
  it("selects every complete search match", () => {
    const ranges = selectionRangesForSearchMatches(matches);
    expect(ranges.map(({ from, to }) => ({ from, to }))).toEqual(matches);
  });

  it("appends the next unselected match and makes it main", () => {
    const current = EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(6, 9)], 1);
    const next = appendSearchMatchSelection(current, matches, "next");

    expect(next?.ranges.map(({ from, to }) => ({ from, to }))).toEqual(matches);
    expect(next?.main.from).toBe(12);
  });

  it("wraps previous from the first match to the last", () => {
    const current = EditorSelection.single(0, 3);

    expect(appendSearchMatchSelection(current, matches, "prev")?.main.from).toBe(12);
  });

  it("finds next and previous matches from a streaming iterable", () => {
    function* stream() {
      yield* matches;
    }

    expect(findSearchMatch(stream(), 7, "next")).toEqual({ from: 12, to: 15 });
    expect(findSearchMatch(stream(), 6, "prev")).toEqual({ from: 0, to: 3 });
    expect(findSearchMatch(stream(), 0, "prev")).toEqual({ from: 12, to: 15 });
  });

  it("appends after the maximum batch selection without building ordered copies", () => {
    function* stream() {
      for (let index = 0; index < 50000; index++) yield { from: index * 2, to: index * 2 + 1 };
    }
    const selected = EditorSelection.create(Array.from({ length: 10000 }, (_, index) => EditorSelection.range(index * 2, index * 2 + 1)));
    const startedAt = performance.now();
    const next = appendSearchMatchSelection(selected, stream(), "next");
    const elapsed = performance.now() - startedAt;

    expect(next?.main).toMatchObject({ from: 20000, to: 20001 });
    expect(elapsed).toBeLessThan(250);
  });

  it("preserves an existing reverse range", () => {
    const current = EditorSelection.create([EditorSelection.range(3, 0)]);
    const next = appendSearchMatchSelection(current, matches, "next");

    expect(next?.ranges[0]?.anchor).toBe(3);
    expect(next?.ranges[0]?.head).toBe(0);
  });

  it("returns no ranges when there is nothing to select or append", () => {
    expect(selectionRangesForSearchMatches([])).toEqual([]);
    expect(appendSearchMatchSelection(EditorSelection.create(selectionRangesForSearchMatches(matches)), matches, "next")).toBeNull();
  });

  it("uses Command-click on macOS and Ctrl-click on Windows and Linux", () => {
    expect(isSearchAddSelectionModifier({ metaKey: true }, "MacIntel")).toBe(true);
    expect(isSearchAddSelectionModifier({ ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isSearchAddSelectionModifier({ ctrlKey: true }, "Win32")).toBe(true);
    expect(isSearchAddSelectionModifier({ metaKey: true }, "Win32")).toBe(false);
    expect(isSearchAddSelectionModifier({ ctrlKey: true }, "Linux x86_64")).toBe(true);
  });

  it("wires select-all and platform-modifier-click match selection into the search panel", () => {
    expect(searchPanelSource).toContain("selectionRangesForSearchMatches");
    expect(searchPanelSource).toContain("appendSearchMatchSelection");
    expect(searchPanelSource).toContain("isSearchAddSelectionModifier(event)");
    expect(searchPanelSource).toContain('@click="selectAllMatches"');
    expect(searchPanelSource).toContain("editor.search.selectAll");
    expect(searchPanelSource).toContain("collectAllMatches(v, limit + 1)");
    expect(searchPanelSource).toContain("matches.slice(0, limit)");
    expect(searchPanelSource).toContain("countEditorSearchMatches");
    expect(searchPanelSource).toContain("editor.search.selectionLimitSummary");
    expect(searchPanelSource).not.toContain("matchCountLimited");
  });

  it("enables multiple selections in every editor using the shared panel", () => {
    expect(ddlViewSource).toContain("EditorState.allowMultipleSelections.of(true)");
    expect(nacosSource).toContain("EditorState.allowMultipleSelections.of(true)");
  });
});
