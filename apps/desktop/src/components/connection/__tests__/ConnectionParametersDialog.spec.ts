// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import ConnectionParametersDialog from "../ConnectionParametersDialog.vue";
import type { ConnectionParameterContext } from "@/lib/connection/connectionParameterCatalog";

let app: App | undefined;
const tick = async () => {
  await nextTick();
  await nextTick();
  await nextTick();
};
async function mount(source = "", context: ConnectionParameterContext = { db_type: "mysql" }) {
  const raw = ref(source),
    open = ref(true),
    driver = ref(context),
    applied: string[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    render: () =>
      h(ConnectionParametersDialog, {
        open: open.value,
        modelValue: raw.value,
        context: driver.value,
        "onUpdate:open": (value: boolean) => (open.value = value),
        onApply: (value: string) => {
          applied.push(value);
          raw.value = value;
        },
      }),
  });
  app.use(i18n);
  app.mount(root);
  await tick();
  return { raw, open, driver, applied };
}
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === name);
  if (!found) throw new Error("Missing button " + name);
  return found;
}
async function click(name: string) {
  button(name).click();
  await tick();
}
async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  expect(input).toBeTruthy();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}
const valueInput = () => document.getElementById("connection-parameter-value") as HTMLInputElement;
beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await tick();
  document.body.innerHTML = "";
});

