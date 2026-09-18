import { describe, expect, it } from "vitest";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { cteDefinitionSources, findCteColumnResolution, findCteReferenceAt, resolveCteColumnOrigins } from "@/lib/sql/semantic/cteNavigation";
import type { SqlSemanticModel } from "@/lib/sql/semantic/types";

function modelAt(sql: string, marker: string, occurrence = 0): { model: SqlSemanticModel; pos: number } {
  let pos = sql.indexOf(marker);
  for (let index = 0; index < occurrence; index += 1) pos = sql.indexOf(marker, pos + 1);
  expect(pos).toBeGreaterThanOrEqual(0);
  return { model: buildSqlSemanticModel(sql, pos), pos };
}

describe("CTE definition enrichment", () => {
  it("records name/body spans, outputs, stars and body sources", () => {
    const sql = "WITH w AS (SELECT id, t.name FROM orders t) SELECT id FROM w";
    const { model } = modelAt(sql, "id", 1); // outer id
    const definition = cteDefinitionSources(model).find((source) => source.name === "w");

    expect(definition).toBeDefined();
    expect(sql.slice(definition!.nameSpan!.start, definition!.nameSpan!.end)).toBe("w");
    expect(sql[definition!.bodySpan!.start]).toBe("(");
    expect(sql[definition!.bodySpan!.end - 1]).toBe(")");

    const bodySources = definition!.bodySources ?? [];
    expect(bodySources.some((source) => source.name === "orders")).toBe(true);
    // Body physical tables stay nested on the definition and never leak to outer row sources.
    expect(model.rowSources.some((source) => source.name === "orders")).toBe(false);
  });

  it("traces bare and qualified projections and marks jump spans on the column segment", () => {
    const sql = "WITH w AS (SELECT id, t.name FROM orders t) SELECT id FROM w";
    const model = buildSqlSemanticModel(sql, sql.length);
    const definition = cteDefinitionSources(model)[0]!;
    const outputs = definition.cteOutputs ?? [];

    expect(outputs.map((column) => column.name)).toEqual(["id", "name"]);
    expect(sql.slice(outputs[0]!.jumpSpan.start, outputs[0]!.jumpSpan.end)).toBe("id");
    expect(sql.slice(outputs[1]!.jumpSpan.start, outputs[1]!.jumpSpan.end)).toBe("name");
    expect(outputs[0]!.origin).toEqual({ qualifierParts: [], column: "id" });
    expect(outputs[1]!.origin).toEqual({ qualifierParts: ["t"], column: "name" });
  });

  it("records bare and qualified stars", () => {
    const sql = "WITH w AS (SELECT t.* FROM orders t) SELECT * FROM w";
    const model = buildSqlSemanticModel(sql, sql.length);
    const stars = cteDefinitionSources(model)[0]!.cteStars ?? [];

    expect(stars).toHaveLength(1);
    expect(stars[0]!.qualifierParts).toEqual(["t"]);
    expect(sql.slice(stars[0]!.starSpan.start, stars[0]!.starSpan.end)).toBe("*");
    // The legacy flat columns list keeps its pre-existing shape (q.* qualifier leaks as a name);
    // accurate star metadata lives on cteStars.
    expect(cteDefinitionSources(model)[0]!.columns).toEqual(["t"]);
  });

  it("inherits positional body origins through an explicit column list", () => {
    const sql = "WITH w(a, b) AS (SELECT id, name FROM orders) SELECT a FROM w";
    const model = buildSqlSemanticModel(sql, sql.length);
    const definition = cteDefinitionSources(model)[0]!;
    const outputs = definition.cteOutputs ?? [];

    expect(outputs.map((column) => column.name)).toEqual(["a", "b"]);
    expect(sql.slice(outputs[0]!.jumpSpan.start, outputs[0]!.jumpSpan.end)).toBe("a");
    expect(outputs[0]!.origin).toEqual({ qualifierParts: [], column: "id" });
    expect(definition.columns).toEqual(["a", "b"]);
  });

  it("does not attach origins to expression/alias projections", () => {
    const sql = "WITH w AS (SELECT n + 1 AS doubled, flag FROM orders) SELECT doubled FROM w";
    const model = buildSqlSemanticModel(sql, sql.length);
    const outputs = cteDefinitionSources(model)[0]!.cteOutputs ?? [];

    expect(outputs[0]!.name).toBe("doubled");
    expect(outputs[0]!.origin).toBeUndefined();
    expect(sql.slice(outputs[0]!.jumpSpan.start, outputs[0]!.jumpSpan.end)).toBe("doubled");
    expect(outputs[1]!.origin).toEqual({ qualifierParts: [], column: "flag" });
  });
});

