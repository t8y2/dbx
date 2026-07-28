import { shallowRef, onBeforeUnmount, getCurrentInstance, type ShallowRef, createApp, watch } from "vue";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { search as cmSearch } from "@codemirror/search";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { trimmedSelectionLayer } from "@/lib/editor/codemirrorTrimmedSelectionLayer";
import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR, cellDetailActiveLineColor, loadEditorTheme, editorFontTheme } from "@/lib/editor/editorThemes";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { useSettingsStore } from "@/stores/settingsStore";
import { CELL_DETAIL_JSON_FORMAT_MAX_LENGTH, isJsonColumnType } from "@/lib/dataGrid/cellDetailPresentation";
import { clampEditorFontSize, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "@/lib/editor/editorZoom";
import i18n from "@/i18n";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import type { EditorTheme } from "@/stores/settingsStore";
import type { AppThemeAppearance, AppThemePalette } from "@/lib/app/appTheme";
import { selectAllCellDetailText } from "@/lib/dataGrid/cellDetailSelection";

export interface UseCellDetailEditorOptions {
  onChange?: (value: string) => void;
  onEscape?: () => void;
  onBlur?: () => void;
  /** Return true after handling a save shortcut so CodeMirror consumes it. */
  onSaveShortcut?: (event: KeyboardEvent) => boolean;
  language?: "auto" | "json";
  readOnly?: boolean | (() => boolean);
  /** Keep cell detail editors gutter-free unless a caller explicitly opts in. */
  lineNumbers?: boolean;
  /** A reactive source for opting into CodeMirror line wrapping. */
  lineWrapping?: () => boolean;
  /** Add CodeMirror fold controls and keyboard bindings for structured source. */
  folding?: boolean;
  /**
   * When false, Mod+F / replace are not bound so a parent (e.g. Redis value viewer)
   * can own the unified find surface. Default true for grid cell editors.
   */
  enableBuiltinFind?: boolean;
  editorTheme: () => EditorTheme;
  appAppearance: () => AppThemeAppearance;
  appPalette: () => AppThemePalette;
  fontSize: () => number;
  fontFamily: () => string;
}

export interface UseCellDetailEditorReturn {
  create: (parent: HTMLElement, initialValue: string, columnType?: string) => Promise<void>;
  setValue: (value: string, columnType?: string) => void;
  getValue: () => string;
  openSearch: () => boolean;
  openReplace: () => boolean;
  selectRange: (from: number, to: number, options?: { focus?: boolean }) => boolean;
  destroy: () => void;
  view: Readonly<ShallowRef<EditorView | null>>;
}

interface CellDetailEditorGestureEvent extends Event {
  scale?: number;
}

function looksLikeJsonString(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function shouldUseJsonMode(columnType?: string, value?: string): boolean {
  if (value && value.length > CELL_DETAIL_JSON_FORMAT_MAX_LENGTH) return false;
  if (isJsonColumnType(columnType)) return true;
  if (value && looksLikeJsonString(value)) return true;
  return false;
}

export function useCellDetailEditor(options: UseCellDetailEditorOptions): UseCellDetailEditorReturn {
  const view = shallowRef<EditorView | null>(null) as ShallowRef<EditorView | null>;
  const settingsStore = useSettingsStore();
  const languageComp = new Compartment();
  const themeComp = new Compartment();
  const fontThemeComp = new Compartment();
  const lineWrappingComp = new Compartment();
  const readOnlyComp = new Compartment();

  let destroyed = false;
  let currentIsJson = false;
  let liveFontSize = clampEditorFontSize(options.fontSize());
  let gestureStartFontSize = liveFontSize;
  let isGestureZooming = false;
  let pendingFontReconfig: { size: number; family: string } | null = null;
  let fontReconfigScheduled = false;
  let searchApp: ReturnType<typeof createApp> | null = null;
  let searchInstance: InstanceType<typeof EditorSearchPanel> | null = null;
  let wrapperEl: HTMLDivElement | null = null;

  const zoomCommitScheduler = createEditorZoomCommitScheduler((fontSize) => {
    if (settingsStore.editorSettings.fontSize === fontSize) return;
    settingsStore.updateEditorSettings({ fontSize });
  });

  function syncEditorFontCssVars(fontSize = liveFontSize, fontFamily = options.fontFamily()) {
    if (!wrapperEl) return;
    wrapperEl.style.setProperty(EDITOR_FONT_SIZE_CSS_VAR, `${clampEditorFontSize(fontSize)}px`);
    wrapperEl.style.setProperty(EDITOR_FONT_FAMILY_CSS_VAR, fontFamily);
  }

  function isReadOnly(): boolean {
    return typeof options.readOnly === "function" ? options.readOnly() : Boolean(options.readOnly);
  }

  function readOnlyExtensions(readOnly: boolean) {
    return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of(readOnly ? { tabindex: "0" } : {})];
  }

  function reconfigureFontTheme(size: number, family: string) {
    const editor = view.value;
    if (!editor) return;
    editor.dispatch({
      effects: fontThemeComp.reconfigure(editorFontTheme(EditorView, size, family, { fixedHeight: true, scrollable: true })),
    });
  }

  function scheduleFontThemeReconfig(size: number, family: string) {
    pendingFontReconfig = { size, family };
    if (fontReconfigScheduled) return;
    fontReconfigScheduled = true;
    requestAnimationFrame(() => {
      fontReconfigScheduled = false;
      const pending = pendingFontReconfig;
      if (!pending || destroyed) return;
      pendingFontReconfig = null;
      reconfigureFontTheme(pending.size, pending.family);
    });
  }

  function applyLiveFontSize(size: number) {
    const next = clampEditorFontSize(size);
    if (liveFontSize === next) return;
    liveFontSize = next;
    syncEditorFontCssVars(next);
    scheduleFontThemeReconfig(next, options.fontFamily());
  }

  function onEditorGestureStart(event: CellDetailEditorGestureEvent) {
    event.preventDefault();
    isGestureZooming = true;
    gestureStartFontSize = liveFontSize;
  }

  function onEditorGestureChange(event: CellDetailEditorGestureEvent) {
    if (typeof event.scale !== "number") return;
    event.preventDefault();
    applyLiveFontSize(fontSizeFromGestureScale(gestureStartFontSize, event.scale));
  }

  function onEditorGestureEnd(event: Event) {
    event.preventDefault();
    isGestureZooming = false;
    zoomCommitScheduler.flush(liveFontSize);
  }

  watch([() => options.fontSize(), () => options.fontFamily(), () => options.editorTheme(), () => options.appAppearance(), () => options.appPalette()], async ([fontSize, fontFamily, editorTheme, appearance, palette]) => {
    const editor = view.value;
    if (!editor || destroyed) return;
    if (!isGestureZooming && !zoomCommitScheduler.hasPendingCommit()) {
      liveFontSize = clampEditorFontSize(fontSize);
    }
    syncEditorFontCssVars(liveFontSize, fontFamily);
    const theme = await loadEditorTheme(editorTheme, appearance, undefined, palette);
    if (!view.value || destroyed) return;
    view.value.dispatch({
      effects: [themeComp.reconfigure(theme), fontThemeComp.reconfigure(editorFontTheme(EditorView, liveFontSize, fontFamily, { fixedHeight: true, scrollable: true }))],
    });
  });

  watch(
    () => options.lineWrapping?.() ?? false,
    (lineWrapping) => {
      const editor = view.value;
      if (!editor || destroyed) return;
      editor.dispatch({ effects: lineWrappingComp.reconfigure(lineWrapping ? EditorView.lineWrapping : []) });
    },
  );

  watch(
    () => isReadOnly(),
    (readOnly) => {
      const editor = view.value;
      if (!editor || destroyed) return;
      editor.dispatch({ effects: readOnlyComp.reconfigure(readOnlyExtensions(readOnly)) });
    },
  );

  async function create(parent: HTMLElement, initialValue: string, columnType?: string): Promise<void> {
    if (destroyed) return;

    const doc = initialValue ?? "";
    currentIsJson = options.language === "json" || shouldUseJsonMode(columnType, doc);

    const theme = await loadEditorTheme(options.editorTheme(), options.appAppearance(), undefined, options.appPalette());
    if (destroyed) return;
    liveFontSize = clampEditorFontSize(options.fontSize());
    const fontTheme = editorFontTheme(EditorView, liveFontSize, options.fontFamily(), { fixedHeight: true, scrollable: true });
    const shortcuts = settingsStore.editorSettings.shortcuts;

    const state = EditorState.create({
      doc,
      extensions: [
        cmSearch({
          createPanel: () => {
            const dom = document.createElement("span");
            dom.style.display = "none";
            return { dom };
          },
        }),
        // Keep the compact detail-editor baseline; gutters and wrapping are opt-in.
        ...(options.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
        ...(options.folding ? [foldGutter()] : []),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        trimmedSelectionLayer(),
        dropCursor(),
        highlightActiveLine(),
        EditorView.theme({
          ".cm-activeLine": {
            backgroundColor: cellDetailActiveLineColor(),
          },
        }),
        EditorState.allowMultipleSelections.of(true),
        bracketMatching(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...(options.folding ? foldKeymap : []),
          // Callers may disable find so a parent surface (e.g. RedisValueViewer) owns Mod+F.
          ...(options.enableBuiltinFind === false
            ? []
            : [
                {
                  key: shortcutToCodeMirrorKey(shortcuts.find),
                  preventDefault: true,
                  run: () => openSearch(),
                },
                {
                  key: shortcutToCodeMirrorKey(shortcuts.replace),
                  preventDefault: true,
                  run: () => openReplace(),
                },
              ]),
        ]),
        languageComp.of(currentIsJson ? json() : []),
        lineWrappingComp.of(options.lineWrapping?.() ? EditorView.lineWrapping : []),
        readOnlyComp.of(readOnlyExtensions(isReadOnly())),
        themeComp.of(theme),
        fontThemeComp.of(fontTheme),
        keymap.of([
          {
            key: "Mod-a",
            run: selectAllCellDetailText,
          },
          {
            key: "Escape",
            run: () => {
              if (searchInstance && (searchInstance as any).closeSearch()) return true;
              options.onEscape?.();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            options.onChange?.(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            if (!options.onSaveShortcut?.(event)) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
          },
          wheel(event) {
            if (!event.metaKey && !event.ctrlKey) return false;
            event.preventDefault();
            const next = fontSizeFromWheelDelta(liveFontSize, event.deltaY);
            applyLiveFontSize(next);
            zoomCommitScheduler.schedule(next);
            return true;
          },
          blur: () => {
            options.onBlur?.();
          },
        }),
      ],
    });

    // Re-check after the async theme load: a fast v-if unmount can destroy this
    // instance while create is still in flight.
    if (destroyed) return;

    wrapperEl = document.createElement("div");
    wrapperEl.style.cssText = "position: relative; width: 100%; height: 100%;";
    wrapperEl.addEventListener("gesturestart", onEditorGestureStart);
    wrapperEl.addEventListener("gesturechange", onEditorGestureChange);
    wrapperEl.addEventListener("gestureend", onEditorGestureEnd);
    parent.appendChild(wrapperEl);
    syncEditorFontCssVars(liveFontSize, options.fontFamily());

    view.value = new EditorView({ state, parent: wrapperEl });

    // Mount search panel component
    const searchMount = document.createElement("div");
    wrapperEl.appendChild(searchMount);
    searchApp = createApp(EditorSearchPanel, { view: view.value });
    searchApp.use(i18n);
    searchInstance = searchApp.mount(searchMount) as any;

    // If unmounted during the last sync steps, drop the late-mounted editor.
    if (destroyed) {
      destroy();
    }
  }

  function setValue(value: string, columnType?: string) {
    const editor = view.value;
    if (!editor || destroyed) return;

    const text = value ?? "";
    const newIsJson = options.language === "json" || shouldUseJsonMode(columnType, text);
    const effects: ReturnType<typeof Compartment.prototype.reconfigure>[] = [];

    if (newIsJson !== currentIsJson) {
      effects.push(languageComp.reconfigure(newIsJson ? json() : []));
      currentIsJson = newIsJson;
    }

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
      effects,
    });
  }

  function getValue(): string {
    return view.value?.state.doc.toString() ?? "";
  }

  function openSearch(): boolean {
    return (searchInstance as any)?.openSearch?.() ?? false;
  }

  function openReplace(): boolean {
    return (searchInstance as any)?.openReplace?.() ?? false;
  }

  function selectRange(from: number, to: number, options?: { focus?: boolean }): boolean {
    const editor = view.value;
    if (!editor || destroyed) return false;
    const max = editor.state.doc.length;
    const start = Math.max(0, Math.min(from, max));
    const end = Math.max(0, Math.min(to, max));
    editor.dispatch({
      selection: EditorSelection.range(start, end),
      scrollIntoView: true,
    });
    // Default focus for explicit navigation; callers can pass focus:false while typing in a find box.
    if (options?.focus !== false) editor.focus();
    return true;
  }

  function destroy() {
    const alreadyDestroyed = destroyed;
    destroyed = true;
    searchApp?.unmount();
    searchApp = null;
    searchInstance = null;
    view.value?.destroy();
    view.value = null;
    if (!alreadyDestroyed) zoomCommitScheduler.dispose();
    if (wrapperEl) {
      wrapperEl.removeEventListener("gesturestart", onEditorGestureStart);
      wrapperEl.removeEventListener("gesturechange", onEditorGestureChange);
      wrapperEl.removeEventListener("gestureend", onEditorGestureEnd);
    }
    if (wrapperEl?.parentNode) {
      wrapperEl.parentNode.removeChild(wrapperEl);
    }
    wrapperEl = null;
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      destroy();
    });
  }

  return { create, setValue, getValue, openSearch, openReplace, selectRange, destroy, view };
}
