import { describe, expect, it } from "vitest";
import { mongoConnectionUsesOidc } from "@/lib/mongo/mongoConnectionOptions";

describe("mongoConnectionUsesOidc", () => {
  it("detects OIDC in structured URL params without case sensitivity", () => {
    expect(mongoConnectionUsesOidc("authSource=%24external&AUTHMECHANISM=mongodb-oidc")).toBe(true);
  });

  it("detects OIDC in mongodb and mongodb+srv connection strings", () => {
    expect(mongoConnectionUsesOidc(undefined, "mongodb://localhost/app?authMechanism=MONGODB-OIDC")).toBe(true);
    expect(mongoConnectionUsesOidc(undefined, "mongodb+srv://cluster.example.com/app?authMechanism=MONGODB%2DOIDC#fragment")).toBe(true);
  });

  it("does not classify non-OIDC or non-MongoDB URLs as OIDC", () => {
    expect(mongoConnectionUsesOidc("authMechanism=SCRAM-SHA-256")).toBe(false);
    expect(mongoConnectionUsesOidc(undefined, "postgres://localhost/app?authMechanism=MONGODB-OIDC")).toBe(false);
  });

  it("treats a connection string as authoritative over stale form params", () => {
    expect(mongoConnectionUsesOidc("authMechanism=MONGODB-OIDC", "mongodb://localhost/app?authMechanism=SCRAM-SHA-256")).toBe(false);
  });
});
