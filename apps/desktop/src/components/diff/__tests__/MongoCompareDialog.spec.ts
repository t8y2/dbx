// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MongoCompareDialog from "../MongoCompareDialog.vue";

const mocks = vi.hoisted(() => ({
  mongoFindDocuments: vi.fn(),
  mongoRunCommand: vi.fn(),
  mongoListCollections: vi.fn(),
  mongoListIndexSpecs: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  guard: vi.fn(),
  readOnly: false,
  saveTextFile: vi.fn(),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ connectionIsEffectivelyReadOnly: () => mocks.readOnly }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: mocks.saveTextFile }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: (id: string) => ({ id, db_type: "mongodb", name: id }), ensureConnected: mocks.ensureConnected }) }));
vi.mock("../MongoCompareEndpointSelect.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: ["label", "modelValue", "disabled"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          h("button", { disabled: props.disabled, onClick: () => emit("update:modelValue", { connectionId: props.label.endsWith("source") ? "source" : "target", database: "db", collection: "items", filter: "{}" }) }, props.label),
    }),
  };
});
vi.mock("../MongoComparePairs.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: ["modelValue", "disabled"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          h(
            "button",
            {
              disabled: props.disabled,
              onClick: () =>
                emit("update:modelValue", [
                  { source: "items", target: "archive", enabled: true, matchFields: "key" },
                  { source: "archive", target: "items", enabled: true, matchFields: "" },
                ]),
            },
            "add-test-pairs",
          ),
    }),
  };
});
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const container = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Dialog: container, DialogContent: container, DialogHeader: container, DialogTitle: container, DialogFooter: container };
});

let app: App;
const sourceDoc = { _id: 1, key: "K", name: "new", ignored: "source" };
const targetDoc = { _id: 1, key: "K", name: "old", ignored: "target" };
const page = (docs: object[]) => ({ documents: docs, extended_documents: docs });
async function flush() {
  for (let i = 0; i < 50; i++) {
    await nextTick();
    await Promise.resolve();
  }
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(MongoCompareDialog, { open: true }) }));
  app.mount(root);
  button("mongoCompare.source").click();
  button("mongoCompare.target").click();
  await flush();
}
async function compareAndSelect() {
  button("mongoCompare.run").click();
  await flush();
  const checkbox = document.querySelector<HTMLInputElement>('input[aria-label^="mongoCompare.select"]')!;
  expect(checkbox).not.toBeNull();
  checkbox.click();
  await flush();
}
async function startBatch() {
  await mount();
  const batch = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  batch.click();
  await flush();
  button("add-test-pairs").click();
  await flush();
  button("mongoCompare.run").click();
  await flush();
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.readOnly = false;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.cancelQuery.mockResolvedValue(true);
  mocks.mongoFindDocuments.mockImplementation(async (id, _db, _col, skip) => page(skip ? [] : [id === "source" ? sourceDoc : targetDoc]));
  mocks.mongoRunCommand.mockResolvedValue(page([{ ok: 1, n: 1 }]));
  mocks.mongoListCollections.mockResolvedValue([{ name: "items" }, { name: "archive" }]);
  mocks.mongoListIndexSpecs.mockResolvedValue([{ keys: [{ field: "key", direction: "1" }], is_unique: true, is_sparse: false, partial_filter_expression: null, properties_complete: true }]);
  mocks.guard.mockImplementation(async ({ execute }) => execute());
});
afterEach(() => {
  app?.unmount();
  document.body.textContent = "";
});

