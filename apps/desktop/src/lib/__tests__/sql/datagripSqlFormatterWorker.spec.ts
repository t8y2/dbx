import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";
import { formatSqlForEditing } from "@/lib/sql/sqlFormatter";
import { cancelDataGripFormatterOwner, disposeDataGripFormatterWorker, formatDataGripSqlUsingWorker, mapDataGripSelectionUsingWorker } from "@/lib/sql/sqlFormatterWorker";

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  request: any;
  terminated = false;

  constructor() {
    ControlledWorker.instances.push(this);
  }

  postMessage(request: unknown): void {
    this.request = request;
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    const request = this.request;
    this.onmessage?.call(this as unknown as Worker, { data: { requestId: request.requestId, ...value } } as MessageEvent);
  }
}

afterEach(() => {
  disposeDataGripFormatterWorker();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ControlledWorker.instances = [];
});

function harness() {
  vi.stubGlobal("Worker", ControlledWorker);
  return ControlledWorker.instances;
}

describe("DataGrip formatter Worker client", () => {
  it("formats through the Worker and reuses it for another owner", async () => {
    const instances = harness();
    const first = formatDataGripSqlUsingWorker("select 1", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-a");
    expect(instances).toHaveLength(1);
    expect(instances[0].request).toEqual(expect.objectContaining({ kind: "format", sql: "select 1", dialect: "postgres", ownerId: "editor-a" }));
    instances[0].respond({ formatted: "select 1;" });
    await expect(first).resolves.toBe("select 1;");

    const second = formatDataGripSqlUsingWorker("select 2", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-b");
    expect(instances).toHaveLength(1);
    instances[0].respond({ formatted: "select 2;" });
    await expect(second).resolves.toBe("select 2;");
  });

  it("cancels the previous request for the same editor without a main-thread fallback", async () => {
    const instances = harness();
    const first = formatDataGripSqlUsingWorker("select old", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-a");
    const second = formatDataGripSqlUsingWorker("select new", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-a");
    await expect(first).resolves.toBe("select old");
    expect(instances[0].terminated).toBe(true);
    expect(instances).toHaveLength(2);
    instances[1].respond({ formatted: "select new;" });
    await expect(second).resolves.toBe("select new;");
  });

  it("cancels a queued request explicitly", async () => {
    const instances = harness();
    const first = formatDataGripSqlUsingWorker("select active", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-a");
    const queued = formatDataGripSqlUsingWorker("select queued", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-b");
    cancelDataGripFormatterOwner("editor-b");
    await expect(queued).resolves.toBe("select queued");
    instances[0].respond({ formatted: "select active;" });
    await expect(first).resolves.toBe("select active;");
    expect(instances).toHaveLength(1);
  });

  it("maps selection through the same Worker", async () => {
    const instances = harness();
    const mapping = mapDataGripSelectionUsingWorker("select 1", "select 1;", { anchor: 7, head: 7 }, "postgres", "editor-a");
    expect(instances[0].request).toEqual(expect.objectContaining({ kind: "mapSelection", selection: { anchor: 7, head: 7 } }));
    instances[0].respond({ selection: { anchor: 8, head: 8 } });
    await expect(mapping).resolves.toEqual({ anchor: 8, head: 8 });
  });
  it("preserves the editing fallback for a structured parser error", async () => {
    const instances = harness();
    const pending = formatSqlForEditing("select )", "postgres", { ...DEFAULT_SQL_FORMATTER_SETTINGS, layoutStyle: "datagrip" });
    instances[0].respond({ error: { message: "Parse error: Invalid SQL", parseError: true } });
    await expect(pending).resolves.toBe("select )");
  });

  it("rejects instead of computing locally when Workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(formatDataGripSqlUsingWorker("select 1", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS)).rejects.toThrow("requires Web Worker support");
  });

  it("terminates a timed-out request and rejects it", async () => {
    vi.useFakeTimers();
    const instances = harness();
    const pending = formatDataGripSqlUsingWorker("select 1", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "editor-a");
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(instances[0].terminated).toBe(true);
  });
});
