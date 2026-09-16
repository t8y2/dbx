import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMetadataRuntimeCache,
  clearMetadataRuntimeCacheForDatabase,
  clearMetadataRuntimeCacheForConnection,
  configureMetadataRuntimeCache,
  getMetadataRuntimeCache,
  getMetadataRuntimeCacheDiagnostics,
  METADATA_CACHE_DEFAULT_MEMORY_MB,
  normalizeMetadataCacheMemoryMb,
  setMetadataRuntimeCache,
} from "@/lib/metadata/metadataRuntimeCache";

describe("metadataRuntimeCache", () => {
  beforeEach(() => {
    clearMetadataRuntimeCache();
    configureMetadataRuntimeCache(METADATA_CACHE_DEFAULT_MEMORY_MB);
    vi.restoreAllMocks();
  });

  it("normalizes the configured memory budget", () => {
    expect(normalizeMetadataCacheMemoryMb(undefined)).toBe(64);
    expect(normalizeMetadataCacheMemoryMb(1)).toBe(16);
    expect(normalizeMetadataCacheMemoryMb(256.4)).toBe(256);
    expect(normalizeMetadataCacheMemoryMb(512)).toBe(512);
    expect(normalizeMetadataCacheMemoryMb(513)).toBe(64);
  });

  it("warns above the recommended limit and falls back above the hard limit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(configureMetadataRuntimeCache(384)).toBe(384);
    expect(configureMetadataRuntimeCache(513)).toBe(64);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("rejects a single entry larger than one megabyte", () => {
    expect(setMetadataRuntimeCache("large", "x".repeat(600_000), "connection-1")).toBe(false);
    expect(getMetadataRuntimeCacheDiagnostics().entries).toBe(0);
  });

  it("evicts the least recently used entry within a connection budget", () => {
    configureMetadataRuntimeCache(16);
    const value = "x".repeat(300_000);
    for (let index = 0; index < 6; index += 1) {
      expect(setMetadataRuntimeCache(`key-${index}`, value, "connection-1")).toBe(true);
    }
    expect(getMetadataRuntimeCache("key-0")).toBeDefined();
    expect(setMetadataRuntimeCache("key-6", value, "connection-1")).toBe(true);

    expect(getMetadataRuntimeCache("key-0")).toBeDefined();
    expect(getMetadataRuntimeCache("key-1")).toBeUndefined();
    expect(getMetadataRuntimeCacheDiagnostics().evictions).toBeGreaterThan(0);
  });

  it("reapplies the per-connection budget when the configured limit shrinks", () => {
    const value = "x".repeat(300_000);
    for (let index = 0; index < 10; index += 1) {
      setMetadataRuntimeCache(`key-${index}`, value, "connection-1");
    }

    configureMetadataRuntimeCache(16);
    expect(getMetadataRuntimeCacheDiagnostics().bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("clears only entries owned by the requested connection", () => {
    setMetadataRuntimeCache("a", { value: 1 }, "connection-1");
    setMetadataRuntimeCache("b", { value: 2 }, "connection-2");

    expect(clearMetadataRuntimeCacheForConnection("connection-1")).toBe(1);
    expect(getMetadataRuntimeCache("a")).toBeUndefined();
    expect(getMetadataRuntimeCache("b")?.value).toEqual({ value: 2 });
    expect(getMetadataRuntimeCacheDiagnostics().connectionClears).toBe(1);
  });

  it("clears only entries owned by the requested database", () => {
    setMetadataRuntimeCache("object-meta:v1:connection-1:database-1:schema:table:catalog:TABLE:columns:", { value: 1 }, "connection-1");
    setMetadataRuntimeCache("object-meta:v1:connection-1:database-2:schema:table:catalog:TABLE:columns:", { value: 2 }, "connection-1");
    setMetadataRuntimeCache("object-meta:v1:connection-2:database-1:schema:table:catalog:TABLE:columns:", { value: 3 }, "connection-2");

    expect(clearMetadataRuntimeCacheForDatabase("connection-1", "database-1")).toBe(1);
    expect(getMetadataRuntimeCache("object-meta:v1:connection-1:database-1:schema:table:catalog:TABLE:columns:")).toBeUndefined();
    expect(getMetadataRuntimeCache("object-meta:v1:connection-1:database-2:schema:table:catalog:TABLE:columns:")).toBeDefined();
    expect(getMetadataRuntimeCache("object-meta:v1:connection-2:database-1:schema:table:catalog:TABLE:columns:")).toBeDefined();
  });
});
