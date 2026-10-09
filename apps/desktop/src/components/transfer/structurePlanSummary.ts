import type { TransferStructureOperation } from "@/lib/backend/api";

export interface TransferStructureOperationSummary {
  createdSchemas: number;
  createdTables: number;
  indexes: number;
  foreignKeys: number;
  sequences: number;
  comments: number;
  skippedTables: number;
  rebuiltTables: number;
}

export interface TransferStructureOperationDescription {
  key: string;
  values: Record<string, string>;
  suffixKey?: string;
}

/** Aggregate only the planner's structured operations; this deliberately does not inspect SQL. */
export function summarizeTransferStructureOperations(operations: readonly TransferStructureOperation[]): TransferStructureOperationSummary {
  const summary: TransferStructureOperationSummary = {
    createdSchemas: 0,
    createdTables: 0,
    indexes: 0,
    foreignKeys: 0,
    sequences: 0,
    comments: 0,
    skippedTables: 0,
    rebuiltTables: 0,
  };
  const sequenceNames = new Set<string>();
  let unnamedSequences = 0;

  for (const operation of operations) {
    switch (operation.kind) {
      case "createSchema":
        summary.createdSchemas += 1;
        break;
      case "createTable":
        summary.createdTables += 1;
        break;
      case "skipExistingTable":
        summary.skippedTables += 1;
        break;
      case "rebuildTable":
        summary.rebuiltTables += 1;
        break;
      case "createIndex":
        summary.indexes += 1;
        break;
      case "addForeignKey":
        summary.foreignKeys += 1;
        break;
      case "createSequence":
      case "bindSequence":
        if (operation.objectName) sequenceNames.add(operation.objectName);
        else unnamedSequences += 1;
        break;
      case "addComment":
        summary.comments += 1;
        break;
    }
  }

  summary.sequences = sequenceNames.size + unnamedSequences;
  return summary;
}

/** Convert an operation DTO into localized-message inputs without consulting SQL or UI state. */
export function describeTransferStructureOperation(operation: TransferStructureOperation): TransferStructureOperationDescription {
  const table = operation.targetTable ?? operation.sourceTable ?? "";
  const mappedTable = operation.sourceTable && operation.targetTable && operation.sourceTable !== operation.targetTable ? `${operation.sourceTable} → ${operation.targetTable}` : table;
  const objectName = operation.objectName ?? "";

  switch (operation.kind) {
    case "createSchema":
      return { key: "transfer.structureOperationCreateSchema", values: { name: objectName } };
    case "createTable":
      return { key: "transfer.structureOperationCreateTable", values: { name: mappedTable } };
    case "skipExistingTable":
      return {
        key: "transfer.structureOperationSkipExistingTable",
        values: { name: mappedTable },
        suffixKey: "transfer.structurePlanTargetAlreadyExists",
      };
    case "rebuildTable":
      return { key: "transfer.structureOperationRebuildTable", values: { name: mappedTable } };
    case "createIndex":
      return { key: "transfer.structureOperationCreateIndex", values: { name: objectName, table } };
    case "addForeignKey":
      return { key: "transfer.structureOperationAddForeignKey", values: { name: objectName, table } };
    case "createSequence":
      return { key: "transfer.structureOperationCreateSequence", values: { name: objectName } };
    case "bindSequence":
      return { key: "transfer.structureOperationBindSequence", values: { name: objectName, table } };
    case "addComment":
      return operation.objectName ? { key: "transfer.structureOperationAddColumnComment", values: { table, column: operation.objectName } } : { key: "transfer.structureOperationAddTableComment", values: { table } };
    default: {
      const exhaustiveCheck: never = operation.kind;
      return exhaustiveCheck;
    }
  }
}
