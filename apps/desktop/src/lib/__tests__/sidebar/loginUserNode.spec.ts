import { describe, expect, it } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import { isLoginUserSchemaNode } from "@/lib/sidebar/loginUserNode";

function config(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: "conn-1",
    name: "conn",
    db_type: "dameng",
    host: "localhost",
    port: 5236,
    username: "TEST01",
    password: "",
    ...overrides,
  } as ConnectionConfig;
}

function schemaNode(overrides: Partial<TreeNode>): TreeNode {
  return {
    id: "conn-1:TEST01:TEST01",
    label: "TEST01",
    type: "schema",
    connectionId: "conn-1",
    database: "TEST01",
    schema: "TEST01",
    ...overrides,
  };
}

describe("isLoginUserSchemaNode", () => {
  it("marks the schema node matching the login user (Case 1)", () => {
    expect(isLoginUserSchemaNode(schemaNode({}), config({ username: "TEST01" }))).toBe(true);
  });

  it("does not mark other user schemas (Case 2)", () => {
    expect(isLoginUserSchemaNode(schemaNode({ schema: "TEST02", label: "TEST02" }), config({ username: "TEST01" }))).toBe(false);
    expect(isLoginUserSchemaNode(schemaNode({ schema: "SYSDBA", label: "SYSDBA" }), config({ username: "TEST01" }))).toBe(false);
  });

  it("isolates by the caller-provided connection config (Case 3)", () => {
    // A same-named schema on a different connection is checked against that
    // connection's own config, whose login user is different, so it stays plain.
    const otherConnectionConfig = config({ id: "conn-2", username: "OTHER" });
    expect(isLoginUserSchemaNode(schemaNode({ connectionId: "conn-2" }), otherConnectionConfig)).toBe(false);
  });

  it("matches Dameng's upper-cased schema against a lower-case login (Case 4)", () => {
    expect(isLoginUserSchemaNode(schemaNode({ schema: "TEST01", label: "TEST01" }), config({ username: "test01" }))).toBe(true);
  });

  it("never highlights engines whose schema is not a user (Case 5)", () => {
    // PostgreSQL: a `postgres` schema that coincidentally matches the login name
    // is a plain schema, not the login user, and must stay unbolded.
    const pgNode = schemaNode({ schema: "postgres", label: "postgres", database: "app" });
    expect(isLoginUserSchemaNode(pgNode, config({ db_type: "postgres", username: "postgres" }))).toBe(false);
    // MySQL has no schema tree level, but guard the type boundary regardless.
    expect(isLoginUserSchemaNode(pgNode, config({ db_type: "mysql", username: "postgres" }))).toBe(false);
  });

  it("is safe when config, username, or schema is missing (Case 6)", () => {
    expect(isLoginUserSchemaNode(schemaNode({}), undefined)).toBe(false);
    expect(isLoginUserSchemaNode(schemaNode({}), config({ username: "" }))).toBe(false);
    expect(isLoginUserSchemaNode(schemaNode({}), config({ username: "   " }))).toBe(false);
    expect(isLoginUserSchemaNode(schemaNode({ schema: undefined, label: "" }), config({ username: "TEST01" }))).toBe(false);
  });

  it("only applies to schema nodes, not tables or other user schemas' children", () => {
    expect(isLoginUserSchemaNode(schemaNode({ type: "table" }), config({ username: "TEST01" }))).toBe(false);
    expect(isLoginUserSchemaNode(schemaNode({ type: "connection" }), config({ username: "TEST01" }))).toBe(false);
  });

  it("falls back to the label when the schema field is absent", () => {
    expect(isLoginUserSchemaNode(schemaNode({ schema: undefined, label: "TEST01" }), config({ username: "test01" }))).toBe(true);
  });

  it("also covers Oracle and OceanBase (Oracle mode) connections", () => {
    expect(isLoginUserSchemaNode(schemaNode({ schema: "SCOTT", label: "SCOTT" }), config({ db_type: "oracle", username: "scott" }))).toBe(true);
    expect(isLoginUserSchemaNode(schemaNode({ schema: "APP", label: "APP" }), config({ db_type: "oceanbase-oracle", username: "app" }))).toBe(true);
  });
});
