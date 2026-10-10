// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import OracleObjectGrantsButton from "../OracleObjectGrantsButton.vue";
import type { ConnectionConfig } from "@/types/database";

vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));
vi.mock("@/components/ui/dialog", () => {
  const box = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", { role: "dialog" }, slots.default?.()) : null,
    }),
    DialogContent: box,
    DialogHeader: box,
    DialogTitle: box,
  };
});
vi.mock("../OracleSecurityAdmin.vue", () => ({ default: defineComponent({ props: ["connection", "objectScope"], setup: (props) => () => h("pre", { "data-scope": "" }, JSON.stringify(props.objectScope)) }) }));

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;
function mount(dbType = "oracle") {
  const state = reactive({ connection: { id: "a", db_type: dbType } as ConnectionConfig, owner: "Case.Owner", objectName: 'Table"Name' });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(OracleObjectGrantsButton, state) });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.mount(root);
  return state;
}
afterEach(() => {
  app?.unmount();
  root?.remove();
});
describe("table object-grant entry", () => {
  it("loads the scoped panel only on demand and closes it when the table changes", async () => {
    const state = mount();
    expect(root.querySelector("[data-scope]")).toBeNull();
    root.querySelector<HTMLButtonElement>("[data-structure-object-grants]")!.click();
    await nextTick();
    expect(JSON.parse(root.querySelector("[data-scope]")!.textContent!)).toEqual({ owner: "Case.Owner", name: 'Table"Name' });
    state.objectName = "Other";
    await nextTick();
    await nextTick();
    expect(root.querySelector("[data-scope]")).toBeNull();
  });
  it("does not expose the Oracle entry for other database families", () => {
    mount("mysql");
    expect(root.querySelector("button")).toBeNull();
  });
});
