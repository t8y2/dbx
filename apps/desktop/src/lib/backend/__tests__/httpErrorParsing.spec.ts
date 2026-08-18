import { describe, expect, test, vi } from "vitest";
import { backendResponseError, executeMulti, importAgentDriver, installJdbcPluginLocal } from "@/lib/backend/http";
import { getDebugLogText } from "@/lib/backend/debugLog";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}
import { BackendErrorException } from "@/lib/backend/errorUtils";

const envelope = {
  version: 1,
  code: "DBX-JDBC-4001",
  messageKey: "backendErrors.jdbc.sqlFailed",
  messageParams: { stage: "execute" },
  source: "jdbcAgent",
  operationOutcome: "unknown",
  detail: "Incorrect syntax near SELECT",
} as const;

describe("HTTP backend error parsing", () => {
  test.each([
    ["direct envelope", JSON.stringify(envelope), envelope],
    ["nested envelope", JSON.stringify({ error: envelope }), envelope],
    ["legacy text", "relation missing_table does not exist", undefined],
    ["malformed JSON text", "{not-json", undefined],
  ])("preserves %s body diagnostics", async (_name, body, expected) => {
    const error = await backendResponseError(new Response(body, { status: 500 }));
    if (expected) {
      expect(error.backendError).toEqual(expected);
    } else {
      expect(error.backendError.code).toBe("DBX-LEGACY-0001");
      expect(error.backendError.detail).toBe(body);
    }
  });

  test("uses a stable summary for an empty body", async () => {
    const error = await backendResponseError(new Response("", { status: 503 }));
    expect(error.backendError.code).toBe("DBX-LEGACY-0001");
    expect(error.backendError.detail).toBeUndefined();
    expect(error.message).toBe("Backend request failed");
  });

  test("keeps a safe SQL diagnostic in a JSON envelope unchanged", async () => {
    const error = await backendResponseError(new Response(JSON.stringify(envelope), { status: 400 }));
    expect(error.backendError.detail).toBe("Incorrect syntax near SELECT");
  });

  test.each([
    ["JDBC plugin upload", () => installJdbcPluginLocal(new File(["plugin"], "plugin.zip"))],
    ["Agent driver upload", () => importAgentDriver("postgres", new File(["driver"], "driver.zip"))],
  ])("normalizes %s multipart failures through the nested backend envelope", async (_name, upload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: envelope }), { status: 400 })));

    const error = await upload().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BackendErrorException);
    expect(error).toMatchObject({
      backendError: expect.objectContaining({ code: envelope.code, detail: envelope.detail }),
    });

    vi.unstubAllGlobals();
  });

  test.each([
    ["JDBC plugin upload", () => installJdbcPluginLocal(new File(["plugin"], "plugin.zip"))],
    ["Agent driver upload", () => importAgentDriver("postgres", new File(["driver"], "driver.zip"))],
  ])("normalizes %s multipart failures through the direct backend envelope", async (_name, upload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 400 })));

    const error = await upload().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BackendErrorException);
    expect(error).toMatchObject({
      backendError: expect.objectContaining({ code: envelope.code, detail: envelope.detail }),
    });

    vi.unstubAllGlobals();
  });
});

describe("HTTP query transport diagnostics", () => {
  test("records timing and payload sizes without logging query contents", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    const sql = "SELECT 'private-query-marker'";
    localStorage.setItem("dbx-debug-logging-enabled", "1");
    localStorage.removeItem("dbx-debug-log-entries");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ columns: ["value"], rows: [["private-cell-marker"]] }]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-dbx-core-ms": "41",
            "x-dbx-serialize-ms": "7",
          },
        }),
      ),
    );

    await executeMulti("private-connection-marker", "private-database-marker", sql, undefined, "trace-12345678");

    const logs = getDebugLogText();
    expect(logs).toContain("[DBX][query-transport:http]");
    expect(logs).toContain('"backendCoreMs":"41"');
    expect(logs).toContain('"backendSerializeMs":"7"');
    expect(logs).toContain('"requestBytes":');
    expect(logs).toContain('"responseBytes":');
    expect(logs).toContain('"jsonParseMs":');
    expect(logs).not.toContain("private-query-marker");
    expect(logs).not.toContain("private-cell-marker");
    expect(logs).not.toContain("private-connection-marker");
    expect(logs).not.toContain("private-database-marker");

    vi.unstubAllGlobals();
  });

  test("preserves structured backend errors while logging only safe failure metadata", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem("dbx-debug-logging-enabled", "1");
    localStorage.removeItem("dbx-debug-log-entries");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 400 })));

    const error = await executeMulti("connection-1", "database-1", "SELECT 'failed-query-marker'", undefined, "trace-87654321").catch((value: unknown) => value);

    expect(error).toBeInstanceOf(BackendErrorException);
    expect(error).toMatchObject({ backendError: expect.objectContaining({ code: envelope.code }) });
    const logs = getDebugLogText();
    expect(logs).toContain("[DBX][query-transport:http:error]");
    expect(logs).toContain('"status":400');
    expect(logs).not.toContain("failed-query-marker");
    expect(logs).not.toContain(envelope.detail);

    vi.unstubAllGlobals();
  });
});
