import type { EditorView } from "@codemirror/view";
import type { ShortcutActionId } from "@/lib/editor/shortcutRegistry";

type VimApi = typeof import("@replit/codemirror-vim").Vim;
type GetVimEditor = typeof import("@replit/codemirror-vim").getCM;
type VimCm = NonNullable<ReturnType<GetVimEditor>>;

/** DOM event the `:dbx` Ex command dispatches; bubbles from the editor's contentDOM. */
export const DBX_VIM_ACTION_EVENT = "dbx-vim-action";

export interface DbxVimActionDetail {
  action: ShortcutActionId;
  /** Extra words after the action name, e.g. `:dbx formatSql foo` → ["foo"]. */
  args: string[];
}

export type DbxVimActionEvent = CustomEvent<DbxVimActionDetail>;

/**
 * Actions `:dbx` accepts. Names reuse ShortcutActionId so the vimrc and the
 * shortcut settings speak the same vocabulary. Matching is case-insensitive.
 */
export const DBX_VIM_ACTIONS = [
  // editor scope (handled by QueryEditor)
  "executeSql",
  "executeSqlInNewResultTab",
  "explainSql",
  "formatSql",
  "saveSql",
  "expandSelectStar",
  "toggleLineComment",
  "toggleBlockComment",
  "selectCurrentStatement",
  "previousStatement",
  "nextStatement",
  "statementStart",
  "uppercaseSelection",
  "lowercaseSelection",
  "sendSelectionToAi",
  "sqlIntentionActions",
  // app scope (fall through to App.vue's window listener)
  "newQuery",
  "closeTab",
  "closeOtherTabs",
  "closeAllTabs",
  "reopenClosedTab",
  "openSettings",
] as const satisfies readonly ShortcutActionId[];

const actionByLowerName = new Map<string, ShortcutActionId>(DBX_VIM_ACTIONS.map((id) => [id.toLowerCase(), id]));

export function resolveDbxVimAction(name: string | undefined): ShortcutActionId | undefined {
  return name ? actionByLowerName.get(name.toLowerCase()) : undefined;
}

/**
 * `:'<,'>dbx ...` runs after codemirror-vim has already left visual mode and
 * collapsed the selection. Rebuild it from `vim.lastSelection` so actions like
 * executeSql / formatSql keep their "selection first" behaviour.
 */
function restoreVisualSelection(cm: VimCm, view: EditorView): void {
  const last = cm.state.vim?.lastSelection;
  if (!last) return;
  const doc = view.state.doc;
  const offset = (pos: { line: number; ch: number }) => {
    const line = doc.line(Math.min(Math.max(pos.line + 1, 1), doc.lines));
    return Math.min(line.from + pos.ch, line.to);
  };
  const a = last.anchorMark?.find?.() ?? last.anchor;
  const h = last.headMark?.find?.() ?? last.head;
  let from = Math.min(offset(a), offset(h));
  let to = Math.max(offset(a), offset(h));
  if (last.visualLine || last.visualBlock) {
    // Block mode has no single-range equivalent; treat it like linewise.
    from = doc.lineAt(from).from;
    to = doc.lineAt(to).to;
  } else {
    // Vim's charwise head is inclusive; CodeMirror ranges are half-open.
    to = Math.min(to + 1, doc.length);
  }
  view.dispatch({ selection: { anchor: from, head: to } });
}

function isVisualRangeInput(input: string): boolean {
  return /^\s*'<\s*,\s*'>/.test(input);
}

/** `executeSql` → `DbxExecuteSql`, the space-free Ex name used in vimrc mappings. */
export function dbxVimExCommandName(action: ShortcutActionId): string {
  return `Dbx${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

function dispatchDbxAction(cm: VimCm, params: { input: string }, action: ShortcutActionId, args: string[]): void {
  const view = cm.cm6;
  if (!view) return;
  if (isVisualRangeInput(params.input)) restoreVisualSelection(cm, view);
  view.contentDOM.dispatchEvent(
    new CustomEvent<DbxVimActionDetail>(DBX_VIM_ACTION_EVENT, {
      bubbles: true,
      cancelable: true,
      detail: { action, args },
    }),
  );
}

/**
 * Register the Vim side of DBX actions. Safe to call once per app session.
 *
 * - `:dbx <action> [args...]` for typing interactively.
 * - `:DbxExecuteSql`, `:DbxFormatSql`, … one per action, for vimrc mappings.
 *   codemirror-vim's `:map` splits its arguments on whitespace, so
 *   `nnoremap Qr :dbx executeSql<CR>` would map only `:dbx`; the space-free
 *   names avoid that.
 */
export function configureVimDbxActions(vimApi: VimApi, options: { onUnknownAction?: (name: string) => void } = {}): void {
  vimApi.defineEx("dbx", "dbx", (cm, params) => {
    const [name, ...args] = params.args ?? (params.argString ?? "").trim().split(/\s+/).filter(Boolean);
    const action = resolveDbxVimAction(name);
    if (!action) {
      options.onUnknownAction?.(name ?? "");
      return;
    }
    dispatchDbxAction(cm as VimCm, params, action, args);
  });
  for (const action of DBX_VIM_ACTIONS) {
    const name = dbxVimExCommandName(action);
    vimApi.defineEx(name, name, (cm, params) => dispatchDbxAction(cm as VimCm, params, action, params.args ?? []));
  }
}
