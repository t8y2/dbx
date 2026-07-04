import { describe, expect, it } from "vitest";
import { zookeeperDelete, zookeeperGet, zookeeperListPrefix, zookeeperPut, type KvListPrefixOptions, type KvPutOptions, type KvPutResponse } from "@/lib/backend/api";
import type { DatabaseType } from "@/types/database";

describe("zookeeper frontend API contract", () => {
  it("exposes the zookeeper database type and KV put options", () => {
    const dbType: DatabaseType = "zookeeper";
    const options: KvPutOptions = {
      writeMode: "create",
      createMode: "ephemeral_sequential",
    };
    const response: KvPutResponse = {
      key: "/sessions/member-0000000001",
      createdKey: "/sessions/member-0000000001",
    };
    const listOptions: KvListPrefixOptions = {
      recursive: false,
    };

    expect(dbType).toBe("zookeeper");
    expect(options.createMode).toBe("ephemeral_sequential");
    expect(listOptions.recursive).toBe(false);
    expect(response.createdKey).toBe(response.key);
    expect(typeof zookeeperListPrefix).toBe("function");
    expect(typeof zookeeperGet).toBe("function");
    expect(typeof zookeeperPut).toBe("function");
    expect(typeof zookeeperDelete).toBe("function");
  });
});
