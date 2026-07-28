import { describe, expect, it } from "vitest";
import { quickConnectionOpenTarget } from "@/lib/connection/connectionOpenTarget";
import type { ConnectionConfig } from "@/types/database";

function connection(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return {
    id: "conn",
    name: "conn",
    db_type: dbType,
    host: "127.0.0.1",
    port: 0,
    user: "",
    password: "",
    database: "",
    readonly: false,
    read_only: false,
    ssl_mode: "disabled",
    color: "#888",
  } as ConnectionConfig;
}

describe("quickConnectionOpenTarget", () => {
  it("opens message queue connections in the MQ admin console", () => {
    expect(quickConnectionOpenTarget(connection("mq"))).toEqual({ kind: "mq-admin" });
  });

  it("opens Nacos connections in the Nacos admin console", () => {
    expect(quickConnectionOpenTarget(connection("nacos"))).toEqual({ kind: "nacos-admin" });
  });

  it("opens Etcd connections in the key browser", () => {
    expect(quickConnectionOpenTarget(connection("etcd"))).toEqual({ kind: "etcd" });
  });

  it("opens ZooKeeper connections in the key browser", () => {
    expect(quickConnectionOpenTarget(connection("zookeeper"))).toEqual({ kind: "zookeeper" });
  });

  it("opens regular connections in a query tab", () => {
    expect(quickConnectionOpenTarget({ ...connection("postgresql"), database: "app" })).toEqual({
      kind: "query",
      database: "app",
    });
  });
});
