import { EditorSelection, type SelectionRange } from "@codemirror/state";
import type { EditorSearchMatch } from "@/lib/editor/editorSearchQuery";
import { isMacShortcutPlatform } from "@/lib/editor/shortcutDisplay";

export type EditorSearchSelectionDirection = "next" | "prev";

export interface SearchSelectionModifierEvent {
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export function isSearchAddSelectionModifier(event: SearchSelectionModifierEvent, platform = globalThis.navigator?.platform || ""): boolean {
  return isMacShortcutPlatform(platform) ? !!event.metaKey : !!event.ctrlKey;
}

function isMatchCovered(selection: EditorSelection, match: EditorSearchMatch): boolean {
  let low = 0;
  let high = selection.ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (selection.ranges[middle].from <= match.from) low = middle + 1;
    else high = middle;
  }
  const range = selection.ranges[low - 1];
  return !!range && range.to >= match.to;
}

export function findSearchMatch(matches: Iterable<EditorSearchMatch>, cursor: number, direction: EditorSearchSelectionDirection, accept: (match: EditorSearchMatch) => boolean = () => true): EditorSearchMatch | null {
  let wrapped: EditorSearchMatch | null = null;
  let target: EditorSearchMatch | null = null;

  for (const match of matches) {
    if (!accept(match)) continue;
    if (direction === "next") {
      wrapped ??= match;
      if (match.from >= cursor) return match;
    } else {
      wrapped = match;
      if (match.to <= cursor) target = match;
    }
  }

  return target ?? wrapped;
}

export function selectionRangesForSearchMatches(matches: readonly EditorSearchMatch[]): SelectionRange[] {
  return matches.map((match) => EditorSelection.range(match.from, match.to));
}

export function appendSearchMatchSelection(selection: EditorSelection, matches: Iterable<EditorSearchMatch>, direction: EditorSearchSelectionDirection): EditorSelection | null {
  const target = findSearchMatch(matches, selection.main.head, direction, (match) => !isMatchCovered(selection, match));
  return target ? selection.addRange(EditorSelection.range(target.from, target.to), true) : null;
}
