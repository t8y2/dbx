import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

const variables = (source: string, databaseType: "mysql" | "postgres" = "mysql") => {
  const cursor = source.indexOf("|");
  const sql = source.replace("|", "");
  return buildSqlCompletionItems(sql, cursor < 0 ? sql.length : cursor, { databaseType, dialect: databaseType, tables: [], columnsByTable: new Map() }).filter((item) => item.type === "variable");
};

const procedure = (body: string) => `CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE db.p(IN p_input INT, OUT p_output DECIMAL(10,2), INOUT p_count INT) BEGIN ${body}`;

describe("MySQL routine variable completion (#12293)", () => {
  it("suggests IN, OUT and INOUT parameters without treating datatype commas as parameters", () => {
    expect(variables(procedure("SELECT p_")).map((item) => item.label)).toEqual(expect.arrayContaining(["p_input", "p_output", "p_count"]));
  });
  it("suggests multiple local declarations and excludes the declaration after the cursor", () => {
    const names = variables(procedure("DECLARE v_first, v_second INT DEFAULT 1; DECLARE v_third VARCHAR(10); SELECT v_|; DECLARE v_later INT;")).map((item) => item.label);
    expect(names).toEqual(expect.arrayContaining(["v_first", "v_second", "v_third"]));
    expect(names).not.toContain("v_later");
  });
  it("filters candidates by prefix and preserves identifier casing", () => {
    expect(variables(procedure("DECLARE v_Mixed INT; SELECT v_mi"))).toEqual([expect.objectContaining({ label: "v_Mixed", apply: "v_Mixed" })]);
  });
  it("supports function parameters in a simple RETURN body", () => {
    expect(variables("CREATE FUNCTION f(p_value INT) RETURNS INT DETERMINISTIC RETURN p_v")).toEqual([expect.objectContaining({ label: "p_value" })]);
  });
  it("does not leak a completed routine into another statement or routine", () => {
    expect(variables(procedure("SELECT 1; END; SELECT p_"))).toEqual([]);
    expect(variables("CREATE FUNCTION f(p_old INT) RETURNS INT RETURN p_old; SELECT p_")).toEqual([]);
    expect(variables(procedure("SELECT 1; END; CREATE PROCEDURE second(p_other INT) BEGIN SELECT p_")).map((item) => item.label)).toEqual(["p_other"]);
  });
  it("restores outer scope after a nested block and handles shadowing case-insensitively", () => {
    expect(variables(procedure("DECLARE v_outer INT; BEGIN DECLARE v_inner INT; SELECT v_")).map((item) => item.label)).toEqual(expect.arrayContaining(["v_outer", "v_inner"]));
    expect(variables(procedure("DECLARE v_outer INT; BEGIN DECLARE v_inner INT; SELECT 1; END; SELECT v_")).map((item) => item.label)).toEqual(["v_outer"]);
    expect(variables(procedure("DECLARE P_INPUT INT; SELECT p_i")).map((item) => item.label)).toEqual(["P_INPUT"]);
  });
  it.each([
    "IF p_input > 0 THEN SELECT 1; END IF;",
    "WHILE p_input > 0 DO SET p_input = p_input - 1; END WHILE;",
    "my_loop: LOOP LEAVE my_loop; END LOOP my_loop;",
    "REPEAT SET p_input = p_input - 1; UNTIL p_input = 0 END REPEAT;",
    "CASE p_input WHEN 1 THEN SELECT 1; ELSE SELECT 2; END CASE;",
    "SELECT CASE WHEN p_input = 1 THEN 2 ELSE 3 END;",
    "SELECT (CASE WHEN p_input = 1 THEN 2 ELSE 3 END);",
    "SELECT IF(p_input = 1, 2, 3);",
  ])("keeps the routine scope after control flow or expressions: %s", (body) => {
    expect(variables(procedure(`${body} SELECT p_i`)).map((item) => item.label)).toEqual(["p_input"]);
  });
  it("does not interpret qualified columns as block keywords", () => {
    expect(variables(procedure("SELECT t.begin, t.end, t.case FROM t; SELECT p_i")).map((item) => item.label)).toEqual(["p_input"]);
  });
  it("ignores strings, comments, cursors, conditions and handlers", () => {
    const names = variables(
      procedure(`DECLARE v_real INT; DECLARE v_condition CONDITION FOR SQLSTATE '45000'; DECLARE v_cursor CURSOR FOR SELECT 1; DECLARE CONTINUE HANDLER FOR NOT FOUND SET p_count = 0; -- DECLARE v_comment INT;\n SELECT 'BEGIN DECLARE v_string INT; END', "DECLARE v_double INT;"; SELECT v_`),
    ).map((item) => item.label);
    expect(names).toEqual(["v_real"]);
  });
  it("quotes identifiers when required by MySQL", () => {
    expect(variables("CREATE PROCEDURE p(IN `p value` INT) BEGIN SELECT p")).toContainEqual(expect.objectContaining({ label: "p value", apply: "`p value`" }));
  });
  it.each(["SELECT t.p_", "SELECT @p_", "SELECT @@p_", "SELECT * FROM p_", "CALL p_", "INSERT INTO t(p_"])("does not offer local values in an object or qualified context: %s", (tail) => {
    expect(variables(procedure(tail))).toEqual([]);
  });
  it.each(["SET p_output = p_i", "IF p_i", "SELECT COALESCE(p_i", "SELECT * FROM t WHERE id = p_i"])("suggests values in expression contexts: %s", (tail) => {
    expect(variables(procedure(tail)).map((item) => item.label)).toEqual(["p_input"]);
  });
  it.each(["$$", "//"])("respects DELIMITER %s scripts", (delimiter) => {
    const first = `DELIMITER ${delimiter}\nCREATE PROCEDURE old(p_old INT) BEGIN SELECT 1; END${delimiter}\n`;
    expect(variables(`${first}CREATE PROCEDURE current(p_current INT) BEGIN SELECT p_`).map((item) => item.label)).toEqual(["p_current"]);
    expect(variables(`${first}DELIMITER ;\nSELECT p_`)).toEqual([]);
    expect(variables(`DELIMITER ${delimiter}\nCREATE PROCEDURE current(p_input INT) BEGIN SELECT '${delimiter}'; SELECT p_i`).map((item) => item.label)).toEqual(["p_input"]);
  });
  it("does not collect values outside a MySQL routine", () => {
    expect(variables("DECLARE v_outside INT; SELECT v_")).toEqual([]);
    expect(variables(procedure("SELECT p_"), "postgres")).toEqual([]);
  });
});
