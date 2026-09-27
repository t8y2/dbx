// @vitest-environment happy-dom

// pi-lens-ignore: typescript:2307
import { afterEach, describe, expect, it, vi } from "vitest";

// CodeMirror reads `navigator.platform` once at module load to decide how `Mod`
// expands (`browser.mac ? "mac" : …` in @codemirror/view), so the harness stubs
// the navigator and re-imports the packages — same approach as
// queryEditorExecutionShortcutWebKit.spec.ts.
const macNavigator = {
  maxTouchPoints: 0,
  platform: "MacIntel",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
  vendor: "Apple Computer, Inc.",
};
const winNavigator = {
  maxTouchPoints: 0,
  platform: "Win32",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  vendor: "",
};

interface MacKeyInit {
  key: string;
  code: string;
  keyCode: number;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

function keyEvent(init: MacKeyInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  // KeyboardEvent's init dict ignores keyCode, but CodeMirror's macOS
  // Option-letter fallback matches on `base[keyCode]` (⌥F arrives as key "ƒ"),
  // which a real webview always provides.
  Object.defineProperty(event, "keyCode", { get: () => init.keyCode });
  return event;
}

async function createMacSearchHarness() {
  vi.stubGlobal("navigator", macNavigator);
  vi.resetModules();

  const [{ EditorState }, { EditorView, keymap }, { createQueryEditorSearchKeymap }] = await Promise.all([import("@codemirror/state"), import("@codemirror/view"), import("../../editor/queryEditorSearchKeymap")]);
  const openSearch = vi.fn(() => true);
  const openReplace = vi.fn(() => true);
  const root = document.createElement("div");
  document.body.append(root);
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      // No explicit platform: this exercises the production wiring, where the
      // editor surface passes options only and the keymap reads the navigator.
      extensions: [keymap.of(createQueryEditorSearchKeymap({ openSearch, openReplace, isReadOnly: () => false }))],
    }),
  });
  return { view, openSearch, openReplace };
}

// Composed regression for the *configurable* replace path (#9068 config layer):
// normalizeShortcutSettings must repair a synced `replace: "Mod+H"` to the mac
// default `Mod+R`, so the replace bindings+handler built from the normalized
// value can no longer consume ⌘H — while the same normalized "Mod+H" on Win32
// (where it means Ctrl+H) must still consume Ctrl+H. Runs under a stubbed mac
// navigator, so CodeMirror resolves Mod→Meta for the keymap and matchesShortcut
// resolves Mod→Meta for the DOM handler, exactly like production on a mac.
async function createReservedKeyHarness(platform: "mac" | "win") {
  vi.stubGlobal("navigator", platform === "mac" ? macNavigator : winNavigator);
  vi.resetModules();

  const [{ EditorState, Prec }, { EditorView, keymap }, { normalizeShortcutSettings }, { createQueryEditorReplaceShortcutBindings, createQueryEditorReplaceShortcutHandler }] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("../../editor/shortcutRegistry"),
    import("../../editor/queryEditorSearchKeymap"),
  ]);
  const shortcut = normalizeShortcutSettings({ replace: "Mod+H" }, platform === "mac" ? "MacIntel" : "Win32").replace;
  const openReplace = vi.fn(() => true);
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      extensions: [
        Prec.high(
          EditorView.domEventHandlers({
            keydown: createQueryEditorReplaceShortcutHandler({ shortcut, openReplace, isReadOnly: () => false }),
          }),
        ),
        Prec.high(keymap.of(createQueryEditorReplaceShortcutBindings(shortcut, openReplace))),
      ],
    }),
  });
  return { shortcut, view, openReplace };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("QueryEditor search keymap on macOS", () => {
  it("opens replace with the platform shortcut (⌥⌘F) instead of ⌘H", async () => {
    const { view, openReplace } = await createMacSearchHarness();

    const event = keyEvent({ key: "ƒ", code: "KeyF", keyCode: 70, altKey: true, metaKey: true });
    view.contentDOM.dispatchEvent(event);

    expect(openReplace).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  it("leaves ⌘H to the system so macOS can hide the app", async () => {
    const { view, openReplace } = await createMacSearchHarness();

    const event = keyEvent({ key: "h", code: "KeyH", keyCode: 72, metaKey: true });
    view.contentDOM.dispatchEvent(event);

    expect(openReplace).not.toHaveBeenCalled();
    // Not consumed: the key event must reach AppKit's Hide menu equivalent.
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("still opens search with ⌘F", async () => {
    const { view, openSearch } = await createMacSearchHarness();

    const event = keyEvent({ key: "f", code: "KeyF", keyCode: 70, metaKey: true });
    view.contentDOM.dispatchEvent(event);

    expect(openSearch).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  it("a configurable replace that was synced as ⌘H is repaired and no longer consumes ⌘H", async () => {
    const { shortcut, view, openReplace } = await createReservedKeyHarness("mac");

    // normalizeShortcutSettings({ replace: "Mod+H" }, "MacIntel") must repair to Mod+R.
    expect(shortcut).toBe("Mod+R");
    const event = keyEvent({ key: "h", code: "KeyH", keyCode: 72, metaKey: true });
    view.contentDOM.dispatchEvent(event);

    expect(openReplace).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("on Win32 the same synced Mod+H (Ctrl+H) stays a live replace shortcut", async () => {
    const { shortcut, view, openReplace } = await createReservedKeyHarness("win");

    expect(shortcut).toBe("Mod+H");
    const event = keyEvent({ key: "h", code: "KeyH", keyCode: 72, ctrlKey: true });
    view.contentDOM.dispatchEvent(event);

    expect(openReplace).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });
});
