import { strict as assert } from "node:assert";
import { test } from "vitest";
import { analyzeMysqlRoutineSyntax } from "../../apps/desktop/src/lib/sql/mysqlRoutineSyntaxDiagnostics.ts";

const reportedSql = `drop procedure if exists proc_check_gys;
CREATE PROCEDURE proc_check_gys(
   in in_gys_name varchar(100), -- 供应商账号
   in in_yys varchar(100), -- 运营商账号
)
run:
BEGIN
 set @yys='';
 set @uid=0;
 select uid,yys INTO @uid, @yys from uchome_space AS us where username=in_gys_name limit 1;
 if @uid=0 THEN
     select 1 as code,'供应商不存在' as msg;
     return;
 END if;
 if @yys<> in_gys_name THEN
     select 2 as code,'运营商不正确' as msg;
     return;
 end if;
 select 0 as code,'' as msg;
end`;

test("reports deterministic MySQL procedure syntax errors", () => {
  const analysis = analyzeMysqlRoutineSyntax(reportedSql);

  assert.equal(analysis.hasRoutine, true);
  assert.equal(analysis.routineRanges.length, 1);
  assert.equal(reportedSql.slice(analysis.routineRanges[0].from, analysis.routineRanges[0].to).startsWith("CREATE PROCEDURE"), true);
  assert.deepEqual(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["Trailing comma is not allowed in a MySQL routine parameter list", "RETURN is not valid in a MySQL procedure; use LEAVE with a block label", "RETURN is not valid in a MySQL procedure; use LEAVE with a block label"],
  );
  assert.deepEqual(
    analysis.diagnostics.map((diagnostic) => [diagnostic.span.start_line, diagnostic.span.start_column]),
    [
      [4, 26],
      [13, 6],
      [17, 6],
    ],
  );
});

test("accepts a labeled MySQL procedure that exits with LEAVE", () => {
  const analysis = analyzeMysqlRoutineSyntax(`CREATE DEFINER=CURRENT_USER PROCEDURE proc_check_gys(
  IN in_gys_name VARCHAR(100),
  IN amount DECIMAL(10, 2),
  IN mode_name ENUM('direct', 'proxy')
)
run: BEGIN
  IF in_gys_name = '' THEN
    LEAVE run;
  END IF;
  SELECT 'RETURN;,)' AS message;
  -- RETURN in a comment must be ignored
END`);

  assert.equal(analysis.hasRoutine, true);
  assert.deepEqual(analysis.diagnostics, []);
});

test("checks bare RETURN only for MySQL functions", () => {
  const validNumber = analyzeMysqlRoutineSyntax("CREATE FUNCTION answer() RETURNS INT BEGIN RETURN -1; END");
  const validString = analyzeMysqlRoutineSyntax("CREATE FUNCTION answer() RETURNS VARCHAR(10) BEGIN RETURN 'ok'; END");
  const invalid = analyzeMysqlRoutineSyntax("CREATE FUNCTION answer() RETURNS INT BEGIN RETURN; END");
  const invalidWithComment = analyzeMysqlRoutineSyntax("CREATE FUNCTION answer() RETURNS INT BEGIN RETURN /* missing value */; END");

  assert.deepEqual(validNumber.diagnostics, []);
  assert.deepEqual(validString.diagnostics, []);
  assert.deepEqual(
    invalid.diagnostics.map((diagnostic) => diagnostic.message),
    ["RETURN in a MySQL function requires an expression"],
  );
  assert.deepEqual(
    invalidWithComment.diagnostics.map((diagnostic) => diagnostic.message),
    ["RETURN in a MySQL function requires an expression"],
  );
});

test("ignores ordinary SQL and quoted routine keywords", () => {
  assert.deepEqual(analyzeMysqlRoutineSyntax("SELECT 'CREATE PROCEDURE p() RETURN;' AS body"), { diagnostics: [], hasRoutine: false, routineRanges: [] });
});

test("keeps multiple routine ranges separate from ordinary SQL", () => {
  const sql = `CREATE PROCEDURE first_proc() BEGIN RETURN; END$$
SELECT missing_column FROM users;
CREATE FUNCTION second_func() RETURNS INT BEGIN RETURN 1; END$$`;
  const analysis = analyzeMysqlRoutineSyntax(sql);

  assert.equal(analysis.routineRanges.length, 2);
  assert.equal(
    analysis.routineRanges.some((range) => sql.slice(range.from, range.to).includes("SELECT missing_column")),
    false,
  );
  assert.deepEqual(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["RETURN is not valid in a MySQL procedure; use LEAVE with a block label"],
  );
});
