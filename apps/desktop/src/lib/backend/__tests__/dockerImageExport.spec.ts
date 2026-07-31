import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerStartImageExport } from "@/lib/backend/http";

describe("Web Docker image export", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects before requesting an archive when streaming persistence is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("showSaveFilePicker", undefined);

    await expect(dockerStartImageExport("connection-1", "image-1", "image.tar", undefined, vi.fn())).rejects.toThrow("Streaming image export requires File System Access API support");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the writable file when the export response fails", async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ abort });
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockResolvedValue({ createWritable }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("export denied", { status: 403 })));

    await expect(dockerStartImageExport("connection-1", "image-1", "image.tar", undefined, vi.fn())).rejects.toThrow("export denied");
    expect(createWritable).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });
});
