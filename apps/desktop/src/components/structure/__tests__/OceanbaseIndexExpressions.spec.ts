// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import OceanbaseIndexExpressions from "../OceanbaseIndexExpressions.vue";
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return { Button: defineComponent({ inheritAttrs: false, setup: (_, { attrs, slots }) => () => h("button", attrs, slots.default?.()) }) };
});
let app: App | undefined;
let root: HTMLElement;
async function render(terms: string[]) {
  const value = ref([...terms]);
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(OceanbaseIndexExpressions, { modelValue: value.value, "onUpdate:modelValue": (terms: string[]) => { value.value = terms; } }) }));
  app.mount(root);
  await nextTick();
  return value;
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); });
describe("OceanBase index SQL terms", () => {
  it("keeps commas and newlines inside one expression", async () => {
    const value = await render(['"Name"']);
    const expression = 'SUBSTR(\n"Name", 1, 3)';
    const input = root.querySelector("textarea")!;
    input.value = expression;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(value.value).toEqual([expression]);
    expect(input.value).toBe(expression);
  });
  it("moves complete terms without splitting or rewriting them", async () => {
    const terms = ['LOWER("Name")', '"Second"'];
    const value = await render(terms);
    root.querySelector<HTMLButtonElement>('[aria-label="structureEditor.obIndexMoveDown"]')!.click();
    await nextTick();
    expect(value.value).toEqual([terms[1], terms[0]]);
    expect([...root.querySelectorAll("textarea")].map(input => input.value)).toEqual(value.value);
    expect(terms).toEqual(['LOWER("Name")', '"Second"']);
  });
  it("removes only the requested term", async () => {
    const value = await render(['"First"', '"Second"']);
    root.querySelector<HTMLButtonElement>('[aria-label="structureEditor.obIndexRemoveExpression"]')!.click();
    await nextTick();
    expect(value.value).toEqual(['"Second"']);
    expect(root.querySelectorAll("textarea")).toHaveLength(1);
  });
});
