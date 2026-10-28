// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeJobReferenceCatalog, NativeJobReferenceKind, NativeJobScope } from "@/lib/database/nativeJobs";

const references = vi.hoisted(() => vi.fn());
function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        h(tag, attrs, slots.default?.()),
  });
}
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, string>) => (key === "nativeJobs.chooseReference" ? `Choose ${values?.kind}` : key) }) }));
vi.mock("@/lib/backend/api", () => ({ nativeJobReferences: references }));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs }) =>
      () =>
        h("input", { ...attrs, value: attrs.modelValue, onInput: (event: Event) => (attrs["onUpdate:modelValue"] as (value: string) => void)((event.target as HTMLInputElement).value) }),
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        attrs.open ? h("section", { role: "dialog" }, slots.default?.()) : null,
  }),
  DialogContent: passthrough("div"),
  DialogHeader: passthrough("header"),
  DialogTitle: passthrough("h2"),
}));
import NativeJobReferencePicker from "@/components/admin/NativeJobReferencePicker.vue";

const scope: NativeJobScope = { connectionId: "c", database: "", contextId: "context" };
const mounted: Array<{ app: ReturnType<typeof createApp>; root: HTMLElement }> = [];
const page = (objects: NativeJobReferenceCatalog["objects"], offset = 0): NativeJobReferenceCatalog => ({ objects, source: { source: "SYS.ALL_SCHEDULER_PROGRAMS", coverage: "accessible" }, offset, limit: 100 });
async function flush() {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function mount(kind: Exclude<NativeJobReferenceKind, "program-arguments" | "destination-group-members"> = "program") {
  const currentScope = ref(scope);
  const disabled = ref(false);
  const selected = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({ setup: () => () => h(NativeJobReferencePicker, { scope: currentScope.value, kind, disabled: disabled.value, onSelect: selected }) });
  app.mount(root);
  mounted.push({ app, root });
  await flush();
  return { root, selected, currentScope, disabled };
}
function button(root: HTMLElement, label: string) {
  const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
function input(root: HTMLElement, label: string, value: string) {
  const element = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(() => {
  references.mockReset();
});
afterEach(() => {
  for (const { app, root } of mounted.splice(0)) {
    app.unmount();
    root.remove();
  }
});

describe("native reference selection", () => {
  it.each(["window", "window-group", "file-watcher", "destination-group"] as const)("reuses the picker for the %s category without changing the selected identity", async (kind) => {
    const row = { DBX_OWNER: "SYS", DBX_NAME: 'Exact.Name,One"', ...(kind.endsWith("-group") ? { GROUP_TYPE: kind === "destination-group" ? "DB_DEST" : "WINDOW" } : {}) };
    references.mockResolvedValue(page({ status: "available", value: [row] }));
    const { root, selected } = await mount(kind);
    button(root, `Choose nativeJobs.referenceKinds.${kind}`).click();
    await flush();
    expect(references).toHaveBeenCalledWith({ scope, kind, schema: undefined, filter: "", offset: 0, limit: 100 });
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    expect(selected).toHaveBeenCalledWith({ owner: row.DBX_OWNER, name: row.DBX_NAME, metadata: row });
  });
  it("loads only when opened and emits separate exact owner and name components", async () => {
    const row = { DBX_OWNER: 'Owner.One"', DBX_NAME: "Program,one", COMMENTS: "read only metadata" };
    references.mockResolvedValue(page({ status: "available", value: [row] }));
    const { root, selected } = await mount();
    expect(references).not.toHaveBeenCalled();
    button(root, "Choose nativeJobs.referenceKinds.program").click();
    await flush();
    expect(references).toHaveBeenCalledWith({ scope, kind: "program", schema: undefined, filter: "", offset: 0, limit: 100 });
    expect(root.textContent).toContain("nativeJobs.catalogCoverage.accessible");
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    expect(selected).toHaveBeenCalledWith({ owner: row.DBX_OWNER, name: row.DBX_NAME, metadata: row });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });
  it("keeps denied, unavailable and successful empty catalogs distinct", async () => {
    for (const status of ["denied", "unknown", "empty"] as const) {
      references.mockResolvedValue(page(status === "empty" ? { status } : { status, reason: "native catalog" }));
      const { root, selected } = await mount();
      button(root, "Choose nativeJobs.referenceKinds.program").click();
      await flush();
      expect(root.textContent).toContain(status === "empty" ? "nativeJobs.emptyReferences" : "nativeJobs.referenceCatalogUnavailable");
      expect(root.querySelector("[data-native-reference]")).toBeNull();
      expect(selected).not.toHaveBeenCalled();
    }
  });
  it("pages at the backend and submits owner and filter without normalizing exact identifiers", async () => {
    references.mockResolvedValue(page({ status: "truncated", value: [{ DBX_OWNER: "Owner", DBX_NAME: "Program" }], limit: 100 }));
    const { root } = await mount();
    button(root, "Choose nativeJobs.referenceKinds.program").click();
    await flush();
    button(root, "nativeJobs.nextPage").click();
    await flush();
    expect(references.mock.calls.at(-1)?.[0].offset).toBe(100);
    input(root, "nativeJobs.ownerFilter", "Mixed Case.Owner");
    input(root, "nativeJobs.referenceFilter", "10%_!");
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(references.mock.calls.at(-1)?.[0]).toMatchObject({ schema: "Mixed Case.Owner", filter: "10%_!", offset: 0 });
  });
  it("discards an old context response and cannot select while the caller is disabled", async () => {
    let resolve!: (value: NativeJobReferenceCatalog) => void;
    references.mockImplementationOnce(
      () =>
        new Promise<NativeJobReferenceCatalog>((done) => {
          resolve = done;
        }),
    );
    const { root, currentScope, selected, disabled } = await mount();
    button(root, "Choose nativeJobs.referenceKinds.program").click();
    await flush();
    currentScope.value = { ...scope, contextId: "new-context" };
    await flush();
    resolve(page({ status: "available", value: [{ DBX_OWNER: "Old", DBX_NAME: "Old" }] }));
    await flush();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    references.mockResolvedValue(page({ status: "available", value: [{ DBX_OWNER: "New", DBX_NAME: "New" }] }));
    button(root, "Choose nativeJobs.referenceKinds.program").click();
    await flush();
    expect(references.mock.calls.at(-1)?.[0].scope.contextId).toBe("new-context");
    disabled.value = true;
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    expect(selected).not.toHaveBeenCalled();
  });
});
