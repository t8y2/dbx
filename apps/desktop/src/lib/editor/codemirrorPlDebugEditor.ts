import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, lineNumberMarkers, lineNumbers, type BlockInfo, type DecorationSet } from "@codemirror/view";

/**
 * PL/SQL 调试的编辑器内装饰：行号区断点 + 当前执行行高亮。
 *
 * 行为对齐 ODC（Monaco）：断点只能落在行号区（`e.target.type ===
 * GUTTER_LINE_NUMBERS`），且仅在调试会话存活时可点（`debug && !isDebugEnd()`）；
 * 悬停行号区显示半透明预览点，移出即消失。断点重画采用 ODC 的"全量清除 + 全量
 * 重画"：每次 refresh 都从 `getSnapshot()` 重新构造整个 RangeSet，不做增量维护，
 * 因此后端断点列表如何变化都不会残留旧装饰。
 *
 * 与 `queryEditorSqlExtensions.ts` 里的 statement 标记一致：标记只提供
 * `elementClass`（不提供 `toDOM`），这样行号仍会正常渲染，圆点由 CSS 的 `::before`
 * 画在同一个行号格子里。
 */

/** Live decoration state, read from the store on every refresh. */
export interface PlDebugEditorSnapshot {
  /** 1-based lines carrying a breakpoint on the displayed object. */
  breakpointLines: readonly number[];
  /** 1-based line the debuggee is parked on, or null when it is not stopped. */
  currentLine: number | null;
}

export interface PlDebugEditorOptions {
  /** Re-read on every refresh effect; never cached by the extension. */
  getSnapshot: () => PlDebugEditorSnapshot;
  /** True while the gutter may toggle breakpoints (debug session still alive). */
  isEnabled: () => boolean;
  /** Toggles the breakpoint on a 1-based source line. */
  toggleBreakpoint: (lineNum: number) => void;
}

/** Pushes `getSnapshot()` into the editor; dispatched whenever the store changes. */
export const refreshPlDebugEditorEffect = StateEffect.define<null>();

/** Line under the pointer inside the line-number gutter, or null when outside it. */
const setPreviewLineEffect = StateEffect.define<number | null>();

class PlDebugBreakpointMarker extends GutterMarker {
  elementClass = "cm-pl-debug-breakpoint";
}

class PlDebugBreakpointPreviewMarker extends GutterMarker {
  elementClass = "cm-pl-debug-breakpoint-preview";
}

const breakpointMarker = new PlDebugBreakpointMarker();
const previewMarker = new PlDebugBreakpointPreviewMarker();
const currentLineDecoration = Decoration.line({ class: "cm-pl-debug-current-line" });

interface PlDebugEditorFieldValue {
  markers: RangeSet<GutterMarker>;
  previewLine: number | null;
  currentLine: DecorationSet;
}

/** Start offset of a 1-based line, or null when the line is outside the document. */
function lineStart(state: EditorState, lineNum: number | null): number | null {
  if (lineNum === null || !Number.isFinite(lineNum) || lineNum < 1 || lineNum > state.doc.lines) return null;
  return state.doc.line(lineNum).from;
}

/**
 * Rebuilds the whole decoration set from one snapshot. Breakpoints and the hover
 * preview share the line-number gutter, so the preview is skipped on a line that
 * already carries a real breakpoint.
 */
function buildFieldValue(state: EditorState, options: PlDebugEditorOptions, previewLine: number | null): PlDebugEditorFieldValue {
  const snapshot = options.getSnapshot();
  const ranges: Array<Range<GutterMarker>> = [];
  const marked = new Set<number>();
  for (const lineNum of snapshot.breakpointLines) {
    const from = lineStart(state, lineNum);
    if (from === null || marked.has(from)) continue;
    marked.add(from);
    ranges.push(breakpointMarker.range(from));
  }
  if (previewLine !== null && options.isEnabled()) {
    const from = lineStart(state, previewLine);
    if (from !== null && !marked.has(from)) {
      marked.add(from);
      ranges.push(previewMarker.range(from));
    }
  }
  const currentLineFrom = lineStart(state, snapshot.currentLine);
  return {
    markers: ranges.length > 0 ? RangeSet.of(ranges, true) : RangeSet.empty,
    previewLine,
    currentLine: currentLineFrom === null ? Decoration.none : Decoration.set([currentLineDecoration.range(currentLineFrom)]),
  };
}

