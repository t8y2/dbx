import { describe, expect, it, vi } from "vitest";
import { createQueryEditorSearchKeymap, replaceFallbackKey } from "@/lib/editor/queryEditorSearchKeymap";

describe("QueryEditor search shortcuts", () => {
  it("opens search and replace in editable editors", () => {
    const openSearch = vi.fn(() => true);
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openSearch, openReplace, isReadOnly: () => false }, "Win32");

    expect(bindings.map(({ key, preventDefault }) => ({ key, preventDefault }))).toEqual([
      { key: "Mod-f", preventDefault: true },
      { key: "Mod-h", preventDefault: true },
    ]);
    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(bindings[1]?.run?.({} as never)).toBe(true);
    expect(openSearch).toHaveBeenCalledOnce();
    expect(openReplace).toHaveBeenCalledOnce();
  });

  it("leaves Cmd+H to the system on macOS and binds the platform replace key instead", () => {
    const openSearch = vi.fn(() => true);
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openSearch, openReplace, isReadOnly: () => false }, "MacIntel");

    // ⌘H must stay unbound: the webview's preventDefault would keep AppKit's
    // Hide key equivalent from ever firing (#9068).
    expect(bindings.map(({ key }) => key)).not.toContain("Mod-h");
    expect(bindings.map(({ key, preventDefault }) => ({ key, preventDefault }))).toEqual([
      { key: "Mod-f", preventDefault: true },
      { key: "Alt-Mod-f", preventDefault: true },
    ]);
    expect(bindings[1]?.run?.({} as never)).toBe(true);
    expect(openReplace).toHaveBeenCalledOnce();
  });

  it("keeps the macOS replace fallback while consuming it without mutation controls in read-only editors", () => {
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openSearch: vi.fn(() => true), openReplace, isReadOnly: () => true }, "MacIntel");

    expect(bindings[1]?.key).toBe("Alt-Mod-f");
    expect(bindings[1]?.run?.({} as never)).toBe(true);
    expect(openReplace).not.toHaveBeenCalled();
  });

  it("maps the built-in replace fallback per platform", () => {
    expect(replaceFallbackKey("MacIntel")).toBe("Alt-Mod-f");
    expect(replaceFallbackKey("Win32")).toBe("Mod-h");
    expect(replaceFallbackKey("Linux x86_64")).toBe("Mod-h");
  });

  it("allows search but consumes replace without opening it in read-only editors", () => {
    const openSearch = vi.fn(() => true);
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openSearch, openReplace, isReadOnly: () => true }, "Win32");

    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(bindings[1]?.run?.({} as never)).toBe(true);
    expect(openSearch).toHaveBeenCalledOnce();
    expect(openReplace).not.toHaveBeenCalled();
  });
});
