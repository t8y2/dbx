// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { configureVimSystemClipboard } from "../vimSystemClipboard";

describe("Vim system clipboard", () => {
  it("connects unnamed yanks and pastes to the clipboard when configured", async () => {
    const [{ EditorState }, { EditorView }, { Vim, vim, getCM }] = await Promise.all([import("@codemirror/state"), import("@codemirror/view"), import("@replit/codemirror-vim")]);
    const clipboard = {
      readText: vi.fn().mockResolvedValue("external"),
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    configureVimSystemClipboard(Vim, clipboard);
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: "A", extensions: [vim()] }) });
    try {
      const cm = getCM(view);
      expect(cm).not.toBeNull();
      if (!cm) return;
      const registers = Vim.getRegisterController();
      registers.pushText(undefined, "yank", "internal");
      expect(clipboard.writeText).not.toHaveBeenCalled();

      Vim.handleEx(cm, "set clipboard=unnamedplus");
      expect(Vim.getOption("clipboard", cm as Parameters<typeof Vim.getOption>[1])).toBe("unnamedplus");
      registers.pushText(undefined, "yank", "selected SQL");
      expect(clipboard.writeText).toHaveBeenCalledWith("selected SQL");
      Vim.handleKey(cm, "y");
      Vim.handleKey(cm, "y");
      expect(clipboard.writeText).toHaveBeenCalledWith("A\n");

      Vim.handleKey(cm, "p");
      await vi.waitFor(() => expect(view.state.doc.toString()).toContain("external"));
      expect(clipboard.readText).toHaveBeenCalledOnce();

      Vim.handleEx(cm, "set clipboard=");
      clipboard.writeText.mockClear();
      registers.pushText(undefined, "yank", "local only");
      expect(clipboard.writeText).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
