import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareOracleViewRename, executeOracleViewRename } from "@/lib/table/oracleViewRename";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), parseOracleObjectName: vi.fn(), buildOracleViewRenameSource: vi.fn(), reviewOracleViewRenameSource: vi.fn(), deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/backend/api", () => api);

const target = { connectionId: "c", database: "OWNER", schema: "OWNER", oldName: "OLD", newName: "NEW" };
const result = (rows: unknown[][]) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
let graph: unknown[][];
let statements: string[];
let renamed: boolean;

beforeEach(() => {
  graph = [];
  statements = [];
  renamed = false;
  vi.clearAllMocks();
  api.parseOracleObjectName.mockImplementation(async (name) => name.toUpperCase());
  api.buildOracleViewRenameSource.mockImplementation(async ({ source, targetViewName }) => ({ source, fingerprint: targetViewName || source }));
  api.reviewOracleViewRenameSource.mockImplementation(async ({ source, viewName, oldName, newName, targetViewName }) => {
    const rewrittenSource = source.replaceAll(oldName, newName).replace(`VIEW ${viewName}`, `VIEW ${targetViewName || viewName}`);
    const references = [...source.matchAll(/\bFROM\s+([A-Z][A-Z0-9_$#]*)/gi)].map((match) => ({ owner: "OWNER", name: match[1] }));
    const fingerprint = rewrittenSource.replace(/\bVIEW\s+[^\s]+/i, "VIEW <NAME>");
    return { source: { source: rewrittenSource, fingerprint, references }, references, issues: [] };
  });
  api.executeQuery.mockImplementation(async (_connection, _database, sql: string) => {
    statements.push(sql);
    if (sql.includes("SYS_CONTEXT")) return result([["OWNER", "OWNER"]]);
    if (sql.includes("DEPENDENCIES")) return result(graph);
    if (sql.includes("ALL_TAB_PRIVS") || sql.includes("ALL_COL_PRIVS")) return result([]);
    if (sql.includes("USER_OBJECTS")) {
      if (sql.includes("OBJECT_NAME='NEW'")) return result(renamed ? [["VIEW", "VALID"]] : []);
      return result(renamed ? [] : [["VIEW", "VALID"]]);
    }
    if (sql.includes("DBMS_LOB.GETLENGTH")) return result([[3]]);
    if (sql.includes("DBMS_LOB.SUBSTR")) return result([[1, renamed ? "NEW" : "OLD"]]);
    if (sql.startsWith("RENAME")) {
      renamed = true;
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

describe("OceanBase view rename plan", () => {
  it("keeps the visible-scope limitation even when there are no visible dependencies", async () => {
    const plan = await prepareOracleViewRename(target);
    expect(plan.statements).toEqual(['RENAME "OLD" TO "NEW";']);
    expect(plan.coverage).toBe("visible-only");
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("blocks a visible foreign dependency before any mutation", async () => {
    graph = [["OTHER", "DEP", "VIEW", null]];
    const plan = await prepareOracleViewRename(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues[0].message).toContain("OTHER");
    expect(renamed).toBe(false);
  });

  it("rejects truncated metadata instead of treating it as a complete graph", async () => {
    api.executeQuery.mockResolvedValue({ ...result([]), truncated: true });
    const plan = await prepareOracleViewRename(target);
    expect(plan.metadataComplete).toBe(false);
    expect(plan.executable).toBe(false);
    expect(renamed).toBe(false);
  });

  it("invalidates the preview if a dependency appears before dispatch", async () => {
    const plan = await prepareOracleViewRename(target);
    graph = [["OTHER", "DEP", "VIEW", null]];
    await expect(executeOracleViewRename(plan)).rejects.toThrow(/OTHER|changed/i);
    expect(renamed).toBe(false);
  });

  it("checks metadata identity before using an unqualified RENAME", async () => {
    api.executeQuery.mockResolvedValue(result([["SOMEONE_ELSE", "OWNER"]]));
    const plan = await prepareOracleViewRename(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(renamed).toBe(false);
  });

  it("does not dispatch when the UI target changes during preflight", async () => {
    const plan = await prepareOracleViewRename(target);
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(executeOracleViewRename(plan, isCurrent)).rejects.toThrow(/changed/i);
    expect(renamed).toBe(false);
  });

  it("reads back the new definition, validity, grants and disappearance of the old name", async () => {
    const plan = await prepareOracleViewRename({ ...target, connectionId: "success" });
    await executeOracleViewRename(plan);
    expect(renamed).toBe(true);
    expect(statements.filter((sql) => sql.startsWith("RENAME"))).toHaveLength(1);
    expect(statements.at(-1)).toContain("OBJECT_NAME='OLD'");
  });

  it("keeps a dispatched failure distinct from a preflight rejection", async () => {
    const plan = await prepareOracleViewRename({ ...target, connectionId: "unknown" });
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("RENAME")) throw new Error("Connection closed before the reply");
      return implementation(...args);
    });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: [], uncertain: "NEW", plan });
    expect(renamed).toBe(false);
  });

  it("falls back only for a denied dictionary and retains the visible-scope limitation", async () => {
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).includes("SYS.DBA_DEPENDENCIES")) throw new Error("ORA-00942: table or view does not exist");
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename(target);
    expect(plan.coverage).toBe("visible-only");
    expect(statements.some((sql) => sql.includes("SYS.ALL_DEPENDENCIES"))).toBe(true);
  });

  it("does not hide a known foreign dependency behind a fallback query", async () => {
    graph = [["OTHER", "DEP", "VIEW", null]];
    const plan = await prepareOracleViewRename(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.message.includes("OTHER"))).toBe(true);
    expect(statements.some((sql) => sql.includes("SYS.ALL_DEPENDENCIES"))).toBe(false);
  });

  it("rejects a smaller dependency graph after preview", async () => {
    let visible = true;
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (sql.includes("DEPENDENCIES")) return result(visible && sql.includes("REFERENCED_NAME='OLD'") ? [["OWNER", "DEP", "VIEW", null]] : []);
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename(target);
    expect(plan.views.map((view) => view.name)).toEqual(["OLD", "DEP"]);
    visible = false;
    await expect(executeOracleViewRename(plan)).rejects.toThrow(/changed/i);
    expect(renamed).toBe(false);
  });

  it("refuses dependency cycles", async () => {
    graph = [["OWNER", "OLD", "VIEW", null]];
    const plan = await prepareOracleViewRename(target);
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "dependency_cycle")).toBe(true);
    expect(renamed).toBe(false);
  });

  it("uses the actual column-permission dictionary owner column", async () => {
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).includes("ALL_COL_PRIVS") && String(args[2]).includes("TABLE_SCHEMA")) throw new Error("ORA-00904: invalid identifier 'TABLE_SCHEMA'");
      return implementation(...args);
    });
    await expect(prepareOracleViewRename(target)).resolves.toMatchObject({ canonicalNewName: "NEW" });
  });
});

