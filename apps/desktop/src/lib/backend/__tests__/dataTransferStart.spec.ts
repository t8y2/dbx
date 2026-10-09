import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransferProgress, TransferRequest } from "@/lib/backend/http";
import { startTransfer } from "@/lib/backend/http";

function request(): TransferRequest {
  return {
    transferId: "transfer-1",
    sourceConnectionId: "source",
    sourceDatabase: "app",
    sourceSchema: "public",
    targetConnectionId: "target",
    targetDatabase: "warehouse",
    targetSchema: "reporting",
    tables: ["orders", "users"],
    createTable: true,
    content: "structureAndData",
    objects: [],
    mode: "append",
    targetTableNameCase: "preserve",
    quoteTargetColumnNames: true,
    ownershipPolicy: "preserve",
    batchSize: 1000,
    dropTargetBeforeCreate: false,
    dropTargetConfirmed: false,
  };
}

function doneProgress(): TransferProgress {
  return {
    transferId: "transfer-1",
    table: "users",
    tableIndex: 2,
    totalTables: 2,
    rowsTransferred: 3,
    totalRows: 3,
    status: "done",
    error: null,
    terminal: true,
  };
}

describe("web data-transfer submission", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends one-run credentials outside the public request and clears them on rejection", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, text: vi.fn().mockResolvedValue('{"message":"DBLink creation failed"}') });
    vi.stubGlobal("fetch", fetch);
    const credentials = [{ objectType: "DB_LINK" as const, name: "L", password: "one-run-secret" }];
    await expect(startTransfer(request(), vi.fn(), undefined, credentials)).rejects.toThrow();
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.databaseLinkCredentials).toEqual([{ objectType: "DB_LINK", name: "L", password: "one-run-secret" }]);
    expect(JSON.stringify(body.request)).not.toContain("one-run-secret");
    expect(credentials[0]!.password).toBe("");
  });

  it("clears one-run credentials when the start transport fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const credentials = [{ objectType: "DB_LINK" as const, name: "L", password: "one-run-secret" }];
    await expect(startTransfer(request(), vi.fn(), undefined, credentials)).rejects.toThrow("network unavailable");
    expect(credentials[0]!.password).toBe("");
  });

  it("acknowledges an accepted task once before tracking its progress", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    let source: FakeEventSource | undefined;
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(readonly url: string) {
        source = this;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onStarted = vi.fn();
    const onProgress = vi.fn();

    const credentials = [{ objectType: "DB_LINK" as const, name: "L", password: "one-run-secret" }];
    const pending = startTransfer(request(), onProgress, onStarted, credentials);
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(credentials[0]!.password).toBe("");

    expect(source?.url).toBe("/api/transfer/progress/transfer-1");
    source?.onmessage?.({ data: JSON.stringify(doneProgress()) });
    await expect(pending).resolves.toBeUndefined();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(doneProgress());
  });

  it("suppresses acknowledgement when task creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        text: vi.fn().mockResolvedValue('{"message":"rejected"}'),
      }),
    );
    const onStarted = vi.fn();

    await expect(startTransfer(request(), vi.fn(), onStarted)).rejects.toThrow();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
