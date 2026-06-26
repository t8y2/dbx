import { shallowRef, onBeforeUnmount, type ShallowRef, createApp, watch } from "vue";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars, highlightActiveLine } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { search as cmSearch } from "@codemirror/search";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { trimmedSelectionLayer } from "@/lib/codemirrorTrimmedSelectionLayer";
import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR, cellDetailActiveLineColor, loadEditorTheme, editorFontTheme } from "@/lib/editorThemes";
import { shortcutToCodeMirrorKey } from "@/lib/shortcutRegistry";
import { useSettingsStore } from "@/stores/settingsStore";
import { CELL_DETAIL_JSON_FORMAT_MAX_LENGTH, isJsonColumnType } from "@/lib/cellDetailPresentation";
import { clampEditorFontSize, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "@/lib/editorZoom";
import i18n from "@/i18n";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import type { EditorTheme } from "@/stores/settingsStore";
import type { AppThemeAppearance } from "@/lib/appTheme";

export interface UseCellDetailEditorOptions {
  onChange?: (value: string) => void;
  onEscape?: () => void;
  onBlur?: () => void;
  readOnly?: boolean;
  editorTheme: () => EditorTheme;
  appAppearance: () => AppThemeAppearance;
  fontSize: () => number;
  fontFamily: () => string;
}

export interface UseCellDetailEditorReturn {
  create: (parent: HTMLElement, initialValue: string, columnType?: string) => Promise<void>;
  setValue: (value: string, columnType?: string) => void;
  getValue: () => string;
  openSearch: () => boolean;
  openReplace: () => boolean;
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

  watch([() => options.fontSize(), () => options.fontFamily(), () => options.editorTheme(), () => options.appAppearance()], async ([fontSize, fontFamily, editorTheme, appearance]) => {
    const editor = view.value;
    if (!editor || destroyed) return;
    if (!isGestureZooming && !zoomCommitScheduler.hasPendingCommit()) {
      liveFontSize = clampEditorFontSize(fontSize);
    }
    syncEditorFontCssVars(liveFontSize, fontFamily);
    const theme = await loadEditorTheme(editorTheme, appearance);
    if (!view.value || destroyed) return;
    view.value.dispatch({
      effects: [themeComp.reconfigure(theme), fontThemeComp.reconfigure(editorFontTheme(EditorView, liveFontSize, fontFamily, { fixedHeight: true, scrollable: true }))],
    });
  });

  async function create(parent: HTMLElement, initialValue: string, columnType?: string): Promise<void> {
    if (destroyed) return;

    const doc = initialValue ?? "";
    currentIsJson = shouldUseJsonMode(columnType, doc);

    const theme = await loadEditorTheme(options.editorTheme(), options.appAppearance());
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
        // Minimal setup without line numbers
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
        languageComp.of(currentIsJson ? json() : []),
        themeComp.of(theme),
        fontThemeComp.of(fontTheme),
        keymap.of([
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
        EditorState.readOnly.of(!!options.readOnly),
        EditorView.editable.of(!options.readOnly),
      ],
    });

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
  }

  function setValue(value: string, columnType?: string) {
    const editor = view.value;
    if (!editor || destroyed) return;

    const text = value ?? "";
    const newIsJson = shouldUseJsonMode(columnType, text);
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

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    searchApp?.unmount();
    searchApp = null;
    searchInstance = null;
    view.value?.destroy();
    view.value = null;
    zoomCommitScheduler.dispose();
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

  onBeforeUnmount(() => {
    destroy();
  });

  return { create, setValue, getValue, openSearch, openReplace, destroy, view };
}
