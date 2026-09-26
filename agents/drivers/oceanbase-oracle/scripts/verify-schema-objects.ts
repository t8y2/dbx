import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { OCEANBASE_ORACLE_DATABASE_LINKS_SQL, createOceanBaseDatabaseLinkSql, oracleDatabaseLinksFromResult, dropOracleDatabaseLinkSql, testOracleDatabaseLinkSql } from "../../../../apps/desktop/src/lib/database/oracleDatabaseLinks";

// Explicit opt-in: creates one isolated user and drops only that user and its objects.
async function main() {
  assert.equal(process.env.OB_TEST_DISPOSABLE, "1", "Set OB_TEST_DISPOSABLE=1 only for a disposable Oracle tenant");
  const host = process.env.OB_HOST,
    tenant = process.env.OB_TENANT,
    password = process.env.OB_PASSWORD;
  assert.ok(host && tenant && password, "Set OB_HOST, OB_TENANT and OB_PASSWORD");
  const port = Number(process.env.OB_PORT ?? 2881);
  const fixturePassword = "Dbx2549_" + randomBytes(12).toString("hex");
  const redact = (error: unknown) =>
    String(error)
      .replaceAll(password, "[redacted]")
      .replaceAll(fixturePassword, "[redacted]")
      .replace(/IDENTIFIED\s+BY\s+(?:"[^"]*"|'[^']*'|\S+)/gi, "IDENTIFIED BY [redacted]");
  const owner = "DBX2549_" + randomBytes(4).toString("hex").toUpperCase();
  const observer = "DBX2549B_" + owner.slice(-8);
  const linkName = "DBX2549_LINK_" + owner.slice(-8);
  const output = process.env.OB_TEST_OUTPUT ?? "agents/drivers/oceanbase-oracle/build/schema-object-evidence";
  mkdirSync(output, { recursive: true });
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
  const child = spawn(java, ["-jar", "agents/drivers/oceanbase-oracle/build/libs/dbx-agent-oceanbase-oracle.jar"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let requestId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("{")) return;
    const response = JSON.parse(line),
      task = pending.get(response.id);
    if (!task) return;
    pending.delete(response.id);
    if (response.error) task.reject(new Error(redact(response.error.message)));
    else task.resolve(response.result);
  });
  const rejectPending = () => {
    for (const task of pending.values()) task.reject(new Error("Agent exited"));
    pending.clear();
  };
  child.on("error", rejectPending);
  child.on("exit", rejectPending);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Agent timeout: " + method));
      }, 45_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const sql = (text: string, session = "fixture") => call("execute_query", { agentSessionId: session, sql: text, maxRows: 100, timeoutSecs: 20 });
  const connect = (user: string, secret: string, session: string) => call("open_session", { agentSessionId: session, host, port, database: user, username: user + "@" + tenant, password: secret, url_params: "connectTimeout=10000&socketTimeout=30000" });
  const qi = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const source = (name: string, object_type: string, schema = owner) => call("get_object_source", { agentSessionId: "fixture", schema, name, object_type });
  const checks: string[] = [];
  let created = false,
    observerCreated = false,
    connected = false,
    observerConnected = false,
    linkCreated = false,
    failure: string | undefined;
  const notes: string[] = [];
  try {
    await call("handshake");
    await connect("SYS", password, "admin");
    await sql(`CREATE USER ${qi(owner)} IDENTIFIED BY ${qi(fixturePassword)}`, "admin");
    created = true;
    await sql(`CREATE USER ${qi(observer)} IDENTIFIED BY ${qi(fixturePassword)}`, "admin");
    observerCreated = true;
    await sql(`GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE, CREATE SYNONYM, CREATE DATABASE LINK, DROP DATABASE LINK, ALTER SESSION TO ${qi(owner)}`, "admin");
    await sql(`GRANT CREATE SESSION TO ${qi(observer)}`, "admin");
    await connect(owner, fixturePassword, "fixture");
    connected = true;
    await connect(observer, fixturePassword, "observer");
    observerConnected = true;
    await sql('CREATE TABLE "T1" ("ID" NUMBER)');
    await sql('CREATE TABLE "T2" ("ID" NUMBER)');
    await sql('INSERT INTO "T1" VALUES (1)');
    await sql('INSERT INTO "T2" VALUES (2)');
    await sql('CREATE SEQUENCE "MiX.Seq" START WITH 10 INCREMENT BY 2 NOCACHE NOCYCLE NOORDER');
    await sql('CREATE SYNONYM "MiX.Syn" FOR "T1"');
    const objects = await call("list_objects", { agentSessionId: "fixture", schema: owner });
    assert.ok(objects.some((item: any) => item.name === "MiX.Seq" && item.object_type === "SEQUENCE"));
    assert.ok(objects.some((item: any) => item.name === "MiX.Syn" && item.object_type === "SYNONYM"));
    checks.push("sequence/synonym discovery");
    assert.equal(Number((await sql('SELECT "MiX.Seq".NEXTVAL FROM DUAL')).rows[0][0]), 10);
    const sequence = await source("MiX.Seq", "SEQUENCE");
    assert.ok(sequence.source.includes("CREATE SEQUENCE"));
    assert.ok(sequence.source.includes("MiX.Seq"));
    const currentSchemaSequence = await source("MiX.Seq", "SEQUENCE", "");
    assert.equal(currentSchemaSequence.schema, owner);
    assert.equal(Number((await sql('SELECT "MiX.Seq".NEXTVAL FROM DUAL')).rows[0][0]), 12);
    await sql(`ALTER SEQUENCE ${qi(owner)}."MiX.Seq" INCREMENT BY 3 NOCACHE NOCYCLE NOORDER`);
    assert.equal(Number((await sql('SELECT "MiX.Seq".NEXTVAL FROM DUAL')).rows[0][0]), 15);
    writeFileSync(join(output, "sequence.sql"), sequence.source);
    checks.push("sequence source/current-schema/ALTER without counter reset");
    const synonym = await source("MiX.Syn", "SYNONYM");
    assert.ok(synonym.source.startsWith("CREATE OR REPLACE SYNONYM"));
    await sql(synonym.source.replace(/;\s*$/, ""));
    assert.equal(Number((await sql('SELECT ID FROM "MiX.Syn"')).rows[0][0]), 1);
    await sql(synonym.source.replace('"T1"', '"T2"').replace(/;\s*$/, ""));
    assert.equal(Number((await sql('SELECT ID FROM "MiX.Syn"')).rows[0][0]), 2);
    writeFileSync(join(output, "synonym.sql"), synonym.source);
    checks.push("synonym DDL replay and target replacement");
    const createLinkSql = createOceanBaseDatabaseLinkSql({ name: linkName, username: owner, tenant, password: fixturePassword, host: process.env.OB_LINK_HOST ?? `${host}:${port}`, protocol: "OB", public: false });
    assert.ok(createLinkSql.startsWith("CREATE DATABASE LINK "));
    assert.ok(!createLinkSql.startsWith("CREATE PUBLIC DATABASE LINK "));
    await sql(createLinkSql);
    linkCreated = true;
    const links = oracleDatabaseLinksFromResult(await sql(OCEANBASE_ORACLE_DATABASE_LINKS_SQL));
    const link = links.find((item) => item.owner === "PUBLIC" && item.name === linkName && item.canDrop);
    if (!link) {
      throw new Error("created link is not discoverable by the production listing query");
    }
    assert.equal(Number((await sql(testOracleDatabaseLinkSql(link, "oceanbase-oracle"))).rows[0][0]), 1);
    const observerLinks = oracleDatabaseLinksFromResult(await sql(OCEANBASE_ORACLE_DATABASE_LINKS_SQL, "observer"));
    const observerLink = observerLinks.find((item) => item.owner === "PUBLIC" && item.name === linkName && item.canDrop === false);
    assert.ok(observerLink, "link must be tenant-visible and read-only for users other than its creator");
    assert.equal(Number((await sql(testOracleDatabaseLinkSql(observerLink, "oceanbase-oracle"), "observer")).rows[0][0]), 1);
    await sql("ALTER SESSION SET CURRENT_SCHEMA = SYS");
    const scopedLinks = oracleDatabaseLinksFromResult(await sql(OCEANBASE_ORACLE_DATABASE_LINKS_SQL));
    assert.ok(scopedLinks.some((item) => item.owner === "PUBLIC" && item.name === linkName && item.canDrop));
    await sql(`ALTER SESSION SET CURRENT_SCHEMA = ${qi(owner)}`);
    checks.push("OB public link create/list/cross-user test and creator-only management");
    try {
      await sql(`ALTER DATABASE LINK ${linkName} CONNECT TO ${qi(owner)} IDENTIFIED BY ${qi(fixturePassword)}`);
      notes.push("ALTER DATABASE LINK accepted by this server; client still requires explicit replacement for host/tenant changes");
    } catch (error) {
      notes.push("ALTER DATABASE LINK probe: " + redact(error));
    }
    await sql(dropOracleDatabaseLinkSql(link, "oceanbase-oracle"));
    linkCreated = false;
    assert.ok(!oracleDatabaseLinksFromResult(await sql(OCEANBASE_ORACLE_DATABASE_LINKS_SQL)).some((item) => item.name === linkName));
    checks.push("explicit DBLink deletion");
  } catch (error) {
    failure = redact(error);
  } finally {
    if (connected) {
      if (linkCreated) {
        try {
          await sql(`DROP DATABASE LINK ${linkName}`);
          linkCreated = false;
          checks.push("failed-path DBLink cleanup");
        } catch (error) {
          notes.push("Cleanup required for database link " + linkName + ": " + redact(error));
          failure ??= "Database link cleanup failed";
        }
      }
      try {
        await call("close_session", { agentSessionId: "fixture" });
      } catch (error) {
        notes.push("close fixture: " + redact(error));
      }
    }
    if (observerConnected) {
      try {
        await call("close_session", { agentSessionId: "observer" });
      } catch (error) {
        notes.push("close observer: " + redact(error));
      }
    }
    if (observerCreated) {
      try {
        await sql(`DROP USER ${qi(observer)} CASCADE`, "admin");
        checks.push("observer fixture cleanup");
      } catch (error) {
        notes.push("Cleanup required for " + observer + ": " + redact(error));
        failure ??= "Observer fixture cleanup failed";
      }
    }
    if (created) {
      try {
        await sql(`DROP USER ${qi(owner)} CASCADE`, "admin");
        checks.push("isolated fixture cleanup");
      } catch (error) {
        notes.push("Cleanup required for " + owner + ": " + redact(error));
        failure ??= "Fixture cleanup failed";
      }
    }
    child.stdin.end();
    child.kill();
    rejectPending();
  }
  const result = { timestamp: new Date().toISOString(), owner, host, port, checks, notes, passed: !failure, ...(failure ? { error: failure } : {}) };
  writeFileSync(join(output, "verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failure) process.exitCode = 1;
}
main().catch((error) => {
  console.error(String(error).replaceAll(process.env.OB_PASSWORD ?? "__none__", "[redacted]"));
  process.exitCode = 1;
});
