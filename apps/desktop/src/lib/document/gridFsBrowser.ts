import { buildDocumentFilterCondition, combineDocumentFilterConditions, defaultDocumentFilterRule, type DocumentFilterRule } from "@/lib/app/documentStoreProvider";
import { formatMongoShellLiteral } from "@/lib/mongo/mongoDocumentValues";
import { quoteUnquotedObjectKeys } from "@/lib/mongo/mongoShellCommand";

export type GridFsBucketSortField = "name" | "fileCount" | "totalBytes";
export type GridFsBucketSortDirection = "asc" | "desc";
export type GridFsSortDirectionState = "none" | "asc" | "desc";
export type GridFsFileField = "_id" | "filename" | "contentType" | "length" | "chunkSize" | "uploadDate" | "md5";
export type GridFsFileFieldDisplayOption = { fieldName: GridFsFileField; label: string; labelKey?: never } | { fieldName: GridFsFileField; labelKey: string; label?: never };
export type GridFsBucketSort = {
  field: GridFsBucketSortField;
  direction: GridFsBucketSortDirection;
};

export const gridFsFileFilterFieldOptions = ["_id", "filename", "contentType", "length", "chunkSize", "uploadDate", "md5"] as const satisfies readonly GridFsFileField[];
export const gridFsFileFieldDisplayOptions = [
  { fieldName: "_id", label: "ID" },
  { fieldName: "filename", labelKey: "gridfsBrowser.name" },
  { fieldName: "contentType", labelKey: "gridfsBrowser.contentType" },
  { fieldName: "length", labelKey: "gridfsBrowser.totalSize" },
  { fieldName: "chunkSize", labelKey: "gridfsBrowser.chunkSize" },
  { fieldName: "uploadDate", labelKey: "gridfsBrowser.uploadDate" },
  { fieldName: "md5", label: "MD5" },
] as const satisfies readonly GridFsFileFieldDisplayOption[];

export function gridFsFilesQueryPreview(options: { bucket: string; filterJson?: string; sortJson?: string }): string {
  const parts = [`db.getCollection(${JSON.stringify(`${options.bucket}.files`)}).find(${mongoShellPreviewLiteral(options.filterJson || "{}")})`];
  if (options.sortJson?.trim()) parts.push(`.sort(${mongoShellPreviewLiteral(options.sortJson)})`);
  return parts.join("");
}

export function currentGridFsBucketFilter(input: string): string | undefined {
  const trimmed = input.trim();
  return trimmed || undefined;
}

export function createGridFsFileFilterRule(id: string): DocumentFilterRule {
  return defaultDocumentFilterRule(id, gridFsFileFilterFieldOptions[0] ?? "");
}

export function gridFsFileFieldDisplayOption(fieldName: string): GridFsFileFieldDisplayOption | null {
  return gridFsFileFieldDisplayOptions.find((option) => option.fieldName === fieldName) ?? null;
}

export function buildGridFsFilesStructuredFilter(rules: DocumentFilterRule[]): Record<string, unknown> | null {
  const items = rules
    .map((rule) => ({
      rule,
      condition: buildDocumentFilterCondition(rule, { kind: "mongodb" }),
    }))
    .filter((item): item is { rule: DocumentFilterRule; condition: Record<string, unknown> } => !!item.condition);
  return combineDocumentFilterConditions(
    items.map((item) => item.condition),
    items.map((item) => item.rule),
  );
}

export function parseGridFsBucketSort(input?: string): GridFsBucketSort | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(quoteUnquotedObjectKeys(trimmed)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GridFS bucket sort must be a JSON object");
  }
  const entries = Object.entries(parsed);
  if (entries.length !== 1) {
    throw new Error("GridFS bucket sort must contain exactly one field");
  }
  const [field, rawDirection] = entries[0]!;
  if (field !== "name" && field !== "fileCount" && field !== "totalBytes") {
    throw new Error("Unsupported GridFS bucket sort field");
  }
  const direction = normalizeGridFsBucketSortDirection(rawDirection);
  if (!direction) {
    throw new Error("GridFS bucket sort direction must be 1, -1, 'asc', or 'desc'");
  }
  return { field, direction };
}

export function currentGridFsBucketSort(input: string): string | undefined {
  const sort = parseGridFsBucketSort(input);
  if (!sort) return undefined;
  return JSON.stringify({ [sort.field]: sort.direction === "desc" ? -1 : 1 });
}

export function currentGridFsFileSortDirection(input: string, column: string): GridFsSortDirectionState {
  const sort = parseSingleFieldSort(input);
  if (!sort || sort.field !== column) return "none";
  return sort.direction;
}

export function currentGridFsBucketSortDirection(input: string, column: GridFsBucketSortField): GridFsSortDirectionState {
  try {
    const sort = parseGridFsBucketSort(input);
    if (!sort || sort.field !== column) return "none";
    return sort.direction;
  } catch {
    return "none";
  }
}

export function gridFsBucketSortInputForColumn(column: string, direction: GridFsBucketSortDirection | null): string {
  if (!direction) return "";
  if (column !== "name" && column !== "fileCount" && column !== "totalBytes") return "";
  return JSON.stringify({ [column]: direction === "desc" ? -1 : 1 });
}

function normalizeGridFsBucketSortDirection(value: unknown): GridFsBucketSortDirection | null {
  if (value === -1 || value === "-1" || value === "desc") return "desc";
  if (value === 1 || value === "1" || value === "asc") return "asc";
  return null;
}

function parseSingleFieldSort(input?: string): { field: string; direction: GridFsBucketSortDirection } | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(quoteUnquotedObjectKeys(trimmed)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length !== 1) return null;
    const [field, rawDirection] = entries[0]!;
    const direction = normalizeGridFsBucketSortDirection(rawDirection);
    if (!direction) return null;
    return { field, direction };
  } catch {
    return null;
  }
}

function mongoShellPreviewLiteral(json: string): string {
  const trimmed = json.trim();
  if (!trimmed) return "{}";
  try {
    return formatMongoShellLiteral(JSON.parse(quoteUnquotedObjectKeys(trimmed)));
  } catch {
    return trimmed;
  }
}
