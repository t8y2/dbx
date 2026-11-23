import { describe, expect, it } from "vitest";
import { decodeQuickOpenMetadataCache, encodeQuickOpenMetadataCache, invalidateQuickOpenMetadataCache, quickOpenMetadataCacheGeneration, quickOpenMetadataCacheKey, quickOpenMetadataConnectionFingerprint } from "@/lib/quickOpen/quickOpenMetadataCache";

const items = [
  {
    type: "column" as const,
    label: "email",
    connectionId: "conn/1",
    database: "analytics",
    schema: "public",
    tableName: "users",
    columnName: "email",
    columnComment: "login address",
    tableType: "TABLE",
  },
];

describe("quick open metadata cache", () => {
  it("round-trips last-known metadata with an explicit capture time", () => {
    const payload = encodeQuickOpenMetadataCache("conn/1", "fingerprint", items, Date.parse("2026-05-10T12:00:00.000Z"));
    expect(decodeQuickOpenMetadataCache(payload, Date.parse("2026-05-11T12:00:00.000Z"))).toMatchObject({
      connectionId: "conn/1",
      connectionFingerprint: "fingerprint",
      capturedAt: "2026-05-10T12:00:00.000Z",
      items,
    });
  });

  it("rejects expired, malformed, and incompatible payloads", () => {
    const payload = encodeQuickOpenMetadataCache("conn", "fingerprint", items, Date.parse("2026-05-10T12:00:00.000Z"));
    expect(decodeQuickOpenMetadataCache(payload, Date.parse("2026-06-10T12:00:00.000Z"))).toBeNull();
    expect(decodeQuickOpenMetadataCache({ ...payload, version: 2 })).toBeNull();
    expect(decodeQuickOpenMetadataCache({ ...payload, items: [{ ...items[0], columnName: 42 }] })).toBeNull();
  });

  it("encodes connection ids in cache keys without prefix collisions", () => {
    const shortKey = quickOpenMetadataCacheKey("a");
    const nestedKey = quickOpenMetadataCacheKey("a:b");
    expect(shortKey).toBe("dbx:quick-open-metadata-v1:a:");
    expect(nestedKey).toBe("dbx:quick-open-metadata-v1:a%3Ab:");
    expect(nestedKey.startsWith(shortKey)).toBe(false);
  });

  it("does not invalidate metadata when only the saved password or display name changes", () => {
    const base = { id: "conn", name: "Production", db_type: "postgres", host: "db.example", port: 5432, username: "app", password: "old" } as any;
    expect(quickOpenMetadataConnectionFingerprint(base)).toBe(quickOpenMetadataConnectionFingerprint({ ...base, name: "Renamed", password: "new" }));
  });

  it("increments the generation used to invalidate late writes", () => {
    const connectionId = "generation-test";
    const before = quickOpenMetadataCacheGeneration(connectionId);
    expect(invalidateQuickOpenMetadataCache(connectionId)).toBe(before + 1);
    expect(quickOpenMetadataCacheGeneration(connectionId)).toBe(before + 1);
  });
});
