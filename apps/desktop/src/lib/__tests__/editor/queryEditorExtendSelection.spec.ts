import { readFileSync } from "node:fs";
import { selectParentSyntax } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { plainTextSelectionRanges } from "@/lib/editor/plainTextSelectionRanges";
import { extendQueryEditorSelection, runQueryEditorAltExtendSelection } from "@/lib/editor/queryEditorExtendSelection";
import { chooseNextSemanticSelectionRange, type SemanticSelectionRange } from "@/lib/editor/semanticSelectionRanges";
import { sqlSemanticSelectionRanges } from "@/lib/editor/sqlSemanticSelectionRanges";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function runCommand(command: Command, state: EditorState): EditorState {
  let nextState = state;
  const handled = command({
    state,
    dispatch(transaction) {
      nextState = transaction.state;
    },
  });

  expect(handled).toBe(true);
  return nextState;
}

function selectedTexts(state: EditorState): string[] {
  return state.selection.ranges.map((range) => state.sliceDoc(range.from, range.to));
}

function plainTextSelectionSequence(doc: string, cursor: number): string[] {
  const result: string[] = [];
  let current: SemanticSelectionRange = { from: cursor, to: cursor };

  while (true) {
    const context = { doc, cursor, current };
    const next = chooseNextSemanticSelectionRange(current, cursor, plainTextSelectionRanges(context));
    if (!next) return result;
    result.push(doc.slice(next.from, next.to));
    current = next;
  }
}

function selectionSequence(doc: string, cursor: number, language: "sql" | "text"): string[] {
  const result: string[] = [];
  let current: SemanticSelectionRange = { from: cursor, to: cursor };

  while (true) {
    const context = { doc, cursor, current, preferDelimitedContent: language === "sql" };
    const candidates = plainTextSelectionRanges(context);
    if (language === "sql") candidates.push(...sqlSemanticSelectionRanges(context, { databaseType: "mysql" }));
    const next = chooseNextSemanticSelectionRange(current, cursor, candidates);
    if (!next) return result;
    result.push(doc.slice(next.from, next.to));
    current = next;
  }
}

function runExtendSelection(state: EditorState, options: { databaseType?: "mysql"; language?: "sql" | "text" } = {}): EditorState {
  let nextState = state;
  const handled = extendQueryEditorSelection(
    {
      state,
      dispatch(transaction) {
        nextState = state.update(transaction).state;
      },
    } as never,
    options,
  );
  expect(handled).toBe(true);
  return nextState;
}

