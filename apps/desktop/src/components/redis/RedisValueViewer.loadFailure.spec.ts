// @vitest-environment happy-dom
//
// 覆盖键详情的读取失败路径：服务端拒绝读取时（早期是 TongRDS 对越界
// GETRANGE 直接报错），面板以前是纯空白，失败只进了调试日志，用户看不出
// 是读取失败还是键里没有内容。

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

// Render the string body without mounting CodeMirror and its stores.
vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h, ref } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: String, readOnly: Boolean, autofocus: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        const input = ref<HTMLTextAreaElement>();
        return () =>
          h("textarea", {
            ref: input,
            value: props.modelValue,
            readonly: props.readOnly,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLTextAreaElement).value),
          });
      },
    }),
  };
});

import RedisValueViewer from "./RedisValueViewer.vue";

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

const testI18nMessages = {
  en: {
    common: { loading: "Loading" },
    grid: { refresh: "Refresh" },
  },
};

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
  app.use(createI18n({ legacy: false, locale: "en", messages: testI18nMessages, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  await settle();
}

function stringValue(text: string) {
  return {
    key_display: "key",
    key_raw: "key",
    ttl: -1,
    redis_type: "string",
    data: {
      kind: "string",
      content: { raw_base64: btoa(text), encoding: "utf8" },
      total_bytes: text.length,
      truncated: false,
    },
  };
}

describe("RedisValueViewer 读取失败", () => {
  it("读取失败时显示原因而不是空白面板", async () => {
    mocks.redisGetValue.mockRejectedValue(new Error("0-65536 is out of bounds"));

    await mountViewer();

    const failure = document.querySelector("[data-redis-value-load-error]");
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain("0-65536 is out of bounds");
    expect(mocks.toast).toHaveBeenCalledWith("0-65536 is out of bounds", 4000);
  });

  it("重试按钮重新读取并渲染值", async () => {
    mocks.redisGetValue.mockRejectedValueOnce(new Error("0-65536 is out of bounds")).mockResolvedValueOnce(stringValue("hello"));

    await mountViewer();
    expect(document.querySelector("[data-redis-value-load-error]")).not.toBeNull();

    const retry = document.querySelector<HTMLButtonElement>("[data-redis-value-load-retry]");
    expect(retry).not.toBeNull();
    retry!.click();
    await settle();
    await settle();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-redis-value-load-error]")).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("hello");
  });
});
