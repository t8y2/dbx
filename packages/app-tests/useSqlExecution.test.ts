import { strict as assert } from "node:assert";
import { test } from "vitest";
import { isDangerousSql, stripSqlComments, supportsSqlTemplateParameters } from "../../apps/desktop/src/composables/useSqlExecution.ts";

test("stripSqlComments removes block comments", () => {
  assert.equal(stripSqlComments("SELECT /* drop */ 1").includes("drop"), false);
});

test("stripSqlComments removes line comments", () => {
  assert.equal(stripSqlComments("SELECT 1 -- DROP TABLE").includes("DROP"), false);
});

test("stripSqlComments removes MySQL hash comments", () => {
  assert.equal(stripSqlComments("SELECT 1 # DELETE").includes("DELETE"), false);
});

test("SELECT with REPLACE function is not dangerous", () => {
  assert.equal(isDangerousSql("SELECT REPLACE(col, ';', ',') FROM t"), false);
});

test("SELECT with TRUNCATE function is not dangerous", () => {
  assert.equal(isDangerousSql("SELECT TRUNCATE(1.234, 2)"), false);
});

test("REPLACE INTO is dangerous", () => {
  assert.equal(isDangerousSql("REPLACE INTO t VALUES (1, 2)"), true);
});

test("DELETE FROM is dangerous", () => {
  assert.equal(isDangerousSql("DELETE FROM t WHERE id = 1"), true);
});

test("DROP TABLE is dangerous", () => {
  assert.equal(isDangerousSql("DROP TABLE t"), true);
});

test("UPDATE is dangerous", () => {
  assert.equal(isDangerousSql("UPDATE t SET col = 1"), true);
});

test("ALTER TABLE is dangerous", () => {
  assert.equal(isDangerousSql("ALTER TABLE t ADD COLUMN c INT"), true);
});

test("TRUNCATE TABLE is dangerous", () => {
  assert.equal(isDangerousSql("TRUNCATE TABLE t"), true);
});

test("multi-statement with danger in second statement is dangerous", () => {
  assert.equal(isDangerousSql("SELECT 1; DROP TABLE t"), true);
});

test("danger keyword inside comment is not dangerous", () => {
  assert.equal(isDangerousSql("SELECT 1 /* DROP TABLE t */"), false);
});

test("leading whitespace before danger keyword is dangerous", () => {
  assert.equal(isDangerousSql("  DELETE FROM t"), true);
});

test("complex SELECT with joins and functions is not dangerous", () => {
  const sql = `select mkey, replace(xxxx,';',',') as xxxx_content,
    SUBSTRING_INDEX(SUBSTRING_INDEX(pmid,'/',3),'/',-1) as xxx
    from m_xxx left join (
      select xxx from m_alarm where alarm_time >= SUBDATE(now(), interval 3 minute)
    ) as xxxx on m_alarm.mid = m_alarm_tmp.mid`;
  assert.equal(isDangerousSql(sql), false);
});

test("distinguishes Elasticsearch REST paths from SQL template parameters", () => {
  assert.equal(supportsSqlTemplateParameters({ db_type: "elasticsearch" }, "GET /_search?pretty"), false);
  assert.equal(supportsSqlTemplateParameters({ db_type: "elasticsearch" }, '/* request */\nPOST /orders/_search\n{"query":{"term":{"id":":id"}}}'), false);
  assert.equal(supportsSqlTemplateParameters({ db_type: "elasticsearch" }, "SELECT * FROM orders WHERE customer_id = :customer_id"), true);
  assert.equal(supportsSqlTemplateParameters({ db_type: "mysql" }), true);
});

test("detects destructive Elasticsearch requests across a parsed request list", () => {
  assert.equal(isDangerousSql("GET /_cluster/health\n\nDELETE /production-index", "elasticsearch"), true);
  assert.equal(isDangerousSql("GET /_cluster/health\n\nPOST /orders/_delete_by_query\n{}", "elasticsearch"), true);
  assert.equal(isDangerousSql('POST /_bulk\n{"delete":{"_index":"orders","_id":"1"}}', "elasticsearch"), true);
  assert.equal(isDangerousSql('PUT /orders/_mapping\n{"properties":{}}', "elasticsearch"), true);
  assert.equal(isDangerousSql("GET /_cluster/health\n\n/* DELETE /production-index */\nGET /_cat/indices", "elasticsearch"), false);
  assert.equal(isDangerousSql('DELETE /_search/scroll\n{"scroll_id":"abc"}', "elasticsearch"), false);
});
