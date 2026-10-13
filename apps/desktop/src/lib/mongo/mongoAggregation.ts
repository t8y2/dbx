import { parseMongoJson } from "./mongoJson";

export interface MongoPipelineStage {
  id: string;
  operator: string;
  body: string;
  enabled: boolean;
}
export type MongoPipeline = Record<string, unknown>[];
export interface MongoOutputTarget {
  database: string;
  collection: string;
}

/** Reject invalid output namespaces before showing a write confirmation.
 * The server still enforces platform- and deployment-specific length limits. */
export function validateMongoOutputName(value: unknown, kind: "database" | "collection"): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("$")) throw new Error("outputTarget");
  if (kind === "database" && (["/", "\\", ".", '"', " "].some((character) => value.includes(character)) || new TextEncoder().encode(value).length > 63)) throw new Error("outputTarget");
  if (kind === "collection" && (value.startsWith("system.") || value.includes(".system."))) throw new Error("outputTarget");
  return value;
}

export const MONGO_STAGE_TEMPLATES: Record<string, unknown> = {
  $match: {},
  $project: { _id: 1 },
  $sort: { _id: 1 },
  $limit: 100,
  $skip: 0,
  $group: { _id: "$field", count: { $sum: 1 } },
  $unwind: { path: "$items", preserveNullAndEmptyArrays: true },
  $lookup: { from: "other", localField: "key", foreignField: "key", as: "joined" },
  $set: { field: { $literal: "value" } },
  $unset: "field",
  $count: "count",
  $replaceRoot: { newRoot: "$document" },
  $facet: { results: [{ $limit: 10 }] },
  $sortByCount: "$field",
  $sample: { size: 100 },
  $unionWith: { coll: "other", pipeline: [] },
  $out: "output_collection",
  $merge: { into: "output_collection", whenMatched: "merge", whenNotMatched: "insert" },
};

export function parseMongoPipeline(text: string): MongoPipeline {
  if (text.length > 2 * 1024 * 1024) throw new Error("Pipeline exceeds 2 MiB");
  const value = parseMongoJson(text);
  if (!Array.isArray(value) || value.length > 1000) throw new Error("pipelineArray");
  for (const stage of value) {
    if (!stage || typeof stage !== "object" || Array.isArray(stage) || Object.keys(stage).length !== 1 || !/^\$[A-Za-z][A-Za-z0-9]*$/.test(Object.keys(stage)[0])) throw new Error("pipelineStage");
  }
  return value;
}

export function buildMongoPipeline(stages: MongoPipelineStage[], through = stages.length - 1): MongoPipeline {
  return parseMongoPipeline(
    JSON.stringify(
      stages
        .slice(0, through + 1)
        .filter((stage) => stage.enabled)
        .map((stage) => ({ [stage.operator]: parseMongoJson(stage.body) })),
    ),
  );
}

/** Only a final top-level output stage can write; nested output stages are invalid. */
export function mongoPipelineOutput(pipeline: MongoPipeline, database: string, depth = 0): MongoOutputTarget | null {
  if (depth > 32) throw new Error("Pipeline nesting exceeds 32 levels");
  let target: MongoOutputTarget | null = null;
  for (const [index, stage] of pipeline.entries()) {
    const operator = Object.keys(stage)[0];
    const body = stage[operator];
    if (operator === "$out" || operator === "$merge") {
      if (index !== pipeline.length - 1) throw new Error("outputLast");
      const into = operator === "$merge" && body && typeof body === "object" ? (body as Record<string, unknown>).into : body;
      const details = into && typeof into === "object" ? (into as Record<string, unknown>) : {};
      const collection = typeof into === "string" ? into : details.coll;
      const db = details.db ?? database;
      target = { database: validateMongoOutputName(db, "database"), collection: validateMongoOutputName(collection, "collection") };
    }
    const nested: unknown[] = [];
    if ((operator === "$lookup" || operator === "$unionWith") && body && typeof body === "object") nested.push((body as Record<string, unknown>).pipeline);
    if (operator === "$facet" && body && typeof body === "object") nested.push(...Object.values(body));
    for (const branch of nested) if (branch !== undefined && mongoPipelineOutput(parseMongoPipeline(JSON.stringify(branch)), database, depth + 1)) throw new Error("nestedOutput");
  }
  return target;
}

