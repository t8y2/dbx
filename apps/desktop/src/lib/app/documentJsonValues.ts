import { isLosslessJsonNumber, parseJsonPreservingLargeNumbers, stringifyJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import { parseMongoDocumentInputValue, serializeMongoDocumentId, type MongoInputValue } from "@/lib/mongo/mongoDocumentValues";
import type { DocumentStoreKind } from "@/lib/app/documentStoreProvider";

export function parseDocumentStoreInputValue(raw: MongoInputValue, kind: DocumentStoreKind): unknown {
  if (kind === "mongodb") return parseMongoDocumentInputValue(raw);
  if (raw === null || typeof raw === "number" || typeof raw === "boolean") return raw;

  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return parseJsonPreservingLargeNumbers(trimmed);
  } catch {
    return trimmed;
  }
}

export function stringifyDocumentStoreValue(value: unknown, kind: DocumentStoreKind, indent?: number): string {
  return kind === "elasticsearch" ? stringifyJsonPreservingLargeNumbers(value, indent) : JSON.stringify(value, null, indent ?? undefined);
}

export function documentStoreValueForGrid(value: unknown, kind: DocumentStoreKind): MongoInputValue {
  if (kind === "elasticsearch" && isLosslessJsonNumber(value)) return value.raw;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return stringifyDocumentStoreValue(value, kind);
}

export function serializeDocumentStoreId(value: unknown, kind: DocumentStoreKind): string {
  return kind === "elasticsearch" ? String(value) : serializeMongoDocumentId(value);
}
