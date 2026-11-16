import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExportTracker } from "@/composables/useExportTracker";
import { hasActiveDictionaryExport, startDataDictionaryExport, type DictionaryExportRequest } from "@/lib/docs/dataDictionaryExportTask";
import * as api from "@/lib/backend/api";
import { renderDataDictionaryPdf } from "@/lib/docs/renderDataDictionaryPdf";
import { saveDataDictionaryFile } from "@/lib/docs/saveDataDictionaryFile";

vi.mock("@/lib/backend/api", () => ({
  collectDocsSnapshotForExport: vi.fn(),
  loadDocsAnnotations: vi.fn(),
  applyDocsAnnotations: vi.fn(),
}));
vi.mock("@/lib/docs/renderDataDictionaryPdf", () => ({ renderDataDictionaryPdf: vi.fn() }));
vi.mock("@/lib/docs/saveDataDictionaryFile", () => ({ saveDataDictionaryFile: vi.fn() }));

const tracker = useExportTracker();
const snapshot = (database: string, names: string[], warnings: unknown[] = []) => ({
  project: { database },
  tables: names.map((name) => ({ name, schema: null, kind: "TABLE" })),
  warnings,
});

function request(databases = ["shop"], names = ["a"]): DictionaryExportRequest {
  return {
    connectionId: "connection",
    databases,
    schemas: [],
    objects: databases.flatMap((database) => names.map((name) => ({ database, schema: "", name, kind: "TABLE" as const }))),
    layout: {} as DictionaryExportRequest["layout"],
    labels: {} as DictionaryExportRequest["labels"],
    outputPath: "/tmp/dictionary.pdf",
    overwrite: true,
    continueOnError: true,
    warningText: (warning) => (warning.kind === "tableSkipped" ? (warning.reason ?? "skipped") : "warning"),
    skippedDatabase: (database, reason) => `${database}: ${reason}`,
    missingObject: (object) => `${object.database}.${object.name}: unavailable`,
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(api.collectDocsSnapshotForExport).mockReset();
  vi.mocked(api.loadDocsAnnotations).mockResolvedValue(null);
  vi.mocked(api.applyDocsAnnotations).mockImplementation(async (_id, raw) => raw);
  vi.mocked(renderDataDictionaryPdf).mockReset();
  vi.mocked(renderDataDictionaryPdf).mockResolvedValue(new Uint8Array([1, 2]));
  vi.mocked(saveDataDictionaryFile).mockReset();
  vi.mocked(saveDataDictionaryFile).mockResolvedValue("/tmp/dictionary.pdf");
});

afterEach(async () => {
  await vi.waitFor(() => expect(hasActiveDictionaryExport("connection")).toBe(false));
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
});

