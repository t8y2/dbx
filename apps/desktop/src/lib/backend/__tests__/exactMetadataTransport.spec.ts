import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import * as tauri from "@/lib/backend/tauri";
import * as http from "@/lib/backend/http";

const owner = " Mixed Owner ";
const table = ' T(a)" ';

describe("exact metadata transports", () => {
  beforeEach(() => {
    invoke.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response("[]", { status: 200 }))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const calls = [
    ["tables", (api: typeof tauri | typeof http, exact?: boolean) => api.listTables("conn", "db", owner, "Ix", 2, 1, ["TABLE"], undefined, undefined, exact)],
    ["objects", (api: typeof tauri | typeof http, exact?: boolean) => api.listObjects("conn", "db", owner, ["INDEX"], "Ix", 2, 1, undefined, undefined, "request", exact)],
    ["columns", (api: typeof tauri | typeof http, exact?: boolean) => api.getColumns("conn", "db", owner, table, undefined, undefined, undefined, exact)],
    ["indexes", (api: typeof tauri | typeof http, exact?: boolean) => api.listIndexes("conn", "db", owner, table, undefined, exact)],
    ["foreign-keys", (api: typeof tauri | typeof http, exact?: boolean) => api.listForeignKeys("conn", "db", owner, table, undefined, exact)],
    ["constraints", (api: typeof tauri | typeof http, exact?: boolean) => api.listConstraints("conn", "db", owner, table, undefined, exact)],
    ["triggers", (api: typeof tauri | typeof http, exact?: boolean) => api.listTriggers("conn", "db", owner, table, undefined, exact)],
    ["ddl", (api: typeof tauri | typeof http, exact?: boolean) => api.getTableDdl("conn", "db", owner, table, undefined, undefined, false, exact)],
  ] as const;

  test.each(calls)("Tauri %s opts in without changing raw identity or legacy payloads", async (_name, call) => {
    await call(tauri, true);
    expect(invoke.mock.calls[0][1]).toMatchObject({ schema: owner, exactIdentity: true });
    if (invoke.mock.calls[0][1].table !== undefined) expect(invoke.mock.calls[0][1].table).toBe(table);
    await call(tauri);
    expect(invoke.mock.calls[1][1]).not.toHaveProperty("exactIdentity");
  });

  test.each(calls)("HTTP %s opts in without changing raw identity or legacy requests", async (_name, call) => {
    await call(http, true);
    const exact = new URL(String(vi.mocked(fetch).mock.calls[0][0]), "http://localhost");
    expect(exact.searchParams.get("schema")).toBe(owner);
    expect(exact.searchParams.get("exact_identity")).toBe("true");
    if (exact.searchParams.has("table")) expect(exact.searchParams.get("table")).toBe(table);
    await call(http);
    const legacy = new URL(String(vi.mocked(fetch).mock.calls[1][0]), "http://localhost");
    expect(legacy.searchParams.has("exact_identity")).toBe(false);
  });

  test("both comment requests preserve the exact parent", async () => {
    await tauri.getTableComment("conn", "db", owner, table, undefined, true);
    expect(invoke.mock.calls[0]).toEqual(["get_table_comment", expect.objectContaining({ schema: owner, table, exactIdentity: true })]);
    await http.getTableComment("conn", "db", owner, table, undefined, true);
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/schema/table-comment");
    expect(url.searchParams.get("schema")).toBe(owner);
    expect(url.searchParams.get("table")).toBe(table);
    expect(url.searchParams.get("exact_identity")).toBe("true");
  });

  test.each(["native", "display"] as const)("both %s DDL transports carry explicit owner without requiring exact capability", async (mode) => {
    for (const api of [tauri, http]) {
      if (mode === "native") await api.getTableDdl("conn", owner, owner, table, undefined, undefined, false, undefined, true, owner);
      else await api.getTableDisplayDdl("conn", owner, owner, table, undefined, undefined, true, owner);
    }
    const payload = invoke.mock.calls[0][1];
    expect(payload).toMatchObject({ schema: owner, explicitOwner: owner, separateIndexes: true });
    expect(payload).not.toHaveProperty("exactIdentity");
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("explicit_owner")).toBe(owner);
    expect(url.searchParams.get("schema")).toBe(owner);
    expect(url.searchParams.has("exact_identity")).toBe(false);
  });
});
