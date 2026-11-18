// @vitest-environment happy-dom
//
// Issue #14653: the 自动换行 / Word wrap toggle in the Redis value pane collapsed to
// one glyph per line in narrow panes. The codec row is a nowrap flex row whose only
// shrinkable item was that label, so `min-width: auto` squeezed it down to min-content
// (4 stacked CJK characters) and the overgrown label painted over the 视图 row below.
// The contract under test: every occurrence of the toggle stays on one line
// (`shrink-0` + `whitespace-nowrap`) so the codec strip keeps the scroll pressure.

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGetValue: vi.fn(),
  redisGetTtl: vi.fn(),
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
  redisGetTtl: mocks.redisGetTtl,
  redisSetTtl: mocks.redisSetTtl,
  redisSetExpireAt: mocks.redisSetExpireAt,
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

// Keep CodeMirror and its stores out of the mount.
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

const WORD_WRAP = "Word wrap";

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
    key(index: number) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value));
    },
  };
}

const testI18nMessages = {
  en: {
    redis: { wordWrap: WORD_WRAP, wordWrapDescription: "Wrap long lines within the editor width" },
  },
};

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

function blob(text: string) {
  return { raw_base64: btoa(String.fromCharCode(...new TextEncoder().encode(text))), encoding: "utf8" as const };
}

function stringValue(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    key_display: "key",
    key_raw: "key",
    ttl: -1,
    redis_type: "string",
    data: {
      kind: "string" as const,
      content: { raw_base64: btoa(String.fromCharCode(...bytes)), encoding: "utf8" as const },
      total_bytes: bytes.length,
      truncated: false,
    },
  };
}

function listValue() {
  return {
    key_display: "key",
    key_raw: "key",
    ttl: -1,
    redis_type: "list",
    data: {
      kind: "list" as const,
      items: [
        { index: 0, value: blob("first") },
        { index: 1, value: blob("second") },
      ],
      total: 2,
      scan_cursor: undefined,
    },
  };
}

/** The word-wrap toggle is the only switch-bearing label whose text is the wrap label. */
function wordWrapLabels(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("label")].filter((label) => label.textContent?.trim() === WORD_WRAP && label.querySelector("[data-slot='switch']"));
}

function expectOneLine(label: HTMLElement) {
  expect(label.className).toContain("shrink-0");
  expect(label.className).toContain("whitespace-nowrap");
}

describe("RedisValueViewer word-wrap toggle stays on one line (issue #14653)", () => {
  it("keeps the string/bitmap codec row toggle unshrinkable", async () => {
    mocks.redisGetValue.mockResolvedValue(stringValue('{"id":1001,"name":"张三"}'));

    await mountViewer();

    const labels = wordWrapLabels();
    expect(labels).toHaveLength(1);
    expectOneLine(labels[0]!);
  });

  it("keeps the RedisJSON row toggle unshrinkable", async () => {
    mocks.redisGetValue.mockResolvedValue({
      key_display: "user:1001",
      key_raw: "user:1001",
      ttl: -1,
      redis_type: "ReJSON-RL",
      data: { kind: "json" as const, value: '{"id":1001,"name":"张三"}' },
    });

    await mountViewer();

    const labels = wordWrapLabels();
    expect(labels).toHaveLength(1);
    expectOneLine(labels[0]!);
  });

  it("keeps the member-detail dialog toggle unshrinkable", async () => {
    mocks.redisGetValue.mockResolvedValue(listValue());

    await mountViewer();
    Array.from(document.querySelectorAll<HTMLElement>("[data-redis-value-row]"))
      .find((row) => row.textContent?.includes("second"))!
      .click();
    await settle();

    const labels = wordWrapLabels();
    expect(labels).toHaveLength(1);
    expectOneLine(labels[0]!);
  });
});
