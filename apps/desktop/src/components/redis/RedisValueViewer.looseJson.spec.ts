// @vitest-environment happy-dom
//
// Issue #14384: values written by Fastjson with WriteClassName (`1L`,
// `Set[...]`) are not JSON, so the JSON view used to stay disabled and the
// value showed as one unformatted line. The JSON view now shows them indented
// and read-only, while editing keeps working on the original text.

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";

const mocks = vi.hoisted(() => ({
  redisGetValue: vi.fn(),
  redisGetTtl: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
  redisGetTtl: mocks.redisGetTtl,
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
}));

vi.mock("@/composables/useEditorFontFamilyStyle", () => ({
  useEditorFontFamilyStyle: () => ({}),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/common/shikiJsonHighlighter", () => ({
  createShikiJsonHighlighter: vi.fn().mockResolvedValue(() => ""),
}));

// Render the editor body without mounting CodeMirror and its stores.
vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: String, readOnly: Boolean, autofocus: Boolean, language: String },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("textarea", {
            value: props.modelValue,
            readonly: props.readOnly,
            "data-language": props.language ?? "json",
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLTextAreaElement).value),
          });
      },
    }),
  };
});

import RedisValueViewer from "./RedisValueViewer.vue";

const FASTJSON_VALUE = '[{"@type":"com.example.SysDictData","dictCode":1L,"dictLabel":"男","roles":Set["admin"]}]';

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

function createLocalStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", createLocalStorage());
});

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  vi.unstubAllGlobals();
});

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountViewer() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(RedisValueViewer, { connectionId: "connection", db: 0, keyDisplay: "key", keyRaw: "key" });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  await settle();
  await settle();
}

function stringValue(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    key_display: "key",
    key_raw: "key",
    ttl: -1,
    redis_type: "string",
    data: {
      kind: "string",
      content: { raw_base64: btoa(String.fromCharCode(...bytes)), encoding: "utf8" },
      total_bytes: bytes.length,
      truncated: false,
    },
  };
}

function viewButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(button, `view button ${label}`).toBeDefined();
  return button!;
}

describe("RedisValueViewer loose JSON view (issue #14384)", () => {
  it("opens Fastjson output indented and read-only in the JSON view", async () => {
    mocks.redisGetValue.mockResolvedValue(stringValue(FASTJSON_VALUE));

    await mountViewer();

    expect(viewButton("redis.jsonView").disabled).toBe(false);
    const looseView = document.querySelector("[data-redis-loose-json]");
    expect(looseView).not.toBeNull();
    const body = looseView!.querySelector("textarea")!;
    expect(body.readOnly).toBe(true);
    expect(body.value).toBe(["[", "  {", '    "@type": "com.example.SysDictData",', '    "dictCode": 1L,', '    "dictLabel": "男",', '    "roles": Set[', '      "admin"', "    ]", "  }", "]"].join("\n"));
    expect(looseView!.textContent).toContain("redis.looseJsonHint");
    // Nothing to save from a read-only view.
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "grid.save")).toBe(false);
    // YAML/XML need a parsed value, which loose text does not have.
    expect(viewButton("YAML").disabled).toBe(true);
  });

  it("edits the original text from the UTF-8 view", async () => {
    mocks.redisGetValue.mockResolvedValue(stringValue(FASTJSON_VALUE));

    await mountViewer();
    viewButton("UTF-8").click();
    await settle();

    expect(document.querySelector("[data-redis-loose-json]")).toBeNull();
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(editor.readOnly).toBe(false);
    expect(editor.value).toBe(FASTJSON_VALUE);
  });

  it("remembers the JSON view when it is picked for loose JSON, like for strict JSON", async () => {
    mocks.redisGetValue.mockResolvedValue(stringValue(FASTJSON_VALUE));

    await mountViewer();
    viewButton("UTF-8").click();
    await settle();
    expect(localStorage.getItem("dbx-redis-value-format")).toBe("utf8");

    viewButton("redis.jsonView").click();
    await settle();

    expect(localStorage.getItem("dbx-redis-value-format")).toBe("json");
    expect(document.querySelector("[data-redis-loose-json]")).not.toBeNull();
  });

  it("keeps strict JSON on the editable JSON editor", async () => {
    mocks.redisGetValue.mockResolvedValue(stringValue('{"dictCode":1}'));

    await mountViewer();

    expect(document.querySelector("[data-redis-loose-json]")).toBeNull();
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(editor.readOnly).toBe(false);
    expect(editor.value).toBe('{\n  "dictCode": 1\n}');
  });
});
