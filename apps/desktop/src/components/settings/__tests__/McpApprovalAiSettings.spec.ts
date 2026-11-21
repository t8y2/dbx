// @vitest-environment happy-dom
import { createApp, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import McpApprovalAiSettings from "../McpApprovalAiSettings.vue";

const boundary = vi.hoisted(() => ({ store: null as any, save: vi.fn(), init: vi.fn(async () => undefined) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => boundary.store }));
vi.mock("@/components/ui/select", () => ({
  Select: { props: ["modelValue", "disabled"], emits: ["update:modelValue"], template: `<select :value="modelValue" :disabled="disabled" @change="$emit('update:modelValue', $event.target.value)"><slot /></select>` },
  SelectTrigger: { template: "<template />" },
  SelectValue: { template: "<template />" },
  SelectContent: { template: "<slot />" },
  SelectItem: { props: ["value", "disabled"], template: '<option :value="value" :disabled="disabled"><slot /></option>' },
}));
let app: ReturnType<typeof createApp>;
let root: HTMLDivElement;
beforeEach(async () => {
  boundary.save.mockReset().mockImplementation(async (patch) => {
    boundary.store.editorSettings.mcpApprovalAi = patch.mcpApprovalAi;
  });
  boundary.store = reactive({
    editorSettings: { mcpApprovalAi: { configId: "", modelId: "", autoGenerate: false } },
    aiConfigs: [
      { id: "one", name: "First", provider: "openai", model: "model-a", models: [{ name: "model-b", label: "Second model" }] },
      { id: "two", name: "Second", provider: "ollama", model: "local-model" },
      { id: "cli", name: "CLI", provider: "codex-cli", model: "agent" },
    ],
    initAiConfigs: boundary.init,
    updateEditorSettingsAndPersist: boundary.save,
  });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(McpApprovalAiSettings);
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, messages: { en: {} } }));
  app.mount(root);
  await nextTick();
});
afterEach(() => {
  app.unmount();
  root.remove();
});

it("lists saved models by configuration, excludes CLI agents, and saves only approval settings", async () => {
  const select = root.querySelector("select")!;
  expect(Array.from(select.options).map((option) => option.textContent)).toContain("First / Second model");
  expect(root.textContent).not.toContain("CLI / agent");
  expect(root.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  select.value = JSON.stringify(["one", "model-b"]);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(boundary.save).toHaveBeenCalledWith({ mcpApprovalAi: { configId: "one", modelId: "model-b", autoGenerate: false } });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await nextTick();
  const automatic = root.querySelector<HTMLInputElement>("input")!;
  expect(automatic.disabled).toBe(false);
  automatic.click();
  await nextTick();
  expect(boundary.save).toHaveBeenLastCalledWith({ mcpApprovalAi: { configId: "one", modelId: "model-b", autoGenerate: true } });
});

it("retains a missing selection visibly and reports persistence failures", async () => {
  boundary.store.editorSettings.mcpApprovalAi = { configId: "deleted", modelId: "old", autoGenerate: false };
  await nextTick();
  expect(Array.from(root.querySelector("select")!.options).find((option) => option.value === JSON.stringify(["deleted", "old"]))?.disabled).toBe(true);
  boundary.save.mockRejectedValueOnce(new Error("storage failure"));
  const select = root.querySelector("select")!;
  select.value = JSON.stringify(["two", "local-model"]);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await nextTick();
  expect(root.querySelector('[role="alert"]')!.textContent).toContain("mcpApprovalAiSaveFailed");
});
