import { describe, expect, it } from "vitest";
import {
  encodeSpannerResourcePath,
  spannerSchemaDisplayName,
  formatSpannerResourcePath,
  hasSpannerResourcePath,
  isSpannerConnection,
  normalizeSpannerConnection,
  parseSpannerResourcePath,
  spannerDisplayDatabase,
  spannerResourceParts,
  withSpannerResourcePart,
} from "@/lib/connection/spannerResourcePath";

const RESOURCE_PATH = "projects/p1/instances/i1/databases/db1";

describe("spannerResourcePath", () => {
  it("detects Cloud Spanner connections", () => {
    expect(isSpannerConnection({ db_type: "spanner" })).toBe(true);
    expect(isSpannerConnection({ db_type: "bigquery" })).toBe(false);
  });

  it("parses a standard resource path", () => {
    expect(parseSpannerResourcePath(RESOURCE_PATH)).toEqual({ project: "p1", instance: "i1", database: "db1" });
  });

  it("tolerates surrounding whitespace, leading and trailing slashes, and keyword casing", () => {
    expect(parseSpannerResourcePath("  /projects/p1/instances/i1/databases/db1/  ")).toEqual({ project: "p1", instance: "i1", database: "db1" });
    expect(parseSpannerResourcePath("Projects/p1/Instances/i1/Databases/db1")).toEqual({ project: "p1", instance: "i1", database: "db1" });
  });

  it("rejects paths that are not exactly project/instance/database", () => {
    expect(parseSpannerResourcePath("projects/p1/databases/db1")).toBeUndefined();
    expect(parseSpannerResourcePath("projects/p1/instances/i1/databases/db1/backups/b1")).toBeUndefined();
    expect(parseSpannerResourcePath("projects/p1/instances//databases/db1")).toBeUndefined();
    expect(parseSpannerResourcePath(undefined)).toBeUndefined();
    expect(parseSpannerResourcePath("")).toBeUndefined();
  });

  it("reads partial paths so a half-filled form keeps the segments already typed", () => {
    expect(spannerResourceParts("projects/p1/instances//databases/")).toEqual({ project: "p1", instance: "", database: "" });
    expect(spannerResourceParts("jdbc:cloudspanner:/whatever")).toEqual({ project: "", instance: "", database: "" });
  });

  it("formats the three segments into a resource path", () => {
    expect(formatSpannerResourcePath({ project: "p1", instance: "i1", database: "db1" })).toBe(RESOURCE_PATH);
  });

  it("keeps partially filled paths instead of discarding typed segments", () => {
    expect(formatSpannerResourcePath({ project: "p1", instance: "", database: "db1" })).toBe("projects/p1/instances//databases/db1");
    expect(formatSpannerResourcePath({ project: "", instance: "", database: "" })).toBe("");
  });

  it("keeps only the last segment when a whole path is pasted into one field", () => {
    expect(formatSpannerResourcePath({ project: "projects/p1", instance: "i1", database: "db1" })).toBe(RESOURCE_PATH);
  });

  it("round-trips a canonical path", () => {
    expect(formatSpannerResourcePath(parseSpannerResourcePath(RESOURCE_PATH)!)).toBe(RESOURCE_PATH);
  });

  it("replaces a single segment and adopts a pasted full path", () => {
    expect(withSpannerResourcePart(RESOURCE_PATH, "database", "db2")).toBe("projects/p1/instances/i1/databases/db2");
    expect(withSpannerResourcePart(undefined, "project", "p1")).toBe("projects/p1/instances//databases/");
    expect(withSpannerResourcePart("projects/px/instances/ix/databases/dx", "project", RESOURCE_PATH)).toBe(RESOURCE_PATH);
  });

  it("requires all three segments before the connection target counts as complete", () => {
    expect(hasSpannerResourcePath({ database: RESOURCE_PATH })).toBe(true);
    expect(hasSpannerResourcePath({ database: undefined })).toBe(false);
    expect(hasSpannerResourcePath({ database: "projects/p1/instances//databases/db1" })).toBe(false);
  });

  it("normalizes credentials and port while preserving host and url params", () => {
    const config = { host: " ", port: 0, username: "root", password: "secret", database: ` /${RESOURCE_PATH}/ `, url_params: "credentials=/path/key.json" };
    normalizeSpannerConnection(config);
    expect(config).toEqual({ host: "", port: 443, username: "", password: "", database: RESOURCE_PATH, url_params: "credentials=/path/key.json" });
  });

  it("keeps an emulator host and port untouched", () => {
    const config = { host: "localhost", port: 9010, username: "", password: "", database: RESOURCE_PATH };
    normalizeSpannerConnection(config);
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(9010);
  });

  it("shows the database ID rather than the whole resource path", () => {
    expect(spannerDisplayDatabase(RESOURCE_PATH)).toBe("db1");
    expect(spannerDisplayDatabase("some-other-path")).toBe("some-other-path");
    expect(spannerDisplayDatabase(undefined)).toBe("");
  });

  it("gives GoogleSQL's nameless default schema something to render", () => {
    // The empty string is the literal name of the GoogleSQL user schema, so the sidebar would
    // otherwise show a blank node beside any named schema. Display only: routing still uses "".
    expect(spannerSchemaDisplayName("")).toBe("(default)");
    expect(spannerSchemaDisplayName("public")).toBe("public");
    expect(spannerSchemaDisplayName("sales")).toBe("sales");
  });

  it("keeps the resource path separators when encoding it for display", () => {
    // The connection tooltip used to run the whole value through
    // encodeURIComponent, rendering every separator as %2F and making the URL
    // unreadable. Separators are structure here, so only the segments escape.
    expect(encodeSpannerResourcePath(RESOURCE_PATH)).toBe(RESOURCE_PATH);
    expect(encodeSpannerResourcePath("projects/p 1/instances/i/databases/d")).toBe("projects/p%201/instances/i/databases/d");
    expect(encodeSpannerResourcePath("")).toBe("");
  });
});