/** Prefix previews never execute $out / $merge, including when previewing the output stage. */
export function mongoPipelinePreview(pipeline: MongoPipeline, database: string): MongoPipeline {
  return mongoPipelineOutput(pipeline, database) ? pipeline.slice(0, -1) : pipeline;
}

export type MongoCodeLanguage = "mongosh" | "node" | "python" | "java" | "csharp";
export function mongoPipelineCode(language: MongoCodeLanguage, database: string, collection: string, pipeline: MongoPipeline): string {
  const json = JSON.stringify(pipeline, null, 2);
  const q = (value: string) => JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  // Encode EJSON as a string, then parse it with each driver's BSON-aware codec.
  if (language === "mongosh") return `const pipeline = EJSON.parse(${q(json)}, { relaxed: false });\ndb.getSiblingDB(${q(database)}).getCollection(${q(collection)}).aggregate(pipeline).forEach(document => print(EJSON.stringify(document, { relaxed: false })));\n`;
  if (language === "node")
    return `import { MongoClient, BSON } from "mongodb";\n\nconst client = new MongoClient(process.env.MONGODB_URI, { promoteValues: false });\ntry {\n  await client.connect();\n  const pipeline = BSON.EJSON.parse(${q(json)}, { relaxed: false });\n  const cursor = client.db(${q(database)}).collection(${q(collection)}).aggregate(pipeline);\n  for await (const document of cursor) console.log(BSON.EJSON.stringify(document, { relaxed: false }));\n} finally {\n  await client.close();\n}\n`;
  if (language === "python")
    return `import os\nfrom pymongo import MongoClient\nfrom bson import json_util\n\nwith MongoClient(os.environ["MONGODB_URI"]) as client:\n    pipeline = json_util.loads(${q(json)})\n    for document in client[${q(database)}][${q(collection)}].aggregate(pipeline):\n        print(json_util.dumps(document, json_options=json_util.CANONICAL_JSON_OPTIONS))\n`;
  // Java class-file UTF-8 constants are limited to 65,535 bytes. Keep each
  // string well below that bound (including modified UTF-8 surrogate encoding).
  const javaJson = json.length <= 12000 ? q(json) : `String.join("", ${Array.from({ length: Math.ceil(json.length / 12000) }, (_, index) => q(json.slice(index * 12000, (index + 1) * 12000))).join(",\n        ")})`;
  if (language === "java")
    return `import com.mongodb.client.*;\nimport org.bson.*;\nimport org.bson.json.*;\nimport java.util.*;\n\npublic class MongoQuery {\n  public static void main(String[] args) {\n    try (MongoClient client = MongoClients.create(System.getenv("MONGODB_URI"))) {\n      List<BsonDocument> pipeline = new ArrayList<>();\n      for (BsonValue stage : BsonArray.parse(${javaJson})) {\n        pipeline.add(stage.asDocument());\n      }\n      try (MongoCursor<Document> cursor = client.getDatabase(${q(database)}).getCollection(${q(collection)}).aggregate(pipeline).iterator()) {\n        while (cursor.hasNext()) System.out.println(cursor.next().toJson(JsonWriterSettings.builder().outputMode(JsonMode.EXTENDED).build()));\n      }\n    }\n  }\n}\n`;
  return `using MongoDB.Bson;\nusing MongoDB.Bson.Serialization;\nusing MongoDB.Bson.IO;\nusing MongoDB.Driver;\nusing System;\nusing System.Linq;\nusing System.Text;\n\nConsole.OutputEncoding = new UTF8Encoding(false);\nvar client = new MongoClient(Environment.GetEnvironmentVariable("MONGODB_URI"));\nvar collection = client.GetDatabase(${q(database)}).GetCollection<BsonDocument>(${q(collection)});\nvar stages = BsonSerializer.Deserialize<BsonArray>(${q(json)}).Select(stage => stage.AsBsonDocument).ToArray();\nusing var cursor = await collection.AggregateAsync<BsonDocument>(stages);\nwhile (await cursor.MoveNextAsync())\n    foreach (var document in cursor.Current) Console.WriteLine(document.ToJson(new JsonWriterSettings { OutputMode = JsonOutputMode.CanonicalExtendedJson }));\n`;
}
