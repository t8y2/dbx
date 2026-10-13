import { mongoExtendedJsonValueType } from "./mongoDocumentValues";
import type { MongoCompareDocument } from "./mongoCompare";

export interface MongoSchemaField {
  path: string;
  segments: (string | null)[];
  documents: number;
  missing: number;
  occurrences: number;
  types: Record<string, number>;
  examples: string[];
}
export interface MongoSchemaAnalysis {
  documentCount: number;
  totalDocuments: number;
  truncated: boolean;
  fields: MongoSchemaField[];
  depthLimited: boolean;
  fieldLimited: boolean;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return mongoExtendedJsonValueType(value) ?? typeof value;
}
function label(segments: (string | null)[]): string {
  return "$" + segments.map((part) => (part === null ? "[]" : `[${JSON.stringify(part)}]`)).join("");
}

/** Presence is counted once per root document, even for repeated array elements. */
export function analyzeMongoSchema(documents: MongoCompareDocument[], includeExamples = false, totalDocuments = documents.length, truncated = false): MongoSchemaAnalysis {
  const fields = new Map<string, MongoSchemaField>();
  const result: MongoSchemaAnalysis = { documentCount: documents.length, totalDocuments, truncated, fields: [], depthLimited: false, fieldLimited: false };
  for (const document of documents) {
    const seen = new Set<string>();
    function visit(value: unknown, segments: (string | null)[]) {
      if (segments.length > 32) {
        result.depthLimited = true;
        return;
      }
      const key = JSON.stringify(segments);
      let field = fields.get(key);
      if (!field) {
        if (fields.size >= 10000) {
          result.fieldLimited = true;
          return;
        }
        field = { path: label(segments), segments, documents: 0, missing: 0, occurrences: 0, types: {}, examples: [] };
        fields.set(key, field);
      }
      if (!seen.has(key)) {
        field.documents++;
        seen.add(key);
      }
      field.occurrences++;
      const type = typeOf(value);
      field.types[type] = (field.types[type] ?? 0) + 1;
      if (includeExamples && field.examples.length < 3 && type !== "object" && type !== "array") {
        const example = JSON.stringify(value).slice(0, 160);
        if (!field.examples.includes(example)) field.examples.push(example);
      }
      if (Array.isArray(value)) for (const child of value) visit(child, [...segments, null]);
      else if (type === "object") for (const [name, child] of Object.entries(value as object)) visit(child, [...segments, name]);
    }
    for (const [name, value] of Object.entries(document)) visit(value, [name]);
  }
  result.fields = [...fields.values()].map((field) => ({ ...field, missing: documents.length - field.documents })).sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
