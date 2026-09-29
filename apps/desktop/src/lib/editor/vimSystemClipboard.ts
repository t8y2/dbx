type VimApi = typeof import("@replit/codemirror-vim").Vim;

export interface VimClipboardAccess {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** Add `set clipboard=unnamedplus` without replacing CodeMirror Vim's editing commands. */
export function configureVimSystemClipboard(vimApi: VimApi, clipboard: VimClipboardAccess): void {
  let clipboardOption = "";
  let unnamedPlus = false;

  vimApi.defineOption("clipboard", "", "string", ["cb"], (value) => {
    if (value !== undefined) {
      clipboardOption = value;
      unnamedPlus = value.split(",").includes("unnamedplus");
    }
    return clipboardOption;
  });

  const registers = vimApi.getRegisterController();
  const pushText = registers.pushText.bind(registers);
  registers.pushText = (registerName, operator, text, linewise, blockwise) => {
    if (unnamedPlus && registerName === "+") {
      // The library writes explicit + yanks through navigator.clipboard. Use
      // DBX's native clipboard path in the desktop webview instead.
      const value = linewise && !text.endsWith("\n") ? `${text}\n` : text;
      registers.getRegister("+").setText(value, linewise, blockwise);
      registers.unnamedRegister.setText(value, linewise, blockwise);
    } else {
      pushText(registerName, operator, text, linewise, blockwise);
    }
    if (unnamedPlus && registerName !== "_") {
      void clipboard.writeText(registers.unnamedRegister.toString()).catch((error) => {
        console.warn("[vim-config] could not write to system clipboard", error);
      });
    }
  };

  const findKey = vimApi.findKey.bind(vimApi);
  const pendingPastes = new WeakSet<object>();
  vimApi.findKey = (cm, key, origin) => {
    if (pendingPastes.has(cm)) return () => true;
    const registerName = cm.state.vim?.inputState.registerName;
    const command = findKey(cm, key, origin);
    if (!unnamedPlus || (key !== "p" && key !== "P") || (registerName && registerName !== "+") || !command || cm.state.vim?.insertMode) return command;

    return () => {
      const vimState = cm.state.vim;
      if (!vimState) return command();
      const previousText = registers.unnamedRegister.toString();
      const previousLinewise = registers.unnamedRegister.linewise;
      pendingPastes.add(cm);
      void clipboard
        .readText()
        .then((text) => {
          if (cm.state.vim !== vimState) return;
          const linewise = text === previousText ? previousLinewise : text.endsWith("\n");
          registers.unnamedRegister.setText(text, linewise, false);
          // Explicit + pastes must use the freshly read native clipboard, not
          // the library's navigator.clipboard branch.
          vimState.inputState.registerName = undefined;
          command();
        })
        .catch((error) => {
          console.warn("[vim-config] could not read system clipboard", error);
          if (cm.state.vim === vimState) {
            vimState.inputState.registerName = undefined;
            command();
          }
        })
        .finally(() => {
          pendingPastes.delete(cm);
        });
      return true;
    };
  };
}
