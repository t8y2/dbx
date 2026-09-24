// @vitest-environment happy-dom

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorCodeMirrorRuntime } from "../queryEditorCodeMirrorRuntime";
import { useQueryEditorCodeMirror } from "../useQueryEditorCodeMirror";

type Options = Parameters<typeof useQueryEditorCodeMirror>[0];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createHarness() {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = shallowRef<EditorView | null>(null);
  const runtime = createQueryEditorCodeMirrorRuntime();
  const editorRef = shallowRef<HTMLElement | null>(parent);
  const events: string[] = [];
  const onReady = vi.fn(() => {
    expect(view.value?.state.doc.toString()).toBe("SELECT 1;");
    events.push("ready");
  });
  const configuration = { parent, state: EditorState.create({ doc: "SELECT 1;" }), onReady };
  const beforeLoad = vi.fn(() => {
    events.push("beforeLoad");
  });
  const prepare = vi.fn<Options["prepare"]>(async () => {
    events.push("prepare");
    return configuration;
  });
  const lifecycle = useQueryEditorCodeMirror({ editorRef, view, runtime, beforeLoad, prepare });
  cleanups.push(() => {
    lifecycle.dispose();
    parent.remove();
  });
  return { lifecycle, editorRef, view, runtime, beforeLoad, prepare, configuration, onReady, events, parent };
}

describe("QueryEditor lazy CodeMirror runtime", () => {
  it("keeps unloaded handles empty and publishes initialized handles on the same object", async () => {
    const runtime = createQueryEditorCodeMirrorRuntime();
    expect(runtime.editorViewModule).toBeNull();
    expect(runtime.codeMirrorStartCompletion).toBeNull();
    expect(runtime.sqlSignatureComp).toBeNull();
    const modules = await runtime.load();
    expect(modules.runtime).toBe(runtime);
    expect(runtime.editorViewModule?.EditorView).toBe(EditorView);
    expect(runtime.codeMirrorStartCompletion).toBe(modules.startCompletion);
    expect(runtime.codeMirrorToggleBlockComment).toBe(modules.toggleBlockComment);
    expect(runtime.sqlSignatureComp).toBeInstanceOf(Compartment);
    expect(runtime.buildSqlLanguageExtension).toBeNull();
  });

  it("isolates per-editor compartments and effects while sharing imported functions", async () => {
    const first = createQueryEditorCodeMirrorRuntime();
    const second = createQueryEditorCodeMirrorRuntime();
    await Promise.all([first.load(), second.load()]);
    expect(first.codeMirrorStartCompletion).toBe(second.codeMirrorStartCompletion);
    expect(first.completionComp).not.toBe(second.completionComp);
    expect(first.sqlLanguageComp).not.toBe(second.sqlLanguageComp);
    expect(first.sqlSignatureComp).not.toBe(second.sqlSignatureComp);
    expect(first.setSqlDiagnosticsEffect).not.toBe(second.setSqlDiagnosticsEffect);
    expect(first.statementBoundariesRefreshEffect).not.toBe(second.statementBoundariesRefreshEffect);
  });
});

describe("QueryEditor initialization lifecycle", () => {
  it("loads, prepares, creates and notifies in order", async () => {
    const harness = createHarness();
    const load = harness.runtime.load;
    vi.spyOn(harness.runtime, "load").mockImplementation(async () => {
      harness.events.push("load");
      return load();
    });
    await harness.lifecycle.initialize();
    expect(harness.events).toEqual(["beforeLoad", "load", "prepare", "ready"]);
    expect(harness.parent.querySelector(".cm-editor")).toBe(harness.view.value?.dom);
    const destroy = vi.spyOn(harness.view.value!, "destroy");
    harness.lifecycle.dispose();
    expect(destroy).toHaveBeenCalledOnce();
    expect(harness.parent.querySelector(".cm-editor")).toBeNull();
  });

  it.each(["missing host", "disposed"])("does not begin initialization when %s", async (reason) => {
    const harness = createHarness();
    const load = vi.spyOn(harness.runtime, "load");
    if (reason === "missing host") harness.editorRef.value = null;
    else harness.lifecycle.dispose();
    await harness.lifecycle.initialize();
    expect(harness.beforeLoad).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.view.value).toBeNull();
  });

  it("does not prepare or mount after disposal during lazy loading", async () => {
    const harness = createHarness();
    const modules = await harness.runtime.load();
    const pending = deferred<typeof modules>();
    vi.spyOn(harness.runtime, "load").mockReturnValue(pending.promise);
    const initializing = harness.lifecycle.initialize();
    harness.lifecycle.dispose();
    pending.resolve(modules);
    await initializing;
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.view.value).toBeNull();
    expect(harness.onReady).not.toHaveBeenCalled();
  });

  it("does not create a view after disposal during asynchronous preparation", async () => {
    const harness = createHarness();
    const preparing = deferred<void>();
    const pending = deferred<typeof harness.configuration>();
    harness.prepare.mockImplementation(() => {
      preparing.resolve();
      return pending.promise;
    });
    const initializing = harness.lifecycle.initialize();
    await preparing.promise;
    harness.lifecycle.dispose();
    pending.resolve(harness.configuration);
    await initializing;
    expect(harness.view.value).toBeNull();
    expect(harness.onReady).not.toHaveBeenCalled();
    expect(harness.parent.querySelector(".cm-editor")).toBeNull();
  });

  it("respects a cancelled configuration", async () => {
    const harness = createHarness();
    harness.prepare.mockResolvedValue(undefined);
    await harness.lifecycle.initialize();
    expect(harness.view.value).toBeNull();
    expect(harness.onReady).not.toHaveBeenCalled();
  });
});
