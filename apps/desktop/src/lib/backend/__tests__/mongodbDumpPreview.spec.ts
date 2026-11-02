import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMongodbRestoreSource, restoreMongodbDatabase } from "../http";

function file(name: string, size = 0) {
  const value = new File([], name);
  Object.defineProperty(value, "webkitRelativePath", { value: `dump/source/${name}` });
  Object.defineProperty(value, "size", { value: size });
  return value;
}

afterEach(() => vi.unstubAllGlobals());

describe("MongoDB metadata-first transport", () => {
  it("previews a multi-gigabyte directory without uploading any BSON bodies", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sourceRef: "catalog", databases: ["source"], collections: [] })));
    vi.stubGlobal("fetch", fetch);
    const data = file("large.bson.gz", 5 * 1024 ** 3);
    const metadata = file("large.metadata.json.gz", 200);
    await prepareMongodbRestoreSource([data, metadata], "directory", true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const form = fetch.mock.calls[0]![1].body as FormData;
    expect(form.get("format")).toBe("directory");
    expect(form.get("gzip")).toBe("true");
    expect(JSON.parse(form.get("manifest") as string)).toEqual([
      { path: "dump/source/large.bson.gz", sizeBytes: 5 * 1024 ** 3 },
      { path: "dump/source/large.metadata.json.gz", sizeBytes: 200 },
    ]);
    expect(form.getAll("file")).toHaveLength(1);
    expect((form.get("file") as File).name).toBe("dump/source/large.metadata.json.gz");
  });

  it("checks the effective server limit before the confirmed data upload", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(1024 ** 3)));
    vi.stubGlobal("fetch", fetch);
    const request = { taskId: "task", connectionId: "conn", database: "target", sourceDatabase: "source", sourceRef: "catalog", dropExisting: true, restoreOptions: true, restoreIndexes: true, stopOnError: true, batchSize: 500 };
    await expect(restoreMongodbDatabase(request, vi.fn(), { files: [file("large.bson", 5 * 1024 ** 3)], gzip: false })).rejects.toThrow("exceeds");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("/upload-limit");
  });

  it("passes cancellation to catalog upload without a separate restore request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetch);
    controller.abort();
    await expect(prepareMongodbRestoreSource([file("a.bson")], "directory", false, { signal: controller.signal })).rejects.toThrow("Aborted");
    expect(fetch.mock.calls[0]![1].signal).toBe(controller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
