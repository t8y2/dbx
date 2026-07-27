// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarDateTimeToUnixSeconds, parseLocalDateTime } from "@/components/ui/date-time-picker/dateTimePicker";

const mocks = vi.hoisted(() => ({
  redisGetValue: vi.fn(),
  redisSetTtl: vi.fn(),
  redisSetExpireAt: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  redisGetValue: mocks.redisGetValue,
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

import RedisValueViewer from "./RedisValueViewer.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function stringValue(rawBase64 = "dmFsdWU=", ttl = 60) {
  return {
    key_display: "key",
    key_raw: "key",
    ttl,
    redis_type: "string",
    data: { kind: "string" as const, content: { raw_base64: rawBase64, encoding: "utf8" as const } },
  };
}

function missingValue() {
  return {
    key_display: "key",
    key_raw: "key",
    ttl: -2,
    redis_type: "none",
    data: { kind: "unknown" as const },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mountViewer(onDeleted: (keyRaw: string) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(RedisValueViewer, {
            connectionId: "connection",
            db: 0,
            keyDisplay: "key",
            keyRaw: "key",
            onDeleted,
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
}

async function saveTtlFromEditor() {
  await openTtlEditor();
  await saveOpenTtlEditor();
}

async function openTtlEditor() {
  document.querySelector<HTMLButtonElement>("[data-slot='badge'][aria-label='redis.expiry']")!.click();
  await settle();
}

async function saveOpenTtlEditor() {
  document.querySelector<HTMLButtonElement>("[data-slot='button'][aria-label='grid.save']")!.click();
  await settle();
}

async function selectExpiryMode(mode: "none" | "at") {
  const trigger = document.querySelector<HTMLButtonElement>("[data-slot='select-trigger'][aria-label='redis.expiry']")!;
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await settle();

  const index = mode === "none" ? 0 : 2;
  const option = document.querySelectorAll<HTMLElement>("[data-redis-expiry-mode-content] [role='option']")[index]!;
  option.focus();
  option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
}

async function setAbsoluteExpiry(value: string) {
  document.querySelector<HTMLButtonElement>("[data-date-time-picker-trigger]")!.click();
  await settle();

  const input = document.querySelector<HTMLInputElement>("[data-date-time-picker-content] [data-date-time-picker-input]")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();

  Array.from(document.querySelectorAll<HTMLButtonElement>("[data-date-time-picker-content] button"))
    .find((button) => button.textContent?.trim() === "Apply")!
    .click();
  await settle();
}

async function setStringDraft(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

describe("RedisValueViewer expiry saving", () => {
  it("removes a key that disappears while a TTL save fails", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(missingValue());
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("Redis key no longer exists; EXPIRE was not applied"));
    const deleted = vi.fn();

    mountViewer(deleted);
    await settle();

    await saveTtlFromEditor();

    expect(mocks.redisSetTtl).toHaveBeenCalledWith("connection", 0, "key", 60);
    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(deleted).toHaveBeenCalledWith("key");
    expect(mocks.toast).toHaveBeenCalledWith("Redis key no longer exists; EXPIRE was not applied", 3000);
  });

  it("keeps an unsaved value draft when a TTL save has an unrelated error", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(stringValue("c2VydmVy"));
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("NOPERM this user has no permissions to run the 'expire' command"));
    const deleted = vi.fn();

    mountViewer(deleted);
    await settle();

    await setStringDraft("draft");
    await saveTtlFromEditor();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft");
    expect(deleted).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("NOPERM this user has no permissions to run the 'expire' command", 3000);
  });

  it("still removes a deleted key when another value draft is unsaved", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(missingValue());
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("Redis key no longer exists; EXPIRE was not applied"));
    const deleted = vi.fn();

    mountViewer(deleted);
    await settle();
    await setStringDraft("draft");
    await saveTtlFromEditor();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(2);
    expect(deleted).toHaveBeenCalledWith("key");
  });

  it("keeps an unsaved value draft after a successful TTL save", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(stringValue("c2VydmVy", 42));
    mocks.redisSetTtl.mockResolvedValueOnce(undefined);

    mountViewer(vi.fn());
    await settle();
    await setStringDraft("draft");
    await saveTtlFromEditor();

    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft");
    expect(document.querySelector<HTMLElement>("[data-slot='badge'][aria-label='redis.expiry']")?.textContent).toContain("00:00:42");
  });

  it("removes a key that disappears while refreshing after a successful TTL save", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockRejectedValueOnce(new Error("RedisJSON key no longer exists")).mockResolvedValueOnce(missingValue());
    mocks.redisSetTtl.mockResolvedValueOnce(undefined);
    const deleted = vi.fn();

    mountViewer(deleted);
    await settle();
    await saveTtlFromEditor();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(3);
    expect(deleted).toHaveBeenCalledWith("key");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("removes a key when two refresh reads confirm a RedisJSON deletion", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockRejectedValueOnce(new Error("RedisJSON key no longer exists")).mockRejectedValueOnce(new Error("RedisJSON key no longer exists"));
    mocks.redisSetTtl.mockResolvedValueOnce(undefined);
    const deleted = vi.fn();

    mountViewer(deleted);
    await settle();
    await saveTtlFromEditor();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(3);
    expect(deleted).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledWith("key");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not remove a key from an old expiry error when refresh cannot confirm its state", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockRejectedValueOnce(new Error("network unavailable")).mockRejectedValueOnce(new Error("network unavailable"));
    mocks.redisSetTtl.mockRejectedValueOnce(new Error("Redis key no longer exists; EXPIRE was not applied"));
    const deleted = vi.fn();

    mountViewer(deleted);
    await settle();
    await saveTtlFromEditor();

    expect(mocks.redisGetValue).toHaveBeenCalledTimes(3);
    expect(deleted).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Redis key no longer exists; EXPIRE was not applied", 3000);
  });

  it("persists a key when the editor is switched to no expiry", async () => {
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(stringValue("dmFsdWU=", -1));
    mocks.redisSetTtl.mockResolvedValueOnce(undefined);

    mountViewer(vi.fn());
    await settle();
    await openTtlEditor();
    await selectExpiryMode("none");
    await saveOpenTtlEditor();

    expect(mocks.redisSetTtl).toHaveBeenCalledOnce();
    expect(mocks.redisSetTtl).toHaveBeenCalledWith("connection", 0, "key", -1);
    expect(mocks.redisSetExpireAt).not.toHaveBeenCalled();
  });

  it("uses EXPIREAT with the selected local date and time", async () => {
    const localDateTime = "2099-02-03 04:05:06";
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(stringValue("dmFsdWU=", 60));
    mocks.redisSetExpireAt.mockResolvedValueOnce(undefined);

    mountViewer(vi.fn());
    await settle();
    await openTtlEditor();
    await selectExpiryMode("at");
    await setAbsoluteExpiry(localDateTime);
    await saveOpenTtlEditor();

    expect(mocks.redisSetExpireAt).toHaveBeenCalledOnce();
    expect(mocks.redisSetExpireAt).toHaveBeenCalledWith("connection", 0, "key", calendarDateTimeToUnixSeconds(parseLocalDateTime(localDateTime)!));
    expect(mocks.redisSetTtl).not.toHaveBeenCalled();
  });

  it("does not submit a second expiry policy while the first is pending", async () => {
    const pending = deferred<void>();
    mocks.redisGetValue.mockResolvedValueOnce(stringValue()).mockResolvedValueOnce(stringValue());
    mocks.redisSetTtl.mockImplementationOnce(() => pending.promise);

    mountViewer(vi.fn());
    await settle();
    document.querySelector<HTMLButtonElement>("[data-slot='badge'][aria-label='redis.expiry']")!.click();
    await settle();

    const save = document.querySelector<HTMLButtonElement>("[data-slot='button'][aria-label='grid.save']")!;
    save.click();
    await nextTick();
    expect(save.disabled).toBe(true);
    save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.redisSetTtl).toHaveBeenCalledOnce();

    pending.resolve();
    await settle();
  });
});