function dependencyFixture(options: { drift?: boolean; failSecond?: boolean } = {}) {
  const sources = new Map([
    ["OLD", "CREATE VIEW OLD AS SELECT 42 X FROM DUAL"],
    ["DEP", "CREATE VIEW DEP AS SELECT /*+ FULL(X) */ * FROM OLD X"],
    ["DEP2", "CREATE VIEW DEP2 AS SELECT * FROM DEP"],
  ]);
  const writes: string[] = [];
  const valid = new Set(["OLD", "DEP", "DEP2"]);
  api.buildOracleViewRenameSource.mockImplementation(async ({ source, oldName, newName, targetViewName }) => {
    let rewritten = source.replaceAll(new RegExp(`\\b${oldName}\\b`, "g"), newName);
    if (targetViewName) rewritten = rewritten.replace(/^CREATE VIEW \w+/, `CREATE VIEW ${targetViewName}`);
    return { source: rewritten, fingerprint: rewritten.replace(/\/\*.*?\*\//g, "") };
  });
  api.executeQuery.mockImplementation(async (_connection, _database, sql: string) => {
    if (sql.includes("SYS_CONTEXT")) return result([["OWNER", "OWNER"]]);
    if (sql.includes("DEPENDENCIES")) return result(sql.includes("REFERENCED_NAME='OLD'") ? [["OWNER", "DEP", "VIEW", null]] : sql.includes("REFERENCED_NAME='DEP'") ? [["OWNER", "DEP2", "VIEW", null]] : []);
    if (sql.includes("ALL_TAB_PRIVS") || sql.includes("ALL_COL_PRIVS")) return result([]);
    if (sql.includes("USER_OBJECTS")) {
      const name = /OBJECT_NAME='([^']+)'/.exec(sql)![1];
      return result(sources.has(name) ? [["VIEW", valid.has(name) ? "VALID" : "INVALID"]] : []);
    }
    if (sql.includes("DBMS_LOB")) {
      const name = /GET_DDL\('VIEW','([^']+)'/.exec(sql)![1];
      const source = sources.get(name)!;
      return sql.includes("GETLENGTH") ? result([[source.length]]) : result([[1, source]]);
    }
    writes.push(sql);
    if (sql.startsWith("RENAME")) {
      sources.set("NEW", sources.get("OLD")!.replace("VIEW OLD", "VIEW NEW"));
      sources.delete("OLD");
      valid.clear();
      valid.add("NEW");
      if (options.drift) sources.set("DEP", sources.get("DEP")!.replace("FULL(X)", "INDEX(X)"));
      return result([]);
    }
    if (sql.startsWith("CREATE VIEW")) {
      const name = /^CREATE VIEW (\w+)/.exec(sql)![1];
      if (name === "DEP2" && options.failSecond) throw new Error("DDL reply lost");
      sources.set(name, sql);
      valid.add(name);
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { sources, writes, valid };
}

describe("view dependency execution", () => {
  it("keeps safe dependent SQL visible when one hint needs a manual repair, then executes the revalidated draft", async () => {
    const fixture = dependencyFixture();
    const review = api.reviewOracleViewRenameSource.getMockImplementation()!;
    api.reviewOracleViewRenameSource.mockImplementation(async (input) => {
      if (input.viewName === "DEP" && String(input.source).includes("FULL(X)")) {
        return { source: null, references: [{ owner: "OWNER", name: "OLD" }], issues: [{ code: "unsupported_hint", message: "Needs a manual hint edit", viewName: "DEP", hintText: "FULL(X)", location: { line: 1, column: 31 }, repairable: true }] };
      }
      return review(input);
    });
    const blocked = await prepareOracleViewRename({ ...target, connectionId: "manual-hint" });
    expect(blocked.executable).toBe(false);
    expect(blocked.views.find((view) => view.name === "DEP")?.source).toContain("FULL(X)");
    expect(blocked.views.find((view) => view.name === "DEP2")?.rewrittenSource).toContain("FROM DEP");
    expect(blocked.issues[0]).toMatchObject({ viewName: "DEP", hintText: "FULL(X)", location: { line: 1, column: 31 } });

    const repaired = await prepareOracleViewRename({ ...target, connectionId: "manual-hint" }, { DEP: "CREATE VIEW DEP AS SELECT * FROM OLD" });
    expect(repaired.executable).toBe(true);
    expect(repaired.steps.map((step) => step.kind)).toEqual(["rename", "replace", "replace"]);
    await expect(executeOracleViewRename(repaired)).resolves.toBeUndefined();
    expect(fixture.writes.map((sql) => (sql.startsWith("RENAME") ? "RENAME" : /^CREATE VIEW (\w+)/.exec(sql)?.[1]))).toEqual(["RENAME", "DEP", "DEP2"]);
  });

  it("replaces a manually corrected root before renaming it", async () => {
    const fixture = dependencyFixture();
    const plan = await prepareOracleViewRename({ ...target, connectionId: "manual-root" }, { OLD: "CREATE VIEW OLD AS SELECT 43 X FROM DUAL" });
    expect(plan.executable).toBe(true);
    expect(plan.steps.map((step) => step.kind)).toEqual(["replace", "rename", "replace", "replace"]);
    await executeOracleViewRename(plan);
    expect(fixture.writes[0]).toContain("43 X");
    expect(fixture.writes[1]).toMatch(/^RENAME/);
  });

  it("allows a parser failure to be corrected when the database dependency edge stays unchanged", async () => {
    dependencyFixture();
    const review = api.reviewOracleViewRenameSource.getMockImplementation()!;
    api.reviewOracleViewRenameSource.mockImplementation(async (input) => {
      if (input.viewName === "DEP" && input.source.includes("FULL(X)")) {
        return { source: null, references: [], issues: [{ code: "invalid_definition", message: "Unsupported query form", viewName: "DEP", repairable: true }] };
      }
      return review(input);
    });
    const blocked = await prepareOracleViewRename({ ...target, connectionId: "manual-parser" });
    expect(blocked.executable).toBe(false);
    const repaired = await prepareOracleViewRename({ ...target, connectionId: "manual-parser" }, { DEP: "CREATE VIEW DEP AS SELECT * FROM OLD" });
    expect(repaired.executable).toBe(true);
    expect(repaired.issues).toEqual([]);
  });

  it("keeps a definition draft visible but blocks changed dependency relationships", async () => {
    const fixture = dependencyFixture();
    const plan = await prepareOracleViewRename({ ...target, connectionId: "manual-graph" }, { DEP: "CREATE VIEW DEP AS SELECT * FROM DEP2" });
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "manual_graph" && item.viewName === "DEP")).toBe(true);
    expect(plan.views.find((view) => view.name === "DEP")?.draft).toBe("CREATE VIEW DEP AS SELECT * FROM DEP2");
    expect(plan.views.find((view) => view.name === "DEP2")?.rewrittenSource).toContain("CREATE VIEW DEP2");
    expect(fixture.writes).toEqual([]);
  });

  it("reports a completed root repair when the following rename fails", async () => {
    const fixture = dependencyFixture();
    const plan = await prepareOracleViewRename({ ...target, connectionId: "manual-root-partial" }, { OLD: "CREATE VIEW OLD AS SELECT 43 X FROM DUAL" });
    const execute = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("RENAME")) throw new Error("rename rejected");
      return execute(...args);
    });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: ["OLD (definition replaced)"], uncertain: "NEW" });
    expect(fixture.sources.get("OLD")).toContain("43 X");
    expect(fixture.sources.has("NEW")).toBe(false);
  });

  it("accepts unchanged sibling dependencies returned in a different order", async () => {
    const fixture = dependencyFixture();
    fixture.sources.set("DEP2", "CREATE VIEW DEP2 AS SELECT * FROM OLD");
    const implementation = api.executeQuery.getMockImplementation()!;
    let reverse = false;
    api.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (sql.includes("DEPENDENCIES") && sql.includes("REFERENCED_NAME='OLD'")) {
        const rows = [
          ["OWNER", "DEP", "VIEW", null],
          ["OWNER", "DEP2", "VIEW", null],
        ];
        return result(reverse ? rows.reverse() : rows);
      }
      if (sql.includes("DEPENDENCIES")) return result([]);
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "sibling-order" });
    reverse = true;
    await expect(executeOracleViewRename(plan)).resolves.toBeUndefined();
  });

  it("allows a view and its legal new name to share the separate index namespace", async () => {
    dependencyFixture();
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      const response = await implementation(...args);
      if (String(args[2]).includes("USER_OBJECTS") && !String(args[2]).includes("OBJECT_TYPE IN")) return result([...response.rows, ["INDEX", "VALID"]]);
      return response;
    });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "index-namespace" });
    await expect(executeOracleViewRename(plan)).resolves.toBeUndefined();
  });

  it("blocks a target name that already belongs to an operator", async () => {
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      const response = await implementation(...args);
      if (String(args[2]).includes("OBJECT_NAME='NEW'") && String(args[2]).includes("OBJECT_TYPE IN")) return result([["OPERATOR", "VALID"]]);
      return response;
    });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "operator-namespace" });
    expect(plan.executable).toBe(false);
    expect(plan.issues.some((item) => item.code === "target_conflict")).toBe(true);
    expect(renamed).toBe(false);
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("reads a large definition in bounded batches and reconstructs out-of-order chunks", async () => {
    const source = `CREATE VIEW OLD AS SELECT /*${"文".repeat(65_000)}*/ 42 FROM DUAL`;
    const codepoints = Array.from(source);
    const implementation = api.executeQuery.getMockImplementation()!;
    let chunkQueries = 0;
    api.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (sql.includes("DBMS_LOB.GETLENGTH")) return result([[codepoints.length]]);
      if (sql.includes("DBMS_LOB.SUBSTR")) {
        chunkQueries++;
        const offsets = [...sql.matchAll(/,1000,(\d+)\)/g)].map((match) => Number(match[1]));
        return result(offsets.reverse().map((offset) => (sql.includes("CHUNK_OFFSET") ? [offset, codepoints.slice(offset - 1, offset - 1 + 1000).join("")] : [codepoints.slice(offset - 1, offset - 1 + 1000).join("")])));
      }
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename(target);
    expect(plan.views[0].source).toBe(source);
    expect(chunkQueries).toBeLessThanOrEqual(3);
  });

  it.each(["missing", "duplicate", "unexpected"])("rejects %s chunks before dispatch", async (problem) => {
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (sql.includes("DBMS_LOB.GETLENGTH")) return result([[1500]]);
      if (sql.includes("DBMS_LOB.SUBSTR")) {
        const rows: unknown[][] = [
          [1, "x".repeat(1000)],
          [1001, "x".repeat(500)],
        ];
        if (problem === "missing") rows.pop();
        if (problem === "duplicate") rows[1][0] = 1;
        if (problem === "unexpected") rows[1][0] = 1000;
        return result(rows);
      }
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename(target);
    expect(plan.metadataComplete).toBe(false);
    expect(plan.issues.some((item) => item.code === "source_read_failed")).toBe(true);
    expect(renamed).toBe(false);
  });

  it("rebuilds two levels in order and verifies their final state", async () => {
    const fixture = dependencyFixture();
    const plan = await prepareOracleViewRename({ ...target, connectionId: "two-level-success" });
    await executeOracleViewRename(plan);
    expect(fixture.writes).toEqual(plan.statements);
    expect([...fixture.valid]).toEqual(["NEW", "DEP", "DEP2"]);
    expect(fixture.sources.get("DEP")).toContain("FROM NEW");
  });

  it("reports confirmed steps and stops after an uncertain dependent rebuild", async () => {
    const fixture = dependencyFixture({ failSecond: true });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "two-level-failure" });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: ["NEW", "DEP"], uncertain: "DEP2", plan });
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.valid.has("DEP2")).toBe(false);
  });

  it("preserves a concurrent hint-only edit before overwriting a dependent", async () => {
    const fixture = dependencyFixture({ drift: true });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "hint-drift" });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: ["NEW"], uncertain: "DEP" });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.sources.get("DEP")).toContain("INDEX(X)");
  });
});
