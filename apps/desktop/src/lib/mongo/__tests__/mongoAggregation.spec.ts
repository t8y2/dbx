import { describe, expect, it } from "vitest";
import { buildMongoPipeline, mongoPipelineCode, mongoPipelineOutput, mongoPipelinePreview, parseMongoPipeline, type MongoPipelineStage } from "../mongoAggregation";

const stages: MongoPipelineStage[] = [
  { id: "1", operator: "$match", body: '{"active":true}', enabled: true },
  { id: "2", operator: "$group", body: '{"_id":"$team","n":{"$sum":1}}', enabled: true },
  { id: "3", operator: "$out", body: '"archive"', enabled: true },
];

describe("Mongo aggregation builder", () => {
  it("validates one-operator stages and preserves enabled stage order", () => {
    expect(buildMongoPipeline(stages.slice(0, 2))).toEqual([{ $match: { active: true } }, { $group: { _id: "$team", n: { $sum: 1 } } }]);
    expect(buildMongoPipeline([stages[0], { ...stages[1], enabled: false }])).toHaveLength(1);
    for (const malformed of ["{}", "[1]", "[{}]", '[{"$match":{},"$limit":1}]', '[{"$bad-name":1}]', "[1,2]"]) expect(() => parseMongoPipeline(malformed)).toThrow();
  });

  it("only treats final output stages as writes and strips them from previews", () => {
    const pipeline = buildMongoPipeline(stages);
    expect(mongoPipelineOutput(pipeline, "shop")).toEqual({ database: "shop", collection: "archive" });
    expect(mongoPipelinePreview(pipeline, "shop")).toEqual(pipeline.slice(0, -1));
    expect(() => mongoPipelineOutput([...pipeline, { $limit: 1 }], "shop")).toThrow();
    expect(() => mongoPipelineOutput([{ $merge: { into: { db: "other", coll: "dest" } } }], "shop")).not.toThrow();
    expect(() => mongoPipelineOutput([{ $facet: { unsafe: [{ $out: "dest" }] } }], "shop")).toThrow();
  });

  it("rejects invalid output namespaces before confirmation", () => {
    expect(() => mongoPipelineOutput([{ $out: "bad$name" }], "shop")).toThrow("outputTarget");
    expect(() => mongoPipelineOutput([{ $out: "system.profile" }], "shop")).toThrow("outputTarget");
    expect(() => mongoPipelineOutput([{ $out: "archive.system.profile" }], "shop")).toThrow("outputTarget");
    expect(() => mongoPipelineOutput([{ $merge: { into: { db: "bad.db", coll: "archive" } } }], "shop")).toThrow("outputTarget");
    for (const db of ["", "bad/name", "bad\\name", 'bad"name', "bad name", "bad\0name", "x".repeat(64), "汉".repeat(22)]) {
      expect(() => mongoPipelineOutput([{ $out: { db, coll: "archive" } }], "shop")).toThrow("outputTarget");
    }
    expect(mongoPipelineOutput([{ $out: " archive " }], "x".repeat(63))).toEqual({ database: "x".repeat(63), collection: " archive " });
    expect(mongoPipelineOutput([{ $out: "names.with.dots" }], "shop")).toEqual({ database: "shop", collection: "names.with.dots" });
  });

  it("escapes Unicode line separators and splits large Java string constants", () => {
    for (const language of ["mongosh", "node", "python", "java", "csharp"] as const) {
      const code = mongoPipelineCode(language, "db", "col", [{ $match: { text: "line\u2028next\u2029line" } }]);
      expect(code).not.toContain("\u2028");
      expect(code).not.toContain("\u2029");
    }
    const code = mongoPipelineCode("java", "db", "col", [{ $match: { text: "汉".repeat(30000) } }]);
    expect(code).toContain('BsonArray.parse(String.join("", ');
  });

  it("generates EJSON-aware code in all selected driver languages", () => {
    for (const language of ["mongosh", "node", "python", "java", "csharp"] as const) {
      const code = mongoPipelineCode(language, "shop", "orders", [{ $match: { id: { $oid: "507f1f77bcf86cd799439011" } } }]);
      if (language !== "mongosh") expect(code).toContain("MONGODB_URI");
      expect(code).toContain("507f1f77bcf86cd799439011");
      expect(code).toContain("orders");
    }
  });

  it("preserves BSON numeric output and uses UTF-8 for C# console output", () => {
    const pipeline = [{ $match: { n: { $numberLong: "9007199254740993" } } }];
    expect(mongoPipelineCode("node", "db", "col", pipeline)).toContain("promoteValues: false");
    expect(mongoPipelineCode("node", "db", "col", pipeline)).toContain("BSON.EJSON.stringify(document, { relaxed: false })");
    expect(mongoPipelineCode("mongosh", "db", "col", pipeline)).toContain("EJSON.stringify(document, { relaxed: false })");
    expect(mongoPipelineCode("python", "db", "col", pipeline)).toContain("CANONICAL_JSON_OPTIONS");
    expect(mongoPipelineCode("java", "db", "col", pipeline)).toContain("JsonMode.EXTENDED");
    expect(mongoPipelineCode("csharp", "db", "col", pipeline)).toContain("CanonicalExtendedJson");
    expect(mongoPipelineCode("csharp", "db", "col", pipeline)).toContain("Console.OutputEncoding = new UTF8Encoding(false)");
  });
});
