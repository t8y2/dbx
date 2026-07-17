import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import Database from "better-sqlite3";
import type { ConnectionConfig } from "../src/connections.js";
import { describeTable, executeQuery, listTables } from "../src/database.js";

function sqliteConfig(path: string): ConnectionConfig {
  return {
    id: "sqlite-test",
    name: "local-sqlite",
    db_type: "sqlite",
    host: path,
    port: 0,
    username: "",
    password: "",
    ssh_enabled: false,
    ssl: false,
  };
}

function mysqlSshConfig(): ConnectionConfig {
  return {
    id: "mysql-ssh-test",
    name: "mysql-over-ssh",
    db_type: "mysql",
    host: "10.0.0.10",
    port: 3306,
    username: "root",
    password: "secret",
    ssl: false,
    transport_layers: [
      {
        type: "ssh",
        id: "bastion",
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        user: "root",
        password: "ssh-secret",
      },
    ],
  };
}

test("queries SQLite connections without the DBX bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbx-mcp-sqlite-"));
  const path = join(dir, "app.db");
  const db = new Database(path);
  db.exec("create table users (id integer primary key, name text not null); insert into users (name) values ('Ada');");
  db.close();

  try {
    const result = await executeQuery(sqliteConfig(path), "select id, name from users");

    assert.deepEqual(result.columns, ["id", "name"]);
    assert.deepEqual(result.rows, [{ id: 1, name: "Ada" }]);
    assert.equal(result.row_count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applies query row limits to SQLite connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbx-mcp-sqlite-"));
  const path = join(dir, "app.db");
  const db = new Database(path);
  db.exec("create table users (id integer primary key, name text not null); insert into users (name) values ('Ada'), ('Grace');");
  db.close();

  try {
    const result = await executeQuery(sqliteConfig(path), "select id, name from users order by id", { maxRows: 1 });

    assert.deepEqual(result.columns, ["id", "name"]);
    assert.deepEqual(result.rows, [{ id: 1, name: "Ada" }]);
    assert.equal(result.row_count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lists and describes SQLite tables without the DBX bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbx-mcp-sqlite-"));
  const path = join(dir, "app.db");
  const db = new Database(path);
  db.exec("create table users (id integer primary key, name text not null);");
  db.close();

  try {
    const tables = await listTables(sqliteConfig(path));
    const columns = await describeTable(sqliteConfig(path), "users");

    assert.deepEqual(tables, [{ name: "users", type: "table" }]);
    assert.deepEqual(
      columns.map((column) => ({
        name: column.name,
        data_type: column.data_type,
        is_nullable: column.is_nullable,
        is_primary_key: column.is_primary_key,
      })),
      [
        { name: "id", data_type: "INTEGER", is_nullable: true, is_primary_key: true },
        { name: "name", data_type: "TEXT", is_nullable: false, is_primary_key: false },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes SSH transport layer connections through the DBX bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbx-mcp-bridge-home-"));
  const originalHome = process.env.HOME;
  const originalDbxDataDir = process.env.DBX_DATA_DIR;
  process.env.HOME = dir;
  process.env.DBX_DATA_DIR = dir;

  try {
    await assert.rejects(() => executeQuery(mysqlSshConfig(), "select 1"), /DBX desktop app is not running/);
    await assert.rejects(() => listTables(mysqlSshConfig()), /DBX desktop app is not running/);
    await assert.rejects(() => describeTable(mysqlSshConfig(), "users"), /DBX desktop app is not running/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDbxDataDir === undefined) delete process.env.DBX_DATA_DIR;
    else process.env.DBX_DATA_DIR = originalDbxDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
