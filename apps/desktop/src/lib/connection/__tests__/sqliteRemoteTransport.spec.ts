import { describe, expect, it } from "vitest";
import type { TransportLayerConfig } from "@/types/database";
import { insertSqliteRemoteTransportLayer, isSqliteRemoteTransportLayerType, sqliteRemoteTransportError } from "../sqliteRemoteTransport";

function layer(type: TransportLayerConfig["type"], enabled = true): Pick<TransportLayerConfig, "type" | "enabled"> {
  return { type, enabled };
}

describe("SQLite remote transport", () => {
  it("allows SSH and proxy layer types", () => {
    expect(isSqliteRemoteTransportLayerType("ssh")).toBe(true);
    expect(isSqliteRemoteTransportLayerType("proxy")).toBe(true);
    expect(isSqliteRemoteTransportLayerType("http_tunnel")).toBe(false);
  });

  it("accepts proxy layers before the final SSH hop", () => {
    expect(sqliteRemoteTransportError([layer("proxy"), layer("ssh")])).toBeNull();
    expect(sqliteRemoteTransportError([layer("proxy"), layer("ssh"), layer("ssh")])).toBeNull();
  });

  it("inserts a new proxy before an existing final SSH hop", () => {
    expect(insertSqliteRemoteTransportLayer([layer("proxy"), layer("ssh")], layer("proxy"))).toEqual([layer("proxy"), layer("proxy"), layer("ssh")]);
    expect(insertSqliteRemoteTransportLayer([layer("proxy")], layer("ssh"))).toEqual([layer("proxy"), layer("ssh")]);
  });

  it("requires the final enabled layer to be SSH", () => {
    expect(sqliteRemoteTransportError([layer("proxy")])).toBe("final_ssh");
    expect(sqliteRemoteTransportError([layer("ssh"), layer("proxy")])).toBe("final_ssh");
    expect(sqliteRemoteTransportError([layer("ssh"), layer("proxy", false)])).toBeNull();
  });

  it("rejects script HTTP tunnel layers", () => {
    expect(sqliteRemoteTransportError([layer("http_tunnel"), layer("ssh")])).toBe("http_tunnel");
  });
});
