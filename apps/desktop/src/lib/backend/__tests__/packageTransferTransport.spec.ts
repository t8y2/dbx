import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferContent, TransferProgress, TransferRequest, OraclePackageTransferRequest } from "@/lib/backend/tauri";

function reviewedPackage(): OraclePackageTransferRequest {
  const source = { connectionId: "source", database: "tenant", schema: "Source.With.Dot", databaseType: "oracle" as const, generation: 1 };
  const target = { ...source, connectionId: "target", schema: "Target.With.Dot", databaseType: "oceanbase-oracle" as const };
  return {
    input: {
      source: { endpoint: source, state: "complete", enumerationComplete: true, objects: [], issues: [] },
      target: { endpoint: target, state: "complete", enumerationComplete: true, objects: [], issues: [] },
      drafts: [{ identity: { owner: target.schema, name: 'Pkg.With.Dot,"中文😀', kind: "PACKAGE_BODY" }, action: "create", sql: 'CREATE PACKAGE BODY "Target.With.Dot"."Pkg.With.Dot,""中文😀" AS END;', packageContract: "target", confirmPackagePair: false }],
    },
    operationIds: ["original-approved-body-id"],
  };
}

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

describe.each(["http", "tauri"] as const)("package transfer %s transport", (transport) => {
  let backend: typeof import("@/lib/backend/http");
  let deliver: (progress: TransferProgress) => void;
  const fetchMock = vi.fn();
  const unlisten = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    native.invoke.mockResolvedValue(undefined);
    native.listen.mockImplementation(async (_event: string, handler: (event: { payload: TransferProgress }) => void) => {
      deliver = (progress) => handler({ payload: progress });
      return unlisten;
    });
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    class Stream {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      close = unlisten;
      constructor() {
        deliver = (progress) => this.onmessage?.({ data: JSON.stringify(progress) });
      }
    }
    vi.stubGlobal("EventSource", Stream);
    backend = await import(transport === "http" ? "@/lib/backend/http" : "@/lib/backend/tauri");
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["structureOnly", "structureAndData", "dataOnly"] satisfies TransferContent[])("retains explicit spec/body identity in %s without broadening BODY-only", async (content) => {
    const request: TransferRequest = {
      transferId: "package-transfer",
      sourceConnectionId: "source",
      sourceDatabase: "tenant",
      sourceSchema: "Source.With.Dot",
      targetConnectionId: "target",
      targetDatabase: "tenant",
      targetSchema: "Target.With.Dot",
      tables: content === "structureAndData" ? ["orders"] : [],
      createTable: content !== "dataOnly",
      content,
      objects: [{ objectType: "PACKAGE_BODY", names: ['Pkg.With.Dot,"中文😀'] }],
      mode: "append",
      targetTableNameCase: "preserve",
      quoteTargetColumnNames: true,
      batchSize: 100,
      dropTargetBeforeCreate: false,
      dropTargetConfirmed: false,
      oraclePackages: reviewedPackage(),
    };
    const progress = vi.fn();
    const started = vi.fn();
    const pending = backend.startTransfer(request, progress, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const sent = transport === "http" ? JSON.parse(String(fetchMock.mock.calls[0][1].body)) : native.invoke.mock.calls[0][1];
    expect(sent.request).toEqual(request);
    expect(sent.request.objects).toEqual([{ objectType: "PACKAGE_BODY", names: ['Pkg.With.Dot,"中文😀'] }]);
    expect(sent.request.oraclePackages).toEqual(reviewedPackage());
    const input = request.oraclePackages!.input!;
    const identity = input.drafts[0].identity;
    const operation: TransferProgress = {
      transferId: request.transferId,
      table: `PackageBody:${identity.name}`,
      tableIndex: 0,
      totalTables: request.tables.length,
      rowsTransferred: 0,
      totalRows: null,
      status: "error",
      terminal: false,
      error: "Package body is INVALID",
      oracleRoutineOperation: {
        operationId: "original-approved-body-id",
        target: input.target.endpoint,
        identity,
        lifecycle: "terminal",
        dispatched: true,
        acknowledged: true,
        error: null,
        readback: { identity, state: "invalid", exists: true, version: null, source: input.drafts[0].sql!, definitionMatches: true, issues: [], compilerMessages: [{ attribute: "ERROR", line: 2, position: 3, text: "PLS-00323 中文😀" }] },
      },
    };
    deliver(operation);
    expect(progress).toHaveBeenCalledWith(operation);
    expect(unlisten).not.toHaveBeenCalled();
    const terminal: TransferProgress = { transferId: request.transferId, table: "", tableIndex: request.tables.length, totalTables: request.tables.length, rowsTransferred: 0, totalRows: null, status: "done", terminal: true, error: null };
    deliver(terminal);
    await expect(pending).resolves.toBeUndefined();
    expect(progress).toHaveBeenCalledWith(terminal);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("preserves frozen pending-table evidence and the ordered nonterminal approval event", async () => {
    const packages = reviewedPackage();
    packages.operationIds = [];
    packages.pendingTables = {
      source: packages.input!.source.endpoint,
      target: packages.input!.target.endpoint,
      tables: [{ sourceTable: "SOURCE", finalDdl: 'CREATE TABLE "Target.With.Dot".FINAL("中文😀" VARCHAR2(20 CHAR))' }],
      dependencyManifest: { proofGroups: [{ use: "external-source", source: "完整原文 中文😀" }] },
      tableEvidence: [{ sourceTable: "SOURCE", targetTable: "FINAL", namespaceRows: [] }],
    };
    const request: TransferRequest = {
      transferId: "pending-tables",
      sourceConnectionId: "source",
      sourceDatabase: "tenant",
      sourceSchema: "Source.With.Dot",
      targetConnectionId: "target",
      targetDatabase: "tenant",
      targetSchema: "Target.With.Dot",
      tables: ["SOURCE"],
      createTable: true,
      content: "structureAndData",
      objects: [{ objectType: "PACKAGE_BODY", names: [packages.input!.drafts[0].identity.name] }],
      mode: "append",
      targetTableNameCase: "preserve",
      quoteTargetColumnNames: true,
      batchSize: 100,
      dropTargetBeforeCreate: false,
      dropTargetConfirmed: false,
      oraclePackages: packages,
    };
    const progress = vi.fn();
    const started = vi.fn();
    const pending = backend.startTransfer(request, progress, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const sent = transport === "http" ? JSON.parse(String(fetchMock.mock.calls[0][1].body)) : native.invoke.mock.calls[0][1];
    expect(sent.request.oraclePackages).toEqual(packages);
    const approval: TransferProgress = {
      transferId: request.transferId,
      table: "package objects",
      tableIndex: 1,
      totalTables: 1,
      rowsTransferred: 0,
      totalRows: null,
      status: "running",
      terminal: false,
      error: null,
      oraclePackageApproval: { input: packages.input!, skipped: [], plan: { target: packages.input!.target.endpoint, ready: true, steps: [] } },
    };
    deliver(approval);
    expect(progress).toHaveBeenNthCalledWith(1, approval);
    expect(unlisten).not.toHaveBeenCalled();
    deliver({ ...approval, oraclePackageApproval: undefined, status: "done", terminal: true });
    await expect(pending).resolves.toBeUndefined();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("returns structured preflight issues and full drafts without any dispatched operation", async () => {
    const request: TransferRequest = {
      transferId: "blocked-package-transfer",
      sourceConnectionId: "source",
      sourceDatabase: "tenant",
      sourceSchema: "Source.With.Dot",
      targetConnectionId: "target",
      targetDatabase: "tenant",
      targetSchema: "Target.With.Dot",
      tables: ["not_written"],
      createTable: true,
      content: "structureAndData",
      mode: "append",
      targetTableNameCase: "preserve",
      quoteTargetColumnNames: true,
      batchSize: 100,
      dropTargetBeforeCreate: false,
      dropTargetConfirmed: false,
      objects: [{ objectType: "PACKAGE_BODY", names: ['Pkg.With.Dot,"中文😀'] }],
    };
    const progress = vi.fn();
    const started = vi.fn();
    const pending = backend.startTransfer(request, progress, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const input = reviewedPackage().input!;
    const identity = input.drafts[0].identity;
    const terminal: TransferProgress = {
      transferId: request.transferId,
      table: "schema objects",
      tableIndex: 0,
      totalTables: request.tables.length,
      rowsTransferred: 0,
      totalRows: null,
      status: "error",
      terminal: true,
      error: "Target draft requires correction",
      oraclePackagePreflight: {
        input,
        skipped: [],
        plan: {
          target: input.target.endpoint,
          ready: false,
          steps: [
            {
              identity,
              action: "create",
              sql: input.drafts[0].sql!,
              sourceOriginal: "Full body 中文😀",
              targetOriginal: null,
              recoverySql: null,
              recoveryComplete: false,
              references: [],
              incomingCallers: [],
              operation: null,
              issues: [{ code: "missing-reference", message: "Missing column 中文😀", line: 3, column: 7 }],
            },
          ],
        },
      },
    };
    deliver(terminal);
    await expect(pending).resolves.toBeUndefined();
    expect(progress).toHaveBeenCalledWith(terminal);
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
