import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ColumnInfo, IndexInfo } from "../../apps/desktop/src/types/database.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
});

test("table metadata loader deduplicates equivalent in-flight requests and caches the result", async () => {
  const columnsGate = deferred<ColumnInfo[]>();
  const indexes: IndexInfo[] = [{ name: "users_pkey", columns: ["id"], is_unique: true, is_primary: true }];
  const getColumns = vi.fn(() => columnsGate.promise);
  const listIndexes = vi.fn().mockResolvedValue(indexes);
  vi.doMock("@/lib/backend/api", () => ({ getColumns, listIndexes }));

  const { clearTableMetadataCache, loadTableMetadata } = await import("../../apps/desktop/src/lib/metadata/tableMetadataCache.ts");
  clearTableMetadataCache();

  const request = {
    connectionId: "conn",
    database: "app",
    schema: "public",
    tableName: "users",
    tableType: "TABLE",
    databaseType: "postgres",
    driverProfile: "postgres",
  };
  const first = loadTableMetadata(request);
  const second = loadTableMetadata(request);
  await vi.waitFor(() => assert.equal(listIndexes.mock.calls.length, 1));
  assert.equal(getColumns.mock.calls.length, 1);

  columnsGate.resolve([
    {
      name: "id",
      data_type: "integer",
      is_nullable: false,
      column_default: null,
      is_primary_key: true,
      extra: null,
    },
  ]);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult.metadata.primaryKeys, ["id"]);
  assert.equal(secondResult.metadata.columns.length, 1);
  assert.equal(listIndexes.mock.calls.length, 1);

  const cached = await loadTableMetadata(request);
  assert.equal(cached.cacheStatus, "hit");
  assert.equal(getColumns.mock.calls.length, 1);
});

test("table metadata invalidation keeps unrelated schemas cached", async () => {
  const getColumns = vi.fn(
    async (_connectionId: string, _database: string, _schema: string, table: string): Promise<ColumnInfo[]> => [
      {
        name: `${table}_id`,
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        extra: null,
      },
    ],
  );
  const listIndexes = vi.fn(async (): Promise<IndexInfo[]> => []);
  vi.doMock("@/lib/backend/api", () => ({ getColumns, listIndexes }));

  const { clearTableMetadataCache, getCachedTableMetadata, invalidateTableMetadataCache, loadTableMetadata } = await import("../../apps/desktop/src/lib/metadata/tableMetadataCache.ts");
  clearTableMetadataCache();

  const publicRequest = {
    connectionId: "conn",
    database: "app",
    schema: "public",
    tableName: "users",
    tableType: "TABLE",
    databaseType: "postgres",
    driverProfile: "postgres",
  };
  const auditRequest = { ...publicRequest, schema: "audit", tableName: "audit_log" };

  await loadTableMetadata(publicRequest);
  await loadTableMetadata(auditRequest);
  assert.equal(getColumns.mock.calls.length, 2);

  assert.equal(invalidateTableMetadataCache({ connectionId: "conn", database: "app", schema: "public" }), 1);
  assert.equal(getCachedTableMetadata(publicRequest), undefined);
  assert.equal(getCachedTableMetadata(auditRequest)?.metadata.tableName, "audit_log");
});
