import { describe, expect, it } from "vitest";
import type { ConnectionConfig, InstalledPlugin } from "@/types/database";
import { fixedS3Bucket, hasS3SyncPlugin, s3SyncConnections, s3SyncObjectUri, S3_SYNC_PLUGIN_ID } from "./s3Sync";

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "s3-1",
    name: "S3",
    db_type: "plugin",
    host: "",
    port: 0,
    username: "key",
    password: "",
    plugin_id: S3_SYNC_PLUGIN_ID,
    plugin_connection_provider: "io.github.t8y2.s3.connection",
    plugin_connection_type: "s3",
    ...overrides,
  } as ConnectionConfig;
}

describe("S3 sync helpers", () => {
  it("only exposes compatible official plugin installations", () => {
    const plugin = (compatible: boolean) => ({ manifest: { id: S3_SYNC_PLUGIN_ID }, compatibility: { compatible } }) as InstalledPlugin;
    expect(hasS3SyncPlugin([plugin(true)])).toBe(true);
    expect(hasS3SyncPlugin([plugin(false)])).toBe(false);
  });

  it("filters official S3 connections and honors a connection-fixed bucket", () => {
    const fixed = connection({ id: "fixed", name: "Beta", database: " archive " });
    const selectable = connection({ id: "selectable", name: "Alpha" });
    const foreign = connection({ id: "foreign", plugin_id: "example.s3" });
    expect(s3SyncConnections([fixed, foreign, selectable]).map(({ id }) => id)).toEqual(["selectable", "fixed"]);
    expect(fixedS3Bucket(fixed)).toBe("archive");
    expect(fixedS3Bucket(selectable)).toBe("");
  });

  it("builds an encoded object URI from the selected bucket and path", () => {
    expect(s3SyncObjectUri("bucket", "/DBX/sync snapshot.json")).toBe("s3://bucket/DBX/sync%20snapshot.json");
    expect(s3SyncObjectUri("", "snapshot.json")).toBe("");
  });
});
