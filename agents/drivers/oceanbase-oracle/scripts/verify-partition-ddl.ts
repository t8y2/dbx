import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { applyDdlStoragePreference } from "../../../../apps/desktop/src/lib/sql/ddlStorage";
import { splitSqlStatementRanges } from "../../../../apps/desktop/src/lib/sql/sqlStatementRanges";

async function main() {
  const password = process.env.OB_PASSWORD;
  const host = process.env.OB_HOST;
  const tenant = process.env.OB_TENANT;
  assert.ok(password && host && tenant, "Set OB_HOST, OB_TENANT and OB_PASSWORD for a disposable Oracle tenant");
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
  const jar = "agents/drivers/oceanbase-oracle/build/libs/dbx-agent-oceanbase-oracle.jar";
  const output = process.env.OB_TEST_OUTPUT ?? join("agents/drivers/oceanbase-oracle/build", "partition-ddl-evidence");
  mkdirSync(output, { recursive: true });
  const child = spawn(java, ["-jar", jar], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  let id = 0;
  const pending = new Map<number, { resolve: (x: any) => void; reject: (x: any) => void }>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("{")) return;
    const response = JSON.parse(line);
    const task = pending.get(response.id);
    if (!task) return;
    pending.delete(response.id);
    response.error ? task.reject(new Error(response.error.message)) : task.resolve(response.result);
  });
  child.on("exit", () => {
    for (const request of pending.values()) request.reject(new Error("Agent exited"));
    pending.clear();
  });
  child.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  function call(method: string, params: any = {}) {
    return new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Agent request timed out: " + method));
      }, 60_000);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
  }
  const connect = (user: string, session: string) => call("open_session", { agentSessionId: session, host, port: Number(process.env.OB_PORT ?? 2881), database: user, username: user + "@" + tenant, password });
  const sql = (text: string, session = "admin") =>
    call("execute_query", { agentSessionId: session, sql: text, maxRows: 1000, timeoutSecs: 30 }).catch((e) => {
      throw new Error((text.startsWith("CREATE USER") ? "CREATE USER [redacted]" : text) + "\n" + e.message);
    });
  const qi = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const source = "DBX7055_S" + suffix,
    logical = "DBX7055_L" + suffix,
    physical = "DBX7055_P" + suffix;
  const fixtures = [
    ["PARENT", "(ID NUMBER PRIMARY KEY)"],
    [
      "RANGE_LIST",
      `(ID NUMBER NOT NULL, REGION VARCHAR2(30) DEFAULT 'PCTFREE = 20', NOTE VARCHAR2(100), CONSTRAINT C_PK PRIMARY KEY(ID,REGION), CONSTRAINT C_CK CHECK(ID>0)) PARTITION BY RANGE(ID) SUBPARTITION BY LIST(REGION) (PARTITION P1 VALUES LESS THAN(100) (SUBPARTITION P1_E VALUES('east'), SUBPARTITION P1_D VALUES(DEFAULT)), PARTITION PM VALUES LESS THAN(MAXVALUE) (SUBPARTITION PM_E VALUES('east'), SUBPARTITION PM_D VALUES(DEFAULT)))`,
    ],
    ["RANGE_T", `(ID NUMBER, D DATE) PARTITION BY RANGE(ID,D) (PARTITION P1 VALUES LESS THAN(100,DATE '2027-01-01'), PARTITION PM VALUES LESS THAN(MAXVALUE,MAXVALUE))`],
    ["LIST_T", `(REGION VARCHAR2(30), ID NUMBER) PARTITION BY LIST(REGION) (PARTITION PE VALUES ('east','PCTFREE = 20'), PARTITION PD VALUES(DEFAULT))`],
    ["HASH_T", "(ID NUMBER, NOTE VARCHAR2(100)) PARTITION BY HASH(ID) PARTITIONS 4"],
    ["CHILD", "(ID NUMBER PRIMARY KEY, PARENT_ID NUMBER, CONSTRAINT C_FK FOREIGN KEY(PARENT_ID) REFERENCES " + qi(source) + ".PARENT(ID))"],
    ["Mixed Table", `("PCTFREE" VARCHAR2(100) DEFAULT 'can''t ; ) PCTFREE=12', "ID" NUMBER)`],
  ];
  const tables = fixtures.map((x) => x[0]);
  tables.push("TEMP_T");
  try {
    await call("handshake");
    await connect("SYS", "admin");
    for (const owner of [source, logical, physical]) {
      await sql("CREATE USER " + qi(owner) + " IDENTIFIED BY " + qi(password));
      await sql("GRANT CREATE SESSION, CREATE TABLE TO " + qi(owner));
    }
    for (const [name, definition] of fixtures) await sql("CREATE TABLE " + qi(source) + "." + qi(name) + " " + definition);
    await sql("CREATE GLOBAL TEMPORARY TABLE " + qi(source) + ".TEMP_T(ID NUMBER) ON COMMIT PRESERVE ROWS");
    await sql("CREATE INDEX " + qi(source) + ".C_LOCAL ON " + qi(source) + ".RANGE_LIST(NOTE) LOCAL");
    await sql("COMMENT ON TABLE " + qi(source) + ".RANGE_LIST IS 'table''s PCTFREE = 20'");
    await sql("COMMENT ON COLUMN " + qi(source) + ".RANGE_LIST.NOTE IS 'note ; ) COMPRESS FOR ARCHIVE'");
    await connect(source, "source");
    await connect(logical, "logical");
    await connect(physical, "physical");
    const checks: any[] = [];
    for (const name of tables) {
      const params = { schema: source, table: name, agentSessionId: "source" };
      const ddl: string = await call("get_table_ddl", params);
      const parts = await call("list_partitions", params),
        subs = await call("list_subpartitions", params);
      const expected: Record<string, [number, number]> = { RANGE_LIST: [2, 4], RANGE_T: [2, 0], LIST_T: [2, 0], HASH_T: [4, 0] };
      if (expected[name]) assert.deepEqual([parts.length, subs.length], expected[name]);
      const simple = applyDdlStoragePreference(ddl, "oceanbase-oracle");
      assert.equal(applyDdlStoragePreference(ddl, "oceanbase-oracle", false), ddl);
      assert.ok(!simple.includes("REPLICA_NUM = "));
      for (const [owner, session, script] of [
        [logical, "logical", simple],
        [physical, "physical", ddl],
      ]) {
        for (const statement of splitSqlStatementRanges(script.replaceAll(qi(source) + ".", qi(owner) + "."), "oceanbase-oracle").map((s) => s.sql)) await sql(statement, session);
        assert.deepEqual(await call("list_partitions", { ...params, schema: owner, agentSessionId: session }), parts);
        assert.deepEqual(await call("list_subpartitions", { ...params, schema: owner, agentSessionId: session }), subs);
        assert.deepEqual(await call("get_columns", { ...params, schema: owner, agentSessionId: session }), await call("get_columns", params));
      }
      writeFileSync(join(output, name.replaceAll('"', "") + ".full.sql"), ddl);
      writeFileSync(join(output, name.replaceAll('"', "") + ".logical.sql"), simple);
      checks.push({ table: name, partitions: parts.length, subpartitions: subs.length, replayed: ["logical", "physical"] });
    }
    for (const session of ["source", "logical", "physical"]) {
      await sql("INSERT INTO RANGE_LIST VALUES(1,'east','first')", session);
      await sql("INSERT INTO RANGE_LIST VALUES(101,'west','second')", session);
      await assert.rejects(sql("INSERT INTO RANGE_LIST VALUES(-1,'east','bad')", session));
      await assert.rejects(sql("INSERT INTO RANGE_LIST VALUES(1,'east','duplicate')", session));
      await sql("INSERT INTO PARENT VALUES(1)", session);
      await sql("INSERT INTO CHILD VALUES(1,1)", session);
      await assert.rejects(sql("INSERT INTO CHILD VALUES(2,999)", session));
      const comment = await sql("SELECT COMMENTS FROM USER_TAB_COMMENTS WHERE TABLE_NAME='RANGE_LIST'", session);
      assert.equal(comment.rows[0][0], "table's PCTFREE = 20");
      const local = await sql("SELECT INDEX_NAME, LOCALITY FROM USER_PART_INDEXES WHERE TABLE_NAME='RANGE_LIST'", session);
      assert.ok(local.rows.some((r: any[]) => r.includes("C_LOCAL") && r.includes("LOCAL")));
    }
    const report = { source, logical, physical, checks, semanticChecks: "partition bounds, keys, columns/defaults/comments, local index, primary/check/foreign-key enforcement" };
    writeFileSync(join(output, "verification.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    child.stdin.end();
    child.kill();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
