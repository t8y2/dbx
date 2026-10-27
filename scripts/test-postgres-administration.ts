// Opt-in live test. Requires a disposable PostgreSQL container and podman.
// DBX_POSTGRES_ADMIN_TEST_CONTAINER=<name> pnpm exec tsx --tsconfig apps/desktop/tsconfig.json scripts/test-postgres-administration.ts
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PG_BLOCKING_SQL, blockingIdentity, buildPgSignalSql, buildPgLockDetailsSql, mapPgBlockingRows, pgSignalResultError } from "../apps/desktop/src/lib/database/postgresLocks";
import { POSTGRES_SYSTEM_CATEGORIES } from "../apps/desktop/src/lib/database/postgresAdministration";
import { postgresSystemInfoSql } from "../apps/desktop/src/lib/database/postgresSystemInfo";
import { PG_PROCESS_LIST_SQL, mapPgProcessRows } from "../apps/desktop/src/lib/database/postgresProcessList";
import assert from "node:assert/strict";
import type { QueryResult } from "../apps/desktop/src/types/database";
type SqlRecord = Record<string, string | number | boolean | null>;
let databaseCreated = false;
let roleCreated = false;
const container = process.env.DBX_POSTGRES_ADMIN_TEST_CONTAINER;
if (!container) throw new Error("Set DBX_POSTGRES_ADMIN_TEST_CONTAINER to a disposable PostgreSQL container name");
const database = `dbx_admin_test_${process.pid}`;
const role = `dbx_admin_reader_${process.pid}`;
const base = ["exec", "-i", container, "psql", "-X", "-q", "-A", "-t", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"];
function sql(query: string) {
  return execFileSync("podman", [...base, "-c", query], { encoding: "utf8" }).trim();
}
function json(query: string) {
  const text = sql(`SELECT COALESCE(json_agg(q),'[]'::json) FROM (${query}) q`);
  return JSON.parse(text) as SqlRecord[];
}
function result(records: SqlRecord[]) {
  return { columns: records.length ? Object.keys(records[0]) : [], rows: records.map((r) => Object.values(r)), affected_rows: 0, execution_time_ms: 0 } as QueryResult;
}
function snapshot() {
  return mapPgBlockingRows(result(json(PG_BLOCKING_SQL)));
}
const processes: ReturnType<typeof spawn>[] = [];
function run(query: string) {
  const child = spawn("podman", [...base.slice(0, -1), "ON_ERROR_STOP=0"], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin!.on("error", () => {});
  child.stdin!.write(query + ";\n");
  processes.push(child);
  return child;
}
async function waitFor<T>(f: () => T | false): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = f();
    if (value) return value;
    await delay(100);
  }
  throw new Error("Timed out");
}
async function main() {
  execFileSync("podman", ["exec", container!, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${database}`], { stdio: "pipe" });
  databaseCreated = true;
  sql("CREATE TABLE IF NOT EXISTS dbx_admin_fixture(id integer PRIMARY KEY, value integer); TRUNCATE dbx_admin_fixture; INSERT INTO dbx_admin_fixture VALUES(1,0)");
  run("SET application_name='dbx_admin_holder'; BEGIN; UPDATE dbx_admin_fixture SET value=1 WHERE id=1; SELECT pg_sleep(90)");
  await waitFor(() => json("SELECT pid FROM pg_stat_activity WHERE application_name='dbx_admin_holder' AND datname=current_database() AND query LIKE '%pg_sleep%'").length > 0);
  run("SET application_name='dbx_admin_waiter'; BEGIN; UPDATE dbx_admin_fixture SET value=2 WHERE id=1; SELECT pg_sleep(90)");
  const edge = await waitFor(() => snapshot().find((r) => r.wait_database === database && r.wait_app === "dbx_admin_waiter" && r.hold_app === "dbx_admin_holder") || false);
  const waiter = blockingIdentity(edge, "wait")!,
    holder = blockingIdentity(edge, "hold")!;
  assert(waiter && holder);
  const locks = json(buildPgLockDetailsSql(waiter));
  assert(locks.some((r) => r.granted === false));
  for (const category of POSTGRES_SYSTEM_CATEGORIES) {
    const rows = json(postgresSystemInfoSql(category));
    assert(rows.length > 0, category);
    console.log("OK catalog", category, rows.length);
  }
  assert(mapPgProcessRows(result(json(PG_PROCESS_LIST_SQL))).some((r) => r.id === waiter.pid && r.backend_start));
  assert.equal(pgSignalResultError(result(json(buildPgSignalSql({ ...waiter, backendStart: "stale" }, "terminate"))), "terminate"), "postgresAdmin.targetChanged");
  assert.equal(pgSignalResultError(result(json(buildPgSignalSql(waiter, "cancel"))), "cancel"), null);
  await waitFor(() => !snapshot().some((r) => r.wait_pid === waiter.pid));
  // Cancellation leaves the client connected; termination removes it.
  assert(json(`SELECT pid FROM pg_stat_activity WHERE pid=${holder.pid}`).length === 1);
  assert(json(`SELECT pid FROM pg_stat_activity WHERE pid=${waiter.pid}`).length === 1);
  assert.equal(pgSignalResultError(result(json(buildPgSignalSql(waiter, "terminate"))), "terminate"), null);
  await waitFor(() => json(`SELECT pid FROM pg_stat_activity WHERE pid=${waiter.pid}`).length === 0);
  assert.equal(pgSignalResultError(result(json(buildPgSignalSql(holder, "terminate"))), "terminate"), null);
  await waitFor(() => json(`SELECT pid FROM pg_stat_activity WHERE pid=${holder.pid}`).length === 0);
  assert.equal(json("SELECT value FROM dbx_admin_fixture WHERE id=1")[0].value, 0);
  console.log("OK blocking edge, lock details, activity identity, stale target, cancel, terminate and rollback");
  sql(`CREATE ROLE ${role} LOGIN; GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  roleCreated = true;
  const restricted = JSON.parse(execFileSync("podman", [...base.map((part) => (part === "postgres" ? role : part)), "-c", `SELECT COALESCE(json_agg(q),'[]'::json) FROM (${PG_PROCESS_LIST_SQL}) q`], { encoding: "utf8" }));
  assert(restricted.length > 0);
  console.log("OK restricted-role activity query");
  sql(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  roleCreated = false;
}
main()
  .finally(() => {
    try {
      if (databaseCreated) sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name IN ('dbx_admin_holder','dbx_admin_waiter')");
      if (roleCreated) sql(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
    } finally {
      for (const p of processes) p.kill();
      if (databaseCreated) execFileSync("podman", ["exec", container!, "psql", "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${database}`], { stdio: "pipe" });
    }
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
