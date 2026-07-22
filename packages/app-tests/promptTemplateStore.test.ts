import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PromptTemplate } from "../../apps/desktop/src/types/promptTemplate";

const apiMock = vi.hoisted(() => ({
  getAiGlobalCustomInstructions: vi.fn(),
  loadPromptTemplates: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

import { usePromptTemplateStore } from "../../apps/desktop/src/stores/promptTemplateStore.ts";

const template: PromptTemplate = {
  id: "production-rules",
  name: "Production Rules",
  content: "Use tenant_id filters.",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.loadPromptTemplates.mockReset();
  apiMock.getAiGlobalCustomInstructions.mockReset();
});

test("concurrent prompt initialization waits for one complete load", async () => {
  let resolveTemplates!: (value: PromptTemplate[]) => void;
  let resolveGlobalInstructions!: (value: string) => void;
  const templates = new Promise<PromptTemplate[]>((resolve) => {
    resolveTemplates = resolve;
  });
  const globalInstructions = new Promise<string>((resolve) => {
    resolveGlobalInstructions = resolve;
  });
  apiMock.loadPromptTemplates.mockReturnValueOnce(templates);
  apiMock.getAiGlobalCustomInstructions.mockReturnValueOnce(globalInstructions);

  const store = usePromptTemplateStore();
  const initialLoad = store.init();
  const sendLoad = store.ensureLoaded();

  assert.equal(apiMock.loadPromptTemplates.mock.calls.length, 1);
  assert.equal(apiMock.getAiGlobalCustomInstructions.mock.calls.length, 1);

  resolveTemplates([template]);
  resolveGlobalInstructions("Always use read-only SQL first.");

  assert.deepEqual(await Promise.all([initialLoad, sendLoad]), [true, true]);
  assert.deepEqual(store.templates, [template]);
  assert.equal(store.globalInstructions, "Always use read-only SQL first.");
});

test("failed prompt initialization remains retryable", async () => {
  apiMock.loadPromptTemplates.mockRejectedValueOnce(new Error("backend unavailable"));
  apiMock.getAiGlobalCustomInstructions.mockResolvedValueOnce("stale instruction");
  apiMock.loadPromptTemplates.mockResolvedValueOnce([template]);
  apiMock.getAiGlobalCustomInstructions.mockResolvedValueOnce("Recovered instruction");

  const store = usePromptTemplateStore();

  assert.equal(await store.ensureLoaded(), false);
  assert.equal(store.isLoaded, false);
  assert.equal(await store.ensureLoaded(), true);
  assert.equal(store.globalInstructions, "Recovered instruction");
  assert.deepEqual(store.templates, [template]);
});

test("delayed load populates globalInstructions after async init resolves", async () => {
  // Simulates EditorSettingsDialog's AI-tab flow: a fire-and-forget init()
  // has been issued elsewhere, and the consumer must await ensureLoaded()
  // before reading globalInstructions — otherwise it sees the empty default.

  let resolveTemplates!: (value: PromptTemplate[]) => void;
  let resolveGlobalInstructions!: (value: string) => void;
  const templates = new Promise<PromptTemplate[]>((resolve) => {
    resolveTemplates = resolve;
  });
  const globalInstructions = new Promise<string>((resolve) => {
    resolveGlobalInstructions = resolve;
  });
  apiMock.loadPromptTemplates.mockReturnValueOnce(templates);
  apiMock.getAiGlobalCustomInstructions.mockReturnValueOnce(globalInstructions);

  const store = usePromptTemplateStore();

  // Kick off init (simulates App.vue's fire-and-forget) but don't await yet
  const initPromise = store.init();

  // Consumer awaits ensureLoaded before reading globalInstructions (fix for #1)
  const sendPromise = store.ensureLoaded().then((ok) => {
    if (!ok) throw new Error("ensureLoaded should succeed");
    return store.globalInstructions;
  });

  // Init hasn't resolved yet — globalInstructions should still be empty default
  assert.equal(store.globalInstructions, "");

  resolveTemplates([template]);
  resolveGlobalInstructions("Use Unicode-aware comparisons.");

  await initPromise;
  const instructions = await sendPromise;
  assert.equal(instructions, "Use Unicode-aware comparisons.");
  assert.equal(store.globalInstructions, "Use Unicode-aware comparisons.");
  assert.equal(store.isLoaded, true);
});

test("concurrent ensureLoaded calls with deferred init do not race", async () => {
  // Two rapid callers both call ensureLoaded() before init resolves.
  // Both must see the same resolved state without spawning duplicate loads
  // or seeing inconsistent globalInstructions values.

  let resolveTemplates!: (value: PromptTemplate[]) => void;
  let resolveGlobalInstructions!: (value: string) => void;
  const templates = new Promise<PromptTemplate[]>((resolve) => {
    resolveTemplates = resolve;
  });
  const globalInstructions = new Promise<string>((resolve) => {
    resolveGlobalInstructions = resolve;
  });
  apiMock.loadPromptTemplates.mockReturnValueOnce(templates);
  apiMock.getAiGlobalCustomInstructions.mockReturnValueOnce(globalInstructions);

  const store = usePromptTemplateStore();

  // Two concurrent callers (simulating two rapid send() calls)
  const callerA = store.ensureLoaded().then((ok) => (ok ? store.globalInstructions : "FAIL_A"));
  const callerB = store.ensureLoaded().then((ok) => (ok ? store.globalInstructions : "FAIL_B"));

  // Only one API call pair
  assert.equal(apiMock.loadPromptTemplates.mock.calls.length, 1);
  assert.equal(apiMock.getAiGlobalCustomInstructions.mock.calls.length, 1);

  resolveTemplates([template]);
  resolveGlobalInstructions("Concurrent-safe value.");

  const [resultA, resultB] = await Promise.all([callerA, callerB]);
  assert.equal(resultA, "Concurrent-safe value.");
  assert.equal(resultB, "Concurrent-safe value.");
  assert.equal(store.isLoaded, true);
});
