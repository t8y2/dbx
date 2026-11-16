// @vitest-environment happy-dom
//
// 覆盖 kvrocks 专有类型（bitmap / hyperloglog）与未知类型的详情渲染：
// 这些类型以前会落到 unknown 分支，界面上只显示空值（issue #10406）。

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
    redis: {
      bitmapInfo: "kvrocks bitmap · {bits} bits set · {bytes} bytes",
      hyperLogLogHint: "kvrocks HyperLogLog: PFCOUNT cardinality estimate",
      unsupportedValueType: "Viewing this Redis type is not supported yet: {type}",
      unsupportedValueTypeHint: "Proprietary kvrocks type",
      largeStringPreviewHintUnknown: "This value is large. Only the first {loaded} is loaded, and the preview is read-only.",
    },
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

describe("RedisValueViewer kvrocks 专有类型", () => {
  it("按字节渲染 kvrocks 位图并显示置位数量，且不提供保存动作", async () => {
    mocks.redisGetValue.mockResolvedValue({
      key_display: "bitmap-key",
      key_raw: "bitmap-key",
      ttl: -1,
      redis_type: "bitmap",
      data: {
        kind: "bitmap",
        content: { raw_base64: "gA==", encoding: "binary" },
        total_bytes: 1,
        set_bits: 1,
      },
    });

    await mountViewer();

    const info = document.querySelector("[data-redis-bitmap-info]");
    expect(info?.textContent).toContain("1 bits set");
    expect(info?.textContent).toContain("1 bytes");
    // 位图写回会改变服务端类型，因此详情面板不出现保存按钮
    expect(document.querySelector("[data-slot='button'][aria-label='grid.save']")).toBeNull();
  });

  it("截断的 kvrocks 位图显示未知总量的截断提示而不是空文案", async () => {
    // 超过预览上限时后端拿不到位图准确长度（total_bytes 为空），截断横幅须走未知总量文案
    mocks.redisGetValue.mockResolvedValue({
      key_display: "bitmap-key",
      key_raw: "bitmap-key",
      ttl: -1,
      redis_type: "bitmap",
      data: {
        kind: "bitmap",
        content: { raw_base64: "gA==", encoding: "binary" },
        truncated: true,
        set_bits: 1,
      },
    });

    await mountViewer();

    const banner = document.querySelector("[data-redis-large-string-preview]");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Only the first 1 B is loaded");
  });

  it("HyperLogLog 类型展示 PFCOUNT 基数估计", async () => {
    mocks.redisGetValue.mockResolvedValue({
      key_display: "hll-key",
      key_raw: "hll-key",
      ttl: -1,
      redis_type: "hyperloglog",
      data: { kind: "hyperloglog", count: 42 },
    });

    await mountViewer();

    expect(document.body.textContent).toContain("42");
    expect(document.body.textContent).toContain("PFCOUNT cardinality estimate");
  });

  it("未知类型提示具体类型名而不是空白", async () => {
    mocks.redisGetValue.mockResolvedValue({
      key_display: "ts-key",
      key_raw: "ts-key",
      ttl: -1,
      redis_type: "timeseries",
      data: { kind: "unknown", redis_type: "timeseries" },
    });

    await mountViewer();

    expect(document.body.textContent).toContain("timeseries");
    expect(document.body.textContent).toContain("Viewing this Redis type is not supported yet");
  });
});
