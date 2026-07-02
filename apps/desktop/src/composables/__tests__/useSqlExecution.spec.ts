import { describe, expect, it } from "vitest";
import { requiresDatabaseSelection } from "../useSqlExecution";
import type { ConnectionConfig, QueryTab } from "@/types/database";

function connection(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Local",
    db_type: dbType,
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
  };
}

function queryTab(database = ""): QueryTab {
  return {
    id: "tab-1",
    connectionId: "conn-1",
    database,
    schema: undefined,
    title: "SQL",
    sql: "",
    mode: "query",
    isDirty: false,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
  };
}

describe("requiresDatabaseSelection", () => {
  it("allows MySQL CREATE DATABASE to run without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db")).toBe(false);
  });

  it("allows MySQL CREATE SCHEMA with options to run without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE SCHEMA `app-db` DEFAULT CHARACTER SET utf8mb4")).toBe(false);
  });

  it("allows MySQL install batches that switch databases before table DDL", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; USE app_db; CREATE TABLE users(id INT PRIMARY KEY)")).toBe(false);
  });

  it("allows MySQL install batches with session setup before switching databases", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SET NAMES utf8mb4; DROP DATABASE IF EXISTS app_db; CREATE DATABASE app_db; USE app_db; INSERT INTO users VALUES (1)")).toBe(false);
  });

  it("requires a database when MySQL batch statements never establish database context", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; CREATE TABLE users(id INT)")).toBe(true);
  });

  it("requires a database when a USE statement is not a standalone database switch", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; USE app_db SELECT 1; CREATE TABLE users(id INT)")).toBe(true);
  });

  it("still requires a database for ordinary MySQL queries", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SELECT * FROM users")).toBe(true);
  });
});
