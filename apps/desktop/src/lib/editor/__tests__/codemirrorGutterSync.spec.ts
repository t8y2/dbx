// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { keepGuttersAttachedDuringSync } from "../codemirrorGutterSync";

interface FakeGutterHost {
  dom: { classList: { contains: (token: string) => boolean } };
  syncGutters?: (detach: boolean) => void;
}

interface FakeInstance {
  update: (update: { view: EditorView }) => void;
  destroy: () => void;
}

interface FakeView {
  plugins: Array<{ value: unknown }>;
}

/** A host whose `syncGutters` lives on the prototype, like CodeMirror's. */
function fakeGutterHost(token = "cm-gutters") {
  const calls: boolean[] = [];
  class Host {
    dom = { classList: { contains: (candidate: string) => candidate === token } };
    syncGutters(detach: boolean) {
      calls.push(detach);
    }
  }
  return { host: new Host() as unknown as FakeGutterHost, calls };
}

/** Minimal stand-in for `ViewPlugin.fromClass`, keeping the created instance. */
function fakeViewPlugin() {
  const instances: FakeInstance[] = [];
  const ViewPlugin = {
    fromClass: (cls: new (view: EditorView) => FakeInstance) => ({
      create: (view: EditorView) => {
        const instance = new cls(view);
        instances.push(instance);
        return instance;
      },
    }),
  } as unknown as typeof import("@codemirror/view").ViewPlugin;
  return { ViewPlugin, instances };
}

function fakeView(hosts: FakeGutterHost[]): FakeView {
  return { plugins: hosts.map((value) => ({ value })) };
}

function createInstance(hosts: FakeGutterHost[]) {
  const { ViewPlugin, instances } = fakeViewPlugin();
  const spec = keepGuttersAttachedDuringSync(ViewPlugin) as unknown as { create: (view: EditorView) => FakeInstance };
  const view = fakeView(hosts);
  expect(instances).toHaveLength(0);
  const instance = spec.create(view as unknown as EditorView);
  expect(instances).toHaveLength(1);
  return { instance, view };
}

describe("keepGuttersAttachedDuringSync", () => {
  it("forces the gutter sync to update in place instead of detaching", () => {
    const gutter = fakeGutterHost();
    createInstance([gutter.host]);

    expect(Object.prototype.hasOwnProperty.call(gutter.host, "syncGutters")).toBe(true);
    gutter.host.syncGutters?.(true);
    gutter.host.syncGutters?.(false);
    expect(gutter.calls).toEqual([false, false]);
  });

  it("leaves a sync shadow owned by somebody else untouched", () => {
    const gutter = fakeGutterHost();
    const own = vi.fn<(detach: boolean) => void>();
    gutter.host.syncGutters = own;

    createInstance([gutter.host]);

    gutter.host.syncGutters?.(true);
    expect(own).toHaveBeenCalledWith(true);
    expect(Object.getOwnPropertyDescriptor(gutter.host, "syncGutters")?.value).toBe(own);
    expect(gutter.calls).toEqual([]);
  });

  it("finds a gutter plugin that is created after the guard", () => {
    const { ViewPlugin, instances } = fakeViewPlugin();
    const spec = keepGuttersAttachedDuringSync(ViewPlugin) as unknown as { create: (view: EditorView) => FakeInstance };
    const view = fakeView([]);
    const instance = spec.create(view as unknown as EditorView);
    expect(instances).toHaveLength(1);

    const gutter = fakeGutterHost();
    view.plugins.push({ value: gutter.host });
    instance.update({ view: view as unknown as EditorView });

    expect(Object.prototype.hasOwnProperty.call(gutter.host, "syncGutters")).toBe(true);
    gutter.host.syncGutters?.(true);
    expect(gutter.calls).toEqual([false]);
  });

  it("moves the guard when the gutter plugin value is replaced", () => {
    const first = fakeGutterHost();
    const { instance, view } = createInstance([first.host]);

    const second = fakeGutterHost();
    view.plugins = [{ value: second.host }];
    instance.update({ view: view as unknown as EditorView });

    expect(Object.prototype.hasOwnProperty.call(first.host, "syncGutters")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(second.host, "syncGutters")).toBe(true);
    first.host.syncGutters?.(true);
    second.host.syncGutters?.(true);
    expect(first.calls).toEqual([true]);
    expect(second.calls).toEqual([false]);
  });

  it("restores the prototype method when the guard is destroyed", () => {
    const gutter = fakeGutterHost();
    const { instance } = createInstance([gutter.host]);

    instance.destroy();

    expect(Object.prototype.hasOwnProperty.call(gutter.host, "syncGutters")).toBe(false);
    gutter.host.syncGutters?.(true);
    expect(gutter.calls).toEqual([true]);
  });

  it("ignores plugin values that do not own the gutter element", () => {
    const other = fakeGutterHost("cm-something-else");

    const { instance } = createInstance([other.host]);

    expect(Object.prototype.hasOwnProperty.call(other.host, "syncGutters")).toBe(false);
    other.host.syncGutters?.(true);
    expect(other.calls).toEqual([true]);
    instance.destroy();
  });

  it("does not attach when the gutter plugin is missing", () => {
    const { instance } = createInstance([]);
    instance.destroy();
  });
});
