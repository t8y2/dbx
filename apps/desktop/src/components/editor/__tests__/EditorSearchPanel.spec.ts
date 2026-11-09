import { describe, expect, it, vi } from "vitest";
import { createQueryEditorSearchKeymap, replaceFallbackKey } from "@/lib/editor/queryEditorSearchKeymap";

describe("QueryEditor search shortcuts", () => {
  it("binds only the replace fallback; Find is left to the configurable shortcut (#14623)", () => {
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openReplace, isReadOnly: () => false }, "Win32");

    expect(bindings.map(({ key, preventDefault }) => ({ key, preventDefault }))).toEqual([{ key: "Mod-h", preventDefault: true }]);
    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(openReplace).toHaveBeenCalledOnce();
  });

  it("leaves Cmd+H to the system on macOS and binds the platform replace key instead", () => {
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openReplace, isReadOnly: () => false }, "MacIntel");

    // ⌘H must stay unbound: the webview's preventDefault would keep AppKit's
    // Hide key equivalent from ever firing (#9068).
    expect(bindings.map(({ key }) => key)).not.toContain("Mod-h");
    expect(bindings.map(({ key, preventDefault }) => ({ key, preventDefault }))).toEqual([{ key: "Alt-Mod-f", preventDefault: true }]);
    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(openReplace).toHaveBeenCalledOnce();
  });

  it("keeps the macOS replace fallback while consuming it without mutation controls in read-only editors", () => {
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openReplace, isReadOnly: () => true }, "MacIntel");

    expect(bindings[0]?.key).toBe("Alt-Mod-f");
    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(openReplace).not.toHaveBeenCalled();
  });

  it("maps the built-in replace fallback per platform", () => {
    expect(replaceFallbackKey("MacIntel")).toBe("Alt-Mod-f");
    expect(replaceFallbackKey("Win32")).toBe("Mod-h");
    expect(replaceFallbackKey("Linux x86_64")).toBe("Mod-h");
  });

  it("consumes replace without opening it in read-only editors", () => {
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openReplace, isReadOnly: () => true }, "Win32");

    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(openReplace).not.toHaveBeenCalled();
  });
});