describe("Mongo Compare dialog", () => {
  it("runs a read-only batch, then refreshes and syncs only the opened mapped collection", async () => {
    await startBatch();
    expect(document.body.textContent).toContain("mongoCompare.batchResults");
    expect(document.body.textContent).toContain("items → archive");
    expect(document.querySelector('input[aria-label^="mongoCompare.select"]')).toBeNull();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    mocks.mongoFindDocuments.mockClear();
    button("mongoCompare.openPair").click();
    await flush();
    expect(mocks.mongoFindDocuments.mock.calls.some((call) => call[0] === "target" && call[2] === "archive")).toBe(true);
    document.querySelector<HTMLInputElement>('input[aria-label^="mongoCompare.select"]')!.click();
    await flush();
    button("mongoCompare.syncToTarget").click();
    await flush();
    expect(document.body.textContent).toContain('"update": "archive"');
    button("mongoCompare.confirmSync").click();
    await flush();
    const command = JSON.parse(mocks.mongoRunCommand.mock.calls[0][2]);
    expect(command.update).toBe("archive");
    expect(mocks.mongoListIndexSpecs).not.toHaveBeenCalled();
    const checks = mocks.mongoFindDocuments.mock.calls.filter((call) => call[5]?.includes("$expr"));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((call) => call[5].includes('"$key"'))).toBe(true);
    expect(document.body.textContent).toContain("mongoCompare.batchStates.stale");
  });

  it("shows a missing unique-index error before a mapped collection is written", async () => {
    mocks.mongoListIndexSpecs.mockResolvedValue([]);
    mocks.mongoFindDocuments.mockImplementation(async (id, _db, _col, skip) => page(skip || id === "target" ? [] : [sourceDoc]));
    await startBatch();
    button("mongoCompare.openPair").click();
    await flush();
    document.querySelector<HTMLInputElement>('input[aria-label^="mongoCompare.select"]')!.click();
    await flush();
    button("mongoCompare.syncToTarget").click();
    await flush();
    button("mongoCompare.confirmSync").click();
    await flush();
    expect(mocks.mongoListIndexSpecs).toHaveBeenCalledWith("target", "db", "archive");
    expect(document.body.textContent).toContain("mongoCompare.errors.uniqueIndexRequired");
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });

  it("exports only batch statistics, and changing options invalidates the summary", async () => {
    await startBatch();
    button("mongoCompare.exportSummary").click();
    await flush();
    const exported = JSON.parse(mocks.saveTextFile.mock.calls[0][0]);
    expect(exported.summaries).toHaveLength(2);
    expect(exported.summaries[0].counts.different).toBe(1);
    expect(exported.summaries[0].rows).toBeUndefined();
    const match = document.querySelector<HTMLInputElement>('input[placeholder="_id"]')!;
    match.value = "key";
    match.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(document.body.textContent).not.toContain("mongoCompare.batchResults");
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });

  it("rejects a disappeared collection before reads or deletes can be planned", async () => {
    mocks.mongoListCollections.mockResolvedValue([]);
    await mount();
    button("mongoCompare.run").click();
    await flush();
    expect(document.body.textContent).toContain("mongoCompare.errors.collectionMissing");
    expect(mocks.mongoFindDocuments).not.toHaveBeenCalled();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });

  it("cancels while connecting without letting the old run query after a new run", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.ensureConnected.mockReturnValueOnce(pending).mockReturnValueOnce(pending);
    await mount();
    button("mongoCompare.run").click();
    await flush();
    button("mongoCompare.cancel").click();
    await flush();
    button("mongoCompare.run").click();
    await flush();
    const reads = mocks.mongoFindDocuments.mock.calls.length;
    release();
    await flush();
    expect(mocks.mongoFindDocuments).toHaveBeenCalledTimes(reads);
    expect(document.body.textContent).toContain("mongoCompare.different");
  });

  it("requires a concrete review and confirmation before writing, then invalidates the results", async () => {
    await mount();
    await compareAndSelect();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    button("mongoCompare.syncToTarget").click();
    await flush();
    expect(document.body.textContent).toContain("mongoCompare.reviewTitle");
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    button("mongoCompare.confirmSync").click();
    await flush();
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("mongoCompare.stale");
    expect(button("mongoCompare.syncToTarget").disabled).toBe(true);
  });

  it("honors a declined production confirmation without reporting a completed sync", async () => {
    mocks.guard.mockResolvedValue(undefined);
    await mount();
    await compareAndSelect();
    button("mongoCompare.syncToTarget").click();
    await flush();
    button("mongoCompare.confirmSync").click();
    await flush();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("mongoCompare.syncComplete");
    expect(document.body.textContent).not.toContain("mongoCompare.stale");
  });

  it("blocks all sync actions for incomplete reads", async () => {
    await mount();
    const limit = document.querySelector<HTMLInputElement>('input[type="number"]')!;
    limit.value = "1";
    limit.dispatchEvent(new Event("input", { bubbles: true }));
    mocks.mongoFindDocuments.mockImplementation(async (id, _db, _col, skip) => page(skip ? [] : [id === "source" ? sourceDoc : targetDoc, { _id: 2 }]));
    await flush();
    button("mongoCompare.run").click();
    await flush();
    expect(document.body.textContent).toContain("mongoCompare.truncated");
    expect(button("mongoCompare.syncToTarget").disabled).toBe(true);
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });

  it("blocks both document and field writes on read-only connections", async () => {
    mocks.readOnly = true;
    await mount();
    await compareAndSelect();
    expect(button("mongoCompare.syncToTarget").disabled).toBe(true);
    expect(button("mongoCompare.syncToSource").disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="mongoCompare.syncTo"]')].every((item) => item.disabled)).toBe(true);
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("clears results when matching options change and safely exports errors", async () => {
    await mount();
    await compareAndSelect();
    mocks.saveTextFile.mockRejectedValue(new Error("Disk full"));
    button("CSV").click();
    await flush();
    expect(document.body.textContent).toContain("Disk full");
    const match = document.querySelector<HTMLInputElement>('input[placeholder="_id"]')!;
    match.value = "name";
    match.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(document.body.textContent).toContain("mongoCompare.empty");
    expect(button("mongoCompare.syncToTarget").disabled).toBe(true);
  });

  it("surfaces failure and forbids retry from a potentially stale result", async () => {
    await mount();
    await compareAndSelect();
    mocks.mongoRunCommand.mockRejectedValue(new Error("Connection lost"));
    button("mongoCompare.syncToTarget").click();
    await flush();
    button("mongoCompare.confirmSync").click();
    await flush();
    expect(document.body.textContent).toContain("mongoCompare.syncStopped");
    expect(document.body.textContent).toContain("Connection lost");
    expect(button("mongoCompare.syncToTarget").disabled).toBe(true);
  });
});
