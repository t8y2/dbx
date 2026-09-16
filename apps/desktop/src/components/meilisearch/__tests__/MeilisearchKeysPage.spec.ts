// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listKeys: vi.fn(),
  listIndexes: vi.fn(),
  createKey: vi.fn(),
  updateKey: vi.fn(),
  deleteKey: vi.fn(),
  getKey: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

function inputComponent(): Component {
  return defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: String, default: "" } },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () => h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
    },
  });
}

function multiSelectComponent(): Component {
  return defineComponent({
    props: { modelValue: { type: Array, default: () => [] }, options: { type: Array, default: () => [] }, placeholder: String, disabled: Boolean },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "select",
          {
            multiple: true,
            disabled: props.disabled,
            "data-placeholder": props.placeholder,
            onChange: (event: Event) =>
              emit(
                "update:modelValue",
                Array.from((event.target as HTMLSelectElement).selectedOptions).map((option) => option.value),
              ),
          },
          (props.options as string[]).map((option) => h("option", { value: option, selected: (props.modelValue as string[]).includes(option) }, option)),
        );
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }) }));
vi.mock("@lucide/vue", () => ({
  AlertTriangle: passthrough("span"),
  CalendarClock: passthrough("span"),
  Copy: passthrough("span"),
  Eye: passthrough("span"),
  Loader2: passthrough("span"),
  Pencil: passthrough("span"),
  Plus: passthrough("span"),
  RefreshCcw: passthrough("span"),
  Settings2: passthrough("span"),
  Trash2: passthrough("span"),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/input", () => ({ Input: inputComponent() }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: passthrough("div"), DialogContent: passthrough("div"), DialogFooter: passthrough("div"), DialogHeader: passthrough("div"), DialogTitle: passthrough("div") }));
vi.mock("@/components/ui/popover", () => ({ Popover: passthrough("div"), PopoverContent: passthrough("div"), PopoverTrigger: passthrough("div") }));
vi.mock("@/components/ui/date-time-picker/DateTimePicker.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/ui/ErrorBanner.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/common/QueryLoadingState.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/meilisearch/MeilisearchMultiSelect.vue", () => ({ default: multiSelectComponent() }));
vi.mock("@/lib/backend/api", () => ({
  meilisearchListKeys: mocks.listKeys,
  meilisearchListIndexes: mocks.listIndexes,
  meilisearchCreateKey: mocks.createKey,
  meilisearchUpdateKey: mocks.updateKey,
  meilisearchDeleteKey: mocks.deleteKey,
  meilisearchGetKey: mocks.getKey,
}));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ read_only: false }) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import MeilisearchKeysPage from "@/components/meilisearch/MeilisearchKeysPage.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

const keyItem = {
  uid: "923675a5-81da-4ea3-813c-f8edb32acd0d",
  key: "full-key-value",
  name: "Search key",
  description: "Frontend",
  maskedKey: "abc1...xyz9",
  actions: ["search"],
  indexes: ["wiki"],
  expiresAt: null,
};

beforeEach(() => {
  localStorage.removeItem("dbx:meilisearch:key-columns:v1");
  mocks.listKeys.mockResolvedValue({ results: [keyItem], total: 1, offset: 0, limit: 20 });
  mocks.listIndexes.mockResolvedValue(["wiki", "movies"]);
  mocks.createKey.mockResolvedValue({ uid: "new-uid", key: "secret" });
  mocks.deleteKey.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

async function mountPage() {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(MeilisearchKeysPage, { connectionId: "c1" });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.listKeys).toHaveBeenCalledWith("c1", 0, 20));
  await vi.waitFor(() => expect(mocks.listIndexes).toHaveBeenCalledWith("c1"));
  await nextTick();
  return root;
}

function inputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MeilisearchKeysPage", () => {
  it("loads accessible indexes and exposes the supported action choices", async () => {
    const container = await mountPage();
    const indexes = container.querySelector<HTMLSelectElement>('select[data-placeholder="meilisearch.indexesPlaceholder"]')!;
    const actions = container.querySelector<HTMLSelectElement>('select[data-placeholder="meilisearch.actionsPlaceholder"]')!;

    expect(Array.from(indexes.options).map((option) => option.value)).toEqual(["*", "movies", "wiki"]);
    expect(Array.from(actions.options).map((option) => option.value)).toEqual([
      "search",
      "documents.add",
      "documents.get",
      "documents.delete",
      "indexes.create",
      "indexes.get",
      "indexes.update",
      "indexes.delete",
      "tasks.get",
      "settings.get",
      "settings.update",
      "stats.get",
      "dumps.create",
      "version",
      "keys.get",
      "keys.create",
      "keys.update",
      "keys.delete",
    ]);
    expect(container.textContent).toContain("meilisearch.uidHelp");
    expect(container.textContent).toContain("meilisearch.actionsHelp");
    expect(container.textContent).toContain("meilisearch.expiresAtHelp");
  });

  it("normalizes a manually entered expiration and submits selected defaults", async () => {
    const container = await mountPage();
    const expiration = container.querySelector<HTMLInputElement>('input[placeholder="meilisearch.expiresAtPlaceholder"]')!;
    inputValue(expiration, "2030-01-02 03:04:05Z");
    const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "common.save")!;
    save.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.createKey).toHaveBeenCalledTimes(1));
    expect(mocks.createKey).toHaveBeenCalledWith("c1", expect.objectContaining({ actions: ["search"], indexes: ["*"], expiresAt: "2030-01-02T03:04:05.000Z" }));
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it("copies the full key while displaying only its masked value, and persists column visibility", async () => {
    const container = await mountPage();
    container.querySelector<HTMLButtonElement>('button[title="meilisearch.copyKeyValue"]')!.click();
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("full-key-value"));

    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(6);
    checkboxes[1].click();
    const stored = JSON.parse(localStorage.getItem("dbx:meilisearch:key-columns:v1") || "null");
    expect(stored.visible).not.toContain("key");
  });

  it("copies the full secret only from the one-time creation response", async () => {
    const container = await mountPage();
    const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "common.save")!;
    save.click();

    await vi.waitFor(() => expect(mocks.createKey).toHaveBeenCalledTimes(1));
    const copy = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "common.copy")!;
    copy.click();
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("secret"));
  });

  it("requires the complete UID before deleting a key", async () => {
    const container = await mountPage();
    container.querySelector<HTMLButtonElement>('button[title="common.delete"]')!.click();
    await nextTick();
    const confirmation = container.querySelector<HTMLInputElement>('input[placeholder="meilisearch.deleteKeyTypePlaceholder"]')!;
    const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "meilisearch.deleteKey")!;
    expect(deleteButton.disabled).toBe(true);

    inputValue(confirmation, keyItem.uid);
    await nextTick();
    expect(deleteButton.disabled).toBe(false);
    deleteButton.click();
    await vi.waitFor(() => expect(mocks.deleteKey).toHaveBeenCalledWith("c1", keyItem.uid));
  });
});