describe("connection parameter editor transaction and legacy compatibility", () => {
  it.each(["?localInfilePath=%2ftmp%2fa.csv&localInfilePath=/tmp/b.csv&&empty=&flag&unknown=%ZZ&", "charset=legacy-value-not-in-a-list&connect_timeout=not-a-number", "password=secret%2Bwith+spaces&unknown=a%26b%3Dc", ""])(
    "applying without edits preserves every original byte: %s",
    async (source) => {
      const state = await mount(source);
      await click("Apply");
      expect(state.applied).toEqual([source]);
      expect(state.open.value).toBe(false);
    },
  );
  it("cancel discards row edits and reopening restores the original source", async () => {
    const state = await mount("charset=latin1&unknown=%2f");
    await click("charset");
    await fill("connection-parameter-value", "utf8mb4");
    await click("Cancel");
    expect(state.raw.value).toBe("charset=latin1&unknown=%2f");
    expect(state.applied).toEqual([]);
    state.open.value = true;
    await tick();
    await click("charset");
    expect(valueInput().value).toBe("latin1");
  });
  it("edits a known parameter and preserves unknown, repeated and opaque neighbors", async () => {
    const state = await mount("unknown=%ZZ&charset=latin1&localInfilePath=/a&localInfilePath=%2fb");
    await click("charset");
    await fill("connection-parameter-value", "utf8mb4");
    await click("Apply");
    expect(state.applied).toEqual(["unknown=%ZZ&charset=utf8mb4&localInfilePath=/a&localInfilePath=%2fb"]);
  });
  it("editing one repeated parameter never collapses the other values", async () => {
    const state = await mount("localInfilePath=/one&localInfilePath=%2ftwo");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((el) => el.textContent?.trim() === "localInfilePath");
    buttons[1].click();
    await tick();
    await fill("connection-parameter-value", "/three 中文.csv");
    await click("Apply");
    expect(state.applied).toEqual(["localInfilePath=/one&localInfilePath=%2Fthree%20%E4%B8%AD%E6%96%87.csv"]);
  });
  it("deletes an added repeatable value without changing existing bytes", async () => {
    const source = "unknown=%ZZ&localInfilePath=%2fone&flag";
    const state = await mount(source);
    await click("localInfilePath");
    await click("Add another value");
    await fill("connection-parameter-value", "/two");
    await click("Delete value");
    expect(valueInput().value).toBe("/one");
    await click("Apply");
    expect(state.applied).toEqual([source]);
  });
  it("deletes one repeated row directly while retaining the selected sibling", async () => {
    const state = await mount("localInfilePath=/one&unknown=%ZZ&localInfilePath=%2ftwo");
    const names = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((element) => element.textContent?.trim() === "localInfilePath");
    names[1].click();
    await tick();
    document.querySelector<HTMLButtonElement>('button[aria-label="Delete value (localInfilePath)"]')!.click();
    await tick();
    expect(valueInput().value).toBe("/two");
    await click("Apply");
    expect(state.applied).toEqual(["unknown=%ZZ&localInfilePath=%2ftwo"]);
  });
  it("can delete all repeatable values and leave the supported parameter unconfigured", async () => {
    const state = await mount("localInfilePath=/one&localInfilePath=/two&unknown=%2f");
    await click("localInfilePath");
    await click("Delete value");
    await click("Delete value");
    expect(document.querySelector('button[aria-label="Delete value (localInfilePath)"]')).toBeNull();
    expect(valueInput().value).toBe("");
    await click("Apply");
    expect(state.applied).toEqual(["unknown=%2f"]);
  });
  it("adding a typed parameter does not persist all the displayed defaults", async () => {
    const state = await mount();
    await click("connect_timeout");
    await fill("connection-parameter-value", "25");
    await click("Apply");
    expect(state.applied).toEqual(["connect_timeout=25"]);
  });
  it("validates edited typed values without rewriting legacy invalid values", async () => {
    await mount("connect_timeout=legacy");
    await click("connect_timeout");
    expect(button("Apply").disabled).toBe(false);
    await fill("connection-parameter-value", "0");
    expect(button("Apply").disabled).toBe(true);
    await fill("connection-parameter-value", "20");
    expect(button("Apply").disabled).toBe(false);
  });
  it("reset removes the selected override rather than serializing a guessed default", async () => {
    const state = await mount("charset=latin1&unknown=%2f");
    await click("charset");
    await click("Use default");
    await click("Apply");
    expect(state.applied).toEqual(["unknown=%2f"]);
  });
  it("adds custom empty values separately from bare flags", async () => {
    const state = await mount("first=keep");
    await click("Add parameter");
    await fill("connection-parameter-name", "custom");
    await click("Apply");
    expect(state.applied).toEqual(["first=keep&custom="]);
  });
  it("shows raw text on demand and round trips it unchanged", async () => {
    const source = "?password=sensitive%2B&flag&&x=%ZZ&";
    const state = await mount(source);
    await click("Raw text");
    expect(document.getElementById("connection-parameter-raw")).toBeNull();
    expect(document.body.textContent).not.toContain("sensitive%2B");
    await click("Show raw text");
    expect((document.getElementById("connection-parameter-raw") as HTMLTextAreaElement).value).toBe(source);
    await click("Apply");
    expect(state.applied).toEqual([source]);
  });
  it("raw to table to raw preserves driver-specific escaping", async () => {
    const source = ";password={a;b&c=d}}e};applicationName=DBX";
    const state = await mount(source, { db_type: "sqlserver" });
    await click("Raw text");
    await click("Show raw text");
    await click("Parameters");
    await click("Raw text");
    await click("Show raw text");
    await click("Apply");
    expect(state.applied).toEqual([source]);
  });
  it("raw edits appear as table rows before applying", async () => {
    const state = await mount("charset=utf8mb4");
    await click("Raw text");
    await fill("connection-parameter-raw", "custom=%2B&custom=two");
    await click("Parameters");
    expect([...document.querySelectorAll("tbody tr")].filter((row) => row.textContent?.includes("custom"))).toHaveLength(2);
    await click("Apply");
    expect(state.applied).toEqual(["custom=%2B&custom=two"]);
  });
  it("blocks a stale apply when the parent configuration changes", async () => {
    const state = await mount("charset=latin1");
    await click("charset");
    await fill("connection-parameter-value", "utf8mb4");
    state.raw.value = "application_name=other";
    await tick();
    expect(button("Apply").disabled).toBe(true);
    button("Apply").click();
    await tick();
    expect(state.applied).toEqual([]);
    await click("Reload parameters");
    expect(button("Apply").disabled).toBe(false);
    await click("Apply");
    expect(state.applied).toEqual(["application_name=other"]);
  });
  it("blocks stale edits after changing drivers and reloads using the new grammar", async () => {
    const state = await mount("custom=one");
    state.driver.value = { db_type: "sqlserver" };
    state.raw.value = "password={a;b};x=1";
    await tick();
    expect(button("Apply").disabled).toBe(true);
    await click("Reload parameters");
    await click("Apply");
    expect(state.applied).toEqual(["password={a;b};x=1"]);
  });
  it("searches parameter names and descriptions without searching secret values", async () => {
    await mount("apiToken=super-secret-value&charset=utf8mb4");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search names or descriptions"]')!;
    input.value = "super-secret-value";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("super-secret-value");
  });
});
