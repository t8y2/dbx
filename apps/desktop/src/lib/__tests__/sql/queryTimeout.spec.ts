import { describe, expect, it } from "vitest";
import { frontendQueryTimeoutSecsForSql, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";

describe("queryTimeout", () => {
  it("lets PostgreSQL row queries use the backend inactivity timeout", () => {
    expect(frontendQueryTimeoutSecsForSql("SELECT * FROM sample_records LIMIT 2000", "postgres", 30)).toBe(0);
    expect(frontendQueryTimeoutSecsForSql("/* page */\nWITH rows AS (SELECT 1) SELECT * FROM rows", "postgres", 30)).toBe(0);
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET state = 'ready' RETURNING id", "postgres", 30)).toBe(0);
  });

  it("keeps the frontend guard for non-row PostgreSQL statements", () => {
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET state = 'ready'", "postgres", 30)).toBe(60);
    expect(frontendQueryTimeoutSecsForSql("INSERT INTO sample_records(note) VALUES ('RETURNING is text')", "postgres", 30)).toBe(60);
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET note = 'ready' /* RETURNING */", "postgres", 30)).toBe(60);
  });

  it("keeps the existing frontend guard for other database types", () => {
    expect(frontendQueryTimeoutSecsForSql("SELECT * FROM sample_records LIMIT 2000", "mysql", 30)).toBe(60);
    expect(queryTimeoutSecsForConnection({ query_timeout_secs: undefined })).toBe(60);
  });
});
