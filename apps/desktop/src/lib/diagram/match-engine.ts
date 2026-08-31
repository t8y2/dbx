import type { DiagramTable, DiagramRelationship } from "./erDiagram";
import type { InferredRelationship, MatchResult } from "@/types/diagram";
import { buildPrimaryKeyIndex, extractTableNameFromColumn, isTypeCompatible, toSnakeCase } from "./match-strategies";

export function buildRelationshipId(sourceTable: string, sourceColumn: string, targetTable: string, targetColumn: string): string {
  return ["inferred", sourceTable, sourceColumn, targetTable, targetColumn].join(":");
}

export function inferRelationships(tables: DiagramTable[]): InferredRelationship[] {
  const results: InferredRelationship[] = [];
  const tableNameSet = new Set(tables.map((t) => t.name));
  const primaryKeys = buildPrimaryKeyIndex(tables);

  for (const table of tables) {
    for (const column of table.columns) {
      if (column.is_primary_key) continue;

      const candidateTableName = extractTableNameFromColumn(column.name);
      if (!candidateTableName) continue;

      const candidateTable = toSnakeCase(candidateTableName);
      if (!tableNameSet.has(candidateTable)) {
        const partialMatch = tables.find((t) => t.name.toLowerCase().includes(candidateTableName.toLowerCase()));
        if (partialMatch) {
          const targetPK = primaryKeys.get(partialMatch.name);
          if (targetPK) {
            const strategy = isTypeCompatible(column.data_type, targetPK.data_type) ? "type_signature" : "naming_convention";
            const confidence = "medium";

            results.push({
              id: buildRelationshipId(table.name, column.name, partialMatch.name, targetPK.name),
              sourceTable: table.name,
              sourceColumn: column.name,
              targetTable: partialMatch.name,
              targetColumn: targetPK.name,
              confidence,
              strategy,
            });
          }
        }
        continue;
      }

      const targetPK = primaryKeys.get(candidateTable);
      if (!targetPK) continue;

      const strategy = isTypeCompatible(column.data_type, targetPK.data_type) ? "type_signature" : "naming_convention";
      const confidence = strategy === "type_signature" ? "high" : "high";

      results.push({
        id: buildRelationshipId(table.name, column.name, candidateTable, targetPK.name),
        sourceTable: table.name,
        sourceColumn: column.name,
        targetTable: candidateTable,
        targetColumn: targetPK.name,
        confidence,
        strategy,
      });
    }
  }

  return deduplicate(results);
}

function deduplicate(relationships: InferredRelationship[]): InferredRelationship[] {
  const seen = new Set<string>();
  const unique: InferredRelationship[] = [];

  for (const rel of relationships) {
    const key = `${rel.sourceTable}:${rel.sourceColumn}:${rel.targetTable}:${rel.targetColumn}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(rel);
    }
  }

  return unique;
}

export function filterByStorage(inferred: InferredRelationship[], confirms: string[], ignores: string[]): MatchResult {
  const confirmed = inferred.filter((r) => confirms.includes(r.id));
  const pending = inferred.filter((r) => !confirms.includes(r.id) && !ignores.includes(r.id));

  const conflictList = findConflicts(pending.filter((r) => r.confidence === "high"));
  const conflictIds = new Set(conflictList.map((r) => r.id));
  const actionablePending = pending.filter((r) => !conflictIds.has(r.id));

  return {
    relationships: [...confirmed, ...actionablePending],
    conflicts: conflictList,
    pending: actionablePending,
    stats: {
      total: inferred.length,
      high: inferred.filter((r) => r.confidence === "high").length,
      medium: inferred.filter((r) => r.confidence === "medium").length,
    },
  };
}

function findConflicts(relationships: InferredRelationship[]): InferredRelationship[] {
  const conflicts: InferredRelationship[] = [];
  const sourceMap = new Map<string, InferredRelationship[]>();

  for (const rel of relationships) {
    const key = `${rel.sourceTable}:${rel.sourceColumn}`;
    const existing = sourceMap.get(key) || [];
    existing.push(rel);
    sourceMap.set(key, existing);
  }

  for (const [, rels] of sourceMap) {
    if (rels.length > 1) {
      conflicts.push(...rels);
    }
  }

  return conflicts;
}

export function mergeRelationships(existing: DiagramRelationship[], inferred: InferredRelationship[]): (DiagramRelationship | InferredRelationship)[] {
  const existingIds = new Set(existing.map((r) => r.id));
  const merged: (DiagramRelationship | InferredRelationship)[] = [...existing];

  for (const rel of inferred) {
    if (!existingIds.has(rel.id)) {
      merged.push(rel);
    }
  }

  return merged;
}