describe("query editor extend selection", () => {
  it("extends plain text through word, quotes, brackets, line, paragraph, and document", () => {
    const doc = "prefix (say 'hello world') suffix\ncontinued line\n\nnext paragraph";
    const cursor = doc.indexOf("hello") + 2;

    expect(plainTextSelectionSequence(doc, cursor)).toEqual(["hello", "hello world", "'hello world'", "say 'hello world'", "(say 'hello world')", "prefix (say 'hello world') suffix", "prefix (say 'hello world') suffix\ncontinued line", doc]);
  });

  it("ignores unmatched delimiters in plain text fallback", () => {
    const doc = "alpha ('broken beta";
    const cursor = doc.indexOf("beta") + 1;

    expect(plainTextSelectionSequence(doc, cursor)).toEqual(["beta", doc]);
  });

  it("matches IntelliJ SQL selection for a string comparison and where clause", () => {
    const doc = "select *\nfrom rq_queuing_record where code = '001';";
    const cursor = doc.indexOf("001") + 1;
    const sequence = selectionSequence(doc, cursor, "sql");

    expect(sequence.slice(0, 4)).toEqual(["001", "'001'", "code = '001'", "where code = '001'"]);
  });

  it("keeps the second command at the complete literal with uppercase SQL and LIMIT", () => {
    const doc = "SELECT *\nFROM rq_operate_log\nWHERE code = '001'\nLIMIT 100;";
    const cursor = doc.indexOf("001") + 1;
    let state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
    });

    state = runExtendSelection(state, { databaseType: "mysql", language: "sql" });
    expect(selectedTexts(state)).toEqual(["001"]);

    state = runExtendSelection(state, { databaseType: "mysql", language: "sql" });
    expect(selectedTexts(state)).toEqual(["'001'"]);
  });

  it("continues through real SQL parents instead of a fixed fifth full-document step", () => {
    const doc = "select * from t where code = (select code from u where id = '001')";
    const sequence = selectionSequence(doc, doc.indexOf("001") + 1, "sql");

    expect(sequence.slice(0, 4)).toEqual(["001", "'001'", "id = '001'", "where id = '001'"]);
    expect(sequence[4]).not.toBe(doc);
    expect(sequence).toContain("select code from u where id = '001'");
  });

  it("extends comparison through AND, OR, and the enclosing where clause", () => {
    const doc = "select * from t where a = 1 and b = 2 or c = 3 order by id";
    const sequence = selectionSequence(doc, doc.indexOf("b = 2") + 1, "sql");

    expect(sequence).toContain("b = 2");
    expect(sequence).toContain("a = 1 and b = 2");
    expect(sequence).toContain("a = 1 and b = 2 or c = 3");
    expect(sequence).toContain("where a = 1 and b = 2 or c = 3");
  });

  it("groups mixed AND and OR conditions by SQL operator precedence", () => {
    const doc = "select * from t where a = 1 or b = 2 and c = 3";
    const sequence = selectionSequence(doc, doc.indexOf("b = 2") + 1, "sql");

    const comparison = sequence.indexOf("b = 2");
    const andExpression = sequence.indexOf("b = 2 and c = 3");
    const orExpression = sequence.indexOf("a = 1 or b = 2 and c = 3");
    expect(comparison).toBeGreaterThanOrEqual(0);
    expect(andExpression).toBeGreaterThan(comparison);
    expect(orExpression).toBeGreaterThan(andExpression);
    expect(sequence).not.toContain("a = 1 or b = 2");
  });

  it("applies arithmetic precedence before comparison and logical operators", () => {
    const doc = "select * from t where a = 1 or score = 2 + 3 * 4";
    const sequence = selectionSequence(doc, doc.indexOf("3 * 4") + 1, "sql");

    expect(sequence).toContain("3 * 4");
    expect(sequence).toContain("2 + 3 * 4");
    expect(sequence).toContain("score = 2 + 3 * 4");
    expect(sequence).toContain("a = 1 or score = 2 + 3 * 4");
    expect(sequence).not.toContain("2 + 3");
  });

  it("keeps parenthesized boolean expressions as an explicit selection parent", () => {
    const doc = "select * from t where a = 1 and (b = 2 or c = 3)";
    const sequence = selectionSequence(doc, doc.indexOf("b = 2") + 1, "sql");

    expect(sequence).toContain("b = 2 or c = 3");
    expect(sequence).toContain("(b = 2 or c = 3)");
    expect(sequence).toContain("a = 1 and (b = 2 or c = 3)");
  });

  it("builds logical ranges independently inside nested subqueries", () => {
    const doc = "select * from t where id in (select id from u where a = 1 or b = 2 and c = 3) and enabled = 1";
    const sequence = selectionSequence(doc, doc.indexOf("b = 2") + 1, "sql");

    expect(sequence).toContain("b = 2 and c = 3");
    expect(sequence).toContain("a = 1 or b = 2 and c = 3");
    expect(sequence).toContain("where a = 1 or b = 2 and c = 3");
    expect(sequence).not.toContain("a = 1 or b = 2 and c = 3) and enabled = 1");
  });

  it("keeps a higher-precedence AND group between two OR branches", () => {
    const doc = "select * from t where a = 1 or b = 2 and c = 3 or d = 4";
    const sequence = selectionSequence(doc, doc.indexOf("b = 2") + 1, "sql");

    expect(sequence).toContain("b = 2 and c = 3");
    expect(sequence).toContain("a = 1 or b = 2 and c = 3");
    expect(sequence).toContain("a = 1 or b = 2 and c = 3 or d = 4");
    expect(sequence).not.toContain("a = 1 or b = 2");
    expect(sequence).not.toContain("c = 3 or d = 4");
  });

  it("preserves independent parenthesized OR branches joined by AND", () => {
    const doc = "select * from t where (a = 1 or b = 2) and (c = 3 or d = 4)";
    const sequence = selectionSequence(doc, doc.indexOf("b = 2") + 1, "sql");

    expect(sequence).toContain("a = 1 or b = 2");
    expect(sequence).toContain("(a = 1 or b = 2)");
    expect(sequence).toContain("(a = 1 or b = 2) and (c = 3 or d = 4)");
    expect(sequence).not.toContain("where (a = 1 or b = 2)");
    expect(sequence).not.toContain("b = 2) and (c = 3");
  });

  it("does not treat BETWEEN's AND as a logical operator", () => {
    const doc = "select * from orders where amount between 10 and 20 or priority = 1";
    const sequence = selectionSequence(doc, doc.indexOf("10") + 1, "sql");

    expect(sequence).toContain("amount between 10 and 20");
    expect(sequence).toContain("amount between 10 and 20 or priority = 1");
    expect(sequence).not.toContain("10 and 20");
  });

  it("keeps NOT IN subquery conditions inside the nested query", () => {
    const doc = "select * from users u where u.id not in (select user_id from bans where reason = 'spam' or active = 1) and u.enabled = 1";
    const sequence = selectionSequence(doc, doc.indexOf("reason") + 2, "sql");

    expect(sequence).toContain("reason = 'spam'");
    expect(sequence).toContain("reason = 'spam' or active = 1");
    expect(sequence).toContain("where reason = 'spam' or active = 1");
    expect(sequence).toContain("select user_id from bans where reason = 'spam' or active = 1");
    expect(sequence).not.toContain("reason = 'spam' or active = 1) and u.enabled = 1");
  });

  it("builds JOIN ON expressions without crossing into WHERE", () => {
    const doc = "select * from accounts a join events e on a.id = e.account_id and (e.kind = 'open' or e.kind = 'close') where a.active = 1";
    const sequence = selectionSequence(doc, doc.indexOf("close") + 2, "sql");

    expect(sequence).toContain("e.kind = 'open' or e.kind = 'close'");
    expect(sequence).toContain("(e.kind = 'open' or e.kind = 'close')");
    expect(sequence).toContain("a.id = e.account_id and (e.kind = 'open' or e.kind = 'close')");
    expect(sequence).toContain("on a.id = e.account_id and (e.kind = 'open' or e.kind = 'close')");
    expect(sequence).not.toContain("e.kind = 'close') where a.active = 1");
  });

  it("applies function, multiplication, addition, and comparison levels in order", () => {
    const doc = "select * from invoice where round(price * quantity + tax, 2) >= minimum and enabled = 1";
    const sequence = selectionSequence(doc, doc.indexOf("price") + 2, "sql");

    expect(sequence).toContain("price * quantity");
    expect(sequence).toContain("price * quantity + tax");
    expect(sequence).toContain("round(price * quantity + tax, 2)");
    expect(sequence).toContain("round(price * quantity + tax, 2) >= minimum");
    expect(sequence).toContain("round(price * quantity + tax, 2) >= minimum and enabled = 1");
  });

  it("isolates a correlated EXISTS subquery from its outer predicate", () => {
    const doc = "select * from users u where exists (select 1 from orders o where o.user_id = u.id and (o.paid = 1 or o.total > 100)) or u.admin = 1";
    const sequence = selectionSequence(doc, doc.indexOf("o.paid") + 2, "sql");

    expect(sequence).toContain("o.paid = 1 or o.total > 100");
    expect(sequence).toContain("(o.paid = 1 or o.total > 100)");
    expect(sequence).toContain("o.user_id = u.id and (o.paid = 1 or o.total > 100)");
    expect(sequence).toContain("where o.user_id = u.id and (o.paid = 1 or o.total > 100)");
    expect(sequence).not.toContain("o.paid = 1 or o.total > 100)) or u.admin = 1");
  });

  it("ignores logical keywords inside strings and comments", () => {
    const doc = "select * from notes where message = 'alpha or beta and gamma' /* or ignored = 1 */ and visible = 1";
    const sequence = selectionSequence(doc, doc.indexOf("beta") + 1, "sql");

    expect(sequence.slice(0, 2)).toEqual(["alpha or beta and gamma", "'alpha or beta and gamma'"]);
    expect(sequence).toContain("message = 'alpha or beta and gamma'");
    expect(sequence).toContain("message = 'alpha or beta and gamma' /* or ignored = 1 */ and visible = 1");
    expect(sequence).not.toContain("beta and gamma");
  });

  it("keeps long AND chains bounded when collecting semantic ranges", () => {
    const conditions = Array.from({ length: 100 }, (_, index) => `c${index} = ${index}`);
    const doc = `select * from t where ${conditions.join(" and ")}`;
    const cursor = doc.indexOf("c50") + 1;
    const startedAt = performance.now();
    const ranges = sqlSemanticSelectionRanges({ doc, cursor, current: { from: cursor, to: cursor } }, { databaseType: "mysql" });
    const elapsed = performance.now() - startedAt;

    expect(ranges.length).toBeLessThan(200);
    expect(elapsed).toBeLessThan(250);
  });

  it("extends 1000 selections in an approximately 100 KB plain text document without rescanning it", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `record_${index.toString().padStart(4, "0")} needle ${"payload".repeat(13)}`);
    const doc = lines.join("\n");
    const selections: ReturnType<typeof EditorSelection.range>[] = [];
    let offset = 0;
    for (const line of lines) {
      const from = offset + line.indexOf("needle");
      selections.push(EditorSelection.range(from, from + "needle".length));
      offset += line.length + 1;
    }
    const state = EditorState.create({
      doc,
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create(selections),
    });

    expect(doc.length).toBeGreaterThanOrEqual(100_000);
    const startedAt = performance.now();
    const next = runExtendSelection(state, { language: "text" });
    const elapsed = performance.now() - startedAt;

    expect(next.selection.ranges).toHaveLength(1000);
    expect(selectedTexts(next).every((text) => text.startsWith("record_") && text.includes(" needle "))).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });

  it("extends 1000 selections in an approximately 100 KB SQL document with one shared tokenization", () => {
    const statements = Array.from({ length: 1000 }, (_, index) => `select * from table_${index} where code = 'needle' and note = '${"payload".repeat(8)}';`);
    const doc = statements.join("\n");
    const selections: ReturnType<typeof EditorSelection.range>[] = [];
    let offset = 0;
    for (const statement of statements) {
      const from = offset + statement.indexOf("needle");
      selections.push(EditorSelection.range(from, from + "needle".length));
      offset += statement.length + 1;
    }
    const state = EditorState.create({
      doc,
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create(selections),
    });

    expect(doc.length).toBeGreaterThanOrEqual(100_000);
    const startedAt = performance.now();
    const next = runExtendSelection(state, { databaseType: "mysql", language: "sql" });
    const elapsed = performance.now() - startedAt;

    expect(next.selection.ranges).toHaveLength(1000);
    expect(selectedTexts(next).every((text) => text === "'needle'")).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });

  it("extends through function calls and nested subqueries", () => {
    const doc = "select coalesce((select max(score) from scores where user_id = u.id), 0) from users u";
    const sequence = selectionSequence(doc, doc.indexOf("score") + 2, "sql");

    expect(sequence).toContain("score");
    expect(sequence).toContain("max(score)");
    expect(sequence).toContain("select max(score) from scores where user_id = u.id");
    expect(sequence).toContain("(select max(score) from scores where user_id = u.id)");
    expect(sequence).toContain("coalesce((select max(score) from scores where user_id = u.id), 0)");
  });

  it("extends through individual query blocks before chained set expressions", () => {
    const doc = "select a from t union select b from u union select c from v";
    const sequence = selectionSequence(doc, doc.indexOf("a"), "sql");

    expect(sequence).toContain("select a from t");
    expect(sequence).toContain("select a from t union select b from u");
    expect(sequence).toContain(doc);
  });

  it("keeps valid statement semantics when a later statement is incomplete", () => {
    const doc = "select * from t where a = 1;\nselect (";
    const sequence = selectionSequence(doc, doc.indexOf("a ="), "sql");

    expect(sequence).toContain("a = 1");
    expect(sequence).toContain("where a = 1");
  });

  it("selects escaped SQL string content before the complete literal", () => {
    const doc = "select * from t where name = 'O''Reilly'";
    const sequence = selectionSequence(doc, doc.indexOf("Reilly") + 2, "sql");

    expect(sequence.slice(0, 2)).toEqual(["O''Reilly", "'O''Reilly'"]);
  });

  it("falls back to plain text when SQL structure is incomplete", () => {
    const doc = "select * from t where code = ('001' and broken";
    const sequence = selectionSequence(doc, doc.indexOf("001") + 1, "sql");

    expect(sequence.slice(0, 2)).toEqual(["001", "'001'"]);
    expect(sequence).not.toContain("code = ('001'");
    expect(sequence[sequence.length - 1]).toBe(doc);
  });

  it("extends every rectangular selection independently", () => {
    const doc = "select a = '001';\nselect b = '002';";
    const first = doc.indexOf("001") + 1;
    const second = doc.indexOf("002") + 1;
    const state = EditorState.create({
      doc,
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.cursor(first), EditorSelection.cursor(second)]),
    });

    expect(selectedTexts(runExtendSelection(state, { databaseType: "mysql" }))).toEqual(["001", "002"]);
  });

  it("preserves reverse selection direction", () => {
    const doc = "where code = '001'";
    const literalFrom = doc.indexOf("'001'");
    const state = EditorState.create({
      doc,
      selection: EditorSelection.range(literalFrom + 4, literalFrom + 1),
    });

    const next = runExtendSelection(state, { databaseType: "mysql" });
    expect(next.selection.main.anchor).toBeGreaterThan(next.selection.main.head);
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe("'001'");
  });

  it("binds the configurable editor shortcut to CodeMirror semantic selection", () => {
    expect(queryEditorSource).toContain("extendQueryEditorSelection");
    expect(queryEditorSource).not.toContain("selectParentSyntax");
    expect(queryEditorSource).not.toContain("codeMirrorSelectParentSyntax");
    expect(queryEditorSource).toContain("shortcuts.extendSelection");
    expect(queryEditorSource).toContain("runQueryEditorAltExtendSelection");
  });

  it("matches macOS Option+W by physical key when the event key is transformed", () => {
    let commandRuns = 0;
    let prevented = false;
    const handled = runQueryEditorAltExtendSelection(
      {
        key: "∑",
        code: "KeyW",
        altKey: true,
        preventDefault() {
          prevented = true;
        },
      },
      "Alt+W",
      {} as never,
      () => {
        commandRuns += 1;
        return true;
      },
      "MacIntel",
    );

    expect(handled).toBe(true);
    expect(commandRuns).toBe(1);
    expect(prevented).toBe(true);
  });

  it("does not prevent macOS Option+W when selection cannot grow", () => {
    let prevented = false;
    const handled = runQueryEditorAltExtendSelection(
      {
        key: "∑",
        code: "KeyW",
        altKey: true,
        preventDefault() {
          prevented = true;
        },
      },
      "Alt+W",
      {} as never,
      () => false,
      "MacIntel",
    );

    expect(handled).toBe(false);
    expect(prevented).toBe(false);
  });

  it("handles Windows Alt+W when the keyboard layout changes event.key", () => {
    let commandRuns = 0;
    let prevented = false;
    const handled = runQueryEditorAltExtendSelection(
      {
        key: "Ц",
        code: "KeyW",
        altKey: true,
        preventDefault() {
          prevented = true;
        },
      },
      "Alt+W",
      {} as never,
      () => {
        commandRuns += 1;
        return true;
      },
      "Win32",
    );

    expect(handled).toBe(true);
    expect(commandRuns).toBe(1);
    expect(prevented).toBe(true);
  });

  it("handles Linux Alt+W while leaving AltGr text input untouched", () => {
    let commandRuns = 0;
    const handled = runQueryEditorAltExtendSelection(
      {
        key: "щ",
        code: "KeyW",
        altKey: true,
        preventDefault() {},
      },
      "Alt+W",
      {} as never,
      () => {
        commandRuns += 1;
        return true;
      },
      "Linux x86_64",
    );

    expect(handled).toBe(true);
    expect(commandRuns).toBe(1);

    const altGrHandled = runQueryEditorAltExtendSelection(
      {
        key: "ł",
        code: "KeyW",
        altKey: true,
        ctrlKey: true,
        preventDefault() {},
      },
      "Alt+W",
      {} as never,
      () => true,
      "Linux x86_64",
    );

    expect(altGrHandled).toBe(false);
  });

  it("selects the SQL word first and then expands to a parent syntax range", () => {
    const doc = "select customer_name from customers";
    const cursor = doc.indexOf("customer_name") + 3;
    let state = EditorState.create({
      doc,
      extensions: [sql()],
      selection: EditorSelection.cursor(cursor),
    });

    state = runCommand(selectParentSyntax, state);
    expect(selectedTexts(state)).toEqual(["customer_name"]);
    const wordRange = state.selection.main;

    state = runCommand(selectParentSyntax, state);
    expect(state.selection.main.from).toBeLessThanOrEqual(wordRange.from);
    expect(state.selection.main.to).toBeGreaterThanOrEqual(wordRange.to);
    expect(state.selection.main.to - state.selection.main.from).toBeGreaterThan(wordRange.to - wordRange.from);
  });

  it("extends every selection in rectangular multi-selection mode", () => {
    const doc = "select customer_name from customers;\nselect order_total from orders;";
    const firstCursor = doc.indexOf("customer_name") + 2;
    const secondCursor = doc.indexOf("order_total") + 2;
    let state = EditorState.create({
      doc,
      extensions: [sql(), EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.cursor(firstCursor), EditorSelection.cursor(secondCursor)]),
    });

    state = runCommand(selectParentSyntax, state);
    expect(selectedTexts(state)).toEqual(["customer_name", "order_total"]);
    const wordRanges = state.selection.ranges;

    state = runCommand(selectParentSyntax, state);
    expect(state.selection.ranges).toHaveLength(2);
    state.selection.ranges.forEach((range, index) => {
      expect(range.from).toBeLessThanOrEqual(wordRanges[index].from);
      expect(range.to).toBeGreaterThanOrEqual(wordRanges[index].to);
      expect(range.to - range.from).toBeGreaterThan(wordRanges[index].to - wordRanges[index].from);
    });
  });
});
