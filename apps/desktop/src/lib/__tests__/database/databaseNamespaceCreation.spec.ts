import { describe, expect, it } from "vitest";
import { connectionNamespaceCreationTarget, databaseNodeNamespaceCreationTarget } from "@/lib/database/databaseNamespaceCreation";

type Conn = Parameters<typeof connectionNamespaceCreationTarget>[0];

const databaseNode = { type: "database" as const, database: "dcss" };

describe("database namespace creation targets", () => {
  it("offers Create Database (not Create Schema) for GBase 8s", () => {
    const gbase8s = { db_type: "gbase", driver_profile: "gbase8s" } as Conn;

    expect(connectionNamespaceCreationTarget(gbase8s)).toBe("database");
    expect(databaseNodeNamespaceCreationTarget(gbase8s, databaseNode)).toBeNull();
  });

  it("keeps the MySQL-style Create Schema target for GBase 8a", () => {
    const gbase8a = { db_type: "gbase", driver_profile: "gbase8a" } as Conn;

    expect(connectionNamespaceCreationTarget(gbase8a)).toBeNull();
    expect(databaseNodeNamespaceCreationTarget(gbase8a, databaseNode)).toBe("schema");
  });

  it("offers Create Database for standalone Informix", () => {
    const informix = { db_type: "informix" } as Conn;

    expect(connectionNamespaceCreationTarget(informix)).toBe("database");
    expect(databaseNodeNamespaceCreationTarget(informix, databaseNode)).toBeNull();
  });

  it("leaves unrelated engines on their existing targets", () => {
    const postgres = { db_type: "postgres" } as Conn;

    expect(connectionNamespaceCreationTarget(postgres)).toBe("database");
    expect(databaseNodeNamespaceCreationTarget(postgres, databaseNode)).toBe("schema");
  });
});