describe("findCteReferenceAt", () => {
  it("hits the outer reference name and its declared alias but never the definition name", () => {
    const sql = "WITH recent AS (SELECT id FROM orders) SELECT x FROM recent r WHERE r.x = 1";
    const outerNamePos = sql.indexOf("recent r");
    const aliasDeclarationPos = sql.indexOf(" r WHERE") + 1;
    const definitionNamePos = sql.indexOf("recent");

    const hitByName = findCteReferenceAt(buildSqlSemanticModel(sql, outerNamePos + 2), outerNamePos + 2);
    expect(hitByName?.definition.name).toBe("recent");

    const hitByAlias = findCteReferenceAt(buildSqlSemanticModel(sql, aliasDeclarationPos + 1), aliasDeclarationPos);
    expect(hitByAlias?.reference.alias).toBe("r");
    expect(hitByAlias?.definition.name).toBe("recent");

    expect(findCteReferenceAt(buildSqlSemanticModel(sql, definitionNamePos + 2), definitionNamePos + 2)).toBeNull();
  });
});

describe("findCteColumnResolution", () => {
  it("resolves a star-derived column to the body star span", () => {
    const sql = "WITH w AS (SELECT * FROM orders) SELECT x FROM w WHERE x = 1";
    const pos = sql.indexOf("x", sql.indexOf("SELECT", sql.indexOf(")")));
    const model = buildSqlSemanticModel(sql, pos + 1);

    const hit = findCteColumnResolution(model, "x");
    expect(hit?.definition.name).toBe("w");
    expect(hit?.output).toBeUndefined();
    expect(hit?.stars).toHaveLength(1);
    expect(sql.slice(hit!.stars![0]!.starSpan.start, hit!.stars![0]!.starSpan.end)).toBe("*");
  });

  it("resolves a named output column", () => {
    const sql = "WITH w AS (SELECT id FROM orders) SELECT id FROM w";
    const outerId = sql.lastIndexOf("id");
    const model = buildSqlSemanticModel(sql, outerId + 1);

    const hit = findCteColumnResolution(model, "id");
    expect(hit?.output?.name).toBe("id");
    expect(sql.slice(hit!.output!.jumpSpan.start, hit!.output!.jumpSpan.end)).toBe("id");
  });

  it("resolves qualified columns through the cursor-intent target source", () => {
    const sql = "WITH w AS (SELECT * FROM orders) SELECT w.id FROM w";
    const idPos = sql.indexOf("id", sql.indexOf("w.id"));
    const model = buildSqlSemanticModel(sql, idPos + 1);

    const hit = findCteColumnResolution(model, "id", "w");
    expect(hit?.definition.name).toBe("w");
    expect(hit?.stars).toHaveLength(1);
  });

  it("returns null when several visible CTEs expose the same bare column", () => {
    const sql = "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM invoices) SELECT id FROM a, b";
    const outerId = sql.lastIndexOf("id");
    const model = buildSqlSemanticModel(sql, outerId + 1);

    expect(findCteColumnResolution(model, "id")).toBeNull();
  });

  it("does not let a later CTE claim a bare column of an earlier CTE body", () => {
    const sql = "WITH w AS (SELECT id FROM orders), later AS (SELECT id FROM invoices) SELECT id FROM later";
    const bodyId = sql.indexOf("SELECT id FROM orders") + "SELECT ".length;
    const model = buildSqlSemanticModel(sql, bodyId + 1);

    // Before the visibility guard this resolved to `later` and ctrl+click jumped into that body.
    expect(findCteColumnResolution(model, "id")).toBeNull();
    // The same column still resolves from the outer block, where `later` is visible.
    const outer = buildSqlSemanticModel(sql, sql.lastIndexOf("id") + 1);
    expect(findCteColumnResolution(outer, "id")?.definition.name).toBe("later");
  });

  it("does not let a CTE referenced only from a deeper subquery claim an outer bare column", () => {
    const sql = "WITH w AS (SELECT x FROM a) SELECT q FROM real_t, (SELECT x FROM w) s";
    const outerQ = sql.indexOf("SELECT q FROM real_t") + "SELECT ".length;
    const model = buildSqlSemanticModel(sql, outerQ + 1);

    // `w` is only referenced inside the derived table; it must not own the outer bare `q`.
    expect(findCteColumnResolution(model, "q")).toBeNull();
    // Inside the subquery that references `w`, its own column still resolves.
    const innerX = sql.indexOf("x FROM w") + 1;
    const inner = buildSqlSemanticModel(sql, innerX);
    expect(findCteColumnResolution(inner, "x")?.definition.name).toBe("w");
  });

  it("keeps bare columns of a CTE body on the CTE that body references", () => {
    const sql = "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM a) SELECT id FROM b";
    const bodyId = sql.indexOf("SELECT id FROM a") + "SELECT ".length;
    const model = buildSqlSemanticModel(sql, bodyId + 1);

    expect(findCteColumnResolution(model, "id")?.definition.name).toBe("a");
  });

  it("returns null for a column absent from an explicit column list", () => {
    const sql = "WITH w(a, b) AS (SELECT id, name FROM orders) SELECT c FROM w";
    const outerC = sql.lastIndexOf("c");
    const model = buildSqlSemanticModel(sql, outerC + 1);

    expect(findCteColumnResolution(model, "c")).toBeNull();
  });

  it("never lets a star-bodied CTE claim a column qualified by a physical table", () => {
    const sql = "WITH w AS (SELECT * FROM a) SELECT t.id FROM orders t JOIN w ON t.id = w.id";
    // Hover/click build the model at the position, so the cursor intent already points at `t`.
    const model = buildSqlSemanticModel(sql, sql.indexOf("t.id") + 2);

    // Before the guard this returned the CTE `w` through its body star.
    expect(findCteColumnResolution(model, "id", "t")).toBeNull();
  });

  it("never lets a named CTE output claim a column qualified by a physical table", () => {
    const sql = "WITH w AS (SELECT id FROM a) SELECT t.id FROM orders t JOIN w ON t.id = w.id";
    const model = buildSqlSemanticModel(sql, sql.indexOf("t.id") + 2);

    expect(findCteColumnResolution(model, "id", "t")).toBeNull();
  });

  it("still resolves the CTE-qualified column in the same statement", () => {
    const sql = "WITH w AS (SELECT * FROM a) SELECT t.id FROM orders t JOIN w ON t.id = w.id";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("w.id") + 2);

    const hit = findCteColumnResolution(model, "id", "w");
    expect(hit?.definition.name).toBe("w");
    expect(hit?.stars).toHaveLength(1);
  });
});

