// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryMessage } from "@/types/database";
import QueryMessagesView from "../QueryMessagesView.vue";

const mocks = vi.hoisted(() => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined), toast: vi.fn() }));
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/common/clipboard")>()), copyToClipboard: mocks.copyToClipboard }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  mocks.copyToClipboard.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
});

async function mountMessages(messages: QueryMessage[]) {
  const state = reactive({ messages });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(QueryMessagesView, { messages: state.messages }) });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          queryMessages: { empty: "No messages", copyAll: "Copy all", copied: "Messages copied", copyFailed: "Failed to copy messages: {message}", code: "Code: {code}", mongoShell: "Generated mongo shell", copyMongoShell: "Copy shell" },
          toolbar: { mongoShellCopied: "Shell copied" },
        },
      },
    }),
  );
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await nextTick();
  return {
    host,
    state,
    button: (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label)!,
  };
}

describe("copy all query messages", () => {
  it("copies the complete batch and preserves server message severity, details, hints and codes", async () => {
    const { button } = await mountMessages([
      { severity: "INFO", message: "UPDATE device SET device_name = device_name WHERE 1 = 0;\nAffected rows: 0\nTime: 4ms" },
      { severity: "INFO", message: "Rows matched: 0 Changed: 0 Warnings: 0" },
      { severity: "ERROR", message: "second statement failed", detail: "constraint detail", hint: "check the key", code: "23505" },
    ]);
    button("Copy all").click();
    await nextTick();
    expect(mocks.copyToClipboard).toHaveBeenCalledExactlyOnceWith("[INFO] UPDATE device SET device_name = device_name WHERE 1 = 0;\nAffected rows: 0\nTime: 4ms\n\n[INFO] Rows matched: 0 Changed: 0 Warnings: 0\n\n[ERROR] second statement failed\nconstraint detail\ncheck the key\nCode: 23505");
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Messages copied");
  });

  it("copies the current messages after a new execution or result run is selected", async () => {
    const { state, button } = await mountMessages([{ severity: "INFO", message: "previous batch" }]);
    state.messages = [{ severity: "INFO", message: "current batch" }];
    await nextTick();
    button("Copy all").click();
    await nextTick();
    expect(mocks.copyToClipboard).toHaveBeenCalledExactlyOnceWith("[INFO] current batch");
  });

  it("keeps Mongo shell copying unchanged and omits its internal code from copy all", async () => {
    const { button } = await mountMessages([{ severity: "INFO", code: "mongo-shell", message: "db.collection.find()" }]);
    button("Copy shell").click();
    await nextTick();
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("db.collection.find()");
    expect(mocks.toast).toHaveBeenLastCalledWith("Shell copied");
    button("Copy all").click();
    await nextTick();
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("[INFO] db.collection.find()");
  });

  it.each(["Copy all", "Copy shell"])("reports clipboard failure from %s without a success toast", async (label) => {
    const { button } = await mountMessages([{ severity: "INFO", code: "mongo-shell", message: "db.collection.find()" }]);
    mocks.copyToClipboard.mockRejectedValueOnce(new Error("Permission denied"));
    button(label).click();
    await nextTick();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Failed to copy messages: Permission denied");
  });

  it("does not offer copy all for an empty output", async () => {
    const { host } = await mountMessages([]);
    expect(host.textContent).toContain("No messages");
    expect(host.querySelector("button")).toBeNull();
  });
});
