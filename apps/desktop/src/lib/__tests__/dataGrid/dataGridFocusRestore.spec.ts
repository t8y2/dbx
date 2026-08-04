import { describe, expect, it } from "vitest";
import { resolveGridFocusRestoreTarget } from "@/lib/dataGrid/dataGridFocusRestore";

function element(overrides: { connected?: boolean; children?: HTMLElement[] } = {}) {
  const children = overrides.children ?? [];
  return {
    isConnected: overrides.connected ?? true,
    contains: (other: Element | null) => !!other && (children as Element[]).includes(other),
  } as unknown as HTMLElement;
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
    const tabButton = element();
    expect(resolveGridFocusRestoreTarget(root, searchInput, tabButton)).toBe(searchInput);
  });

  it("falls back to the grid root when the last focused element was removed", () => {
    const staleEditor = element({ connected: false });
    const root = element();
    const tabButton = element();
    expect(resolveGridFocusRestoreTarget(root, staleEditor, tabButton)).toBe(root);
  });

  it("falls back to the grid root when the last focused element is no longer inside the grid", () => {
    const movedElsewhere = element();
    const root = element();
    expect(resolveGridFocusRestoreTarget(root, movedElsewhere, null)).toBe(root);
  });
});
