// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import { expect, it } from "vitest";
import zh from "@/i18n/locales/zh-CN";
import NativeJobArgumentValueEditor from "@/components/admin/NativeJobArgumentValueEditor.vue";
import type { NativeJobValue } from "@/lib/database/nativeJobs";

function mount(initial: NativeJobValue, readonly = false) {
  const value = ref(initial);
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(defineComponent({ setup: () => () => h(NativeJobArgumentValueEditor, { modelValue: value.value, "onUpdate:modelValue": (next: NativeJobValue) => (value.value = next), anydata: true, readonly, label: "参数值" }) }));
  app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
  app.mount(root);
  return {
    root,
    value,
    close: () => {
      app.unmount();
      root.remove();
    },
  };
}

it("keeps JSON-looking ordinary text on the string setter path", async () => {
  const fixture = mount('{"$dbx":"oracle-anydata-v1","scalarType":"number","value":"1"}');
  try {
    expect(fixture.root.querySelector("select")!.value).toBe("text");
    const input = fixture.root.querySelector("textarea")!;
    input.value = "  text with trailing spaces  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toBe("  text with trailing spaces  ");
  } finally {
    fixture.close();
  }
});

it("retains the readable legacy scalar display for non-ANYDATA defaults", () => {
  const fixture = mount(42, true);
  try {
    expect(fixture.root.querySelector("textarea")!.value).toBe("42");
    expect(fixture.value.value).toBe(42);
  } finally {
    fixture.close();
  }
});

it("edits legacy NUMBER envelopes without coercing exact decimals through JavaScript numbers", async () => {
  const fixture = mount({ $dbx: "oracle-anydata-v1", typeName: "SYS.NUMBER", value: "12345678901234567890123456789012345678" });
  try {
    expect(fixture.root.querySelector("select")!.value).toBe("number");
    const input = fixture.root.querySelector("textarea")!;
    expect(input.value).toBe("12345678901234567890123456789012345678");
    input.value = "-0.000000000000000000000000000001";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toEqual({ $dbx: "oracle-anydata-v1", scalarType: "number", value: input.value });
  } finally {
    fixture.close();
  }
});

it("keeps explicit typed NULL distinct from ordinary NULL and offers every closed scalar type", async () => {
  const fixture = mount({ $dbx: "oracle-anydata-v1", scalarType: "char", value: "x " });
  try {
    const select = fixture.root.querySelector("select")!;
    expect([...select.options].map((option) => option.value)).toEqual(["text", "varchar2", "char", "nvarchar2", "nchar", "number", "date", "timestamp", "timestamp-tz", "timestamp-ltz", "interval-ym", "interval-ds", "raw", "binary-float", "binary-double", "urowid"]);
    const checkbox = fixture.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toEqual({ $dbx: "oracle-anydata-v1", scalarType: "char", value: null });
    expect(fixture.root.querySelector("textarea")).toBeNull();
  } finally {
    fixture.close();
  }
});

it("keeps BC civil dates and fractional seconds as exact strings with local time-zone fields", async () => {
  const initial = { $dbx: "oracle-anydata-v1", scalarType: "timestamp-tz", value: { civilDate: "-0001-12-31", seconds: "86399.123456789", region: "America/New_York", offset: "-05:00", abbreviation: "EST" } };
  const fixture = mount(initial);
  try {
    const inputs = [...fixture.root.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    expect(inputs.map((input) => input.value)).toEqual(["-0001-12-31", "23:59:59.123456789", "America/New_York", "-05:00", "EST"]);
    inputs[1]!.value = "00:00:00.000000001";
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toEqual({ ...initial, value: { ...initial.value, seconds: "0.000000001" } });
  } finally {
    fixture.close();
  }
});

it("replaces an older JDN date only when the user explicitly enters a civil date", async () => {
  const fixture = mount({ $dbx: "oracle-anydata-v1", scalarType: "timestamp", value: { day: "1234567", seconds: "1.123456789" } });
  try {
    const date = fixture.root.querySelector<HTMLInputElement>('input[type="text"]')!;
    date.value = "2026-10-21";
    date.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toEqual({ $dbx: "oracle-anydata-v1", scalarType: "timestamp", value: { civilDate: "2026-10-21", seconds: "1.123456789" } });
  } finally {
    fixture.close();
  }
});

it("does not update a kept or otherwise read-only scalar", async () => {
  const initial = { $dbx: "oracle-anydata-v1", scalarType: "raw", value: "00FF" };
  const fixture = mount(initial, true);
  try {
    expect(fixture.root.querySelector("select")!.disabled).toBe(true);
    const input = fixture.root.querySelector("textarea")!;
    expect(input.readOnly).toBe(true);
    input.value = "01";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toEqual(initial);
  } finally {
    fixture.close();
  }
});

it.each([
  ["nvarchar2", "引号'、反斜线\\、😀与尾空格  "],
  ["interval-ds", "-86399999999999999999999"],
  ["interval-ym", "-11999999999"],
  ["binary-double", "3FF0000000000001"],
  ["raw", "00FF0000"],
])("keeps %s payloads as full text", async (scalarType, text) => {
  const fixture = mount({ $dbx: "oracle-anydata-v1", scalarType, value: text });
  try {
    const input = fixture.root.querySelector("textarea")!;
    expect(input.value).toBe(text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(fixture.value.value).toEqual({ $dbx: "oracle-anydata-v1", scalarType, value: text });
  } finally {
    fixture.close();
  }
});
