// @vitest-environment happy-dom
// Authored regression tests. Vitest execution requires a host permitting its child processes.
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MongoAggregationDialog from "../MongoAggregationDialog.vue";

const mocks = vi.hoisted(() => ({
  mongoAggregateDocuments: vi.fn(),
  mongoRunCommand: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  guard: vi.fn(),
  saveTextFile: vi.fn(),
  readOnly: false,
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ connectionIsEffectivelyReadOnly: () => mocks.readOnly }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: mocks.saveTextFile }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: (id: string) => ({ id, db_type: "mongodb", name: id }), ensureConnected: mocks.ensureConnected }),
}));
vi.mock("@/components/diff/MongoCompareEndpointSelect.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: ["label", "modelValue", "disabled"], setup: (props) => () => h("div", props.label) }) };
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
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const container = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Select: container, SelectContent: container, SelectItem: container, SelectTrigger: container, SelectValue: container };
});

let app: App | undefined;
let visible: Ref<boolean>;
const page = (documents: object[]) => ({ documents, extended_documents: documents });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 40; index++) {
    await nextTick();
    await Promise.resolve();
  }
}
function button(key: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === key);
  if (!value) throw new Error("Missing button: " + key);
  return value;
}
function hasButton(key: string) {
  return [...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === key);
}
async function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  visible = ref(true);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(MongoAggregationDialog, {
          open: visible.value,
          "onUpdate:open": (value: boolean) => {
            visible.value = value;
          },
          prefillConnectionId: "connection",
          prefillDatabase: "source_db",
          prefillCollection: "items",
        }),
    }),
  );
  app.mount(root);
  await flush();
}
async function importPipeline(pipeline: object[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const text = JSON.stringify(pipeline);
  Object.defineProperty(input, "files", { configurable: true, value: [{ name: "pipeline.json", size: text.length, text: async () => text }] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}
async function prepare(pipeline: object[] = [{ $match: { active: true } }, { $out: "archive" }]) {
  await mount();
  await importPipeline(pipeline);
  button("mongoAggregation.run").click();
  await flush();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readOnly = false;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.cancelQuery.mockResolvedValue(true);
  mocks.mongoAggregateDocuments.mockResolvedValue(page([{ _id: { $numberLong: "9007199254740993" }, name: "preview-row" }]));
  mocks.mongoRunCommand.mockResolvedValue(page([{ ok: 1 }]));
  mocks.guard.mockImplementation(async ({ execute }) => execute());
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.textContent = "";
});

describe("aggregation preview and manual output safety", () => {
  it.each(["$out", "$merge"])("strips %s from preview without preparing or executing writes", async (operator) => {
    await mount();
    const output = operator === "$out" ? "archive" : { into: "archive", whenMatched: "merge", whenNotMatched: "insert" };
    await importPipeline([{ $match: { active: true } }, { [operator]: output }]);
    button("mongoAggregation.previewRun").click();
    await flush();
    expect(mocks.mongoAggregateDocuments).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.mongoAggregateDocuments.mock.calls[0][3])).toEqual([{ $match: { active: true } }]);
    expect(mocks.mongoAggregateDocuments.mock.calls[0].slice(0, 3)).toEqual(["connection", "source_db", "items"]);
    expect(document.body.textContent).toContain("9007199254740993");
    expect(hasButton("mongoAggregation.confirm")).toBe(false);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("prepares the complete exact output command and writes only after explicit confirmation", async () => {
    await prepare();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("mongoAggregation.review");
    expect(document.body.textContent).toContain('"$out": "archive"');
    expect(button("mongoAggregation.run").disabled).toBe(true);
    button("mongoAggregation.confirm").click();
    await flush();
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(mocks.guard.mock.calls[0][0].database).toBe("source_db");
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
    const [connection, database, text] = mocks.mongoRunCommand.mock.calls[0];
    expect([connection, database]).toEqual(["connection", "source_db"]);
    expect(JSON.parse(text)).toEqual({ aggregate: "items", pipeline: [{ $match: { active: true } }, { $out: "archive" }], cursor: {}, maxTimeMS: 60000 });
    expect(mocks.guard.mock.calls[0][0].reviewText).toBe(text);
    expect(document.body.textContent).toContain("mongoAggregation.applied");
    expect(hasButton("mongoAggregation.confirm")).toBe(false);
  });
  it("guards both source and destination databases for a cross-database output", async () => {
    await prepare([{ $match: {} }, { $out: { db: "production_target", coll: "archive" } }]);
    button("mongoAggregation.confirm").click();
    await flush();
    expect(mocks.guard.mock.calls.map((call) => call[0].database)).toEqual(["source_db", "production_target"]);
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
    expect(mocks.guard.mock.calls[0][0].reviewText).toBe(mocks.guard.mock.calls[1][0].reviewText);
    expect(mocks.mongoRunCommand.mock.calls[0][1]).toBe("source_db");
  });
  it("does not write or report success when the destination production guard declines", async () => {
    mocks.guard.mockImplementation(async ({ database, execute }) => (database === "production_target" ? undefined : execute()));
    await prepare([{ $merge: { into: { db: "production_target", coll: "archive" } } }]);
    button("mongoAggregation.confirm").click();
    await flush();
    expect(mocks.guard).toHaveBeenCalledTimes(2);
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("mongoAggregation.applied");
  });
  it("permits read-only previews but blocks output preparation on a read-only connection", async () => {
    mocks.readOnly = true;
    await mount();
    await importPipeline([{ $out: "archive" }]);
    button("mongoAggregation.previewRun").click();
    await flush();
    expect(mocks.mongoAggregateDocuments).toHaveBeenCalledOnce();
    button("mongoAggregation.run").click();
    await flush();
    expect(document.body.textContent).toContain("mongoAggregation.outputReadOnly");
    expect(mocks.mongoAggregateDocuments).toHaveBeenCalledOnce();
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(hasButton("mongoAggregation.confirm")).toBe(false);
  });
  it("rechecks read-only state after a pending production approval", async () => {
    const approval = deferred<boolean>();
    mocks.guard.mockImplementation(async ({ execute }) => {
      await approval.promise;
      return execute();
    });
    await prepare();
    button("mongoAggregation.confirm").click();
    await flush();
    mocks.readOnly = true;
    approval.resolve(true);
    await flush();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("mongoAggregation.outputReadOnly");
    expect(document.body.textContent).not.toContain("mongoAggregation.applied");
  });
  it("cancels a connecting request and never dispatches the stale aggregate", async () => {
    const connect = deferred<void>();
    mocks.ensureConnected.mockReturnValueOnce(connect.promise);
    await mount();
    button("mongoAggregation.previewRun").click();
    await flush();
    button("common.cancel").click();
    await flush();
    button("mongoAggregation.previewRun").click();
    await flush();
    expect(mocks.mongoAggregateDocuments).toHaveBeenCalledOnce();
    connect.resolve(undefined);
    await flush();
    expect(mocks.mongoAggregateDocuments).toHaveBeenCalledOnce();
    expect(mocks.cancelQuery).toHaveBeenCalled();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("does not refill a cancelled result or output review after a newer request completes", async () => {
    const old = deferred<ReturnType<typeof page>>();
    mocks.mongoAggregateDocuments.mockReturnValueOnce(old.promise);
    await mount();
    await importPipeline([{ $out: "archive" }]);
    button("mongoAggregation.run").click();
    await flush();
    button("common.cancel").click();
    await flush();
    mocks.mongoAggregateDocuments.mockResolvedValueOnce(page([{ name: "latest-only" }]));
    button("mongoAggregation.previewRun").click();
    await flush();
    old.resolve(page([{ name: "stale-must-not-appear" }]));
    await flush();
    expect(document.body.textContent).toContain("latest-only");
    expect(document.body.textContent).not.toContain("stale-must-not-appear");
    expect(hasButton("mongoAggregation.confirm")).toBe(false);
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("closing the dialog abandons a pending review request", async () => {
    const old = deferred<ReturnType<typeof page>>();
    mocks.mongoAggregateDocuments.mockReturnValueOnce(old.promise);
    await mount();
    await importPipeline([{ $out: "archive" }]);
    button("mongoAggregation.run").click();
    await flush();
    visible.value = false;
    await flush();
    old.resolve(page([{ name: "closed-stale-row" }]));
    await flush();
    expect(hasButton("mongoAggregation.confirm")).toBe(false);
    expect(mocks.cancelQuery).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("closed-stale-row");
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("invalidates the review on command failure and never reports it as applied", async () => {
    mocks.mongoRunCommand.mockResolvedValue(page([{ ok: 1, writeConcernError: { message: "uncertain acknowledgement" } }]));
    await prepare();
    button("mongoAggregation.confirm").click();
    await flush();
    expect(document.body.textContent).toContain("mongoAggregation.writeUncertain");
    expect(document.body.textContent).not.toContain("mongoAggregation.applied");
    expect(hasButton("mongoAggregation.confirm")).toBe(false);
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
  });
});
