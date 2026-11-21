// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyVimConfig, isVimMappingCommand, parseVimConfig } from "../vimConfig";

const fs = { exists: vi.fn(), readTextFile: vi.fn() };

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: () => Promise.resolve("/home/tester"),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (path: string) => fs.exists(path),
  readTextFile: (path: string) => fs.readTextFile(path),
}));

describe("Vim config", () => {
  beforeEach(() => {
    fs.exists.mockReset();
    fs.readTextFile.mockReset();
  });

  it.each(["\n", "\r\n"])("parses commands, comments and blank lines with %j endings", (ending) => {
    expect(parseVimConfig(['" DBX Vim config', "", "  imap jj <Esc>  ", "  nmap Y y$", '  " another comment'].join(ending))).toEqual(["imap jj <Esc>", "nmap Y y$"]);
  });

  it("loads the file once and reuses its commands for later editors", async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue("imap jj <Esc>\r\nnmap Y y$\r\n");
    vi.resetModules();
    const { loadVimConfig } = await import("../vimConfig");
    const [first, second] = await Promise.all([loadVimConfig(), loadVimConfig()]);
    expect(first).toEqual(["imap jj <Esc>", "nmap Y y$"]);
    expect(second).toEqual(first);
    expect(fs.exists).toHaveBeenCalledExactlyOnceWith("/home/tester/.dbx/vimrc");
    expect(fs.readTextFile).toHaveBeenCalledExactlyOnceWith("/home/tester/.dbx/vimrc");
  });

  it("starts without a config file", async () => {
    fs.exists.mockResolvedValue(false);
    vi.resetModules();
    const { loadVimConfig } = await import("../vimConfig");
    expect(await loadVimConfig()).toEqual([]);
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it("continues when the file cannot be read", async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockRejectedValue(new Error("denied"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.resetModules();
      const { loadVimConfig } = await import("../vimConfig");
      expect(await loadVimConfig()).toEqual([]);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("continues after an invalid command", () => {
    const execute = vi.fn((command: string) => {
      if (command === "bogus") throw new Error("unknown command");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      applyVimConfig(["imap jj <Esc>", "bogus", "nmap Y y$"], execute);
      expect(execute.mock.calls.map(([command]) => command)).toEqual(["imap jj <Esc>", "bogus", "nmap Y y$"]);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("applies an insert mapping to a CodeMirror Vim editor", async () => {
    const [{ EditorState }, { EditorView }, { Vim, vim, getCM }] = await Promise.all([import("@codemirror/state"), import("@codemirror/view"), import("@replit/codemirror-vim")]);
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: "select 1", extensions: [vim()] }) });
    try {
      const cm = getCM(view);
      expect(cm).not.toBeNull();
      if (!cm) return;
      applyVimConfig(["imap jj <Esc>"], (command) => Vim.handleEx(cm, command));
      Vim.handleKey(cm, "i");
      expect(cm.state.vim?.insertMode).toBe(true);
      Vim.handleKey(cm, "j");
      Vim.handleKey(cm, "j");
      expect(cm.state.vim?.insertMode).toBe(false);

      const secondParent = document.createElement("div");
      document.body.append(secondParent);
      const secondView = new EditorView({ parent: secondParent, state: EditorState.create({ doc: "select 2", extensions: [vim()] }) });
      try {
        const secondCm = getCM(secondView);
        expect(secondCm).not.toBeNull();
        if (!secondCm) return;
        Vim.handleKey(secondCm, "i");
        Vim.handleKey(secondCm, "j");
        Vim.handleKey(secondCm, "j");
        expect(secondCm.state.vim?.insertMode).toBe(false);
      } finally {
        secondView.destroy();
        secondParent.remove();
      }
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("identifies shared mappings so later editor tabs do not add duplicates", () => {
    expect(isVimMappingCommand("imap jj <Esc>")).toBe(true);
    expect(isVimMappingCommand("nmap Y y$")).toBe(true);
    expect(isVimMappingCommand("inoremap jk <Esc>")).toBe(true);
    expect(isVimMappingCommand("set ignorecase")).toBe(false);
  });
});
