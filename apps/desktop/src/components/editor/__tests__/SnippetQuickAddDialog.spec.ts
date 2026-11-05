// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import i18n from "@/i18n";
import SnippetQuickAddDialog from "@/components/editor/SnippetQuickAddDialog.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";

const mountedApps: App[] = [];

async function mountDialog(prefillBody: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const state = reactive({ open: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SnippetQuickAddDialog, {
          open: state.open,
          prefillBody,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { state };
}

function queryInput(id: string): HTMLInputElement | null {
  return document.body.querySelector(`#${id}`);
}

function setText(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error("input not found");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitButton(): HTMLButtonElement | null {
  return document.body.querySelector('button[type="submit"]');
}

function duplicateError(): string {
  return document.body.querySelector("p.text-destructive")?.textContent ?? "";
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  useToast().dismissToast();
});

describe("SnippetQuickAddDialog", () => {
  it("seeds the body from the selection prefill and focuses the required prefix field", async () => {
    await mountDialog("SELECT 1;");

    expect(queryInput("snippet-quick-add-body")?.value).toBe("SELECT 1;");
    expect(queryInput("snippet-quick-add-prefix")?.value).toBe("");
    expect(document.activeElement).toBe(queryInput("snippet-quick-add-prefix"));
  });

  it("keeps Save disabled until a prefix is typed", async () => {
    await mountDialog("SELECT 1;");

    expect(submitButton()?.disabled).toBe(true);

    setText(queryInput("snippet-quick-add-prefix"), "myq");
    await nextTick();

    expect(submitButton()?.disabled).toBe(false);
    expect(duplicateError()).toBe("");
  });

  it("rejects a prefix that already exists instead of letting the store drop it", async () => {
    await mountDialog("");

    setText(queryInput("snippet-quick-add-prefix"), "sel"); // built-in snippet prefix
    await nextTick();

    expect(duplicateError()).toBe("Prefix must be unique.");
    expect(submitButton()?.disabled).toBe(true);
  });

  it("saves immediately, defaults the label to the prefix, closes, and toasts", async () => {
    const { state } = await mountDialog("SELECT 1;");

    setText(queryInput("snippet-quick-add-prefix"), "myq");
    await nextTick();
    submitButton()?.click();
    await nextTick();

    const settingsStore = useSettingsStore();
    const saved = settingsStore.editorSettings.snippets.find((snippet) => snippet.prefix === "myq");
    expect(saved).toEqual(expect.objectContaining({ label: "myq", prefix: "myq", body: "SELECT 1;", enabled: true }));
    expect(typeof saved?.id).toBe("string");
    expect(saved?.id.length ?? 0).toBeGreaterThan(0);
    // Built-in defaults stay intact — the snippet is appended, not replacing the list.
    expect(settingsStore.editorSettings.snippets.some((snippet) => snippet.prefix === "sel")).toBe(true);
    expect(state.open).toBe(false);

    const toast = useToast();
    expect(toast.visible.value).toBe(true);
    expect(toast.message.value).toContain("myq");
  });

  it("submits through the form so Enter in any field saves", async () => {
    const { state } = await mountDialog("");

    setText(queryInput("snippet-quick-add-prefix"), "ent");
    setText(document.body.querySelector<HTMLTextAreaElement>("#snippet-quick-add-body"), "SELECT 2;");
    await nextTick();
    document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
    await nextTick();

    expect(useSettingsStore().editorSettings.snippets.some((snippet) => snippet.prefix === "ent")).toBe(true);
    expect(state.open).toBe(false);
  });

  it("cancel closes without saving", async () => {
    const { state } = await mountDialog("");

    setText(queryInput("snippet-quick-add-prefix"), "nope");
    await nextTick();
    const cancel = Array.from(document.body.querySelectorAll('button[type="button"]')).find((button) => button.textContent === "Cancel");
    cancel?.click();
    await nextTick();

    expect(state.open).toBe(false);
    expect(useSettingsStore().editorSettings.snippets.some((snippet) => snippet.prefix === "nope")).toBe(false);
  });
});
