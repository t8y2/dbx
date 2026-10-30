import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RoutineCopyObjectSourceInput } from "@/lib/table/objectSourceEditor";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("routine copy SQL builder transports", () => {
  it("forwards the exact source and new identity through HTTP and Tauri without executing SQL", async () => {
    const input: RoutineCopyObjectSourceInput = { databaseType: "postgres", objectType: "PROCEDURE", schema: 'Mixed "schema', name: "original", newName: "copied", source: "CREATE PROCEDURE original(IN n integer) LANGUAGE sql AS $$SELECT n$$;" };
    const sql = 'CREATE PROCEDURE "copied"(IN n integer) LANGUAGE sql AS $$SELECT n$$;';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => sql });
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockResolvedValue(sql);
    const http = await import("@/lib/backend/http");
    const tauri = await import("@/lib/backend/tauri");

    await expect(http.buildRoutineCopyObjectSourceSql(input)).resolves.toBe(sql);
    await expect(tauri.buildRoutineCopyObjectSourceSql(input)).resolves.toBe(sql);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/query/build-routine-copy-object-source-sql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("build_routine_copy_object_source_sql", { input });
  });

  it("registers the pure builder on both native and web backends", () => {
    const root = process.cwd();
    const native = readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
    const web = readFileSync(path.join(root, "crates/dbx-web/src/main.rs"), "utf8");
    expect(native).toContain("commands::query::build_routine_copy_object_source_sql,");
    expect(web).toContain('"/query/build-routine-copy-object-source-sql"');
    expect(web).toContain("post(routes::query::build_routine_copy_object_source_sql)");
  });
});
