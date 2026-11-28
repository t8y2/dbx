package main

import "testing"

func TestRewriteSQLPlusExecute(t *testing.T) {
	cases := map[string]string{
		"EXEC p_noargs":                     "BEGIN\n  p_noargs\n;\nEND;",
		"exec p_noargs;":                    "BEGIN\n  p_noargs\n;\nEND;",
		"EXECUTE app.pkg.run(1, 'a;b');":    "BEGIN\n  app.pkg.run(1, 'a;b')\n;\nEND;",
		"  EXEC\tp_x(\n    1\n  )  ;  ":     "BEGIN\n  p_x(\n    1\n  )\n;\nEND;",
		"-- run it\nEXEC p_noargs":          "BEGIN\n  p_noargs\n;\nEND;",
		"/* c */ EXEC p_noargs -- trailing": "BEGIN\n  p_noargs -- trailing\n;\nEND;",
	}
	for input, want := range cases {
		got, ok := rewriteSQLPlusExecute(input)
		if !ok || got != want {
			t.Errorf("rewriteSQLPlusExecute(%q) = %q, %v; want %q", input, got, ok, want)
		}
	}
}

func TestRewriteSQLPlusExecuteLeavesOtherStatementsAlone(t *testing.T) {
	for _, input := range []string{
		"",
		"EXEC",
		"EXEC   ;",
		"EXECUTE IMMEDIATE 'DROP TABLE t'",
		"exec immediate 'x'",
		"EXECUTOR_RUN(1)",
		"EXECUTE_PROC",
		"SELECT * FROM exec",
		"BEGIN p; END;",
		"CALL p()",
	} {
		if got, ok := rewriteSQLPlusExecute(input); ok {
			t.Errorf("rewriteSQLPlusExecute(%q) rewrote to %q; want it untouched", input, got)
		}
	}
}

func TestTrimStatementSQLRewritesSQLPlusExecute(t *testing.T) {
	if got, want := trimStatementSQL("EXEC p_noargs;"), "BEGIN\n  p_noargs\n;\nEND;"; got != want {
		t.Fatalf("trimStatementSQL = %q, want %q", got, want)
	}
	if got, want := trimStatementSQL("EXECUTE IMMEDIATE 'x';"), "EXECUTE IMMEDIATE 'x'"; got != want {
		t.Fatalf("trimStatementSQL = %q, want %q", got, want)
	}
}
