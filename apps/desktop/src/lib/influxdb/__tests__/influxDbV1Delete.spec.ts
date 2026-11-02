import { describe, expect, it } from "vitest";
import type { ColumnInfo, ConnectionConfig } from "@/types/database";
import { getDatabaseCapability } from "@/lib/database/databaseTableDataCapabilities";
import { buildInfluxDbV1DeleteStatements, canDeleteInfluxDbV1Row, INFLUXDB_V1_AMBIGUOUS_COLUMN_EXTRA, INFLUXDB_V1_FIELD_COLUMN_EXTRA, INFLUXDB_V1_TAG_COLUMN_EXTRA, INFLUXDB_V1_TIME_COLUMN_EXTRA, isInfluxDbV1Connection, resolveInfluxDbV1DeleteTarget } from "@/lib/influxdb/influxDbV1Delete";

function connection(version?: unknown, url_params?: string): Pick<ConnectionConfig, "db_type" | "external_config" | "url_params"> {
  return {
    db_type: "influxdb",
    external_config: version === undefined ? undefined : { version },
    url_params,
  };
}

function column(name: string, role: string, primary = false): ColumnInfo {
  return {
    name,
    data_type: role === INFLUXDB_V1_TIME_COLUMN_EXTRA ? "timestamp" : "string",
    is_nullable: role !== INFLUXDB_V1_TIME_COLUMN_EXTRA,
    column_default: null,
    is_primary_key: primary,
    extra: role,
  };
}

const metadata = [column("time", INFLUXDB_V1_TIME_COLUMN_EXTRA, true), column("host", INFLUXDB_V1_TAG_COLUMN_EXTRA, true), column("region", INFLUXDB_V1_TAG_COLUMN_EXTRA, true), column("usage", INFLUXDB_V1_FIELD_COLUMN_EXTRA)];

function target(options: { measurement?: string; tableColumns?: ColumnInfo[]; resultColumns?: string[]; version?: unknown; urlParams?: string } = {}) {
  const resolved = resolveInfluxDbV1DeleteTarget({
    connection: connection(options.version, options.urlParams),
    measurement: options.measurement ?? "cpu",
    tableColumns: options.tableColumns ?? metadata,
    resultColumns: options.resultColumns ?? ["time", "host", "region", "usage"],
  });
  if (!resolved) throw new Error("expected a safe InfluxDB delete target");
  return resolved;
}

function changes(rows: Array<Array<string | number | boolean | null>>, deletedRows = new Set([0])) {
  return {
    dirtyRows: new Map<number, Map<number, string | number | boolean | null>>(),
    newRows: [],
    deletedRows,
    columns: ["time", "host", "region", "usage"],
    rows,
  };
}

