import { describe, expect, it } from "vitest";
import { withYashanGeometrySrids } from "@/lib/dataGrid/dataGridSaveSpatial";
import type { DataGridSaveStatementOptions } from "@/lib/dataGrid/dataGridSql";

function options(): DataGridSaveStatementOptions {
  return {
    databaseType: "yashandb",
    tableMeta: {
      schema: "APP",
      tableName: "GEO",
      primaryKeys: ["ID"],
      columns: [
        { name: "ID", data_type: "INTEGER", is_nullable: false },
        { name: "GEOM", data_type: "ST_GEOMETRY", is_nullable: true },
      ],
    },
    columns: ["ID", "GEOM"],
    rows: [
      [1, "POINT(1 2)"],
      [2, "POINT(3 4)"],
      [3, "POINT(5 6)"],
    ],
    dirtyRows: [[0, [[1, "POINT(7 8)"]]]],
    deletedRows: [1],
    newRows: [[4, "POINT(9 10)"]],
  };
}

const meta = {
  databaseType: "yashandb" as const,
  columnTypes: ["INTEGER", "MDSYS.ST_GEOMETRY"],
  spatialColumns: [{ column_index: 1, srid: 4326 }],
  spatialValues: [
    [null, 4326],
    [null, 3857],
    [null, null],
  ],
};

describe("withYashanGeometrySrids", () => {
  it("embeds per-cell SRIDs for dirty and deleted rows", () => {
    const result = withYashanGeometrySrids(options(), meta);
    expect(result.rows[0]?.[1]).toBe("SRID=4326;POINT(1 2)");
    expect(result.rows[1]?.[1]).toBe("SRID=3857;POINT(3 4)");
    expect(result.dirtyRows[0]?.[1][0]?.[1]).toBe("SRID=4326;POINT(7 8)");
  });

  it("leaves untouched rows and non-geometry values alone", () => {
    const source = options();
    const result = withYashanGeometrySrids(source, meta);
    expect(result.rows[2]).toBe(source.rows[2]);
    expect(result.rows[2]?.[1]).toBe("POINT(5 6)");
    expect(result.rows[0]?.[0]).toBe(1);
  });

  it("uses the column-level hint for new rows", () => {
    const result = withYashanGeometrySrids(options(), meta);
    expect(result.newRows[0]?.[1]).toBe("SRID=4326;POINT(9 10)");
  });

  it("preserves explicit EWKT and skips non-WKT values", () => {
    const source = options();
    source.rows[0] = [1, "SRID=3857;POINT(1 2)"];
    source.newRows = [[4, "0x0101000000"]];
    const result = withYashanGeometrySrids(source, meta);
    expect(result.rows[0]?.[1]).toBe("SRID=3857;POINT(1 2)");
    expect(result.newRows[0]?.[1]).toBe("0x0101000000");
  });

  it("does nothing for other databases", () => {
    const source = options();
    const result = withYashanGeometrySrids(source, { ...meta, databaseType: "postgres" });
    expect(result).toBe(source);
  });
});
