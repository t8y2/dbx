import { StateEffect, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { MAX_ALIAS_HIGHLIGHT_SQL_LENGTH, sqlAliasHighlightGroups, type SqlAliasHighlightGroup } from "@/lib/sql/semantic/aliasHighlights";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { resolveSqlStatementWindow, resolveStatementWindowFromSyntaxTree } from "@/lib/sql/sqlSyntaxTreeWindow";
import type { SqlSemanticBuildOptions } from "@/lib/sql/semantic/types";

const refreshAliasHighlights = StateEffect.define<null>();
const aliasMark = Decoration.mark({ class: "cm-sqlAliasHighlight" });

export function createSqlAliasHighlights(options: SqlSemanticBuildOptions & { enabled: boolean }): Extension {
  if (!options.enabled) return [];
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet = Decoration.none;
        private timer: ReturnType<typeof setTimeout> | null = null;
        private doc: Text | null = null;
        private sql = "";
        private window: { from: number; to: number } | null = null;
        private groups: SqlAliasHighlightGroup[] = [];

        constructor(view: EditorView) {
          this.schedule(view);
        }

        update(update: ViewUpdate) {
          if (update.docChanged || update.selectionSet || update.focusChanged) {
            this.decorations = Decoration.none;
            this.schedule(update.view);
          } else if (update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshAliasHighlights)))) {
            this.render(update.view);
          } else if (update.viewportChanged) {
            this.render(update.view);
          }
        }

        destroy() {
          if (this.timer !== null) clearTimeout(this.timer);
        }

        private schedule(view: EditorView) {
          if (this.timer !== null) clearTimeout(this.timer);
          this.timer = null;
          if (!view.hasFocus || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return;
          this.timer = setTimeout(() => {
            this.timer = null;
            view.dispatch({ effects: refreshAliasHighlights.of(null) });
          }, 100);
        }

        private render(view: EditorView) {
          const { state } = view;
          this.decorations = Decoration.none;
          if (this.timer !== null || !view.hasFocus || state.selection.ranges.length !== 1 || !state.selection.main.empty) return;
          const cursor = state.selection.main.head;
          if (this.doc !== state.doc) {
            this.doc = state.doc;
            this.sql = "";
            this.window = null;
          }
          if (!this.window || cursor < this.window.from || cursor >= this.window.to) {
            let window = resolveStatementWindowFromSyntaxTree(state, cursor);
            if (!window) {
              // Avoid flattening huge documents while the incremental parser is still catching up.
              if (state.doc.length > MAX_ALIAS_HIGHLIGHT_SQL_LENGTH) return;
              this.sql ||= state.doc.toString();
              window = resolveSqlStatementWindow(this.sql, cursor, state, sqlSemanticDialectFor(options).id);
            }
            this.window = window;
            this.groups = window.to - window.from <= MAX_ALIAS_HIGHLIGHT_SQL_LENGTH ? sqlAliasHighlightGroups(state.doc.sliceString(window.from, window.to), options) : [];
          }
          const offset = this.window.from;
          const localCursor = cursor - offset;
          const containsCursor = (span: { start: number; end: number }) => span.start <= localCursor && localCursor <= span.end;
          const group = this.groups.find((candidate) => containsCursor(candidate.declaration) || candidate.qualifiers.some(containsCursor));
          if (!group) return;
          const ranges = [group.declaration, ...group.references].filter((span) => view.visibleRanges.some((visible) => span.end + offset > visible.from && span.start + offset < visible.to)).map((span) => aliasMark.range(span.start + offset, span.end + offset));
          this.decorations = Decoration.set(ranges, true);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.baseTheme({
      ".cm-sqlAliasHighlight": {
        backgroundColor: "rgb(34 139 74 / 0.16)",
        boxShadow: "inset 0 0 0 1px rgb(34 139 74 / 0.28)",
        borderRadius: "2px",
      },
      "&dark .cm-sqlAliasHighlight": {
        backgroundColor: "rgb(110 231 183 / 0.18)",
        boxShadow: "inset 0 0 0 1px rgb(110 231 183 / 0.32)",
      },
    }),
  ];
}