describe("resolveCteColumnOrigins", () => {
  it("traces a star-derived column to the physical body table", () => {
    const sql = "WITH w AS (SELECT * FROM orders) SELECT x FROM w";
    const pos = sql.indexOf("x", sql.indexOf("SELECT", sql.indexOf(")")));
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "x");

    const origins = resolveCteColumnOrigins(model, hit!, "x");
    expect(origins).toHaveLength(1);
    expect(origins[0]!.source.name).toBe("orders");
    expect(origins[0]!.column).toBe("x");
  });

  it("traces qualified projections to the aliased body table", () => {
    const sql = "WITH w AS (SELECT t.id FROM orders t) SELECT id FROM w";
    const pos = sql.lastIndexOf("id");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "id");

    const origins = resolveCteColumnOrigins(model, hit!, "id");
    expect(origins.map((origin) => ({ name: origin.source.name, column: origin.column }))).toEqual([{ name: "orders", column: "id" }]);
  });

  it("follows CTE chains down to the physical table", () => {
    const sql = "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM a) SELECT id FROM b";
    const pos = sql.lastIndexOf("id");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "id");

    expect(hit?.definition.name).toBe("b");
    const origins = resolveCteColumnOrigins(model, hit!, "id");
    expect(origins).toHaveLength(1);
    expect(origins[0]!.source.name).toBe("orders");
    expect(origins[0]!.column).toBe("id");
  });

  it("traces through a derived table inside the CTE body", () => {
    const sql = "WITH w AS (SELECT X.id FROM (SELECT T.id FROM orders T) X) SELECT id FROM w";
    const pos = sql.lastIndexOf("id");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "id");

    expect(hit?.definition.name).toBe("w");
    expect(resolveCteColumnOrigins(model, hit!, "id").map((origin) => ({ name: origin.source.name, column: origin.column }))).toEqual([{ name: "orders", column: "id" }]);
  });

  it("expands a derived table's body star down to the physical table", () => {
    const sql = "WITH w AS (SELECT X.qty FROM (SELECT T.* FROM orders T) X) SELECT qty FROM w";
    const pos = sql.lastIndexOf("qty");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "qty");

    expect(resolveCteColumnOrigins(model, hit!, "qty").map((origin) => ({ name: origin.source.name, column: origin.column }))).toEqual([{ name: "orders", column: "qty" }]);
  });

  it("keeps every union branch of a derived-table CTE body", () => {
    const sql = "WITH w AS (SELECT X.a FROM (SELECT T.* FROM t1 T) X UNION ALL SELECT X.a FROM (SELECT T.* FROM t2 T) X) SELECT a FROM w";
    const pos = sql.lastIndexOf("a");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "a");

    expect(resolveCteColumnOrigins(model, hit!, "a").map((origin) => origin.source.name)).toEqual(["t1", "t2"]);
  });

  it("does not recurse through a recursive CTE self-reference", () => {
    const sql = "WITH RECURSIVE r(n) AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r) SELECT n FROM r";
    const pos = sql.lastIndexOf("n");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const definition = cteDefinitionSources(model)[0]!;
    const hit = findCteColumnResolution(model, "n");

    expect(definition.bodySources?.some((source) => source.name === "r")).toBe(true);
    expect(() => resolveCteColumnOrigins(model, hit!, "n")).not.toThrow();
    expect(resolveCteColumnOrigins(model, hit!, "n")).toEqual([]);
  });

  it("returns no origin for expression outputs", () => {
    const sql = "WITH w AS (SELECT n + 1 AS doubled FROM orders) SELECT doubled FROM w";
    const pos = sql.lastIndexOf("doubled");
    const model = buildSqlSemanticModel(sql, pos + 1);
    const hit = findCteColumnResolution(model, "doubled");

    expect(resolveCteColumnOrigins(model, hit!, "doubled")).toEqual([]);
  });
});

