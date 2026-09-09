import { strict as assert } from "node:assert";
import { test, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  prepareSchemaDiff: vi.fn(),
}));
const openMock = vi.hoisted(() => vi.fn());
const trackerMock = vi.hoisted(() => ({
  addSchemaDiffTask: vi.fn(),
  updateCompareTask: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/composables/useDialogSources", () => ({ openSchemaDiffSession: openMock }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => trackerMock }));
vi.mock("@/lib/schema/schemaDiffMetadataLoad", () => ({ loadSchemaDetails: vi.fn().mockResolvedValue([]) }));

const { startSchemaDiffSession } = await import("../useSchemaDiffSession.ts");

test("runs a schema diff session after the dialog is closed and retains the prepared result", async () => {
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const tableListLoader = {
    load: vi.fn().mockResolvedValue([]),
  };
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "app",
      sourceSchema: "public",
      targetConnectionId: "target",
      targetDatabase: "warehouse",
      targetSchema: "public",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: {},
      ignoreComments: false,
      label: "app → warehouse",
    },
    { tableListLoader },
  );

  for (let attempt = 0; attempt < 20 && session.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(session.status, "completed");
  assert.deepEqual(session.result?.diffs, []);
  assert.equal(tableListLoader.load.mock.calls.length, 2);
  assert.equal(tableListLoader.load.mock.calls[0]?.[1]?.refresh, true);
  assert.equal(trackerMock.addSchemaDiffTask.mock.calls.length, 1);
  assert.equal(trackerMock.updateCompareTask.mock.calls.at(-1)?.[1].status, "Done");

  const onOpen = trackerMock.addSchemaDiffTask.mock.calls[0]?.[2] as (() => void) | undefined;
  onOpen?.();
  assert.equal(openMock.mock.calls.at(-1)?.[0], session.id);
});
