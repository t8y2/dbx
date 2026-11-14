import { afterEach, describe, expect, it, vi } from "vitest";
import { installJdbcCompatibilityRuntimeFromFile } from "@/lib/backend/http";

afterEach(() => vi.unstubAllGlobals());

describe("JDBC compatibility upload", () => {
  it("uploads the id and local file, rather than sending a path to the server", async () => {
    const fetch = vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["fixture"], "compatibility.zip");
    await expect(installJdbcCompatibilityRuntimeFromFile("phoenix-5.0-hbase-2.0-compat", file)).resolves.toEqual([]);
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/jdbc/compatibility/install-file");
    const body = request.body as FormData;
    expect(body.get("id")).toBe("phoenix-5.0-hbase-2.0-compat");
    expect((body.get("file") as File).name).toBe("compatibility.zip");
  });

  it("rejects string paths without making a network request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(installJdbcCompatibilityRuntimeFromFile("phoenix-5.0-hbase-2.0-compat", "/private/file.zip")).rejects.toThrow("uploaded file");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates server verification failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Compatibility runtime checksum mismatch", { status: 400 })),
    );
    await expect(installJdbcCompatibilityRuntimeFromFile("phoenix-5.0-hbase-2.0-compat", new File(["bad"], "bad.zip"))).rejects.toThrow("checksum mismatch");
  });
});