describe("多星号与派生表别名列的溯源", () => {
  it("多星号 body 保留全部候选星号，并逐个展开为来源", () => {
    const sql = "WITH w AS (SELECT a.*, b.* FROM t1 a, t2 b) SELECT id FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("id") + 1);
    const hit = findCteColumnResolution(model, "id");

    expect(hit?.stars).toHaveLength(2);
    expect(hit?.stars?.map((star) => star.qualifierParts)).toEqual([["a"], ["b"]]);
    // 两个来源都返回，由调用方用列元数据裁决（见 CteColumnHit.stars 注释）。
    expect(resolveCteColumnOrigins(model, hit!, "id").map((origin) => origin.source.name)).toEqual(["t1", "t2"]);
  });

  it("限定星号只展开它自己的来源，不受其它星号影响", () => {
    const sql = "WITH w AS (SELECT a.*, b.* FROM t1 a, t2 b) SELECT id FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("id") + 1);
    const hit = findCteColumnResolution(model, "id");
    const second = { ...hit!, stars: [hit!.stars![1]!] };

    expect(resolveCteColumnOrigins(model, second, "id").map((origin) => origin.source.name)).toEqual(["t2"]);
  });

  it("派生表别名列 X(a) 让外层 a 继续溯源到物理列", () => {
    const sql = "WITH w AS (SELECT X.a FROM (SELECT id FROM orders) X(a)) SELECT a FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("a") + 1);
    const hit = findCteColumnResolution(model, "a");

    expect(hit?.output?.name).toBe("a");
    expect(resolveCteColumnOrigins(model, hit!, "a").map((origin) => ({ name: origin.source.name, column: origin.column }))).toEqual([{ name: "orders", column: "id" }]);
  });

  it("别名列数量与投影数量不一致时不做按位改名，避免错配", () => {
    const sql = "WITH w AS (SELECT X.a FROM (SELECT id, name FROM orders) X(a)) SELECT a FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("a") + 1);
    const derived = cteDefinitionSources(model)[0]!.bodySources![0]!;
    const hit = findCteColumnResolution(model, "a");

    // 内层仍投影 id/name，改名被放弃：外层 a 仍解析到 w，但溯源在这里中断，
    // 而不是把 X.a 错配到 orders.id。
    expect(derived.cteOutputs?.map((column) => column.name)).toEqual(["id", "name"]);
    expect(hit?.output?.name).toBe("a");
    expect(resolveCteColumnOrigins(model, hit!, "a")).toEqual([]);
  });

  it("命名投影命中时不再回退到星号", () => {
    const sql = "WITH w AS (SELECT id, a.* FROM t1 a) SELECT id FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("id") + 1);
    const hit = findCteColumnResolution(model, "id");

    // 命名输出优先，星号只在没有任何命名命中时充当候选。
    expect(hit?.output?.name).toBe("id");
    expect(hit?.stars).toBeUndefined();
    expect(resolveCteColumnOrigins(model, hit!, "id").map((origin) => origin.source.name)).toEqual(["t1"]);
  });

  it("同一来源被多个星号重复引用时，来源去重", () => {
    const sql = "WITH w AS (SELECT a.*, a.* FROM t1 a) SELECT id FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("id") + 1);
    const hit = findCteColumnResolution(model, "id");

    expect(hit?.stars).toHaveLength(2);
    expect(resolveCteColumnOrigins(model, hit!, "id").map((origin) => origin.source.name)).toEqual(["t1"]);
  });

  it("星号 body + 别名列：改名被放弃，退化到星号兜底并由元数据筛选兜底", () => {
    const sql = "WITH w AS (SELECT X.a FROM (SELECT * FROM orders) X(a)) SELECT a FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("a") + 1);
    const derived = cteDefinitionSources(model)[0]!.bodySources![0]!;
    const hit = findCteColumnResolution(model, "a");

    // 星号无法与别名列表建立位置对应，因此这里不做改名：内层不产出命名输出，
    // 溯源只能落到星号，列名沿用外层别名 `a`。调用方按真实列元数据筛选，
    // 内层没有 a 列时整条链路被丢弃（不会显示错误的注释）。
    expect(derived.columns).toEqual(["a"]);
    expect(derived.cteOutputs).toEqual([]);
    expect(resolveCteColumnOrigins(model, hit!, "a").map((origin) => ({ name: origin.source.name, column: origin.column }))).toEqual([{ name: "orders", column: "a" }]);
  });

  it("别名列不创造 origin，也不改变内层跳转目标", () => {
    const sql = "WITH w AS (SELECT X.a FROM (SELECT id AS x FROM orders) X(a)) SELECT a FROM w";
    const model = buildSqlSemanticModel(sql, sql.lastIndexOf("a") + 1);
    const derived = cteDefinitionSources(model)[0]!.bodySources![0]!;
    const output = derived.cteOutputs![0]!;
    const hit = findCteColumnResolution(model, "a");

    // 名称换成了外层别名，但 jumpSpan 仍指向内层别名 token、且不因此获得 origin。
    expect(output.name).toBe("a");
    expect(sql.slice(output.jumpSpan.start, output.jumpSpan.end)).toBe("x");
    expect(resolveCteColumnOrigins(model, hit!, "a")).toEqual([]);
  });
});

