import { describe, expect, it } from "vitest";
import { classifySqlRisk } from "@/lib/sql/sqlRisk";

describe("DynamoDB statement risk", () => {
  it("classifies PartiQL reads and mutations without relaxing existing guards", () => {
    expect(classifySqlRisk('SELECT * FROM "items" WHERE "status"=\'PENDING\'', { dialect: "dynamodb" }).risk).toBe("read");
    expect(classifySqlRisk("-- comment\nSELECT 'UPDATE' FROM \"items\"", { dialect: "dynamodb" }).risk).toBe("read");
    for (const sql of ["INSERT INTO \"items\" VALUE {'pk':'x'}", "UPDATE \"items\" SET flag=true WHERE pk='x'", "DELETE FROM \"items\" WHERE pk='x'"]) {
      expect(classifySqlRisk(sql, { dialect: "dynamodb" }).risk).toBe("write");
    }
    expect(classifySqlRisk('SELECT * FROM "items"; DELETE FROM "items" WHERE pk=\'x\'', { dialect: "dynamodb" }).risk).not.toBe("read");
  });
  it("treats generated scan statements as reads", () => {
    expect(classifySqlRisk('DBX DYNAMODB SCAN\ntable: "orders"\nlimit: 1000', { dialect: "dynamodb" }).risk).toBe("read");
    expect(classifySqlRisk('DBX DYNAMODB QUERY / SCAN\ntable: "orders"\nfilter:\n{"status":"SHIPPED"}', { dialect: "dynamodb" }).risk).toBe("read");
  });

  it("treats generated item changes as writes", () => {
    for (const operation of ["INSERT ITEM", "PUT ITEM", "DELETE ITEM"]) {
      expect(classifySqlRisk(`DBX DYNAMODB ${operation}\ntable: "orders"`, { dialect: "dynamodb" }).risk).toBe("write");
    }
  });

  it("keeps unknown DynamoDB operations unsafe", () => {
    expect(classifySqlRisk('DBX DYNAMODB UNKNOWN\ntable: "orders"', { dialect: "dynamodb" }).risk).toBe("unknown");
  });
});
