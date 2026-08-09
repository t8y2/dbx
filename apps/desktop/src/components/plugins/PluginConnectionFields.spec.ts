// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import PluginConnectionFields from "./PluginConnectionFields.vue";
import type { PluginConnectionProviderContribution, PluginFormFieldBinding, PluginFormFieldValue } from "@/types/database";

const mountedApps: App[] = [];

const contribution: PluginConnectionProviderContribution = {
  type: "connection-provider",
  id: "example.connection",
  label: "Example connection",
  database_type: "example",
  fields: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "localhost" },
    { key: "password", label: "Password", type: "password" },
  ],
};

async function mountFields(initialValues: Record<string, PluginFormFieldValue> = {}, hiddenBindings: PluginFormFieldBinding[] = [], layout: "stacked" | "connection-dialog" = "stacked") {
  const state = reactive({ values: initialValues });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(PluginConnectionFields, {
            contribution,
            modelValue: state.values,
            hiddenBindings,
            layout,
            "onUpdate:modelValue": (value: Record<string, PluginFormFieldValue>) => {
              state.values = value;
            },
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return state;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("PluginConnectionFields", () => {
  it("renders declared fields and emits immutable model updates", async () => {
    const state = await mountFields({ password: "secret" });
    const hostInput = document.querySelector<HTMLInputElement>("#example-connection-host");
    const passwordInput = document.querySelector<HTMLInputElement>("#example-connection-password");

    expect(hostInput?.placeholder).toBe("localhost");
    expect(passwordInput?.value).toBe("secret");

    if (!hostInput) throw new Error("host input not mounted");
    hostInput.value = "db.internal";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(state.values).toEqual({ password: "secret", host: "db.internal" });
  });

  it("can hide host-owned common bindings", async () => {
    contribution.fields[0].binding = "host";
    await mountFields({}, ["host"]);
    expect(document.querySelector("#example-connection-host")).toBeNull();
    expect(document.querySelector("#example-connection-password")).not.toBeNull();
    contribution.fields[0].binding = undefined;
  });

  it("uses the native four-column connection layout without a nested card", async () => {
    await mountFields({}, [], "connection-dialog");

    const root = document.querySelector(".contents");
    const hostInput = document.querySelector("#example-connection-host");
    const fieldRow = hostInput?.closest(".grid");

    expect(root).not.toBeNull();
    expect(root?.textContent).not.toContain("Example connection");
    expect(fieldRow?.classList.contains("grid-cols-4")).toBe(true);
    expect(document.querySelector(".rounded-lg.border")).toBeNull();
  });
});