describe("InfluxDB 1.x result-grid delete", () => {
  it("is gated to explicit or legacy-v1 InfluxDB connections", () => {
    expect(getDatabaseCapability("influxdb").tableData).toMatchObject({ insert: false, existingRowsReadonly: true, readonly: true });
    expect(isInfluxDbV1Connection(connection())).toBe(true);
    expect(isInfluxDbV1Connection(connection("1"))).toBe(true);
    expect(isInfluxDbV1Connection(connection("V1"))).toBe(true);
    expect(isInfluxDbV1Connection(connection(1))).toBe(true);
    expect(isInfluxDbV1Connection(connection("2"))).toBe(false);
    expect(isInfluxDbV1Connection(connection("V2"))).toBe(false);
    expect(isInfluxDbV1Connection(connection("3"))).toBe(false);
    expect(isInfluxDbV1Connection({ ...connection("1"), db_type: "influxdb3" })).toBe(false);
    expect(isInfluxDbV1Connection({ ...connection("1"), db_type: "victoriametrics" })).toBe(false);
  });

  it("requires explicit metadata roles, one time column, every tag, and an unmodified result shape", () => {
    expect(resolveInfluxDbV1DeleteTarget({ connection: connection("1"), measurement: "cpu", tableColumns: metadata, resultColumns: ["time", "host", "region", "usage"] })).toBeDefined();
    expect(resolveInfluxDbV1DeleteTarget({ connection: connection("2"), measurement: "cpu", tableColumns: metadata, resultColumns: ["time", "host", "region", "usage"] })).toBeUndefined();
    expect(resolveInfluxDbV1DeleteTarget({ connection: connection("1"), measurement: "cpu", tableColumns: metadata, resultColumns: ["time", "host", "usage"] })).toBeUndefined();
    expect(resolveInfluxDbV1DeleteTarget({ connection: connection("1"), measurement: "cpu", tableColumns: metadata, resultColumns: ["time", "host", "region", "computed"] })).toBeUndefined();
    expect(resolveInfluxDbV1DeleteTarget({ connection: connection("1"), measurement: "cpu", tableColumns: metadata, resultColumns: ["time", "host", "host", "region", "usage"] })).toBeUndefined();
    expect(
      resolveInfluxDbV1DeleteTarget({
        connection: connection("1"),
        measurement: "cpu",
        tableColumns: metadata.map((item) => ({ ...item, extra: item.name === "host" ? null : item.extra })),
        resultColumns: ["time", "host", "region", "usage"],
      }),
    ).toBeUndefined();
    expect(
      resolveInfluxDbV1DeleteTarget({
        connection: connection("1"),
        measurement: "cpu",
        tableColumns: metadata.map((item) => ({ ...item, extra: item.name === "host" ? INFLUXDB_V1_AMBIGUOUS_COLUMN_EXTRA : item.extra })),
        resultColumns: ["time", "host", "region", "usage"],
      }),
    ).toBeUndefined();
    expect(
      resolveInfluxDbV1DeleteTarget({
        connection: connection("1"),
        measurement: "cpu",
        tableColumns: metadata.map((item) => ({ ...item, is_primary_key: item.name === "host" ? false : item.is_primary_key })),
        resultColumns: ["time", "host", "region", "usage"],
      }),
    ).toBeUndefined();
  });

  it("quotes identifiers and tag literals and builds one guarded statement per selected row", () => {
    const deleteTarget = target({ measurement: 'cpu" load\\prod' });
    const statements = buildInfluxDbV1DeleteStatements(
      deleteTarget,
      changes(
        [
          ["2026-09-27T10:11:12.123456789Z", "web'01", "us\\west", "field value must not appear"],
          ["2026-09-27T10:11:13+08:00", "web02", "cn", "DELETE FROM other"],
        ],
        new Set([1, 0]),
      ),
    );

    expect(statements).toEqual([
      "DELETE FROM \"cpu\\\" load\\\\prod\" WHERE (time = '2026-09-27T10:11:12.123456789Z' AND \"host\" = 'web\\'01' AND \"region\" = 'us\\\\west');",
      'DELETE FROM "cpu\\" load\\\\prod" WHERE (time = \'2026-09-27T10:11:13+08:00\' AND "host" = \'web02\' AND "region" = \'cn\');',
    ]);
    expect(statements.join("\n")).not.toContain("field value must not appear");
    expect(statements.join("\n")).not.toContain("DELETE FROM other");
  });

  it("accepts exact nanosecond epoch values but rejects lossy or unsafe numeric time values", () => {
    const nanosecondTarget = target({ urlParams: "epoch=ns" });
    expect(buildInfluxDbV1DeleteStatements(nanosecondTarget, changes([["1727431200123456789", "web01", "us", 10]]))).toEqual(['DELETE FROM "cpu" WHERE (time = 1727431200123456789 AND "host" = \'web01\' AND "region" = \'us\');']);
    expect(canDeleteInfluxDbV1Row(nanosecondTarget, [1_727_431_200, "web01", "us", 10])).toBe(true);
    expect(canDeleteInfluxDbV1Row(target({ urlParams: "epoch=ms" }), [1_727_431_200_123, "web01", "us", 10])).toBe(false);
    expect(canDeleteInfluxDbV1Row(target(), [1_727_431_200, "web01", "us", 10])).toBe(false);
    expect(canDeleteInfluxDbV1Row(nanosecondTarget, [Number.MAX_SAFE_INTEGER + 1, "web01", "us", 10])).toBe(false);
    expect(canDeleteInfluxDbV1Row(nanosecondTarget, ["9223372036854775807", "web01", "us", 10])).toBe(false);
  });

  it("allows a tagless measurement to use measurement plus time as its complete identity", () => {
    const taglessMetadata = [column("time", INFLUXDB_V1_TIME_COLUMN_EXTRA, true), column("value", INFLUXDB_V1_FIELD_COLUMN_EXTRA)];
    const deleteTarget = target({ tableColumns: taglessMetadata, resultColumns: ["time", "value"] });
    const taglessChanges = changes([["2026-09-27T10:11:12Z", 42]]);
    taglessChanges.columns = ["time", "value"];

    expect(buildInfluxDbV1DeleteStatements(deleteTarget, taglessChanges)).toEqual(["DELETE FROM \"cpu\" WHERE (time = '2026-09-27T10:11:12Z');"]);
  });

  it.each([
    { label: "null time", row: [null, "web01", "us", 10] },
    { label: "invalid timestamp", row: ["2026-02-30T00:00:00Z", "web01", "us", 10] },
    { label: "out-of-range timestamp", row: ["1600-01-01T00:00:00Z", "web01", "us", 10] },
    { label: "missing tag", row: ["2026-09-27T10:11:12Z", "web01", null, 10] },
    { label: "non-string tag", row: ["2026-09-27T10:11:12Z", "web01", 7, 10] },
    { label: "short row", row: ["2026-09-27T10:11:12Z", "web01", "us"] },
  ])("fails closed for $label", ({ row }) => {
    expect(canDeleteInfluxDbV1Row(target(), row)).toBe(false);
    expect(() => buildInfluxDbV1DeleteStatements(target(), changes([row]))).toThrow(/Cannot safely delete/);
  });

  it("rejects duplicate point targets even when their field values differ", () => {
    expect(() =>
      buildInfluxDbV1DeleteStatements(
        target(),
        changes(
          [
            ["2026-09-27T10:11:12Z", "web01", "us", 10],
            ["2026-09-27T10:11:12Z", "web01", "us", 99],
          ],
          new Set([0, 1]),
        ),
      ),
    ).toThrow(/duplicate target/);
  });

  it("rejects stale or invalid selected row indexes", () => {
    const rows = [["2026-09-27T10:11:12Z", "web01", "us", 10]];
    expect(() => buildInfluxDbV1DeleteStatements(target(), changes(rows, new Set([2])))).toThrow(/no longer present/);
    expect(() => buildInfluxDbV1DeleteStatements(target(), changes(rows, new Set([-1])))).toThrow(/invalid row index/);
  });

  it("rejects any attempt to route inserts or updates through the delete-only path", () => {
    const update = changes([["2026-09-27T10:11:12Z", "web01", "us", 10]]);
    update.dirtyRows.set(0, new Map([[3, 11]]));
    expect(() => buildInfluxDbV1DeleteStatements(target(), update)).toThrow(/delete-only/);

    const insert = changes([["2026-09-27T10:11:12Z", "web01", "us", 10]]);
    insert.newRows.push(["2026-09-27T10:11:13Z", "web02", "us", 11]);
    expect(() => buildInfluxDbV1DeleteStatements(target(), insert)).toThrow(/delete-only/);
  });
});
