// @vitest-environment happy-dom
// Mocked bridge/UI regression; real browser CSP is a separate acceptance gate.
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MongoScriptDialog from "../MongoScriptDialog.vue";

const mocks = vi.hoisted(() => ({
  mongoAggregateDocuments: vi.fn(),
  mongoRunCommand: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  guard: vi.fn(),
  sandbox: vi.fn(),
  readOnly: false,
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ connectionIsEffectivelyReadOnly: () => mocks.readOnly }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/lib/mongo/mongoScriptSandbox", () => ({ runMongoScriptSandbox: (...args: unknown[]) => mocks.sandbox(...args) }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: (id: string) => ({ id, db_type: "mongodb", name: id }), ensureConnected: mocks.ensureConnected }),
}));
vi.mock("@/components/diff/MongoCompareEndpointSelect.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
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

let app: App | undefined;
let controller: AbortController;
let bridge: { request: (request: unknown, signal: AbortSignal) => Promise<unknown> };
let complete: () => void;
let stop: (error: Error) => void;
let nextId = 0;
const page = (documents: object[]) => ({ documents, extended_documents: documents });
async function flush() {
  for (let index = 0; index < 30; index++) {
    await nextTick();
    await Promise.resolve();
  }
}
function button(key: string): HTMLButtonElement {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === key);
  if (!value) throw new Error("Missing button: " + key);
  return value;
}
async function start() {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(MongoScriptDialog, { open: true, prefillConnectionId: "connection", prefillDatabase: "source_db", prefillCollection: "items" }) }));
  app.mount(root);
  await flush();
  button("mongoScript.run").click();
  await flush();
}
const request = (method: string, args: unknown[]) => bridge.request({ id: ++nextId, collection: "items", method, args }, controller.signal);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readOnly = false;
  nextId = 0;
  controller = new AbortController();
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.cancelQuery.mockResolvedValue(true);
  mocks.mongoAggregateDocuments.mockResolvedValue(page([{ n: { $numberLong: "9223372036854775807" } }]));
  mocks.mongoRunCommand.mockResolvedValue({ documents: [{ ok: 1, n: 1 }], extended_documents: [{ ok: { $numberDouble: "1.0" }, n: { $numberInt: "1" } }] });
  mocks.guard.mockImplementation(async ({ execute }) => execute());
  mocks.sandbox.mockImplementation((_source, options) => {
    bridge = options;
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve;
      stop = reject;
    });
    return {
      completion,
      cancel: () => {
        controller.abort();
        stop(new Error("Cancelled"));
      },
    };
  });
});
afterEach(async () => {
  complete?.();
  await flush();
  app?.unmount();
  app = undefined;
  document.body.textContent = "";
});

describe("script workspace bridge and write review", () => {
  it("routes find through strict aggregation and returns canonical BSON", async () => {
    await start();
    const result = await request("find", [{ _id: "507f1f77bcf86cd799439011", text: "ISODate(2020)" }, { n: 1 }, { limit: 2, skip: 1, sort: { n: -1 } }]);
    expect(result).toEqual([{ n: { $numberLong: "9223372036854775807" } }]);
    expect(JSON.parse(mocks.mongoAggregateDocuments.mock.calls[0][3])).toEqual([{ $match: { _id: "507f1f77bcf86cd799439011", text: "ISODate(2020)" } }, { $sort: { n: -1 } }, { $skip: 1 }, { $limit: 2 }, { $project: { n: 1 } }]);
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("never falls back to lossy display JSON", async () => {
    mocks.mongoAggregateDocuments.mockResolvedValue({ documents: [{ n: 1 }] });
    await start();
    await expect(request("find", [{}])).rejects.toThrow("bsonUnavailable");
  });
  it("reviews every write and returns the canonical command response only after confirmation", async () => {
    await start();
    const result = request("insertOne", [{ amount: { $numberLong: "9223372036854775807" } }]);
    await flush();
    expect(document.body.textContent).toContain("9223372036854775807");
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(mocks.guard).not.toHaveBeenCalled();
    button("mongoAggregation.confirm").click();
    expect(await result).toEqual({ ok: { $numberDouble: "1.0" }, n: { $numberInt: "1" } });
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
    const second = request("deleteOne", [{ _id: 1 }]);
    await flush();
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
    controller.abort();
    await expect(second).rejects.toThrow("Write cancelled");
    expect(mocks.mongoRunCommand).toHaveBeenCalledOnce();
  });
  it("guards both source and target for aggregation output and respects a declined target guard", async () => {
    mocks.guard.mockImplementation(async ({ database, execute }) => (database === "production_target" ? undefined : execute()));
    await start();
    const result = request("aggregate", [[{ $out: { db: "production_target", coll: "archive" } }]]);
    await flush();
    button("mongoAggregation.confirm").click();
    await expect(result).rejects.toThrow("Write cancelled");
    expect(mocks.guard.mock.calls.map((call) => call[0].database)).toEqual(["source_db", "production_target"]);
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("blocks read-only writes before review and rechecks after waiting on production confirmation", async () => {
    await start();
    mocks.readOnly = true;
    await expect(request("insertOne", [{ x: 1 }])).rejects.toThrow("mongoAggregation.outputReadOnly");
    expect(mocks.guard).not.toHaveBeenCalled();
    mocks.readOnly = false;
    mocks.guard.mockImplementation(async ({ execute }) => {
      mocks.readOnly = true;
      return execute();
    });
    const result = request("insertOne", [{ x: 1 }]);
    await flush();
    button("mongoAggregation.confirm").click();
    await expect(result).rejects.toThrow("mongoAggregation.outputReadOnly");
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
  });
  it("rejects backend write-concern failures instead of reporting a successful write", async () => {
    mocks.mongoRunCommand.mockResolvedValue(page([{ ok: 1, writeConcernError: { errmsg: "uncertain" } }]));
    await start();
    const result = request("insertOne", [{ x: 1 }]);
    await flush();
    button("mongoAggregation.confirm").click();
    await expect(result).rejects.toThrow("uncertain");
  });
  it("cancellation rejects a pending review without dispatching any write", async () => {
    await start();
    const result = request("insertOne", [{ x: 1 }]);
    await flush();
    // Last Cancel is the run-level stop; the other Cancel declines only this write.
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter((item) => item.textContent?.trim() === "common.cancel")
      .at(-1)!
      .click();
    await expect(result).rejects.toThrow("Write cancelled");
    await flush();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(document.body.textContent).toContain("mongoScript.cancelled");
  });
});
