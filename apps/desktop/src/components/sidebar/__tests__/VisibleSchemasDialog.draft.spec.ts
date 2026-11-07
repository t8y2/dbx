// @vitest-environment happy-dom
import { createApp, h, nextTick, type App, type VNode } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import VisibleSchemasDialog from "../VisibleSchemasDialog.vue";
const backend = vi.hoisted(() => ({ ensureConnected: vi.fn(), listSchemas: vi.fn(), setVisibleSchemas: vi.fn(), clearVisibleSchemas: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => backend }));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: {
    props: ["items"],
    setup:
      (props: { items: unknown[] }, { slots }: { slots: { default: (value: { item: unknown }) => VNode[] } }) =>
      () =>
        h(
          "div",
          props.items.flatMap((item) => slots.default({ item })),
        ),
  },
}));
const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label)!;
}
async function mount() {
  const saved = vi.fn();
  const all = vi.fn();
  const closed = vi.fn();
  const app = createApp({ render: () => h(VisibleSchemasDialog, { open: true, connectionName: "Draft", databaseType: "postgres", draftSchemaNames: ["public", "sales", "pg_catalog"], draftInitialSelection: ["public"], "onDraft:save": saved, "onDraft:showAll": all, "onUpdate:open": closed }) });
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, messages: { en: {} } }));
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  apps.push(app);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return { saved, all, closed };
}
describe("connection editor schema selection draft", () => {
  it("edits the supplied list and emits its draft without connecting or persisting", async () => {
    const { saved, closed } = await mount();
    button("sales").click();
    button("visibleSchemas.save").click();
    expect(saved).toHaveBeenCalledExactlyOnceWith(["public", "sales"]);
    expect(closed).toHaveBeenCalledWith(false);
    for (const operation of Object.values(backend)) expect(operation).not.toHaveBeenCalled();
  });
  it("selects all current candidates and saves a snapshot without storing directly", async () => {
    const { all, saved, closed } = await mount();
    button("visibleSchemas.selectAll").click();
    await nextTick();
    button("visibleSchemas.save").click();
    expect(all).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith(["public", "sales", "pg_catalog"]);
    expect(closed).toHaveBeenCalledWith(false);
    expect(backend.clearVisibleSchemas).not.toHaveBeenCalled();
  });
  it("cancels without updating the parent draft", async () => {
    const { saved, all, closed } = await mount();
    button("sales").click();
    button("dangerDialog.cancel").click();
    expect(saved).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledWith(false);
  });
});