describe("CTE 溯源链路的深度边界", () => {
  /** c1 → c2 → … → cN 的线性链路，最外层引用 cN。 */
  function chainedSql(length: number): string {
    const definitions = Array.from({ length }, (_, index) => (index === 0 ? "c1 AS (SELECT id FROM orders)" : `c${index + 1} AS (SELECT id FROM c${index})`));
    return `WITH ${definitions.join(", ")} SELECT id FROM c${length}`;
  }

  it("九层链路仍在深度上限内，可追溯到物理表", () => {
    const sql = chainedSql(9);
    const { model } = modelAt(sql, "id FROM c9");
    const hit = findCteColumnResolution(model, "id");

    expect(hit?.definition.name).toBe("c9");
    expect(resolveCteColumnOrigins(model, hit!, "id").map((origin) => origin.source.name)).toEqual(["orders"]);
  });

  it("超过八层（十层链路）时截断为空，交由上层回退", () => {
    const sql = chainedSql(10);
    const { model } = modelAt(sql, "id FROM c10");
    const hit = findCteColumnResolution(model, "id");

    expect(hit?.definition.name).toBe("c10");
    expect(resolveCteColumnOrigins(model, hit!, "id")).toEqual([]);
  });

  it("限定符解析不到任何 CTE 引用时返回 null", () => {
    const sql = "WITH w AS (SELECT * FROM orders) SELECT w.id FROM w";
    const { model } = modelAt(sql, "WITH");

    expect(findCteColumnResolution(model, "id", "zzz")).toBeNull();
  });
});