describe("background dictionary export", () => {
  it("survives its caller, tracks completed objects over multiple databases and finishes only after the file is written", async () => {
    let resolveSave!: (path: string) => void;
    vi.mocked(saveDataDictionaryFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    vi.mocked(api.collectDocsSnapshotForExport).mockImplementation(async (_id, database, _schemas, _names, progress) => {
      progress({ completed: 0, total: 2, current: "" });
      progress({ completed: 1, total: 2, current: "a" });
      progress({ completed: 2, total: 2, current: "b" });
      return snapshot(database, ["a", "b"]) as never;
    });
    const input = request(["shop", "archive"], ["a", "b"]);
    expect(startDataDictionaryExport(input)).toBe(true);
    expect(startDataDictionaryExport(input)).toBe(false);
    await vi.waitFor(() => expect(saveDataDictionaryFile).toHaveBeenCalledOnce());
    const task = tracker.tasks.value[0]!;
    expect(task.dictionaryCompleted).toBe(4);
    expect(task.dictionaryTotal).toBe(4);
    expect(task.status).toBe("Writing");
    expect(task.filePath).toBe("");
    expect(input.onSuccess).not.toHaveBeenCalled();
    resolveSave("/tmp/dictionary.pdf");
    await vi.waitFor(() => expect(task.status).toBe("Done"));
    expect(task.filePath).toBe("/tmp/dictionary.pdf");
    expect(input.onSuccess).toHaveBeenCalledWith("/tmp/dictionary.pdf", 0);
    expect(hasActiveDictionaryExport("connection")).toBe(false);
  });

  it("reports save failures, frees the connection slot and permits a retry", async () => {
    vi.mocked(api.collectDocsSnapshotForExport).mockResolvedValue(snapshot("shop", ["a"]) as never);
    vi.mocked(saveDataDictionaryFile).mockRejectedValueOnce(new Error("disk full"));
    const input = request();
    startDataDictionaryExport(input);
    await vi.waitFor(() => expect(tracker.tasks.value[0]?.status).toBe("Error"));
    expect(tracker.tasks.value[0]?.errorMessage).toBe("disk full");
    expect(input.onSuccess).not.toHaveBeenCalled();
    expect(input.onFailure).toHaveBeenCalledOnce();
    expect(startDataDictionaryExport(request())).toBe(true);
    await vi.waitFor(() => expect(tracker.tasks.value[1]?.status).toBe("Done"));
  });

  it("preserves skipped-object warnings only when continue-on-error is enabled", async () => {
    vi.mocked(api.collectDocsSnapshotForExport).mockResolvedValue(snapshot("shop", ["a"], [{ kind: "tableSkipped", table: ".b", reason: "denied" }]) as never);
    const input = request(["shop"], ["a", "b"]);
    startDataDictionaryExport(input);
    await vi.waitFor(() => expect(tracker.tasks.value[0]?.status).toBe("Done"));
    expect(tracker.tasks.value[0]?.dictionaryWarnings).toBe(1);
    expect(renderDataDictionaryPdf).toHaveBeenCalledWith(expect.any(Array), expect.anything(), expect.anything(), ["denied"]);
    const strict = request(["shop"], ["a", "b"]);
    strict.continueOnError = false;
    startDataDictionaryExport(strict);
    await vi.waitFor(() => expect(tracker.tasks.value[1]?.status).toBe("Error"));
    expect(saveDataDictionaryFile).toHaveBeenCalledTimes(1);
  });

  it("does not silently export a partial PDF when a selected object disappears", async () => {
    vi.mocked(api.collectDocsSnapshotForExport).mockResolvedValue(snapshot("shop", ["a"]) as never);
    const input = request(["shop"], ["a", "b"]);
    startDataDictionaryExport(input);
    await vi.waitFor(() => expect(tracker.tasks.value[0]?.status).toBe("Done"));
    expect(renderDataDictionaryPdf).toHaveBeenCalledWith(expect.any(Array), expect.anything(), expect.anything(), ["shop.b: unavailable"]);
    expect(tracker.tasks.value[0]?.dictionaryWarnings).toBe(1);

    const strict = request(["shop"], ["a", "b"]);
    strict.continueOnError = false;
    startDataDictionaryExport(strict);
    await vi.waitFor(() => expect(tracker.tasks.value[1]?.status).toBe("Error"));
    expect(tracker.tasks.value[1]?.errorMessage).toContain("shop.b: unavailable");
    expect(saveDataDictionaryFile).toHaveBeenCalledTimes(1);
  });

  it("ignores stale and out-of-order progress callbacks", async () => {
    let firstProgress!: Parameters<typeof api.collectDocsSnapshotForExport>[4];
    vi.mocked(api.collectDocsSnapshotForExport).mockImplementation(async (_id, database, _schemas, _names, progress) => {
      if (database === "shop") {
        firstProgress = progress;
        progress({ completed: 2, total: 2, current: "b" });
        progress({ completed: 1, total: 2, current: "a" });
      } else {
        firstProgress({ completed: 0, total: 2, current: "old" });
        progress({ completed: 1, total: 2, current: "new" });
      }
      return snapshot(database, ["a", "b"]) as never;
    });
    let resolveRender!: (bytes: Uint8Array) => void;
    vi.mocked(renderDataDictionaryPdf).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
    );
    startDataDictionaryExport(request(["shop", "archive"], ["a", "b"]));
    await vi.waitFor(() => expect(renderDataDictionaryPdf).toHaveBeenCalled());
    expect(tracker.tasks.value[0]?.dictionaryCompleted).toBe(4);
    expect(tracker.tasks.value[0]?.dictionaryCurrent).toBe("");
    resolveRender(new Uint8Array([1]));
    await vi.waitFor(() => expect(tracker.tasks.value[0]?.status).toBe("Done"));
  });
});
