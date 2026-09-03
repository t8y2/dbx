import { describe, expect, it } from "vitest";
import { looksLikeDmlStatement } from "../dmlChangePreview";

describe("looksLikeDmlStatement", () => {
  it("recognizes UPDATE / INSERT / DELETE statements", () => {
    expect(looksLikeDmlStatement("UPDATE admin_sessions SET public_id = 123 WHERE id = 1")).toBe(true);
    expect(looksLikeDmlStatement("  INSERT INTO t (a) VALUES (1)")).toBe(true);
    expect(looksLikeDmlStatement("\nDELETE FROM t WHERE id = 2")).toBe(true);
  });
  it("ignores leading whitespace and preserves case-insensitivity", () => {
    expect(looksLikeDmlStatement("   update t set a = 1")).toBe(true);
    expect(looksLikeDmlStatement("Insert into t values (1)")).toBe(true);
  });
  it("rejects non-DML and unrelated statements", () => {
    expect(looksLikeDmlStatement("SELECT * FROM t")).toBe(false);
    expect(looksLikeDmlStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
    expect(looksLikeDmlStatement("")).toBe(false);
    expect(looksLikeDmlStatement("CREATE TABLE t (a int)")).toBe(false);
  });
});
