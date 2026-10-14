import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type ViewModule = typeof import("@codemirror/view");
type GetVimEditor = typeof import("@replit/codemirror-vim").getCM;

const imePhysicalKeys: Record<string, string> = {
  Space: " ",
  Backquote: "`~",
  Minus: "-_",
  Equal: "=+",
  BracketLeft: "[{",
  BracketRight: "]}",
  Backslash: "\\|",
  Semicolon: ";:",
  Quote: "'\"",
  Comma: ",<",
  Period: ".>",
  Slash: "/?",
};

function imeCommandKey(event: KeyboardEvent): string | undefined {
  if (event.key !== "Process" && event.key !== "Unidentified") return event.key;
  if (/^Key[A-Z]$/.test(event.code)) {
    const letter = event.code.slice(3);
    return event.shiftKey ? letter : letter.toLowerCase();
  }
  if (/^Digit\d$/.test(event.code)) {
    const digit = event.code.slice(5);
    return event.shiftKey ? ")!@#$%^&*("[Number(digit)] : digit;
  }
  const pair = imePhysicalKeys[event.code];
  return pair?.[event.shiftKey && pair.length > 1 ? 1 : 0];
}

/** Keep IME input on Vim's command path while normal/visual mode owns the editor. */
export function createVimImeGuard({ EditorView, ViewPlugin }: Pick<ViewModule, "EditorView" | "ViewPlugin">, getCM: GetVimEditor): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        constructor(private view: EditorView) {
          // CodeMirror skips its DOM key handlers during composition. Capture
          // IME keys before that check, then use Vim's existing command handler
          // so mappings, pending operators, status and multiple cursors agree.
          view.contentDOM.addEventListener("keydown", this.keydown, true);
        }

        private keydown = (event: KeyboardEvent) => {
          const cm = getCM(this.view);
          const vim = cm?.state.vim;
          if (!vim || vim.insertMode || vim.expectLiteralNext || cm.state.dialog || event.defaultPrevented) return;
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (!event.isComposing && event.keyCode !== 229 && event.key !== "Process" && event.key !== "Unidentified" && !this.view.compositionStarted) return;
          const key = imeCommandKey(event);
          if (!key || key === "Dead") return;
          const plugin = cm.state.vimPlugin;
          if (!plugin) return;
          const handled = plugin.handleKey(new KeyboardEvent("keydown", { key, code: event.code, shiftKey: event.shiftKey }), this.view);
          if (!handled && key.length !== 1) return;
          // Even an unmapped printable key must not become SQL in normal mode.
          event.preventDefault();
          event.stopImmediatePropagation();
        };

        destroy() {
          this.view.contentDOM.removeEventListener("keydown", this.keydown, true);
        }
      },
    ),
    // Put this after vim(): let its single-character/literal handling run
    // first, then swallow text that an IME commits without a usable keydown.
    // Vim edits and clipboard paste dispatch transactions directly, so this
    // does not block commands that intentionally change the document.
    EditorView.inputHandler.of((view) => {
      const cm = getCM(view);
      const vim = cm?.state.vim;
      return !!vim && !vim.insertMode && !vim.expectLiteralNext && !cm.state.dialog;
    }),
  ];
}
