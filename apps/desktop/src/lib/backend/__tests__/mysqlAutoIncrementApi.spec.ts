import { afterEach, describe, expect, it, vi } from "vitest";

import { getMysqlTableAutoIncrement } from "@/lib/backend/http";

describe("MySQL AUTO_INCREMENT web API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the table counter from the schema endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue("42"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMysqlTableAutoIncrement("connection 1", "sales/db", "order items")).resolves.toBe("42");
    expect(fetchMock).toHaveBeenCalledWith("/api/schema/mysql/auto-increment?connection_id=connection+1&database=sales%2Fdb&table=order+items");
  });
});
