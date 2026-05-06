import type { ForeignKeyInfo } from "@/types/database";

export type FieldLineageConfidence = "certain" | "likely" | "possible";
export type FieldLineageKind = "foreignKey" | "viewReference" | "historyReference" | "sameName";
export type FieldLineageDirection = "incoming" | "outgoing" | "reference";

export interface FieldLineageTarget {
  schema?: string;
  table: string;
  column: string;
}

export interface FieldLineageTable {
  schema?: string;
  name: string;
  columns: string[];
  foreignKeys?: ForeignKeyInfo[];
}

export interface FieldLineageView {
  schema?: string;
  name: string;
  ddl: string;
}

export interface FieldLineageHistory {
  id: string;
  sql: string;
  executed_at?: string;
}

export interface FieldLineageItem {
  id: string;
  kind: FieldLineageKind;
  confidence: FieldLineageConfidence;
  direction: FieldLineageDirection;
  title: string;
  description: string;
  schema?: string;
  table?: string;
  column?: string;
  sqlSnippet?: string;
}

export interface FieldLineageResult {
  target: FieldLineageTarget;
  items: FieldLineageItem[];
}

export function analyzeFieldLineage(options: {
  target: FieldLineageTarget;
  tables?: FieldLineageTable[];
  views?: FieldLineageView[];
  histories?: FieldLineageHistory[];
}): FieldLineageResult {
  const target = normalizeTarget(options.target);
  const items: FieldLineageItem[] = [
    ...foreignKeyLineage(target, options.tables ?? []),
    ...viewLineage(target, options.views ?? []),
    ...historyLineage(target, options.histories ?? []),
    ...sameNameLineage(target, options.tables ?? []),
  ];

  return { target: options.target, items };
}

export function summarizeLineageCounts(items: FieldLineageItem[]) {
  return {
    certain: items.filter((item) => item.confidence === "certain").length,
    likely: items.filter((item) => item.confidence === "likely").length,
    possible: items.filter((item) => item.confidence === "possible").length,
  };
}

export function identifierInSql(sql: string, identifier: string): boolean {
  const escaped = escapeRegExp(identifier);
  const quoted = [
    `"${escapeRegExp(identifier)}"`,
    `\`${escapeRegExp(identifier)}\``,
    `\\[${escapeRegExp(identifier)}\\]`,
  ];
  const pattern = `(?:${quoted.join("|")}|(?<![\\w$])${escaped}(?![\\w$]))`;
  return new RegExp(pattern, "i").test(sql);
}

function foreignKeyLineage(target: Required<FieldLineageTarget>, tables: FieldLineageTable[]): FieldLineageItem[] {
  const items: FieldLineageItem[] = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys ?? []) {
      const tableMatches = sameIdentifier(table.name, target.table) && schemaMatches(table.schema, target.schema);
      if (tableMatches && sameIdentifier(fk.column, target.column)) {
        items.push({
          id: `fk-out:${table.schema ?? ""}:${table.name}:${fk.name}:${fk.column}`,
          kind: "foreignKey",
          confidence: "certain",
          direction: "outgoing",
          title: `${table.name}.${fk.column} -> ${fk.ref_table}.${fk.ref_column}`,
          description: `Foreign key ${fk.name} references ${fk.ref_table}.${fk.ref_column}.`,
          schema: table.schema,
          table: fk.ref_table,
          column: fk.ref_column,
        });
      }

      if (sameIdentifier(fk.ref_table, target.table) && sameIdentifier(fk.ref_column, target.column)) {
        items.push({
          id: `fk-in:${table.schema ?? ""}:${table.name}:${fk.name}:${fk.column}`,
          kind: "foreignKey",
          confidence: "certain",
          direction: "incoming",
          title: `${table.name}.${fk.column} -> ${target.table}.${target.column}`,
          description: `Foreign key ${fk.name} points to this field.`,
          schema: table.schema,
          table: table.name,
          column: fk.column,
        });
      }
    }
  }
  return items;
}

function viewLineage(target: Required<FieldLineageTarget>, views: FieldLineageView[]): FieldLineageItem[] {
  return views
    .filter((view) => identifierInSql(view.ddl, target.column))
    .map((view) => {
      const confidence: FieldLineageConfidence = identifierInSql(view.ddl, target.table) ? "likely" : "possible";
      return {
        id: `view:${view.schema ?? ""}:${view.name}`,
        kind: "viewReference" as const,
        confidence,
        direction: "reference" as const,
        title: `${view.name} references ${target.column}`,
        description:
          confidence === "likely"
            ? `View definition mentions both ${target.table} and ${target.column}.`
            : `View definition mentions ${target.column}.`,
        schema: view.schema,
        table: view.name,
        sqlSnippet: snippetAround(view.ddl, target.column),
      };
    });
}

function historyLineage(target: Required<FieldLineageTarget>, histories: FieldLineageHistory[]): FieldLineageItem[] {
  return histories
    .filter((entry) => identifierInSql(entry.sql, target.column))
    .slice(0, 20)
    .map((entry) => {
      const confidence: FieldLineageConfidence = identifierInSql(entry.sql, target.table) ? "likely" : "possible";
      return {
        id: `history:${entry.id}`,
        kind: "historyReference" as const,
        confidence,
        direction: "reference" as const,
        title: confidence === "likely" ? "Query history references table and field" : "Query history references field",
        description: entry.executed_at ? `Executed at ${entry.executed_at}.` : "Found in query history.",
        sqlSnippet: snippetAround(entry.sql, target.column),
      };
    });
}

function sameNameLineage(target: Required<FieldLineageTarget>, tables: FieldLineageTable[]): FieldLineageItem[] {
  const items: FieldLineageItem[] = [];
  for (const table of tables) {
    if (sameIdentifier(table.name, target.table) && schemaMatches(table.schema, target.schema)) continue;
    for (const column of table.columns) {
      if (!sameIdentifier(column, target.column)) continue;
      items.push({
        id: `same:${table.schema ?? ""}:${table.name}:${column}`,
        kind: "sameName",
        confidence: "possible",
        direction: "reference",
        title: `${table.name}.${column}`,
        description:
          "Another field has the same name. This is a possible semantic relationship, not a verified dependency.",
        schema: table.schema,
        table: table.name,
        column,
      });
    }
  }
  return items.slice(0, 40);
}

function normalizeTarget(target: FieldLineageTarget): Required<FieldLineageTarget> {
  return {
    schema: target.schema ?? "",
    table: target.table,
    column: target.column,
  };
}

function sameIdentifier(left: string | undefined, right: string | undefined): boolean {
  return normalizeIdentifier(left) === normalizeIdentifier(right);
}

function schemaMatches(left: string | undefined, right: string | undefined): boolean {
  return normalizeIdentifier(left) === normalizeIdentifier(right);
}

function normalizeIdentifier(value: string | undefined): string {
  return (value ?? "").replace(/^[`"[]|[`"\]]$/g, "").toLowerCase();
}

function snippetAround(sql: string, needle: string): string {
  const index = sql.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return sql.slice(0, 180);
  const start = Math.max(0, index - 80);
  const end = Math.min(sql.length, index + needle.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < sql.length ? "..." : "";
  return `${prefix}${sql.slice(start, end)}${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
