import { describe, expect, it } from "vitest";
import { resolveGridFocusRestoreTarget, shouldRestoreDataGridFocusAfterEditCommit } from "@/lib/dataGrid/dataGridFocusRestore";

function element(overrides: { connected?: boolean; children?: HTMLElement[]; closest?: Record<string, HTMLElement | null>; ownerDocument?: { body: HTMLElement; documentElement: HTMLElement }; activeGrid?: boolean } = {}) {
  const children = overrides.children ?? [];
  const target = {
    isConnected: overrides.connected ?? true,
    contains: (other: Element | null) => !!other && (children as Element[]).includes(other),
    closest: (selector: string) => overrides.closest?.[selector] ?? null,
    ownerDocument: overrides.ownerDocument,
    dataset: overrides.activeGrid === undefined ? {} : { gridActive: String(overrides.activeGrid) },
  } as unknown as HTMLElement;
  return target;
}

describe("resolveGridFocusRestoreTarget", () => {
  it("returns null when the grid never held focus", () => {
    const root = element();
    expect(resolveGridFocusRestoreTarget(root, null, null)).toBeNull();
  });

  it("returns null when focus is already inside the grid", () => {
    const input = element();
    const root = element({ children: [input] });
    expect(resolveGridFocusRestoreTarget(root, input, input)).toBeNull();
  });

  it("restores the last focused inner element when focus was left on the tab strip", () => {
    const searchInput = element();
    const root = element({ children: [searchInput] });
    const tabButton = element({ closest: { ".app-tab-bar, [role='tab'], [role='tablist']": element() } });
    expect(resolveGridFocusRestoreTarget(root, searchInput, tabButton)).toBe(searchInput);
  });

  it("falls back to the grid root when the last focused element was removed", () => {
    const staleEditor = element({ connected: false });
    const root = element();
    const tabButton = element({ closest: { ".app-tab-bar, [role='tab'], [role='tablist']": element() } });
    expect(resolveGridFocusRestoreTarget(root, staleEditor, tabButton)).toBe(root);
  });

  it("falls back to the grid root from body when the last focused element moved", () => {
    const movedElsewhere = element();
    const body = element();
    const documentElement = element();
    const root = element({ ownerDocument: { body, documentElement } });
    expect(resolveGridFocusRestoreTarget(root, movedElsewhere, body)).toBe(root);
  });

  it("does not steal focus from an external dialog or editor", () => {
    const searchInput = element();
    const root = element({ children: [searchInput] });
    const dialogInput = element();
    expect(resolveGridFocusRestoreTarget(root, searchInput, dialogInput)).toBeNull();
  });

  it("restores from an inactive grid but not from another active grid", () => {
    const searchInput = element();
    const root = element({ children: [searchInput] });
    const inactiveGrid = element({ activeGrid: false });
    const inactiveGridInput = element({ closest: { "[data-grid-root]": inactiveGrid } });
    expect(resolveGridFocusRestoreTarget(root, searchInput, inactiveGridInput)).toBe(searchInput);

    const activeGrid = element({ activeGrid: true });
    const activeGridInput = element({ closest: { "[data-grid-root]": activeGrid } });
    expect(resolveGridFocusRestoreTarget(root, searchInput, activeGridInput)).toBeNull();
  });
});

describe("shouldRestoreDataGridFocusAfterEditCommit", () => {
  it("restores focus when the grid root is not mounted yet", () => {
    expect(shouldRestoreDataGridFocusAfterEditCommit(null, null)).toBe(true);
    expect(shouldRestoreDataGridFocusAfterEditCommit(undefined, null)).toBe(true);
  });

  it("keeps focus in the grid after a keyboard commit", () => {
    const input = element();
    const root = element({ children: [input] });
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, input)).toBe(true);
  });

  it("restores focus when the blur landed on body or the document element", () => {
    const body = element();
    const documentElement = element();
    const root = element({ ownerDocument: { body, documentElement } });
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, body)).toBe(true);
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, documentElement)).toBe(true);
  });

  it("restores focus from a stale removed element", () => {
    const root = element();
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, element({ connected: false }))).toBe(true);
  });

  it("restores focus when the tab strip took it", () => {
    const root = element();
    const tabButton = element({ closest: { ".app-tab-bar, [role='tab'], [role='tablist']": element() } });
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, tabButton)).toBe(true);
  });

  it("does not steal focus back from the SQL editor after an outside click", () => {
    const root = element();
    const sqlEditor = element();
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, sqlEditor)).toBe(false);
  });

  it("does not steal focus back from another active grid", () => {
    const root = element();
    const grid = element({ activeGrid: true });
    const otherGridInput = element({ closest: { "[data-grid-root]": grid } });
    expect(shouldRestoreDataGridFocusAfterEditCommit(root, otherGridInput)).toBe(false);
  });
});
