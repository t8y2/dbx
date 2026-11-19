import { describe, expect, it } from "vitest";
import { buildColumnIndexMap, columnIndexCacheAction, columnIndexMetadataRequestCurrent, columnIndexNameKey, columnIndexTableIdentity } from "@/lib/dataGrid/dataGridColumnIndexIcon";
import type { IndexInfo } from "@/types/database";

function indexInfo(overrides: Partial<IndexInfo>): IndexInfo {
  return {
    name: "idx_users_email",
    columns: ["email"],
    is_unique: false,
    is_primary: false,
    ...overrides,
  };
}

describe("buildColumnIndexMap", () => {
  it("uses column metadata for custom-named and composite primary keys", () => {
    const map = buildColumnIndexMap([indexInfo({ name: "PK_USERS", columns: ["User_ID", "Tenant_ID"], is_unique: true }), indexInfo({ columns: ["user_id"] })], ["user_id", "tenant_id"]);

    expect(map.get(columnIndexNameKey("USER_ID"))).toBe("primary");
    expect(map.get(columnIndexNameKey("tenant_id"))).toBe("primary");
  });

  it("keeps the highest-priority kind with case-insensitive names", () => {
    const map = buildColumnIndexMap([indexInfo({ columns: ["Email"] }), indexInfo({ name: "uq_email", columns: ["email"], is_unique: true })]);
    expect(map.get(columnIndexNameKey("EMAIL"))).toBe("unique");
  });
});

describe("column index metadata request guard", () => {
  it("includes the full table identity and rejects stale responses", () => {
    const users = columnIndexTableIdentity({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "users",
    })!;
    const orders = columnIndexTableIdentity({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "orders",
    })!;

    expect(users).not.toBe(orders);
    expect(
      columnIndexMetadataRequestCurrent({
        requestGeneration: 2,
        currentGeneration: 2,
        requestIdentity: users,
        currentIdentity: users,
      }),
    ).toBe(true);
    expect(
      columnIndexMetadataRequestCurrent({
        requestGeneration: 2,
        currentGeneration: 3,
        requestIdentity: users,
        currentIdentity: users,
      }),
    ).toBe(false);
    expect(
      columnIndexMetadataRequestCurrent({
        requestGeneration: 2,
        currentGeneration: 2,
        requestIdentity: users,
        currentIdentity: orders,
      }),
    ).toBe(false);
  });
});

describe("column index cache action", () => {
  const users = columnIndexTableIdentity({
    connectionId: "c1",
    database: "db",
    schema: "public",
    tableName: "users",
  });
  const orders = columnIndexTableIdentity({
    connectionId: "c1",
    database: "db",
    schema: "public",
    tableName: "orders",
  });

  it("resets only when the table actually changes", () => {
    expect(columnIndexCacheAction(users, orders, true)).toBe("reset");
    expect(columnIndexCacheAction(undefined, users, false)).toBe("reset");
  });

  it("keeps loaded indexes visible while the same table refreshes", () => {
    // 手动刷新重新发布 tableMeta 时不能清空索引，否则表头标识会闪断（#12093）。
    expect(columnIndexCacheAction(users, users, true)).toBe("keep-refresh");
  });

  it("does nothing while the same table's first load is still pending", () => {
    expect(columnIndexCacheAction(users, users, false)).toBe("unchanged");
  });
});
