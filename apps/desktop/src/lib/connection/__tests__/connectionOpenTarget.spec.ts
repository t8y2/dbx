import { describe, expect, it } from "vitest";
import { quickConnectionOpenTarget } from "../connectionOpenTarget";

function config(dbType: string, database?: string) {
  return { db_type: dbType, database } as any;
}

describe("quickConnectionOpenTarget", () => {
  it("returns mq-admin for mq", () => {
    expect(quickConnectionOpenTarget(config("mq"))).toEqual({ kind: "mq-admin" });
  });

  it("returns nacos-admin for nacos", () => {
    expect(quickConnectionOpenTarget(config("nacos"))).toEqual({ kind: "nacos-admin" });
  });

  it("returns etcd/zookeeper admin kinds", () => {
    expect(quickConnectionOpenTarget(config("etcd"))).toEqual({ kind: "etcd" });
    expect(quickConnectionOpenTarget(config("zookeeper"))).toEqual({ kind: "zookeeper" });
  });

  it("returns ldap kind for ldap connections (no SQL editor)", () => {
    expect(quickConnectionOpenTarget(config("ldap"))).toEqual({ kind: "ldap" });
  });

  it("returns query kind with a resolved database for SQL connections", () => {
    const target = quickConnectionOpenTarget(config("mysql", "app_db"));
    expect(target).toEqual({ kind: "query", database: "app_db" });
  });
});
