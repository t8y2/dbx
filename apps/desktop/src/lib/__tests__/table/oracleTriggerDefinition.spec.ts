import { describe, expect, it } from "vitest";
import { oracleTriggerOwner, parseOracleTriggerDefinition, prepareDisabledOracleTriggerReplacement, prepareOracleTriggerReplacement, updateOracleTriggerDefinition } from "@/lib/table/oracleTriggerDefinition";

const source = `-- original header
CREATE OR REPLACE TRIGGER "APP"."Quoted Trigger"
BEFORE INSERT OR UPDATE OF "Value" ON "APP"."Data Table"
REFERENCING OLD AS prior NEW AS next
FOR EACH ROW DISABLE
WHEN (next."Value" <> q'[O'Reilly (body)]')
DECLARE
  v_text VARCHAR2(100) := q'[BEGIN; END; Quoted Trigger]';
BEGIN
  :next."Value" := :prior."Value";
END;
/`;

describe("Oracle complete trigger definition editing", () => {
  it.each([
    { name: "ENABLE", table: "DISABLE", header: "" },
    { name: "T", table: "DATA", header: "REFERENCING OLD AS DISABLE NEW AS ENABLE FOR EACH ROW" },
    { name: "T", table: "DATA", header: "FOLLOWS APP.ENABLE, APP.DISABLE" },
    { name: "T", table: "DATA", header: 'FOLLOWS APP."BEGIN"' },
  ])("preserves names in the header when disabling before replacement: $header", ({ name, table, header }) => {
    const prefix = `CREATE OR REPLACE TRIGGER APP.${name} BEFORE INSERT ON APP.${table} ${header} `;
    const expected = { schema: "APP", name, tableSchema: "APP", tableName: table };
    expect(prepareDisabledOracleTriggerReplacement(prefix + "BEGIN NULL; END;", expected)).toBe(prefix + "DISABLE\nBEGIN NULL; END;");
    expect(prepareDisabledOracleTriggerReplacement(prefix + "ENABLE BEGIN NULL; END;", expected)).toBe(prefix + "DISABLE BEGIN NULL; END;");
  });

  it("locates the body after an edition clause, ordering names and a balanced WHEN condition", () => {
    const prefix = "CREATE OR REPLACE TRIGGER APP.T BEFORE INSERT ON APP.DATA FOR EACH ROW FORWARD CROSSEDITION FOLLOWS APP.ENABLE ";
    const body = 'WHEN (:NEW."BEGIN" = q\'[DISABLE (BEGIN)]\') BEGIN NULL; END;';
    expect(prepareDisabledOracleTriggerReplacement(prefix + body, { schema: "APP", name: "T" })).toBe(prefix + "DISABLE\n" + body);
  });

  it("uses the exact trigger owner and does not infer it from an unqualified or mismatched source", () => {
    expect(oracleTriggerOwner({ name: "T", owner: " Other Owner ", statement: "invalid source" })).toBe(" Other Owner ");
    expect(oracleTriggerOwner({ name: "T", statement: "CREATE TRIGGER OTHER.T BEFORE INSERT ON APP.DATA BEGIN NULL; END;" })).toBe("OTHER");
    expect(oracleTriggerOwner({ name: "T", statement: "CREATE TRIGGER T BEFORE INSERT ON APP.DATA BEGIN NULL; END;" })).toBeUndefined();
    expect(oracleTriggerOwner({ name: "T", statement: "CREATE TRIGGER OTHER.UNRELATED BEFORE INSERT ON APP.DATA BEGIN NULL; END;" })).toBeUndefined();
    expect(oracleTriggerOwner({ name: "T" })).toBeUndefined();
  });
  it("round-trips comments, aliases, WHEN, body and quoted names without serialization", () => {
    const parsed = parseOracleTriggerDefinition(source);
    expect(parsed).toMatchObject({ structured: true, schema: "APP", name: "Quoted Trigger", tableName: "Data Table" });
    expect(parsed.fields).toMatchObject({ referencing: "OLD AS prior NEW AS next", rowLevel: true, when: `next."Value" <> q'[O'Reilly (body)]'` });
    expect(updateOracleTriggerDefinition(parsed, { ...parsed.fields! })).toBe(source);
  });

  it("changes only the requested event field while retaining unrelated text", () => {
    const parsed = parseOracleTriggerDefinition(source);
    const edited = updateOracleTriggerDefinition(parsed, { ...parsed.fields!, events: "DELETE" });
    expect(edited).toBe(source.replace('INSERT OR UPDATE OF "Value"', "DELETE"));
  });

  it("qualifies unqualified trigger and table declarations using independent selected owners", () => {
    const sql = 'CREATE TRIGGER /* trigger comment */ "Quoted Trigger" BEFORE INSERT ON /* target comment */ "Data Table" FOR EACH ROW BEGIN NULL; END;';
    const replacement = prepareDisabledOracleTriggerReplacement(sql, { schema: 'Trigger"Owner', name: "Quoted Trigger", tableSchema: 'Table"Owner', tableName: "Data Table" });
    expect(replacement).toContain('TRIGGER /* trigger comment */ "Trigger""Owner"."Quoted Trigger"');
    expect(replacement).toContain('ON /* target comment */ "Table""Owner"."Data Table"');
    expect(replacement).toContain("FOR EACH ROW DISABLE\nBEGIN NULL; END;");
    const parsed = parseOracleTriggerDefinition(sql);
    expect(updateOracleTriggerDefinition(parsed, { ...parsed.fields! })).toBe(sql);
  });

  it("rejects explicit table owner or name changes before generating replacement DDL", () => {
    const selected = { schema: "OTHER", name: "T", tableSchema: "APP", tableName: "DATA" };
    expect(() => prepareDisabledOracleTriggerReplacement("CREATE TRIGGER OTHER.T BEFORE INSERT ON WRONG.DATA BEGIN NULL; END;", selected)).toThrow("target");
    expect(() => prepareDisabledOracleTriggerReplacement("CREATE TRIGGER OTHER.T BEFORE INSERT ON APP.WRONG BEGIN NULL; END;", selected)).toThrow("target");
  });

  it("keeps a nested-table trigger in complete-source mode and qualifies its parent view", () => {
    const sql = 'CREATE TRIGGER OTHER.T INSTEAD OF INSERT ON NESTED TABLE "Nested Values" OF "Data View" REFERENCING NEW AS next PARENT AS parent FOR EACH ROW BEGIN NULL; END;';
    const parsed = parseOracleTriggerDefinition(sql);
    expect(parsed).toMatchObject({ structured: false, schema: "OTHER", name: "T", tableName: "Data View" });
    const replacement = prepareDisabledOracleTriggerReplacement(sql, { schema: "OTHER", name: "T", tableSchema: "APP", tableName: "Data View" });
    expect(replacement).toContain('NESTED TABLE "Nested Values" OF "APP"."Data View"');
    expect(replacement).toContain("REFERENCING NEW AS next PARENT AS parent FOR EACH ROW DISABLE\nBEGIN NULL; END;");
  });

  it("inserts row and alias clauses before an existing DISABLE and WHEN clause", () => {
    const initial = "CREATE TRIGGER APP.T AFTER INSERT ON APP.DATA DISABLE BEGIN NULL; END;";
    const parsed = parseOracleTriggerDefinition(initial);
    const edited = updateOracleTriggerDefinition(parsed, { ...parsed.fields!, rowLevel: true, referencing: "NEW AS next", when: "next.VALUE > 0" });
    expect(edited).toContain("REFERENCING NEW AS next\nFOR EACH ROW\nDISABLE WHEN (next.VALUE > 0)\nBEGIN");
    expect(parseOracleTriggerDefinition(edited).fields).toMatchObject({ rowLevel: true, referencing: "NEW AS next", when: "next.VALUE > 0" });
  });

  it("requires complete source mode for compound and ordering clauses", () => {
    for (const sql of [
      "CREATE TRIGGER APP.T FOR INSERT ON APP.DATA COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;",
      "CREATE TRIGGER APP.T AFTER INSERT ON APP.DATA FOR EACH ROW FOLLOWS APP.OTHER BEGIN NULL; END;",
    ]) expect(parseOracleTriggerDefinition(sql).structured).toBe(false);
  });

  it("rejects changing the selected identity and never emits DROP", () => {
    expect(() => prepareOracleTriggerReplacement(source, { schema: "OTHER", name: "Quoted Trigger" })).toThrow("identity");
    const sql = prepareDisabledOracleTriggerReplacement(source, { schema: "APP", name: "Quoted Trigger" });
    expect(sql).toContain("FOR EACH ROW DISABLE");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql.endsWith("/" )).toBe(false);
  });

  it("adds replacement and disabled state without rewriting a compound body", () => {
    const sql = "CREATE TRIGGER APP.T FOR INSERT ON APP.DATA COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;";
    expect(prepareDisabledOracleTriggerReplacement(sql, { schema: "APP", name: "T" })).toBe(sql.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER").replace("COMPOUND TRIGGER", "DISABLE\nCOMPOUND TRIGGER"));
  });

  it("round-trips a matching ALTER footer while saving only the trigger definition", () => {
    const sql = 'CREATE TRIGGER "APP"."Quoted Trigger" BEFORE INSERT ON "APP"."Data Table" FOR EACH ROW BEGIN NULL; END;\n/\nALTER TRIGGER "APP"."Quoted Trigger" ENABLE;\n';
    const parsed = parseOracleTriggerDefinition(sql);
    expect(parsed.fields?.body).toBe("BEGIN NULL; END;");
    expect(updateOracleTriggerDefinition(parsed, { ...parsed.fields! })).toBe(sql);
    const replacement = prepareDisabledOracleTriggerReplacement(sql, { schema: "APP", name: "Quoted Trigger" });
    expect(replacement).toContain("DISABLE\nBEGIN NULL; END;");
    expect(replacement).not.toContain("ALTER TRIGGER");
    expect(replacement).not.toContain("\n/");
  });

  it("checks a qualified ALTER footer against the selected owner even when CREATE is unqualified", () => {
    const sql = "CREATE TRIGGER T BEFORE INSERT ON APP.DATA BEGIN NULL; END;\nALTER TRIGGER OTHER.T DISABLE;";
    expect(() => prepareOracleTriggerReplacement(sql, { schema: "APP", name: "T" })).toThrow("different identity");
  });

  it.each([
    "ALTER TRIGGER APP.OTHER ENABLE;",
    "ALTER TRIGGER APP.T COMPILE;",
    "ALTER TRIGGER APP.T ENABLE; DROP TABLE APP.DATA;",
    "DROP TABLE APP.DATA;",
    "SELECT * FROM APP.DATA;",
    "BEGIN DELETE FROM APP.DATA; END;",
    "DECLARE v NUMBER; BEGIN DELETE FROM APP.DATA; END;",
  ])("rejects an unsafe or unrelated trailing statement: %s", (tail) => {
    expect(() => prepareOracleTriggerReplacement(`CREATE TRIGGER APP.T BEFORE INSERT ON APP.DATA BEGIN NULL; END;\n${tail}`, { schema: "APP", name: "T" })).toThrow();
  });

  it("keeps nested blocks, local routines, CASE, IF and LOOP inside one trigger", () => {
    const sql = `CREATE TRIGGER APP.T BEFORE INSERT ON APP.DATA
DECLARE
  PROCEDURE local_proc;
  PROCEDURE local_proc IS BEGIN NULL; END;
BEGIN
  BEGIN NULL; END;
  BEGIN NULL; END;
  IF 1 = 1 THEN
    FOR i IN 1..2 LOOP
      CASE i WHEN 1 THEN local_proc; ELSE NULL; END CASE;
    END LOOP;
  END IF;
END;`;
    expect(prepareOracleTriggerReplacement(sql, { schema: "APP", name: "T" })).toBe(sql.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER"));
  });

  it("does not terminate a compound trigger at the end of its first timing section", () => {
    const sql = `CREATE TRIGGER APP.T FOR INSERT ON APP.DATA COMPOUND TRIGGER
  PROCEDURE local_proc IS BEGIN NULL; END;
  BEFORE STATEMENT IS BEGIN local_proc; END BEFORE STATEMENT;
  AFTER EACH ROW IS BEGIN NULL; END AFTER EACH ROW;
END T;`;
    expect(prepareOracleTriggerReplacement(sql, { schema: "APP", name: "T" })).toBe(sql.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER"));
    expect(() => prepareOracleTriggerReplacement(sql + "\nBEGIN DELETE FROM APP.DATA; END;", { schema: "APP", name: "T" })).toThrow("Additional statements");
  });
});
