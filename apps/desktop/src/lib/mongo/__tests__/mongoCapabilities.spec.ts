import { describe, expect, it } from "vitest";
import { isMongoLegacyDriverProfile, mongoCollectionSupportsIndexes, supportsMongoAllDriverMutations, supportsMongoIndexMutations, supportsNativeMongoDriverMutations } from "@/lib/mongo/mongoCapabilities";

describe("MongoDB driver mutation capabilities", () => {
  it("keeps index and drop mutations available through both native and Legacy drivers", () => {
    expect(supportsMongoAllDriverMutations({ db_type: "mongodb", driver_profile: "mongodb" })).toBe(true);
    expect(supportsMongoAllDriverMutations({ db_type: "mongodb", driver_profile: "mongodb-legacy" })).toBe(true);
  });

  it("does not offer mutation actions on a read-only MongoDB connection", () => {
    const readOnly = { db_type: "mongodb", driver_profile: "mongodb-legacy", read_only: true } as const;

    expect(supportsMongoAllDriverMutations(readOnly)).toBe(false);
    expect(supportsMongoIndexMutations(readOnly, "collection")).toBe(false);
    expect(supportsNativeMongoDriverMutations({ ...readOnly, driver_profile: "mongodb" })).toBe(false);
  });

  it("keeps index metadata visible on read-only collections", () => {
    expect(mongoCollectionSupportsIndexes("collection")).toBe(true);
    expect(mongoCollectionSupportsIndexes("timeseries")).toBe(true);
    expect(mongoCollectionSupportsIndexes(undefined)).toBe(true);
    expect(mongoCollectionSupportsIndexes(" VIEW ")).toBe(false);
  });

  it("allows index mutations for collections and time-series collections, but not views", () => {
    const native = { db_type: "mongodb", driver_profile: "mongodb" } as const;
    const legacy = { db_type: "mongodb", driver_profile: "mongodb-legacy" } as const;

    expect(supportsMongoIndexMutations(native, "collection")).toBe(true);
    expect(supportsMongoIndexMutations(legacy, "timeseries")).toBe(true);
    expect(supportsMongoIndexMutations(legacy)).toBe(true);
    expect(supportsMongoIndexMutations(native, " VIEW ")).toBe(false);
  });

  it("reserves native-only mutations for the native MongoDB driver", () => {
    expect(supportsNativeMongoDriverMutations({ db_type: "mongodb", driver_profile: "mongodb" })).toBe(true);
    expect(supportsNativeMongoDriverMutations({ db_type: "mongodb", driver_profile: undefined })).toBe(true);
    expect(supportsNativeMongoDriverMutations({ db_type: "mongodb", driver_profile: "mongodb-legacy" })).toBe(false);
    expect(supportsNativeMongoDriverMutations({ db_type: "mongodb", driver_profile: "legacy" })).toBe(false);
    expect(supportsNativeMongoDriverMutations({ db_type: "mongodb", driver_profile: "MongoDB_Legacy" })).toBe(false);
  });

  it("recognizes historical Legacy profile spellings", () => {
    expect(isMongoLegacyDriverProfile("mongodb-legacy")).toBe(true);
    expect(isMongoLegacyDriverProfile(" mongodb_legacy ")).toBe(true);
    expect(isMongoLegacyDriverProfile("legacy")).toBe(true);
    expect(isMongoLegacyDriverProfile("mongodb")).toBe(false);
  });

  it("does not grant MongoDB mutations to another connection type", () => {
    expect(supportsMongoAllDriverMutations({ db_type: "postgres", driver_profile: undefined })).toBe(false);
    expect(supportsNativeMongoDriverMutations(undefined)).toBe(false);
  });
});
