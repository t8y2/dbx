import { describe, expect, it } from "vitest";
import { batchResultInsertRequest } from "../queryResultBatchInsert";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { QueryMetadataPatch } from "@/stores/queryStore";
import type { QueryResult } from "@/types/database";

const options: DataGridExtractorOptions = structuredClone(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);

function metadata(): QueryMetadataPatch {
  return {
    queryAnalysis: { schema: undefined, tableName: "menus", tableAlias: "mn", selectStar: true, columns: [], allowInsert: true, allowInsertDelete: false },
    tableMeta: {
      tableName: "menus",
      primaryKeys: ["id"],
      columns: [
        { name: "id", data_type: "int", is_nullable: false },
        { name: "name", data_type: "varchar(100)", is_nullable: false },
      ],
    },
  };
}

describe("batch result INSERT requests", () => {
  it("derives SELECT * columns from table metadata", () => {
    const result: QueryResult = {
      columns: ["id", "name"],
      rows: [[1, "root"]],
      sourceStatement: "SELECT * FROM menus mn LIMIT 100",
    };

    const request = batchResultInsertRequest(result, metadata(), "mysql", "`", options);

    expect(request?.columns.map((column) => column.sourceName)).toEqual(["id", "name"]);
    expect(request?.rows).toEqual([[1, "root"]]);
  });

  it("allows INSERT generation when the table has no primary key metadata", () => {
    const result: QueryResult = {
      columns: ["id", "name"],
      rows: [[1, "root"]],
      sourceStatement: "SELECT * FROM menus mn LIMIT 100",
    };
    const noKeyMetadata = metadata();
    noKeyMetadata.queryAnalysis = undefined;
    noKeyMetadata.tableMeta!.primaryKeys = [];

    expect(batchResultInsertRequest(result, noKeyMetadata, "mysql", "`", options)?.rows).toEqual([[1, "root"]]);
  });

  it("keeps an aliased projection mapped to its source column", () => {
    const result: QueryResult = {
      columns: ["id"],
      rows: [["root"]],
      sourceStatement: "SELECT name AS id FROM menus",
    };
    const aliasedMetadata = { ...metadata(), querySourceColumns: ["name"] };

    expect(batchResultInsertRequest(result, aliasedMetadata, "mysql", "`", options)?.columns[0]?.sourceName).toBe("name");
  });

  it("rejects a joined result even when metadata has a mapping", () => {
    const result: QueryResult = {
      columns: ["id", "name"],
      rows: [[1, "root"]],
      sourceStatement: "SELECT m.id, u.name FROM menus m JOIN users u ON u.id = m.user_id",
    };
    const joinedMetadata = { ...metadata(), queryAnalysis: { ...metadata().queryAnalysis!, multiSource: true } };

    expect(batchResultInsertRequest(result, joinedMetadata, "mysql", "`", options)).toBeUndefined();
  });
});
