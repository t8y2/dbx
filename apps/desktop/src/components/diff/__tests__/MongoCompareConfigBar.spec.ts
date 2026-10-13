// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MONGO_COMPARE_CONFIG_KEY, mongoCompareConfigSnapshot, useMongoCompareConfigs } from "@/composables/useMongoCompareConfigs";
import MongoCompareConfigBar from "../MongoCompareConfigBar.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const select = defineComponent({
    props: ["modelValue", "disabled"],
    emits: ["update:modelValue"],
    setup:
      (props, { emit, slots }) =>
      () =>
        h("select", { value: props.modelValue, disabled: props.disabled, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) }, slots.default?.()),
  });
  const item = defineComponent({
    props: ["value"],
    setup:
      (props, { slots }) =>
      () =>
        h("option", { value: props.value }, slots.default?.()),
  });
  const content = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        slots.default?.(),
  });
  const empty = defineComponent({ setup: () => () => null });
  return { Select: select, SelectItem: item, SelectContent: content, SelectTrigger: empty, SelectValue: empty };
});

let app: App;
const current = ref(mongoCompareConfigSnapshot({}));
const disabled = ref(false);
const apply = vi.fn();
function button(key: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === `mongoCompare.${key}`)!;
}
async function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(MongoCompareConfigBar, { snapshot: current.value, disabled: disabled.value, onApply: apply }) }));
  app.mount(root);
  await nextTick();
}
beforeEach(() => {
  localStorage.clear();
  apply.mockClear();
  disabled.value = false;
  current.value = mongoCompareConfigSnapshot({});
});
afterEach(() => {
  app?.unmount();
  document.body.textContent = "";
});

describe("Mongo comparison configuration controls", () => {
  it("loads only configuration inputs and indicates edits without silently saving them", async () => {
    const store = useMongoCompareConfigs();
    const saved = mongoCompareConfigSnapshot({ source: { connectionId: "a", database: "shop" }, batchMode: true, pairs: [{ source: "orders", target: "orders_copy", matchFields: "orderNo", enabled: true }] });
    store.save("Saved", saved);
    await mount();
    const select = document.querySelector("select")!;
    select.value = store.activeId.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(apply).toHaveBeenCalledWith(saved);
    current.value = { ...saved, ignoredFields: "updatedAt" };
    await nextTick();
    expect(document.body.textContent).toContain("mongoCompare.configUnsaved");
    expect(JSON.parse(localStorage.getItem(MONGO_COMPARE_CONFIG_KEY)!)[0].ignoredFields).toBe("");
    button("configSave").click();
    await nextTick();
    expect(JSON.parse(localStorage.getItem(MONGO_COMPARE_CONFIG_KEY)!)[0].ignoredFields).toBe("updatedAt");
    expect(document.body.textContent).not.toContain("mongoCompare.configUnsaved");
  });

  it("disables configuration changes while comparing or confirming writes", async () => {
    await mount();
    disabled.value = true;
    await nextTick();
    expect(document.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(button("configSave").disabled).toBe(true);
    expect(button("configSaveAs").disabled).toBe(true);
  });
});
