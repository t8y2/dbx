import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { shellLineCommentRanges } from "@/lib/editor/shellLineCommentRanges";

type EditorViewType = import("@codemirror/view").EditorView;
type DecorationSet = import("@codemirror/view").DecorationSet;
interface SyntaxNodeLike {
  name: string;
  parent: SyntaxNodeLike | null;
}

export const SHELL_LINE_COMMENT_CLASS = "cm-shell-line-comment";

interface ShellLineCommentHighlightDeps {
  ViewPlugin: typeof import("@codemirror/view").ViewPlugin;
  Decoration: typeof import("@codemirror/view").Decoration;
  highlightingFor: typeof import("@codemirror/language").highlightingFor;
  syntaxTree: typeof import("@codemirror/language").syntaxTree;
}

/** Reuses the active theme's comment colour so `//` matches what the SQL grammar gives `--`. */
export function shellLineCommentClass(state: import("@codemirror/state").EditorState, highlightingFor: ShellLineCommentHighlightDeps["highlightingFor"]): string {
  const themeClass = highlightingFor(state, [tags.lineComment, tags.comment]);
  return themeClass ? `${SHELL_LINE_COMMENT_CLASS} ${themeClass}` : SHELL_LINE_COMMENT_CLASS;
}

export function createShellLineCommentHighlight({ ViewPlugin, Decoration, highlightingFor, syntaxTree }: ShellLineCommentHighlightDeps): Extension {
  function buildDecorations(view: EditorViewType, className: string): DecorationSet {
    const tree = syntaxTree(view.state);
    const ranges = new Map<number, number>();
    for (const visibleRange of view.visibleRanges) {
      const from = view.state.doc.lineAt(visibleRange.from).from;
      const to = view.state.doc.lineAt(visibleRange.to).to;
      const text = view.state.doc.sliceString(from, to);
      for (const range of shellLineCommentRanges(text)) {
        const absoluteFrom = from + range.from;
        const absoluteTo = from + range.to;
        if (absoluteFrom >= visibleRange.to || absoluteTo <= visibleRange.from) continue;
        let node: SyntaxNodeLike | null = tree.resolveInner(absoluteFrom, 1);
        let excluded = false;
        while (node) {
          if (node.name === "BlockComment" || node.name === "String" || node.name === "QuotedIdentifier") {
            excluded = true;
            break;
          }
          node = node.parent;
        }
        if (!excluded) ranges.set(absoluteFrom, absoluteTo);
      }
    }
    const decoration = Decoration.mark({ class: className });
    return Decoration.set([...ranges].sort(([left], [right]) => left - right).map(([from, to]) => decoration.range(from, to)));
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      className: string;
      constructor(view: EditorViewType) {
        this.className = shellLineCommentClass(view.state, highlightingFor);
        this.decorations = buildDecorations(view, this.className);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        const className = shellLineCommentClass(update.state, highlightingFor);
        if (!update.docChanged && !update.viewportChanged && className === this.className) return;
        this.className = className;
        this.decorations = buildDecorations(update.view, className);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