function lineNumberOf(view: EditorView, line: BlockInfo): number | null {
  if (line.from > view.state.doc.length) return null;
  return view.state.doc.lineAt(line.from).number;
}

/**
 * ODC 的 `editor-breakpoints` 是行号区里 8×8、圆角 4px、`#ff4d4f` 的实心圆点，
 * `editor-breakpoints-fake` 同款但 `opacity: .2`。这里用同一个行号格子上的
 * `::before` 画点，并始终预留出圆点轨道，避免圆点出现时行号左右跳动。
 */
const plDebugEditorTheme = EditorView.theme({
  ".cm-gutters .cm-lineNumbers .cm-gutterElement": {
    position: "relative",
    paddingLeft: "14px",
  },
  ".cm-gutters .cm-lineNumbers .cm-gutterElement.cm-pl-debug-breakpoint::before": {
    content: '""',
    position: "absolute",
    left: "3px",
    top: "50%",
    width: "8px",
    height: "8px",
    marginTop: "-4px",
    borderRadius: "4px",
    background: "#ff4d4f",
    pointerEvents: "none",
  },
  ".cm-gutters .cm-lineNumbers .cm-gutterElement.cm-pl-debug-breakpoint-preview::before": {
    content: '""',
    position: "absolute",
    left: "3px",
    top: "50%",
    width: "8px",
    height: "8px",
    marginTop: "-4px",
    borderRadius: "4px",
    background: "#ff4d4f",
    opacity: "0.2",
    pointerEvents: "none",
  },
  ".cm-pl-debug-current-line": {
    backgroundColor: "color-mix(in srgb, var(--primary, #3b82f6) 22%, transparent)",
  },
});

export function createPlDebugEditorExtension(options: PlDebugEditorOptions): Extension {
  const field = StateField.define<PlDebugEditorFieldValue>({
    create: (state) => buildFieldValue(state, options, null),
    update: (value, transaction) => {
      let previewLine = value.previewLine;
      let previewChanged = false;
      let refresh = transaction.docChanged;
      for (const effect of transaction.effects) {
        if (effect.is(refreshPlDebugEditorEffect)) {
          refresh = true;
        } else if (effect.is(setPreviewLineEffect)) {
          if (effect.value !== previewLine) {
            previewLine = effect.value;
            previewChanged = true;
          }
        }
      }
      if (!refresh && !previewChanged) return value;
      return buildFieldValue(transaction.state, options, previewLine);
    },
    provide: (field) => [lineNumberMarkers.from(field, (value) => value.markers), EditorView.decorations.from(field, (value) => value.currentLine)],
  });

  return [
    field,
    lineNumbers({
      domEventHandlers: {
        mousedown(view, line, event) {
          if (!options.isEnabled()) return false;
          if (event instanceof MouseEvent && event.button !== 0) return false;
          const lineNum = lineNumberOf(view, line);
          if (lineNum === null) return false;
          options.toggleBreakpoint(lineNum);
          return true;
        },
        mousemove(view, line) {
          if (!options.isEnabled()) return false;
          const lineNum = lineNumberOf(view, line);
          if (lineNum === null) return false;
          if (view.state.field(field).previewLine === lineNum) return false;
          view.dispatch({ effects: setPreviewLineEffect.of(lineNum) });
          return false;
        },
        mouseleave(view) {
          if (view.state.field(field).previewLine === null) return false;
          view.dispatch({ effects: setPreviewLineEffect.of(null) });
          return false;
        },
      },
    }),
    plDebugEditorTheme,
  ];
}
