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

    const pending = startTransfer(request(), onProgress, onStarted);
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));

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
