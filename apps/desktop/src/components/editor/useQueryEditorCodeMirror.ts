import type { Ref, ShallowRef } from "vue";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { QueryEditorCodeMirrorModules, QueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";

interface QueryEditorCodeMirrorConfiguration {
  state: EditorState;
  parent: HTMLElement;
  onReady: () => void;
}

interface QueryEditorCodeMirrorOptions {
  editorRef: Readonly<Ref<HTMLElement | null | undefined>>;
  view: ShallowRef<EditorView | null>;
  runtime: QueryEditorCodeMirrorRuntime;
  beforeLoad: () => void;
  prepare: (modules: QueryEditorCodeMirrorModules) => Promise<QueryEditorCodeMirrorConfiguration | undefined>;
}

export function useQueryEditorCodeMirror(options: QueryEditorCodeMirrorOptions) {
  let disposed = false;

  async function initialize() {
    if (disposed || !options.editorRef.value) return;
    options.beforeLoad();
    const modules = await options.runtime.load();
    if (disposed) return;
    const configuration = await options.prepare(modules);
    if (disposed || !configuration) return;
    options.view.value = new modules.EditorView({ state: configuration.state, parent: configuration.parent });
    configuration.onReady();
  }

  function dispose() {
    disposed = true;
    options.view.value?.destroy();
  }

  return { initialize, dispose };
}
