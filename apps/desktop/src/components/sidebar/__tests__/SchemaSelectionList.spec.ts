// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App, type VNode } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchemaSelectionList from "../SchemaSelectionList.vue";

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
let app: App;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
async function mount(selected = ["APP"], names = ["APP", "SALES", "SYS", "SYSRAC"]) {
  const selection = ref(new Set(selected));
  const search = ref("");
  const candidates = ref(names);
  app = createApp({ render: () => h(SchemaSelectionList, { names: candidates.value, databaseType: "oracle", search: search.value, modelValue: selection.value, "onUpdate:modelValue": (value: Set<string>) => (selection.value = value) }) });
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, messages: { en: {} } }));
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
  return { selection, search, candidates };
}
const row = (name: string) => document.querySelector<HTMLButtonElement>(`[data-schema-row="${name}"]`);
const group = () => document.querySelector<HTMLButtonElement>('[data-schema-group="system"] button[aria-expanded]')!;
describe("grouped schema selection", () => {
  it("collapses system schemas without changing the selected scope", async () => {
    const { selection } = await mount();
    expect(row("APP")).toBeTruthy();
    expect(row("SYS")).toBeNull();
    group().click();
    await nextTick();
    row("SYS")!.click();
    await nextTick();
    group().click();
    await nextTick();
    expect(row("SYS")).toBeNull();
    expect([...selection.value]).toEqual(["APP", "SYS"]);
  });
  it("expands existing system choices and searches both groups without selecting matches", async () => {
    const { search, selection } = await mount(["APP", "SYS"]);
    expect(row("SYS")).toBeTruthy();
    group().click();
    await nextTick();
    search.value = "sysrac";
    await nextTick();
    expect(row("SYSRAC")).toBeTruthy();
    expect(row("APP")).toBeNull();
    expect([...selection.value]).toEqual(["APP", "SYS"]);
  });
  it("selects a group as a snapshot and leaves newly discovered names unchecked", async () => {
    const { candidates, selection } = await mount();
    document.querySelector<HTMLButtonElement>('[data-schema-group="system"] button[role="checkbox"]')!.click();
    await nextTick();
    expect([...selection.value]).toEqual(["APP", "SYS", "SYSRAC"]);
    candidates.value.push("SYSBACKUP");
    await nextTick();
    expect(selection.value.has("SYSBACKUP")).toBe(false);
    expect(document.querySelector('[data-schema-group="system"] button[role="checkbox"]')!.getAttribute("aria-checked")).toBe("mixed");
  });
});
