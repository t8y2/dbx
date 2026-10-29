import type { Command, KeyBinding } from "@codemirror/view";
import type { DatabaseType } from "@/types/database";
import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { parseShortcutStrokes } from "@/lib/editor/shortcutDisplay";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { graphQueryProfile, isGraphQueryDatabase } from "@/lib/graph/graphQueryProfiles";

const SQL_LINE_COMMENT_TOKEN = "--";

// Editors that speak a shell/script dialect instead of SQL keep their native line comment marker.
const LINE_COMMENT_TOKENS: Partial<Record<DatabaseType, string>> = {
  mongodb: "//",
};

export function queryEditorLineCommentToken(dbType?: DatabaseType): string {
  if (!dbType) return SQL_LINE_COMMENT_TOKEN;
  if (isGraphQueryDatabase(dbType)) return graphQueryProfile(dbType).lineComment;
  return LINE_COMMENT_TOKENS[dbType] ?? SQL_LINE_COMMENT_TOKEN;
}

export function queryEditorCommentTokens(dbType?: DatabaseType) {
  return {
    line: queryEditorLineCommentToken(dbType),
    block: { open: "/*", close: "*/" },
  };
}

export function queryEditorWordLanguageData(dbType?: DatabaseType) {
  return dbType === "sqlserver" ? [{ wordChars: "@#" }] : [];
}

/**
 * Creates CodeMirror keybindings for toggling line comments.
 * Single-stroke shortcuts use an `any` handler backed by `matchesShortcut`
 * so that physical key fallback (Slash / NumpadDivide) works seamlessly
 * even when active IMEs (e.g. Windows Chinese IME producing "、" or "Process"),
 * numpad keys ("Divide"), or layout shifts alter `KeyboardEvent.key`.
 */
export function createQueryEditorLineCommentShortcutBindings(shortcut: string, run: Command, platform = globalThis.navigator?.platform || ""): KeyBinding[] {
  if (!shortcut) return [];

  if (parseShortcutStrokes(shortcut).length === 1) {
    return [
      {
        any(view, event) {
          if (event.isComposing && event.code !== "Slash" && event.code !== "NumpadDivide") return false;
          if (!matchesShortcut(event, shortcut, platform)) return false;
          if (run(view)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    ];
  }

  return [{ key: shortcutToCodeMirrorKey(shortcut), preventDefault: true, run }];
}
