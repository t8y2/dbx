package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The helper-package DDL templates already contain the double quotes around the
// schema placeholder ("%[1]s"), so the caller must substitute the BARE owner.
// Substituting an already-quoted identifier renders ""OWNER"" and real Oracle
// (21c XE verified) rejects the statement with
// ORA-01741: illegal zero-length identifier -- which broke every
// pl_debug_start before anything was created.
func TestPLDebugHelperPackageDDLQuotesSchemaExactlyOnce(t *testing.T) {
	for name, tmpl := range map[string]string{
		"head": plDebugPackageHeadDDL,
		"body": plDebugPackageBodyDDL,
	} {
		rendered := fmt.Sprintf(tmpl, "DBX_TEST")
		if strings.Contains(rendered, `""`) {
			t.Fatalf("%s DDL double-quotes the schema identifier: %q", name, firstLine(rendered))
		}
		want := fmt.Sprintf(`"DBX_TEST".%s`, plDebugPackageName)
		if !strings.Contains(rendered, want) {
			t.Fatalf("%s DDL does not qualify the package as %s: %q", name, want, firstLine(rendered))
		}
	}
}

// DBMS_DEBUG.GET_VALUES is an OceanBase Oracle-mode extension. Stock Oracle
// declares GET_VALUE but not GET_VALUES, and a static reference makes the whole
// PACKAGE BODY invalid (PLS-00302), taking set_breakpoint/continue/backtrace down
// with it. The wrapper therefore has to resolve it dynamically.
func TestPLDebugHelperPackageBodyDoesNotStaticallyCallGetValues(t *testing.T) {
	body := fmt.Sprintf(plDebugPackageBodyDDL, "DBX_TEST")
	if strings.Contains(body, "get_values(scalar_values)") {
		t.Fatal("body statically calls dbms_debug.get_values; this is INVALID on stock Oracle")
	}
	if !strings.Contains(body, "EXECUTE IMMEDIATE") {
		t.Fatal("body does not resolve dbms_debug.get_values dynamically")
	}
	if !strings.Contains(body, "dbms_debug.get_values(:2)") {
		t.Fatal("dynamic get_values wrapper is missing")
	}
}

// plDebugParseBacktrace must stay byte-compatible with ODC's DebuggerSession
// parsing, whose documented samples are "[Line 0] F_ADD" and "[Line 8] PROC".
func TestPLDebugParseBacktraceMatchesODCSamples(t *testing.T) {
	cases := []struct {
		listing string
		line    int
		program string
	}{
		{"[Line 8] PROC", 8, "PROC"},
		{"[Line 0] F_ADD", 0, "F_ADD"},
		{"[Line 0] PKG.F_ADD", 0, "PKG.F_ADD"},
		{"[Line 12] PROC\n[Line 5] CALLER", 12, "PROC"},
	}
	for _, tc := range cases {
		line, program, err := plDebugParseBacktrace(tc.listing)
		if err != nil {
			t.Fatalf("parse(%q) failed: %v", tc.listing, err)
		}
		if line != tc.line || program != tc.program {
			t.Fatalf("parse(%q) = (%d, %q), want (%d, %q)", tc.listing, line, program, tc.line, tc.program)
		}
	}
	if _, _, err := plDebugParseBacktrace("no line information here"); err == nil {
		t.Fatal("expected an error for a listing without line information")
	}
}

// The CNT_* wrappers and DBX_GET_LINE label their loops; Oracle accepts
// "<<label>> LOOP ... END LOOP label;" and the whole body must compile, so the
// construct has to survive into the generated DDL.
func TestPLDebugHelperPackageBodyUsesLabeledLoops(t *testing.T) {
	body := fmt.Sprintf(plDebugPackageBodyDDL, "DBX_TEST")
	if !strings.Contains(body, "<<label>> loop") || !strings.Contains(body, "end loop label;") {
		t.Fatal("labeled loop construct missing from the helper package body")
	}
}

// DBMS_DEBUG.SET_VALUE is an extension too (stock Oracle does not declare it for
// DBMS_DEBUG), so DBX_SET_VALUE has to resolve it dynamically exactly like
// DBX_GET_VALUES does: a static reference would leave the whole PACKAGE BODY
// INVALID. Its real overloads take the frame number plus the *text* of a PL/SQL
// assignment -- (frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2) and
// (handle IN program_info, assignment_statement IN VARCHAR2), both RETURN
// BINARY_INTEGER (Oracle 21c XE ALL_PROCEDURES/ALL_ARGUMENTS verified) -- so the
// wrapper must forward exactly two arguments. The old four-argument call matched
// no overload at all and made every server look unsupported.
func TestPLDebugHelperPackageDeclaresAndDynamicallyWrapsSetValue(t *testing.T) {
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	declaration := "DBX_SET_VALUE(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2," +
		" result OUT BINARY_INTEGER, message OUT VARCHAR2);"
	if !strings.Contains(head, declaration) {
		t.Fatalf("package head does not declare DBX_SET_VALUE with its real two-argument shape:\n%s", head)
	}
	if !strings.Contains(head, procSetBreakpointEx) {
		t.Fatalf("package head does not declare %s:\n%s", procSetBreakpointEx, head)
	}
	if strings.Contains(head, "index# IN BINARY_INTEGER") || strings.Contains(head, "value IN VARCHAR2") {
		t.Fatal("package head still declares the removed four-argument DBX_SET_VALUE")
	}

	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	if strings.Contains(body, "result := dbms_debug.set_value(") {
		t.Fatal("body statically calls dbms_debug.set_value; this is INVALID on stock Oracle")
	}
	if !strings.Contains(body, "EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.set_value(:2, :3); END;'") {
		t.Fatal("dynamic set_value wrapper is missing or does not pass exactly the two real arguments")
	}
	if strings.Contains(body, "set_value(:2,:3,:4,:5)") {
		t.Fatal("the removed four-argument set_value call is still in the body")
	}
	if !strings.Contains(body, "USING OUT result, IN frame#, IN assignment_statement") {
		t.Fatal("set_value wrapper does not bind the frame number and the assignment text")
	}
	if !strings.Contains(body, "EXCEPTION WHEN OTHERS THEN result := -1;") {
		t.Fatal("set_value wrapper does not degrade to the -1 capability sentinel")
	}
	if !strings.Contains(body, "message := SQLERRM;") {
		t.Fatal("set_value wrapper does not report why the dynamic call failed")
	}
	if !strings.Contains(plDebugVersionNote, "Version: V6") {
		t.Fatalf("version note was not bumped: %q", plDebugVersionNote)
	}
	header := firstLine(body)
	if !strings.Contains(header, "CREATE OR REPLACE PACKAGE BODY") || !strings.Contains(header, plDebugVersionNote) {
		t.Fatalf("version note must share the PACKAGE BODY header line: %q", header)
	}
}

// The version note is the only thing that forces an already-installed helper
// package to be rebuilt, and the Go and Java agents share one package name, so both
// must emit this exact string (the Java test asserts the same literal).
const plDebugExpectedVersionNote = "-- DBX PL Debug Package Version: V6 (ODC V3.3.2.1 aligned, Oracle portable)"

func TestPLDebugVersionNoteIsV6AndExact(t *testing.T) {
	if plDebugVersionNote != plDebugExpectedVersionNote {
		t.Fatalf("version note = %q, want %q", plDebugVersionNote, plDebugExpectedVersionNote)
	}
	body := fmt.Sprintf(plDebugPackageBodyDDL, "DBX_TEST")
	if !strings.Contains(firstLine(body), plDebugExpectedVersionNote) {
		t.Fatalf("the body header line does not carry the V6 note: %q", firstLine(body))
	}
}

// The exact DDL the agent would deploy has to be renderable from a test, because a
// shared test schema can be unable to accept it: while a parked debuggee holds the
// helper package's execution pin, CREATE OR REPLACE PACKAGE BODY does not return
// (measured on 19c EE, 40s and still waiting). Setting DBX_PLDEBUG_DDL_OUT writes the
// rendered body -- and the head -- to that directory so the very same text can be
// deployed out of band, with the package renamed, and driven directly.
func TestPLDebugHelperPackageDDLIsRenderableForOutOfBandDeployment(t *testing.T) {
	directory := strings.TrimSpace(os.Getenv("DBX_PLDEBUG_DDL_OUT"))
	if directory == "" {
		t.Skip("set DBX_PLDEBUG_DDL_OUT to dump the helper-package DDL")
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("cannot create %s: %v", directory, err)
	}
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	// The zero value is the shape a server without the DBMS_DEBUG.PROGRAM_INFO overload
	// attributes selects, i.e. what Oracle 19c EE gets: referencing pro_info.signature
	// there fails the whole body with PLS-00302. The opt-in (Signature) rendering is
	// covered by TestPLDebugProgramInfoOverloadAttributesAreOptIn.
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	for name, text := range map[string]string{"head.sql": head, "body.sql": body} {
		if err := os.WriteFile(directory+string(os.PathSeparator)+name, []byte(text), 0o644); err != nil {
			t.Fatalf("cannot write %s: %v", name, err)
		}
	}
}

// A head is only reusable when the *signature* of the routines whose parameter list
// changed still matches: the version note rebuilds the body, but a head left at V5
// declares the old four-argument DBX_SET_VALUE and the new body would then fail with
// PLS-00306 (or PLS-00302 for a missing routine), leaving the whole package INVALID.
func TestPLDebugHeadRequirementsPinChangedSignatures(t *testing.T) {
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	for _, requirement := range plDebugHeadRequirements {
		if !strings.Contains(head, requirement) {
			t.Fatalf("plDebugHeadRequirements entry %q is not part of the head DDL:\n%s", requirement, head)
		}
	}
	for _, routine := range []string{procSetValue, procSetBreakpointEx, procSetBreakpointEntry,
		procEnableBreakpoint, procDisableBreakpoint} {
		if !containsString(plDebugHeadRequiredRoutines, routine) {
			t.Fatalf("%s is missing from plDebugHeadRequiredRoutines: %v", routine, plDebugHeadRequiredRoutines)
		}
	}
	signatures := []string{
		procSetValue + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2",
		procEnableBreakpoint + "(breakpoint# IN BINARY_INTEGER",
		procDisableBreakpoint + "(breakpoint# IN BINARY_INTEGER",
	}
	for _, signature := range signatures {
		if !containsString(plDebugHeadRequiredDeclarations, signature) {
			t.Fatalf("%q is not pinned in plDebugHeadRequiredDeclarations: %v", signature, plDebugHeadRequiredDeclarations)
		}
		if !containsString(plDebugHeadRequirements, signature) {
			t.Fatalf("%q is not part of plDebugHeadRequirements: %v", signature, plDebugHeadRequirements)
		}
	}
	// A V5 head must not satisfy the requirements: it declares SET_VALUE first.
	v5Head := "CREATE OR REPLACE PACKAGE \"DBX_TEST\".DBX_PL_DEBUG_PACKAGE AS" +
		" PROCEDURE DBX_SET_VALUE(name IN VARCHAR2, frame# IN BINARY_INTEGER, index# IN BINARY_INTEGER," +
		" value IN VARCHAR2, result OUT BINARY_INTEGER); END DBX_PL_DEBUG_PACKAGE;"
	for _, requirement := range plDebugHeadRequiredDeclarations {
		if strings.Contains(strings.ToUpper(v5Head), strings.ToUpper(requirement)) {
			t.Fatalf("a V5 head satisfies %q", requirement)
		}
	}
}

// A breakpoint on a subprogram INSIDE a package is only armable through
// DBMS_DEBUG.PROGRAM_INFO.entrypointname: measured on Oracle 19c EE, name=<subprogram>
// answers error_bad_handle (16) in namespaces 1 and 2 and error_exception (28) with
// namespace NULL, while name=<package> + namespace_pkg_body + entrypointname=<subprogram>
// answers success (0). The head has to declare the wrapper (the body calls it) and the
// body must fill the attribute only on a server whose record type declares it: a static
// pro_info.entrypointname reference on a server without the field leaves the whole
// PACKAGE BODY INVALID (PLS-00302).
func TestPLDebugHelperPackageDeclaresEntrypointArmForPackageSubprograms(t *testing.T) {
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	declaration := "PROCEDURE " + procSetBreakpointEntry +
		"(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2, line# IN BINARY_INTEGER," +
		" breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
	if !strings.Contains(head, declaration) {
		t.Fatalf("package head does not declare %s:\n%s", procSetBreakpointEntry, head)
	}
	if !containsString(plDebugHeadRequiredRoutines, procSetBreakpointEntry) {
		t.Fatalf("%s is missing from plDebugHeadRequiredRoutines: %v",
			procSetBreakpointEntry, plDebugHeadRequiredRoutines)
	}

	// The entrypointname assignment is opt-in, exactly like signature/sequence.
	none := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	if strings.Contains(none, "pro_info.entrypointname") {
		t.Fatal("a server without the entrypointname attribute still references pro_info.entrypointname")
	}
	if !strings.Contains(none, "PROCEDURE "+procSetBreakpointEntry+
		"(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2,") {
		t.Fatal("the entrypoint wrapper is missing from the package body")
	}
	supported := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{Entrypoint: true})
	if !strings.Contains(supported,
		"if entrypointname is not null then pro_info.entrypointname := entrypointname; end if;") {
		t.Fatal("the entrypointname assignment is missing for a server that declares the attribute")
	}
	for name, body := range map[string]string{"none": none, "supported": supported} {
		if strings.Contains(body, plDebugProgramInfoEntryMarker) {
			t.Fatalf("%s body still carries the entrypointname placeholder", name)
		}
	}

	// The namespace chain starts with the measured working namespace for a package
	// subprogram, and it must not be the standalone chain (that one tries the
	// spec/top-level namespace first, which answered 12 for this target).
	if !strings.Contains(plDebugEntrypointFallbackDDL,
		"pro_info.namespace := dbms_debug.namespace_pkg_body; result := dbms_debug.set_breakpoint") {
		t.Fatalf("the entrypoint arm does not try namespace_pkg_body first:\n%s", plDebugEntrypointFallbackDDL)
	}
	wantBody := fmt.Sprintf("PROCEDURE %s(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2,"+
		" line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"+
		" pro_info dbms_debug.program_info; BEGIN pro_info.name := name; pro_info.owner := owner;"+
		" if entrypointname is not null then pro_info.entrypointname := entrypointname; end if; %s END;",
		procSetBreakpointEntry, plDebugEntrypointFallbackDDL)
	if !strings.Contains(supported, wantBody) {
		t.Fatalf("the rendered entrypoint wrapper is not the expected DDL:\n%s", supported)
	}
	// The standalone wrapper keeps its own order: the entry arm must not have changed it.
	if got := strings.Count(supported, plDebugNamespaceFallbackDDL); got != 2 {
		t.Fatalf("the standalone namespace fallback is used %d times, want 2 (DBX_SET_BREAKPOINT and _EX)", got)
	}
}

// The desktop client addresses a package member as "PKG.SUB" (PlDebugSessionTarget
// .programName). The server needs the two halves in separate PROGRAM_INFO fields, so
// setBreakpoints has to split the name and call DBX_SET_BREAKPOINT_ENTRY -- and only when
// the server declares the attribute. Every other shape keeps the previous arm, so an
// engine that resolves the dotted name itself is unchanged.
func TestPLDebugSetBreakpointsArmsAPackageSubprogramThroughTheEntrypoint(t *testing.T) {
	const breakpointNumber = 7

	t.Run("the split reaches the entrypoint wrapper", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procSetBreakpointEntry, 4, breakpointNumber)
		drv.scriptOut(procSetBreakpointEntry, 5, plDebugErrSuccess)
		session := newPLDebugCallSession(db, false)
		session.programInfoFields.Entrypoint = true

		created, err := session.setBreakpoints([]plDebugBreakpoint{
			{Owner: "CHZ", Name: "DBX_MSBP_PKG.RUN_MSBP", Line: 12},
		})
		if err != nil {
			t.Fatalf("setBreakpoints failed: %v", err)
		}
		if len(created) != 1 || created[0].BreakpointNbr != breakpointNumber {
			t.Fatalf("setBreakpoints created %#v, want one breakpoint %d", created, breakpointNumber)
		}
		if created[0].Name != "DBX_MSBP_PKG.RUN_MSBP" {
			t.Fatalf("the created breakpoint echoed name %q, want the requested dotted name",
				created[0].Name)
		}
		call := drv.callFor(t, procSetBreakpointEntry)
		wantBinds := []string{"string", "string", "string", "int", "go_ora.Out(size=0)", "go_ora.Out(size=0)"}
		assertPLDebugBinds(t, call, wantBinds)
		wantValues := []string{"CHZ", "DBX_MSBP_PKG", "RUN_MSBP", "12", "", ""}
		if got := strings.Join(call.inValues, ","); got != strings.Join(wantValues, ",") {
			t.Fatalf("the entrypoint wrapper got values [%s], want [%s] (owner, package, subprogram, line)",
				got, strings.Join(wantValues, ","))
		}
		if got := countRoutine(drv.recordedRoutines(), procSetBreakpoint); got != 0 {
			t.Fatalf("the plain wrapper was called %d time(s) for a package subprogram", got)
		}
	})

	t.Run("a server without the attribute keeps the dotted name", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procSetBreakpoint, 3, breakpointNumber)
		drv.scriptOut(procSetBreakpoint, 4, plDebugErrSuccess)
		session := newPLDebugCallSession(db, false)

		created, err := session.setBreakpoints([]plDebugBreakpoint{
			{Owner: "CHZ", Name: "DBX_MSBP_PKG.RUN_MSBP", Line: 12},
		})
		if err != nil {
			t.Fatalf("setBreakpoints failed: %v", err)
		}
		if len(created) != 1 {
			t.Fatalf("setBreakpoints created %#v, want one breakpoint", created)
		}
		call := drv.callFor(t, procSetBreakpoint)
		if got := strings.Join(call.inValues, ","); got != "CHZ,DBX_MSBP_PKG.RUN_MSBP,12,," {
			t.Fatalf("the plain wrapper got values [%s], want the untouched dotted name", got)
		}
	})

	t.Run("a standalone routine is unaffected", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procSetBreakpoint, 3, breakpointNumber)
		drv.scriptOut(procSetBreakpoint, 4, plDebugErrSuccess)
		session := newPLDebugCallSession(db, false)
		session.programInfoFields.Entrypoint = true

		if _, err := session.setBreakpoints([]plDebugBreakpoint{
			{Owner: "CHZ", Name: "DBX_MSBP_TOP", Line: 4},
		}); err != nil {
			t.Fatalf("setBreakpoints failed: %v", err)
		}
		drv.callFor(t, procSetBreakpoint)
		if _, called := drv.recordedStatementContaining(procSetBreakpointEntry); called {
			t.Fatal("a standalone routine was armed through the entrypoint wrapper")
		}
	})
}

// plDebugSplitPackageSubprogram is the whole split rule: the first dot separates the
// package from the subprogram, and both halves have to be plain identifiers.
func TestPLDebugSplitPackageSubprogram(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		in          string
		wantPackage string
		wantSub     string
		wantOK      bool
	}{
		{"a package member", "DBX_MSBP_PKG.RUN_MSBP", "DBX_MSBP_PKG", "RUN_MSBP", true},
		{"a standalone routine", "DBX_MSBP_TOP", "", "", false},
		{"an empty subprogram", "DBX_MSBP_PKG.", "", "", false},
		{"a leading dot", ".RUN_MSBP", "", "", false},
		{"a schema-qualified three-part name", "DBX_DEBUG.DBX_MSBP_PKG.RUN_MSBP", "", "", false},
		{"a quoted wrapper", `"My Pkg"."My Proc"`, "", "", false},
		{"an empty name", "", "", "", false},
	} {
		gotPackage, gotSub, gotOK := plDebugSplitPackageSubprogram(testCase.in)
		if gotPackage != testCase.wantPackage || gotSub != testCase.wantSub || gotOK != testCase.wantOK {
			t.Fatalf("%s: plDebugSplitPackageSubprogram(%q) = (%q, %q, %v), want (%q, %q, %v)",
				testCase.name, testCase.in, gotPackage, gotSub, gotOK,
				testCase.wantPackage, testCase.wantSub, testCase.wantOK)
		}
	}
}

// ENABLE_BREAKPOINT / DISABLE_BREAKPOINT are functions -- (breakpoint IN
// BINARY_INTEGER) RETURN BINARY_INTEGER -- so the wrappers have to call them in an
// assignment (a statement call raises PLS-00221), resolve them dynamically for
// servers that lack them, and answer with the -1 capability sentinel.
func TestPLDebugHelperPackageDeclaresAndDynamicallyWrapsBreakpointToggle(t *testing.T) {
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	cases := []struct {
		procedure string
		primitive string
	}{
		{procEnableBreakpoint, "dbms_debug.enable_breakpoint"},
		{procDisableBreakpoint, "dbms_debug.disable_breakpoint"},
	}
	for _, tc := range cases {
		if !strings.Contains(head, "PROCEDURE "+tc.procedure+"(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER);") {
			t.Fatalf("package head does not declare %s:\n%s", tc.procedure, head)
		}
		if !strings.Contains(body, "PROCEDURE "+tc.procedure+"(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER) IS") {
			t.Fatalf("package body does not define %s", tc.procedure)
		}
		if !strings.Contains(body, "EXECUTE IMMEDIATE 'BEGIN :1 := "+tc.primitive+"(:2); END;' USING OUT result, IN breakpoint#;") {
			t.Fatalf("%s does not call %s as a function through EXECUTE IMMEDIATE", tc.procedure, tc.primitive)
		}
		if strings.Contains(body, "BEGIN "+tc.primitive+"(:2); END;") {
			t.Fatalf("%s calls %s as a statement; PLS-00221 on a function", tc.procedure, tc.primitive)
		}
	}
	// Both wrappers degrade to the sentinel with the generic WHEN OTHERS shape.
	if strings.Count(body, "EXCEPTION WHEN OTHERS THEN result := -1; END; END;") < 2 {
		t.Fatal("the breakpoint toggle wrappers do not degrade to the -1 capability sentinel")
	}
}

// The caller sends {name, frame, index, value} and the agent turns it into the
// PL/SQL assignment DBMS_DEBUG.SET_VALUE executes. The value is forwarded verbatim
// (the desktop client quotes string literals itself), and an index addresses a
// collection element unless the name already carries one.
func TestPLDebugAssignmentStatement(t *testing.T) {
	cases := []struct {
		name  string
		index int
		value string
		want  string
	}{
		{"x", 0, "5", "x := 5"},
		{"  x  ", 0, "5", "x := 5"},
		{"s", 0, "'abc'", "s := 'abc'"},
		{"s", 0, `''abc''`, `s := ''abc''`},
		{"arr", 1, "5", "arr(1) := 5"},
		{"arr(1)", 1, "5", "arr(1) := 5"},
		{"arr(2)", 0, "5", "arr(2) := 5"},
		{"d", 0, "to_date('2024-01-01','YYYY-MM-DD')", "d := to_date('2024-01-01','YYYY-MM-DD')"},
	}
	for _, tc := range cases {
		if got := plDebugAssignmentStatement(tc.name, tc.index, tc.value); got != tc.want {
			t.Fatalf("plDebugAssignmentStatement(%q, %d, %q) = %q, want %q", tc.name, tc.index, tc.value, got, tc.want)
		}
	}
}

// The -1 sentinel covers "the routine is not declared" and "the assignment itself
// failed" at once; the wrapper's SQLERRM is what keeps them apart, so a malformed
// assignment is not reported as "this server cannot change variable values".
func TestPLDebugCapabilityMissing(t *testing.T) {
	missing := []string{
		"ORA-06550: line 1, column 18:\nPLS-00201: identifier 'DBMS_DEBUG.SET_VALUE' must be declared",
		"PLS-00302: component 'SET_VALUE' must be declared",
		"ORA-00904: \"DBMS_DEBUG\".\"SET_VALUE\": invalid identifier",
		"",
	}
	for _, message := range missing {
		if !plDebugCapabilityMissing(message) {
			t.Fatalf("message %q must be classified as a missing capability", message)
		}
	}
	present := []string{
		"ORA-06550: line 1, column 22:\nPLS-00103: Encountered the symbol \"end-of-file\" when expecting one of the following",
		"ORA-00900: invalid SQL statement",
		"ORA-06502: PL/SQL: numeric or value error",
	}
	for _, message := range present {
		if plDebugCapabilityMissing(message) {
			t.Fatalf("message %q must not be classified as a missing capability", message)
		}
	}
}

// Oracle's reference examples pass the assignment WITH its terminator ('x := 3;',
// 'var := 6;') while the agent renders it without one, and real Oracle 19c EE proved
// what it does with the unterminated form: error_value_malformed (7) with no message.
// The retry policy therefore has to be: the caller's text is sent as-is, and a form-level
// answer -- a syntax-level rejection of the dynamic block, or error_value_malformed with
// no other explanation -- earns exactly one retry with the terminator appended. All the
// answers are pure decisions, so they are pinned here without a database.
func TestPLDebugSetValueRetryPolicy(t *testing.T) {
	assignment := "x := 5"

	// ① The first form succeeded: no terminator is ever added.
	if retry, ok := plDebugSetValueRetry(plDebugErrSuccess, "", assignment); ok || retry != assignment {
		t.Fatalf("a successful call must not be retried: (%q, %v)", retry, ok)
	}
	// error_value_malformed (7) with an EMPTY message is what stock Oracle 19c EE
	// answers for the unterminated form: measured set_value(0, 'V_COUNT := 100') -> 7
	// and set_value(0, 'V_COUNT := 100;') -> 0. It is a form answer, so it earns the
	// single terminator retry; the old policy stopped at the code and reported 7 for
	// an assignment the server accepts once it is terminated.
	for _, message := range []string{"", "bad value"} {
		retry, ok := plDebugSetValueRetry(7, message, assignment)
		if !ok || retry != "x := 5;" {
			t.Fatalf("error_value_malformed with %q must be retried with the terminator: (%q, %v)", message, retry, ok)
		}
	}
	if retry, ok := plDebugSetValueRetry(7, "bad value", "x := 5;"); ok || retry != "x := 5;" {
		t.Fatalf("a terminated assignment has no second form: (%q, %v)", retry, ok)
	}
	// Any other real code is not a form question.
	for _, result := range []int{plDebugErrBadHandle, plDebugErrException, 26} {
		if retry, ok := plDebugSetValueRetry(result, fmt.Sprintf("dbms_debug returned %d", result), assignment); ok || retry != assignment {
			t.Fatalf("result %d must not be retried: (%q, %v)", result, retry, ok)
		}
	}

	// ② A syntax-level rejection of the text is retried once, with the terminator.
	for _, message := range []string{
		"ORA-06550: line 1, column 22:\nPLS-00103: Encountered the symbol \"end-of-file\" when expecting one of the following",
		"PLS-00103: Encountered the symbol \";\"",
		"ORA-06550: line 1, column 7:\nPLS-00103: Encountered the symbol \"5\"",
	} {
		retry, ok := plDebugSetValueRetry(plDebugErrCapabilityUnavailable, message, assignment)
		if !ok {
			t.Fatalf("syntax error %q was not retried", message)
		}
		if retry != "x := 5;" {
			t.Fatalf("retry text for %q = %q, want %q", message, retry, "x := 5;")
		}
	}

	// ③ A missing primitive is a capability answer, never a form answer: PLS-00201
	// and PLS-00302 arrive behind the same ORA-06550 prefix as PLS-00103.
	for _, message := range []string{
		"ORA-06550: line 1, column 18:\nPLS-00201: identifier 'DBMS_DEBUG.SET_VALUE' must be declared",
		"PLS-00302: component 'SET_VALUE' must be declared",
		"ORA-00904: \"DBMS_DEBUG\".\"SET_VALUE\": invalid identifier",
		"",
	} {
		if retry, ok := plDebugSetValueRetry(plDebugErrCapabilityUnavailable, message, assignment); ok || retry != assignment {
			t.Fatalf("missing primitive %q must not be retried: (%q, %v)", message, retry, ok)
		}
		if !plDebugCapabilityMissing(message) {
			t.Fatalf("message %q is no longer classified as a missing capability", message)
		}
	}

	// ④ A non-syntax rejection (the assignment itself was refused) is reported
	// verbatim instead of being retried with a different form.
	for _, message := range []string{
		"ORA-06502: PL/SQL: numeric or value error",
		"ORA-00900: invalid SQL statement",
		"ORA-01403: no data found",
	} {
		if retry, ok := plDebugSetValueRetry(plDebugErrCapabilityUnavailable, message, assignment); ok || retry != assignment {
			t.Fatalf("non-syntax failure %q must not be retried: (%q, %v)", message, retry, ok)
		}
		if plDebugAssignmentSyntaxError(message) {
			t.Fatalf("message %q is classified as a syntax error", message)
		}
	}

	// The two helpers stay individually honest as well. ORA-06550 is a syntax
	// marker on its own (Oracle's compilation-unit prefix, which PLS-00103 arrives
	// behind) -- harmless to retry once, and PLS-00201 is already filtered out as a
	// capability answer above.
	if !plDebugAssignmentSyntaxError("ORA-06550: line 1, column 7: PL/SQL: compilation unit analysis terminated") {
		t.Fatal("ORA-06550 is listed as a syntax-class error and must be retried")
	}
	if got := plDebugRetryAssignmentStatement("x := 5"); got != "x := 5;" {
		t.Fatalf("retry text = %q, want %q", got, "x := 5;")
	}
	if got := plDebugRetryAssignmentStatement("x := 5;"); got != "x := 5;" {
		t.Fatalf("an already terminated assignment was altered: %q", got)
	}
	// A text that already carries its terminator yields no retry form, so the
	// policy must report "no retry" rather than looping on the same text.
	if retry, ok := plDebugSetValueRetry(
		plDebugErrCapabilityUnavailable,
		"PLS-00103: Encountered the symbol \"end-of-file\"",
		"x := 5;",
	); ok || retry != "x := 5;" {
		t.Fatalf("a terminated assignment must not be retried again: (%q, %v)", retry, ok)
	}
	// The rendered assignment is what the first attempt sends: no terminator.
	for _, assignment := range []string{
		plDebugAssignmentStatement("x", 0, "5"),
		plDebugAssignmentStatement("arr", 1, "5"),
		plDebugAssignmentStatement("s", 0, "'abc'"),
	} {
		if strings.HasSuffix(assignment, ";") {
			t.Fatalf("first attempt already carries a terminator: %q", assignment)
		}
		if got := plDebugRetryAssignmentStatement(assignment); got != assignment+";" {
			t.Fatalf("retry of %q = %q", assignment, got)
		}
	}
}

// DBMS_DEBUG.ABORT is documented as "NOT YET SUPPORTED", so aborting has to go
// through continue(abort_execution): calling dbms_debug.abort() would raise instead
// of stopping the debuggee, and the failure would only surface as a session that
// never ends.
func TestPLDebugAbortUsesContinueWithAbortExecution(t *testing.T) {
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	if !strings.Contains(body, "PROCEDURE "+procCntAbort+"(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS") {
		t.Fatal("the abort wrapper is missing from the package body")
	}
	if !strings.Contains(body, "dbms_debug.continue(run_info, dbms_debug.abort_execution, "+plDebugRunInfoMask+")") {
		t.Fatal("DBX_CNT_ABORT does not continue with abort_execution and an explicit run_info mask")
	}
	if strings.Contains(body, "dbms_debug.abort(") {
		t.Fatal("DBX_CNT_ABORT calls dbms_debug.abort(), which is NOT YET SUPPORTED in the spec")
	}
	if !strings.Contains(body, "abort_execution") {
		t.Fatal("abort_execution is not referenced at all")
	}
}

// The overload attributes of DBMS_DEBUG.PROGRAM_INFO are only referenced when the
// server's record type declares them; the placeholder must never survive into an
// executed DDL statement.
func TestPLDebugProgramInfoOverloadAttributesAreOptIn(t *testing.T) {
	none := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	if strings.Contains(none, "pro_info.signature") || strings.Contains(none, "pro_info.sequence") {
		t.Fatal("unsupported program_info attributes are still referenced")
	}
	both := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{Signature: true, Sequence: true})
	if !strings.Contains(both, "if signature is not null then pro_info.signature := signature; end if;") {
		t.Fatal("signature assignment missing for a server that declares the attribute")
	}
	if !strings.Contains(both, "if sequence# >= 0 then pro_info.sequence := sequence#; end if;") {
		t.Fatal("sequence assignment missing for a server that declares the attribute")
	}
	for name, body := range map[string]string{"none": none, "both": both} {
		if strings.Contains(body, plDebugProgramInfoExtraMarker) {
			t.Fatalf("%s body still carries the program_info placeholder", name)
		}
	}
}

// PRINT_BACKTRACE prints one "[Line N] NAME" entry per frame, innermost first: the
// first frame of the parsed array is therefore the current frame, and lines that
// carry no frame entry are skipped instead of failing the stack.
func TestPLDebugParseBacktraceFramesKeepsCurrentFrameFirst(t *testing.T) {
	listing := "note: debugger attached\n[Line 12] PKG.F_INNER\n[Line 5] PKG.P_CALLER\n[Line 0] ANON_BLOCK\n"
	frames := plDebugParseBacktraceFrames(listing)
	if len(frames) != 3 {
		t.Fatalf("frames = %#v, want 3 entries", frames)
	}
	want := []plDebugFrame{
		{StackDepth: 3, Line: 12, Program: "PKG.F_INNER"},
		{StackDepth: 2, Line: 5, Program: "PKG.P_CALLER"},
		{StackDepth: 1, Line: 0, Program: "ANON_BLOCK"},
	}
	for index, expected := range want {
		if frames[index] != expected {
			t.Fatalf("frame %d = %#v, want %#v", index, frames[index], expected)
		}
	}
	// The legacy single-frame fields must stay consistent with frames[0].
	if line, program, err := plDebugParseBacktrace(listing); err != nil || line != 12 || program != "PKG.F_INNER" {
		t.Fatalf("plDebugParseBacktrace = (%d, %q, %v), want (12, PKG.F_INNER, nil)", line, program, err)
	}
	// Unparseable lines are skipped entirely.
	if got := plDebugParseBacktraceFrames("program source\n   \nno frame here"); len(got) != 0 {
		t.Fatalf("unparseable listing produced frames: %#v", got)
	}
}

// An overloaded target armed without signature/sequence must warn; a unique
// target, or one the caller disambiguated, must stay silent.
func TestPLDebugOverloadWarningRequiresSignature(t *testing.T) {
	warning := plDebugOverloadWarningForTarget("CHZ", "PKG.PROC", 3, false, false)
	if !strings.Contains(warning, "重载") || !strings.Contains(warning, "signature") || !strings.Contains(warning, "sequence") {
		t.Fatalf("overload warning does not name the missing attributes: %q", warning)
	}
	if got := plDebugOverloadWarningForTarget("CHZ", "PKG.PROC", 1, false, false); got != "" {
		t.Fatalf("unique target produced a warning: %q", got)
	}
	if got := plDebugOverloadWarningForTarget("CHZ", "PKG.PROC", 3, true, false); got != "" {
		t.Fatalf("disambiguated target produced a warning: %q", got)
	}
	if got := plDebugOverloadWarningForTarget("CHZ", "PKG.PROC", 3, false, true); got != "" {
		t.Fatalf("sequence-disambiguated target produced a warning: %q", got)
	}

	// The pointers are what let the session tell "absent" from "empty", so the
	// JSON contract of the set_breakpoints payload is part of the guarantee.
	var requested []plDebugBreakpoint
	if err := json.Unmarshal([]byte(`[{"owner":"CHZ","name":"PKG.PROC","line":12},
		{"owner":"CHZ","name":"PKG.PROC","line":12,"signature":"(A IN NUMBER)","sequence":2}]`), &requested); err != nil {
		t.Fatalf("decoding breakpoints failed: %v", err)
	}
	if len(requested) != 2 {
		t.Fatalf("decoded %d breakpoints, want 2", len(requested))
	}
	if requested[0].Signature != nil || requested[0].Sequence != nil {
		t.Fatalf("absent attributes decoded as present: %#v", requested[0])
	}
	if requested[1].Signature == nil || *requested[1].Signature != "(A IN NUMBER)" || requested[1].Sequence == nil || *requested[1].Sequence != 2 {
		t.Fatalf("supplied attributes were not decoded: %#v", requested[1])
	}
}

func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return text[:index]
	}
	return text
}

// debugBefore arms the anonymous-block breakpoint on the line of the target call
// inside the block the debuggee runs (ODC's AnonymousBlockProcedureCall
// .getCallLine equivalent). The generated block puts the call on line 2; a block
// that opens with a comment banner, a call nested in an IF, and an argument list
// continuing on the following lines must all report the physical line the call
// starts on.
func TestPLDebugAnonymousCallLine(t *testing.T) {
	cases := []struct {
		name    string
		block   string
		routine string
		want    int
	}{
		{"generated procedure block", plDebugAnonymousBlock("CHZ", `"CHZ"."PROC"`, false, 0), `"CHZ"."PROC"`, 2},
		{"generated function block with parameters", plDebugAnonymousBlock("CHZ", `"CHZ"."PKG"."F_ADD"`, true, 2), `"CHZ"."PKG"."F_ADD"`, 2},
		{"leading line comments", "-- banner\n-- more\nBEGIN\n  \"CHZ\".\"PROC\"(:p1);\nEND;", `"CHZ"."PROC"`, 4},
		{"leading block comment", "/* banner\n   still a comment */\nBEGIN\n  \"CHZ\".\"PROC\"(:p1);\nEND;", `"CHZ"."PROC"`, 4},
		{"call nested in an IF", "DECLARE\n  v NUMBER;\nBEGIN\n  IF v IS NULL THEN\n    \"CHZ\".\"PROC\"(v);\n  END IF;\nEND;", `"CHZ"."PROC"`, 5},
		{"nested package routine", "BEGIN\n  \"CHZ\".\"PKG\".\"PROC\"(:p1);\nEND;", `"CHZ"."PKG"."PROC"`, 2},
		{"arguments on the following lines", "BEGIN\n  \"CHZ\".\"PROC\"(\n    :p1,\n    :p2,\n    :p3);\nEND;", `"CHZ"."PROC"`, 2},
		{"unqualified call", "BEGIN\n  PROC(:p1);\nEND;", "PROC", 2},
		{"commented out call is not a call", "BEGIN\n  -- \"CHZ\".\"PROC\"(1);\n  \"CHZ\".\"F_ADD\"(2);\nEND;", `"CHZ"."PROC"`, 0},
		{"routine never called", plDebugAnonymousBlock("CHZ", `"CHZ"."F_ADD"`, false, 0), `"CHZ"."PROC"`, 0},
		{"empty routine", "BEGIN\n  \"CHZ\".\"PROC\"(1);\nEND;", "", 0},
	}
	for _, tc := range cases {
		if got := plDebugAnonymousCallLine(tc.block, tc.routine); got != tc.want {
			t.Fatalf("%s: line = %d, want %d (block %q)", tc.name, got, tc.want, tc.block)
		}
	}

	// The generated block must keep the call off the BEGIN line, otherwise the
	// breakpoint would be armed on the block header instead of on the call. The
	// trailing statement is the V6.3 DBMS_OUTPUT capture: it has to stay *after* the
	// call (the output only exists once the target ran) and it has to name the helper
	// package of the target's owner.
	block := plDebugAnonymousBlock("CHZ", `"CHZ"."PROC"`, false, 1)
	if firstLine(block) != "BEGIN" || !strings.Contains(block, "\n  \"CHZ\".\"PROC\"(:p1);\n") {
		t.Fatalf("generated anonymous block does not put the call on its own line: %q", block)
	}
	if !strings.Contains(block, "\n  :"+plDebugCaptureBind+" := \"CHZ\".\"DBX_PL_DEBUG_PACKAGE\".DBX_FETCH_OUTPUT(") {
		t.Fatalf("generated anonymous block has no trailing DBMS_OUTPUT capture: %q", block)
	}
	if strings.Index(block, plDebugCaptureBind) < strings.Index(block, `"CHZ"."PROC"`) {
		t.Fatalf("the capture must come after the target call: %q", block)
	}
}

// plDebugResolveTarget renders exactly the block the debuggee executes and the
// program name debugBefore publishes; the call line has to be found in that same
// text, and OUT parameters still bind as SQL OUT arguments.
func TestPLDebugResolveTargetMatchesRenderedBlock(t *testing.T) {
	target, err := plDebugResolveTarget("CHZ", map[string]interface{}{
		"objectType":  "PROCEDURE",
		"packageName": "PKG",
		"objectName":  "PROC",
		"params": []interface{}{
			map[string]interface{}{"name": "A", "mode": "IN", "value": "1"},
			map[string]interface{}{"name": "B", "mode": "OUT"},
		},
	})
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	if target.Program != "PKG.PROC" {
		t.Fatalf("program = %q, want PKG.PROC", target.Program)
	}
	if target.Block != "BEGIN\n  \"CHZ\".\"PKG\".\"PROC\"(:p1, :p2);\n  :"+plDebugCaptureBind+
		" := \"CHZ\".\"DBX_PL_DEBUG_PACKAGE\".DBX_FETCH_OUTPUT(32000);\nEND;" {
		t.Fatalf("unexpected block: %q", target.Block)
	}
	if target.CapturedOutput == nil {
		t.Fatal("PROCEDURE target has no DBMS_OUTPUT capture binding")
	}
	if line := plDebugAnonymousCallLine(target.Block, target.Routine); line != 2 {
		t.Fatalf("call line = %d, want 2", line)
	}
	if len(target.Params) != 2 || target.IsFunction {
		t.Fatalf("params/isFunction = %d/%v, want 2/false", len(target.Params), target.IsFunction)
	}
	if _, ok := target.Params[1].(sql.Out); !ok {
		t.Fatalf("OUT parameter is not bound as sql.Out: %#v", target.Params[1])
	}

	function, err := plDebugResolveTarget("CHZ", map[string]interface{}{
		"objectType": "FUNCTION",
		"objectName": "F_ADD",
	})
	if err != nil {
		t.Fatalf("resolve function failed: %v", err)
	}
	if !function.IsFunction || function.Program != "F_ADD" || !strings.Contains(function.Block, ":result := ") {
		t.Fatalf("function target not rendered for a return value: %#v", function)
	}
	if _, err := plDebugResolveTarget("CHZ", map[string]interface{}{"objectType": "PROCEDURE"}); err == nil {
		t.Fatal("expected an error for a target without an object name")
	}
}

// ODC steps in at most MAX_TRY_STEP_INTO_TIMES (5) times waiting for the stack
// depth to grow, then fails the start; the limit and the failure have to be
// observable without a database.
func TestPLDebugStepInUntilDeeperRespectsLimit(t *testing.T) {
	if plDebugStartStepInLimit != 5 {
		t.Fatalf("step-in limit = %d, want 5 (ODC MAX_TRY_STEP_INTO_TIMES)", plDebugStartStepInLimit)
	}

	attempts := 0
	depth, err := plDebugStepInUntilDeeper(1, plDebugStartStepInLimit, func() (int, error) {
		attempts++
		return 1, nil
	})
	if err == nil {
		t.Fatal("expected an error when the stack depth never grows")
	}
	if attempts != plDebugStartStepInLimit {
		t.Fatalf("stepped in %d times, want the %d-attempt cap", attempts, plDebugStartStepInLimit)
	}
	if depth != 1 {
		t.Fatalf("depth = %d, want the unchanged 1", depth)
	}

	attempts = 0
	depth, err = plDebugStepInUntilDeeper(1, plDebugStartStepInLimit, func() (int, error) {
		attempts++
		if attempts == 2 {
			return 2, nil
		}
		return 1, nil
	})
	if err != nil {
		t.Fatalf("depth grew but stepping reported %v", err)
	}
	if attempts != 2 || depth != 2 {
		t.Fatalf("attempts/depth = %d/%d, want 2/2", attempts, depth)
	}

	sentinel := errors.New("step-in failed")
	if _, err := plDebugStepInUntilDeeper(1, plDebugStartStepInLimit, func() (int, error) {
		return 0, sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("step-in error was not propagated: %v", err)
	}

	if _, err := plDebugStepInUntilDeeper(1, 0, func() (int, error) {
		t.Fatal("stepped in with a zero limit")
		return 0, nil
	}); err == nil {
		t.Fatal("a zero limit must report that the depth never grew")
	}
}

// debugBefore applies to PROCEDURE/FUNCTION targets only: an anonymous block is
// submitted verbatim and keeps its caller-supplied breakpoints, so it must not
// touch the connections here (the session has neither).
func TestPLDebugDebugBeforeSkipsAnonymousTargets(t *testing.T) {
	session := &plDebugSession{owner: "CHZ"}
	if err := session.debugBefore(map[string]interface{}{
		"objectType": "ANONYMOUS",
		"source":     "BEGIN NULL; END;",
	}); err != nil {
		t.Fatalf("anonymous target ran debugBefore: %v", err)
	}
}

// pl_debug_start must not hand the client the zero state: the snapshot it returns
// carries whatever debugBefore parked the session on.
func TestPLDebugStartSnapshotIsNotZeroState(t *testing.T) {
	session := &plDebugSession{
		debugID:            "42",
		owner:              "CHZ",
		lastActivityMillis: nowMillis(),
	}
	session.lastProgram = "PKG.PROC"
	session.lastProgramOwner = "CHZ"
	session.lastLine = 12
	session.lastStackDepth = 1
	snapshot := session.startSnapshot()
	if snapshot["debugId"] != "42" || snapshot["owner"] != "CHZ" {
		t.Fatalf("snapshot lost the session identity: %#v", snapshot)
	}
	if snapshot["line"] != 12 || snapshot["program"] != "PKG.PROC" || snapshot["programOwner"] != "CHZ" || snapshot["stackDepth"] != 1 {
		t.Fatalf("snapshot is not filled in: %#v", snapshot)
	}
}

// The start sequence calls DBX_SYNCHRONIZE and DBX_SET_BREAKPOINT_ANONYMOUS, so
// both must be declared in the package head and defined in the body: a head
// without them leaves the body INVALID (PLS-00302) and takes the whole debugger
// down, and plDebugHeadRequiredRoutines is what forces that reinstall.
func TestPLDebugHelperPackageDeclaresStartRoutines(t *testing.T) {
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	for _, routine := range []string{procSynchronize, procSetBreakpointAnonymous} {
		if !strings.Contains(head, routine+"(") {
			t.Fatalf("package head does not declare %s:\n%s", routine, head)
		}
		if !strings.Contains(body, "PROCEDURE "+routine+"(") {
			t.Fatalf("package body does not define %s", routine)
		}
		if !containsString(plDebugHeadRequiredRoutines, routine) {
			t.Fatalf("%s is missing from plDebugHeadRequiredRoutines: %v", routine, plDebugHeadRequiredRoutines)
		}
	}
	if !strings.Contains(body, "dbms_debug.synchronize(run_info, dbms_debug.info_getLineinfo)") {
		t.Fatal("DBX_SYNCHRONIZE does not wrap dbms_debug.synchronize")
	}
	if !strings.Contains(body, "dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info)") {
		t.Fatal("DBX_SET_BREAKPOINT_ANONYMOUS does not resolve the anonymous block through get_runtime_info")
	}
	if !strings.Contains(body, "dbms_debug.set_breakpoint(run_info.program, line#, breakpoint#)") {
		t.Fatal("DBX_SET_BREAKPOINT_ANONYMOUS does not set the breakpoint on the anonymous block")
	}
}

// DBMS_DEBUG result codes must be named, not printed as bare numbers: the real
// 19c EE failure surfaced as "16" and "28" and could not be read without
// dbms_debug.sql at hand. The enumeration values are pinned here because the
// whole diagnosis of that failure depends on them.
func TestPLDebugResultNamesMatchTheDBMSDebugConstants(t *testing.T) {
	if plDebugErrSuccess != 0 || plDebugErrNameIncomplete != 11 || plDebugErrNoSuchBreakpoint != 13 ||
		plDebugErrBadHandle != 16 || plDebugErrException != 28 {
		t.Fatalf("result codes drifted from dbms_debug.sql: success=%d name_incomplete=%d no_such_breakpt=%d bad_handle=%d exception=%d",
			plDebugErrSuccess, plDebugErrNameIncomplete, plDebugErrNoSuchBreakpoint,
			plDebugErrBadHandle, plDebugErrException)
	}
	for result, want := range map[int]string{
		plDebugErrSuccess:               "success",
		plDebugErrNameIncomplete:        "error_name_incomplete",
		plDebugErrNoSuchBreakpoint:      "error_no_such_breakpt",
		plDebugErrBadHandle:             "error_bad_handle",
		plDebugErrException:             "error_exception",
		plDebugErrCapabilityUnavailable: "capability_unavailable",
		plDebugErrValueMalformed:        "error_value_malformed",
		plDebugErrTimeout:               "error_timeout",
	} {
		if got := plDebugResultName(result); got != want {
			t.Fatalf("plDebugResultName(%d) = %q, want %q", result, got, want)
		}
	}
}

// stepIntoRoutine is what replaced the anonymous-block breakpoint plus resume plus
// depth-based step-in, and it has to stop on the frame's PROGRAM NAME: at
// reason_interpreter_starting the debuggee's stack depth is 0 and only a CONTINUE
// produces a frame, so the run_info register of DBX_CNT_STEP_IN is the signal. The
// measurement on Oracle 19c EE is one continue(break_any_call) after SYNCHRONIZE, with
// run_info.programname then naming the target routine.
func TestPLDebugStepIntoRoutineStopsOnTheRoutineFrame(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
	drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("DBX_V1_PROC", "DBX_DEBUG", 1, 2, plDebugReasonEnter))
	session := newPLDebugCallSession(db, false)

	if err := session.stepIntoRoutine(plDebugTarget{Program: "DBX_V1_PROC"}); err != nil {
		t.Fatalf("stepIntoRoutine did not accept the target frame: %v", err)
	}
	if got := countRoutine(drv.recordedRoutines(), procCntStepIn); got != 1 {
		t.Fatalf("stepIntoRoutine stepped in %d times, want 1: %v", got, drv.recordedRoutines())
	}
	// The frame name is what the caller (debugBefore) publishes, and run_info reports
	// it owner-qualified, so the match must survive the qualification.
	t.Run("owner-qualified frame name", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
		drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("DBX_DEBUG.DBX_V1_PROC", "DBX_DEBUG", 1, 2, plDebugReasonEnter))
		if err := newPLDebugCallSession(db, false).stepIntoRoutine(plDebugTarget{Program: "DBX_V1_PROC"}); err != nil {
			t.Fatalf("an owner-qualified frame name must still match the target: %v", err)
		}
	})
}

// A frame that never becomes the target must give up after plDebugStartStepInLimit
// attempts -- never step forever -- and the error has to name the routine it looked for.
func TestPLDebugStepIntoRoutineGivesUpAfterTheLimit(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
	drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("OTHER_PROC", "DBX_DEBUG", 1, 2, plDebugReasonLine))
	session := newPLDebugCallSession(db, false)

	err := session.stepIntoRoutine(plDebugTarget{Program: "DBX_V1_PROC"})
	if err == nil {
		t.Fatal("stepIntoRoutine accepted a frame that is not the target")
	}
	if !strings.Contains(err.Error(), "DBX_V1_PROC") {
		t.Fatalf("the error does not name the routine that was never entered: %v", err)
	}
	if got := countRoutine(drv.recordedRoutines(), procCntStepIn); got != plDebugStartStepInLimit {
		t.Fatalf("stepIntoRoutine stepped in %d times, want the %d-attempt limit: %v",
			got, plDebugStartStepInLimit, drv.recordedRoutines())
	}
}

// A debuggee that finishes while stepping in must be reported through the target's own
// error, and nothing may step in afterwards.
func TestPLDebugStepIntoRoutineReportsTermination(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
	drv.scriptOut(procCntStepIn, 1, " run_info.breakpoint = , run_info.stackdepth = 2, run_info.reason = 15,"+
		" run_info.programname = OTHER_PROC, run_info.programowner = DBX_DEBUG")
	session := newPLDebugCallSession(db, false)
	session.targetErr = "ORA-06543: application error"

	err := session.stepIntoRoutine(plDebugTarget{Program: "DBX_V1_PROC"})
	if err == nil || !strings.Contains(err.Error(), "ORA-06543") {
		t.Fatalf("stepIntoRoutine did not surface the debuggee's own error: %v", err)
	}
	if got := countRoutine(drv.recordedRoutines(), procCntStepIn); got != 1 {
		t.Fatalf("stepIntoRoutine kept stepping after termination: %d calls", got)
	}
}

// A server that reports no program name at all (some engines fill only the stack depth)
// must still be driven to the deeper frame instead of failing: that is ODC's
// stepInForStartingDebug criterion, kept as the fallback.
func TestPLDebugStepIntoRoutineFallsBackToStackDepthWithoutProgramNames(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
	drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("", "", 0, 2, plDebugReasonEnter))
	session := newPLDebugCallSession(db, false)

	if err := session.stepIntoRoutine(plDebugTarget{Program: "DBX_V1_PROC"}); err != nil {
		t.Fatalf("the depth fallback did not accept the deeper frame: %v", err)
	}
	if got := countRoutine(drv.recordedRoutines(), procCntStepIn); got == 0 {
		t.Fatal("stepIntoRoutine never stepped in")
	}
}

// debugBefore must not go back to arming an anonymous-block breakpoint: at
// reason_interpreter_starting GET_RUNTIME_INFO answers error_exception (28) with an
// empty run_info (measured on 19c EE), so SET_BREAKPOINT_ANONYMOUS can only answer
// error_bad_handle (16). The routine is entered by CONTINUE(break_any_call) instead.
func TestPLDebugDebugBeforeParksInsideTheRoutineWithoutArmingBreakpoints(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
	drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("DBX_V1_PROC", "DBX_DEBUG", 1, 2, plDebugReasonEnter))
	session := newPLDebugCallSession(db, false)

	if err := session.debugBefore(map[string]interface{}{
		"objectType": "PROCEDURE",
		"objectName": "DBX_V1_PROC",
	}); err != nil {
		t.Fatalf("debugBefore failed: %v", err)
	}
	for _, routine := range drv.recordedRoutines() {
		switch routine {
		case procGetRuntimeInfo, procSetBreakpointAnonymous, procSetBreakpoint, procCntNextBreakpoint:
			t.Fatalf("debugBefore still depends on %s, which cannot work at the start state: %v",
				routine, drv.recordedRoutines())
		}
	}
	if !containsString(drv.recordedRoutines(), procCntStepIn) {
		t.Fatalf("debugBefore never entered the routine: %v", drv.recordedRoutines())
	}
	snapshot := session.startSnapshot()
	if snapshot["program"] != "DBX_V1_PROC" {
		t.Fatalf("start snapshot program = %v, want DBX_V1_PROC", snapshot["program"])
	}
	// ODC publishes the routine itself as the current frame, at depth 1.
	if snapshot["stackDepth"] != 1 {
		t.Fatalf("start snapshot stackDepth = %v, want ODC's 1", snapshot["stackDepth"])
	}
}

// An anonymous-block target has no call line to stop on, so debugBefore must leave it
// alone and let its caller-supplied breakpoints do the work.
func TestPLDebugDebugBeforeLeavesAnonymousTargetsAlone(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	session := newPLDebugCallSession(db, false)
	for _, objectType := range []string{"ANONYMOUS", "PACKAGE", ""} {
		if err := session.debugBefore(map[string]interface{}{
			"objectType": objectType,
			"objectName": "DBX_V1_PROC",
		}); err != nil {
			t.Fatalf("debugBefore(%q) failed: %v", objectType, err)
		}
	}
	if routines := drv.recordedRoutines(); len(routines) != 0 {
		t.Fatalf("debugBefore touched the server for a non-routine target: %v", routines)
	}
}

// A parked helper call -- the server never answers, and the driver ignores the
// context -- has to come back as the documented timeout error, and the session
// then has to refuse every later PROBE call instead of blocking on it again.
func TestPLDebugGuardedCallTimesOutInsteadOfHanging(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	releaseCall := drv.blockRoutine(procCntNextBreakpoint)
	defer releaseCall()
	session := newPLDebugCallSession(db, false)
	session.callTimeout = 50 * time.Millisecond

	done := make(chan error, 1)
	go func() {
		_, err := session.continueWith(procCntNextBreakpoint)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("continueWith returned no error for a call that never returned")
		}
		if !strings.Contains(err.Error(), "did not return within") ||
			!strings.Contains(err.Error(), "connection dropped") {
			t.Fatalf("continueWith error is not the documented timeout: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("continueWith did not return: the guard does not bound a call the server never answers")
	}

	// State guard: the session is poisoned, so the next call must fail at once
	// without reaching the driver at all.
	before := len(drv.recordedRoutines())
	start := time.Now()
	if _, err := session.continueWith(procCntNextBreakpoint); err == nil ||
		!strings.Contains(err.Error(), "was abandoned") {
		t.Fatalf("a call on the abandoned session returned %v, want the abandoned-session error", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("the state guard took %s to fail; it must not wait for the server", elapsed)
	}
	if after := len(drv.recordedRoutines()); after != before {
		t.Fatalf("the state guard issued another DBMS_DEBUG call: %v", drv.recordedRoutines())
	}
	// Every handler on that session inherits the guard, not only resume.
	if _, err := session.variables(0); err == nil || !strings.Contains(err.Error(), "was abandoned") {
		t.Fatalf("get_variables on the abandoned session returned %v, want the abandoned-session error", err)
	}
}

// plDebugBoundedRun reports the timeout through its own type and leaves the
// timeout value to the caller.
func TestPLDebugBoundedRunReportsTheTimeoutType(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	releaseCall := drv.blockRoutine(procCntNextLine)
	defer releaseCall()

	err := plDebugBoundedRun(db, procCntNextLine, 40*time.Millisecond, func() error {
		return plDebugHelperCall(db, false, "CHZ", procCntNextLine, nil, new(int), new(string))
	})
	var timeoutErr *plDebugCallTimeoutError
	if !errors.As(err, &timeoutErr) {
		t.Fatalf("plDebugBoundedRun returned %v, want a *plDebugCallTimeoutError", err)
	}
	if !strings.Contains(err.Error(), procCntNextLine+" did not return within") {
		t.Fatalf("timeout message = %v", err)
	}
	if timeoutErr.Timeout != 40*time.Millisecond {
		t.Fatalf("timeout reported as %s, want 40ms", timeoutErr.Timeout)
	}
}

// Abort and close must stay usable -- and fast -- on a session whose debugger
// connection is gone: that is the "cancel" half of the contract, because the
// client's only way out of a wedged start is pl_debug_abort / pl_debug_close.
func TestPLDebugAbortAndCloseAreBoundedOnAnAbandonedSession(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	session := newPLDebugCallSession(db, false)
	session.abandonDebugger("after a simulated timeout")

	done := make(chan error, 1)
	go func() {
		_, err := session.abort()
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "was abandoned") {
			t.Fatalf("abort on the abandoned session returned %v, want the abandoned-session error", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("abort blocked on an abandoned session; the client could not cancel")
	}

	start := time.Now()
	if err := session.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("Close took %s on an abandoned session", elapsed)
	}
	if routines := drv.recordedRoutines(); len(routines) != 0 {
		for _, routine := range routines {
			if routine != "" {
				t.Fatalf("Close issued debugger-side PROBE calls on an abandoned session: %v", routines)
			}
		}
	}
}

// Close has to wait for the debuggee's statement before it closes the pools, because
// database/sql's DB.Close only closes FREE connections: a connection an in-flight
// statement is still using is closed when that statement returns, so a target still
// parked at close time keeps its server session alive. Measured on Oracle 19c EE: three
// rounds of start/set-breakpoint/resume/abort/close left the agent process holding one
// more TCP connection to the database after every round (1 -> 2 -> 3 -> 4) and the
// matching session parked in "pipe get".
func TestPLDebugCloseWaitsForTheDebuggeeStatementBeforeItClosesThePools(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	session := newPLDebugCallSession(db, false)
	session.targetDone = make(chan struct{})
	session.releaseTimeout = 2 * time.Second

	// The parked target runs on its own goroutine and hands its connection back when
	// the abort releases it; that is the moment Close may close the pool.
	released := make(chan struct{})
	go func() {
		<-released
		session.finishTarget()
	}()

	done := make(chan error, 1)
	go func() { done <- session.Close() }()
	select {
	case <-done:
		t.Fatal("Close returned while the debuggee's statement was still in flight; " +
			"database/sql cannot close the connection that statement is using, so its server " +
			"session would have survived")
	case <-time.After(200 * time.Millisecond):
	}
	close(released)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close never returned after the debuggee released its connection")
	}

	if _, ok := drv.recordedStatementContaining("DEBUG_OFF"); ok {
		t.Fatal("Close issued DBMS_DEBUG.DEBUG_OFF: it is itself debugged and can only be released " +
			"by the server-side SET_TIMEOUT (measured: 12.078s with SET_TIMEOUT(12)), so a 5s bound " +
			"can never be met and the abandoned statement keeps the connection -- and the server " +
			"session -- alive")
	}
	if _, ok := drv.recordedStatementContaining("DETACH_SESSION"); !ok {
		t.Fatal("Close no longer detaches the debugger session")
	}
	if closes := drv.closedConnections(); closes == 0 {
		t.Fatal("Close did not close the pools, so both server sessions would have survived")
	}
}

// A debuggee the server keeps parked (an abandoned debugger could not abort it) must not
// turn Close into a hang: the wait is bounded, the pools are closed anyway, and the
// server releases the session when its own SET_TIMEOUT expires.
func TestPLDebugCloseIsBoundedWhileTheDebuggeeStaysParked(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	session := newPLDebugCallSession(db, false)
	session.targetDone = make(chan struct{}) // never closed: the debuggee never returns
	session.releaseTimeout = 200 * time.Millisecond

	start := time.Now()
	if err := session.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("Close took %s while the debuggee stayed parked; the wait must stay bounded", elapsed)
	}
	if closes := drv.closedConnections(); closes == 0 {
		t.Fatal("Close left the pools open after the debuggee failed to return")
	}
}

// cancel_session has to reach the PL/SQL debug sessions too: a debug RPC blocks
// inside DBMS_DEBUG on the server, not in a tracked query, so only dropping its
// connections can release it. Every later call must then fail on the state guard
// instead of attaching to the dead debuggee again.
func TestPLDebugClientCancelAbandonsEveryDebugSession(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	session := newPLDebugCallSession(db, false)
	server := newServer()
	server.plDebugSessions = map[string]*plDebugSession{"1": session}

	server.cancelPlDebugCalls()

	if err := session.debuggerFailure(); err == nil || !strings.Contains(err.Error(), "was abandoned") {
		t.Fatalf("cancel_session did not abandon the debugger connection: %v", err)
	}
	if _, err := session.resume(); err == nil || !strings.Contains(err.Error(), "was abandoned") {
		t.Fatalf("resume after cancel_session returned %v, want the abandoned-session error", err)
	}
	if routines := drv.recordedRoutines(); len(routines) != 0 {
		t.Fatalf("resume after cancel_session still reached the database: %v", routines)
	}
}

// A package subprogram cannot be matched by its frame NAME: Oracle reports the *package*
// as the frame's program and leaves entrypointname NULL (measured on 19c EE against
// DBX_DEBUG.DBX_MSCHK_PKG: program.name = DBX_MSCHK_PKG, program.entrypointname NULL,
// namespace = 2 (namespace_pkg_body), line = 2 at the subprogram's first line while the
// backtrace printed "[Line 2]   PROCEDURE RUN_MSCHK IS"). Before this, stepIntoRoutine
// compared "DBX_MSCHK_PKG" with "RUN_MSCHK", never matched, and failed the start with
// "the interpreter never entered DBX_MSCHK_PKG.RUN_MSCHK after 5 step-in attempts
// (last frame: \"DBX_MSCHK_PKG\")". The source line is what says which subprogram of the
// package body is current.
func TestPLDebugStepIntoRoutineAcceptsThePackageFrameInsideTheSubprogram(t *testing.T) {
	target := plDebugTarget{
		Routine: `"DBX_DEBUG"."DBX_MSCHK_PKG"."RUN_MSCHK"`,
		Program: "DBX_MSCHK_PKG.RUN_MSCHK",
		Package: "DBX_MSCHK_PKG",
	}

	t.Run("the subprogram's first line is accepted", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
		drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("DBX_MSCHK_PKG", "DBX_DEBUG", 0, 2, plDebugReasonEnter))
		drv.scriptOut(procPrintBacktrace, 0, " [Line 2]   PROCEDURE RUN_MSCHK IS\n<source not available>")
		drv.scriptOut(procPrintBacktrace, 1, 0)
		session := newPLDebugCallSession(db, false)
		session.targetLines = plDebugLineRange{First: 2, Last: 7}

		if err := session.stepIntoRoutine(target); err != nil {
			t.Fatalf("stepIntoRoutine did not accept the package frame at the subprogram's line range: %v", err)
		}
		if got := countRoutine(drv.recordedRoutines(), procCntStepIn); got != 1 {
			t.Fatalf("stepIntoRoutine stepped in %d times, want the single one that entered the subprogram: %v",
				got, drv.recordedRoutines())
		}
	})

	// The interpreter walks the package's initialization section first and reports the
	// same package frame there, so the match must not fire on a line outside the
	// subprogram -- that is the "only compare the package name" failure mode.
	t.Run("the initialization section is not the subprogram", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		for attempt := 1; attempt <= 8; attempt++ {
			drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
			drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("DBX_MSCHK_PKG", "DBX_DEBUG", 0, 2, plDebugReasonLine))
		}
		drv.scriptOut(procPrintBacktrace, 0, " [Line 9]   DBMS_OUTPUT.PUT_LINE('init');\n<source not available>")
		drv.scriptOut(procPrintBacktrace, 1, 0)
		session := newPLDebugCallSession(db, false)
		session.targetLines = plDebugLineRange{First: 2, Last: 7}

		err := session.stepIntoRoutine(target)
		// The frame never reaches the subprogram, so the only acceptable outcomes are the
		// bounded give-up and the documented, *reported* degradation -- never a silent
		// "we are inside the package, that will do".
		if err != nil && !strings.Contains(err.Error(), "RUN_MSCHK") {
			t.Fatalf("the give-up error does not name the routine: %v", err)
		}
		if err == nil {
			if !strings.Contains(session.debugInfo, "initialization section") {
				t.Fatalf("the package frame was accepted silently; the degradation has to be reported: debugInfo=%q",
					session.debugInfo)
			}
			if got := countRoutine(drv.recordedRoutines(), procCntStepIn); got != plDebugPackageStepInLimit {
				t.Fatalf("the degradation ran %d step-ins, want the package budget %d",
					got, plDebugPackageStepInLimit)
			}
		}
	})

	t.Run("another package is not the target", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
		drv.scriptOut(procCntStepIn, 1, plDebugRunInfo("OTHER_PKG", "DBX_DEBUG", 0, 2, plDebugReasonEnter))
		drv.scriptOut(procPrintBacktrace, 0, " [Line 2]   PROCEDURE RUN_MSCHK IS\n<source not available>")
		drv.scriptOut(procPrintBacktrace, 1, 0)
		session := newPLDebugCallSession(db, false)
		session.targetLines = plDebugLineRange{First: 2, Last: 7}

		if err := session.stepIntoRoutine(target); err == nil {
			t.Fatal("a frame from a different package matched the target")
		}
	})
}

// plDebugFrameMatchesProgram is the whole match rule, so the package case is pinned here
// as well: the package name is a precondition, the line decides.
func TestPLDebugFrameMatchesProgram(t *testing.T) {
	packageTarget := plDebugTarget{Program: "DBX_MSCHK_PKG.RUN_MSCHK", Package: "DBX_MSCHK_PKG"}
	lines := plDebugLineRange{First: 2, Last: 7}
	for _, testCase := range []struct {
		name  string
		frame string
		line  int
		want  bool
	}{
		{"the subprogram's own first line", "DBX_MSCHK_PKG", 2, true},
		{"a line inside the subprogram", "DBX_MSCHK_PKG", 5, true},
		{"the package header", "DBX_MSCHK_PKG", 1, false},
		{"the initialization section", "DBX_MSCHK_PKG", 9, false},
		{"another package", "OTHER_PKG", 5, false},
		{"an owner-qualified package frame", "DBX_DEBUG.DBX_MSCHK_PKG", 5, true},
		// The frame name is an engine property, not a documented one: a server that
		// reports the subprogram itself must keep working exactly as it did before the
		// package rule existed.
		{"an engine that reports the qualified subprogram", "DBX_MSCHK_PKG.RUN_MSCHK", 0, true},
		{"an engine that reports the bare subprogram name", "RUN_MSCHK", 9, true},
	} {
		if got := plDebugFrameMatchesProgram(testCase.frame, testCase.line, packageTarget, lines); got != testCase.want {
			t.Fatalf("%s: plDebugFrameMatchesProgram(%q, %d) = %v, want %v",
				testCase.name, testCase.frame, testCase.line, got, testCase.want)
		}
	}
	// Without a range the package frame is accepted: that is the documented
	// degradation for a server whose ALL_SOURCE the agent cannot read.
	if !plDebugFrameMatchesProgram("DBX_MSCHK_PKG", 9, packageTarget, plDebugLineRange{}) {
		t.Fatal("an unknown source range must fall back to the package frame, not block the start")
	}
	// A standalone routine keeps the name-only rule.
	standalone := plDebugTarget{Program: "DBX_V1_PROC"}
	if !plDebugFrameMatchesProgram("DBX_DEBUG.DBX_V1_PROC", 0, standalone, plDebugLineRange{}) {
		t.Fatal("a standalone routine no longer matches by name")
	}
	if plDebugFrameMatchesProgram("DBX_MSCHK_PKG", 5, standalone, plDebugLineRange{}) {
		t.Fatal("a package frame matched a standalone routine")
	}
}

// The order inside plDebugFrameMatchesProgram is a regression point: the subprogram-name
// match comes FIRST, before the package-name-plus-line-range rule. A server that reports
// the subprogram itself in run_info.program.name (OceanBase Oracle mode among them) must
// keep matching even when the frame line falls outside the range the agent read from
// ALL_SOURCE -- with the range rule first, such a frame would be rejected and the start
// would never park inside the routine. The package rule is only the additional way in
// that Oracle 19c EE needs, not a replacement for the name match.
func TestPLDebugFrameMatchTriesTheSubprogramNameFirst(t *testing.T) {
	target := plDebugTarget{Program: "DBX_MSBP_PKG.RUN_MSBP", Package: "DBX_MSBP_PKG"}
	// A range that does NOT contain the frame line: only the name match can accept it.
	outside := plDebugLineRange{First: 100, Last: 120}
	for _, frame := range []string{"DBX_MSBP_PKG.RUN_MSBP", "RUN_MSBP", "DBX_DEBUG.RUN_MSBP"} {
		if !plDebugFrameMatchesProgram(frame, 3, target, outside) {
			t.Fatalf("frame %q outside the source range was not matched by name: the package-plus-line "+
				"rule runs before the subprogram-name rule", frame)
		}
	}
	// The package frame is still judged by the range, i.e. the extra rule is intact.
	if plDebugFrameMatchesProgram("DBX_MSBP_PKG", 3, target, outside) {
		t.Fatal("the package frame matched outside the subprogram's range")
	}
	if !plDebugFrameMatchesProgram("DBX_MSBP_PKG", 105, target, outside) {
		t.Fatal("the package frame did not match inside the subprogram's range")
	}
}

// The subprogram's source range is what keeps the package frame match honest. It has to
// contain the subprogram (its declaration line, its body and its END) and exclude the
// package's initialization section, which the interpreter reports as the same package
// frame: measured on 19c EE against DBX_DEBUG.DBX_MSCHK_PKG2, whose three-line
// initialization section produced reason_enter on line 1, then lines 8/9/10, and only
// then the subprogram's own reason_enter on line 2.
func TestPLDebugSubprogramRangeKeepsTheInitializationSectionOut(t *testing.T) {
	lines := func(rows ...string) []plDebugSourceLine {
		out := make([]plDebugSourceLine, 0, len(rows))
		for index, row := range rows {
			out = append(out, plDebugSourceLine{Line: index + 1, Text: row})
		}
		return out
	}

	t.Run("no initialization section", func(t *testing.T) {
		source := lines(
			"PACKAGE BODY PKG AS",
			"  PROCEDURE RUN_MSCHK IS",
			"    V NUMBER;",
			"  BEGIN",
			"    V := 7;",
			"    DBMS_OUTPUT.PUT_LINE('x' || V);",
			"  END RUN_MSCHK;",
			"  FUNCTION F_MSCHK RETURN NUMBER IS",
			"  BEGIN",
			"    RETURN 11;",
			"  END F_MSCHK;",
			"END PKG;")
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_MSCHK"); !ok || first != 2 || last != 7 ||
			closure != plDebugRangeByName {
			t.Fatalf("RUN_MSCHK range = (%d, %d, %v, %v), want (2, 7, byName, true)", first, last, closure, ok)
		}
		if first, last, closure, ok := plDebugSubprogramRange(source, "F_MSCHK"); !ok || first != 8 || last != 11 ||
			closure != plDebugRangeByName {
			t.Fatalf("F_MSCHK range = (%d, %d, %v, %v), want (8, 11, byName, true)", first, last, closure, ok)
		}
	})

	t.Run("initialization section is excluded", func(t *testing.T) {
		source := lines(
			"PACKAGE BODY PKG2 AS",
			"  PROCEDURE RUN_MSCHK IS",
			"    V NUMBER;",
			"  BEGIN",
			"    V := 7;",
			"    DBMS_OUTPUT.PUT_LINE('x' || V);",
			"  END RUN_MSCHK;",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('pkg2 init');",
			"END PKG2;")
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_MSCHK"); !ok || first != 2 || last != 7 ||
			closure != plDebugRangeByName {
			t.Fatalf("RUN_MSCHK range = (%d, %d, %v, %v), want (2, 7, byName, true): the initialization "+
				"section the interpreter walks first must stay outside it", first, last, closure, ok)
		}
	})

	t.Run("unnamed END falls back to the package BEGIN", func(t *testing.T) {
		source := lines(
			"PACKAGE BODY PKG3 AS",
			"  PROCEDURE RUN_MSCHK IS",
			"  BEGIN",
			"    NULL;",
			"  END;",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('pkg3 init');",
			"END PKG3;")
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_MSCHK"); !ok || first != 2 || last != 5 ||
			closure != plDebugRangeByOuterBegin {
			t.Fatalf("RUN_MSCHK range = (%d, %d, %v, %v), want (2, 5, byOuterBegin, true)", first, last, closure, ok)
		}
	})

	t.Run("a commented-out declaration does not win", func(t *testing.T) {
		source := lines(
			"PACKAGE BODY PKG4 AS",
			"  -- PROCEDURE RUN_MSCHK IS",
			"  PROCEDURE RUN_MSCHK IS",
			"  BEGIN",
			"    NULL;",
			"  END RUN_MSCHK;",
			"END PKG4;")
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_MSCHK"); !ok || first != 3 || last != 6 ||
			closure != plDebugRangeByName {
			t.Fatalf("RUN_MSCHK range = (%d, %d, %v, %v), want (3, 6, byName, true)", first, last, closure, ok)
		}
	})

	// A nested subprogram inside the target's declaration section is part of the
	// target: only the target's own END may close the range, and the nested unit's own
	// END (named or not) must not.
	t.Run("a nested subprogram stays inside the target", func(t *testing.T) {
		source := lines(
			"PACKAGE BODY PKG6 AS",
			"  PROCEDURE RUN_OUTER IS",
			"    PROCEDURE RUN_INNER IS",
			"    BEGIN",
			"      DBMS_OUTPUT.PUT_LINE('inner');",
			"    END RUN_INNER;",
			"  BEGIN",
			"    RUN_INNER;",
			"  END RUN_OUTER;",
			"  PROCEDURE RUN_SIBLING IS",
			"  BEGIN",
			"    NULL;",
			"  END RUN_SIBLING;",
			"END PKG6;")
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_OUTER"); !ok || first != 2 || last != 9 ||
			closure != plDebugRangeByName {
			t.Fatalf("RUN_OUTER range = (%d, %d, %v, %v), want (2, 9, byName, true): the nested subprogram's "+
				"END must not close the outer range", first, last, closure, ok)
		}
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_INNER"); !ok || first != 3 || last != 6 ||
			closure != plDebugRangeByName {
			t.Fatalf("RUN_INNER range = (%d, %d, %v, %v), want (3, 6, byName, true)", first, last, closure, ok)
		}
	})

	// The whole body in column 1: the "BEGIN indented less than the declaration" rule
	// can never fire there, so the range is closed by an unnamed END at the declaration's
	// own indentation and, past it, by the package's initialization BEGIN -- which must
	// never be swallowed, or the label would name the subprogram for an init-section line.
	t.Run("a body with no indentation at all", func(t *testing.T) {
		named := lines(
			"PACKAGE BODY PKG7 AS",
			"PROCEDURE RUN_Z IS",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('z');",
			"END RUN_Z;",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('pkg7 init');",
			"END PKG7;")
		if first, last, closure, ok := plDebugSubprogramRange(named, "RUN_Z"); !ok || first != 2 || last != 5 ||
			closure != plDebugRangeByName {
			t.Fatalf("RUN_Z range = (%d, %d, %v, %v), want (2, 5, byName, true)", first, last, closure, ok)
		}

		unnamed := lines(
			"PACKAGE BODY PKG8 AS",
			"PROCEDURE RUN_Z2 IS",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('z2');",
			"END;",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('pkg8 init');",
			"END PKG8;")
		if first, last, closure, ok := plDebugSubprogramRange(unnamed, "RUN_Z2"); !ok || first != 2 || last != 5 ||
			closure != plDebugRangeByOuterBegin {
			t.Fatalf("RUN_Z2 range = (%d, %d, %v, %v), want (2, 5, byOuterBegin, true): an unindented body's "+
				"initialization section was swallowed", first, last, closure, ok)
		}

		bare := lines(
			"PACKAGE BODY PKG9 AS",
			"PROCEDURE RUN_Z3 IS",
			"BEGIN",
			"  DBMS_OUTPUT.PUT_LINE('z3');",
			"END;",
			"END PKG9;")
		if first, last, closure, ok := plDebugSubprogramRange(bare, "RUN_Z3"); !ok || first != 2 || last != 5 ||
			closure != plDebugRangeByOwnEnd {
			t.Fatalf("RUN_Z3 range = (%d, %d, %v, %v), want (2, 5, byOwnEnd, true)", first, last, closure, ok)
		}
	})

	// Nothing the scan recognises closes the subprogram: it has to say so instead of
	// publishing the range that runs to the end of the body.
	t.Run("an unclosable range is reported", func(t *testing.T) {
		source := lines(
			"PACKAGE BODY PKG10 AS",
			"  PROCEDURE RUN_Z4 IS",
			"    V NUMBER;",
			"  -- no BEGIN at all")
		if first, last, closure, ok := plDebugSubprogramRange(source, "RUN_Z4"); !ok || closure != plDebugRangeByBodyEnd ||
			last != 4 {
			t.Fatalf("RUN_Z4 range = (%d, %d, %v, %v), want (2, 4, byBodyEnd, true)", first, last, closure, ok)
		}
	})

	t.Run("a missing subprogram is reported as such", func(t *testing.T) {
		source := lines("PACKAGE BODY PKG5 AS", "  PROCEDURE OTHER IS", "  BEGIN", "    NULL;", "  END OTHER;", "END PKG5;")
		if _, _, closure, ok := plDebugSubprogramRange(source, "RUN_MSCHK"); ok || closure != plDebugRangeUnclosed {
			t.Fatal("a subprogram the body does not declare was located anyway")
		}
	})
}

// The package a subprogram target lives in is what the frame match needs, and the client
// may send it either as packageName or folded into objectName.
func TestPLDebugTargetPackageSplitsThePackageOut(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		request       map[string]interface{}
		wantPackage   string
		wantSubsystem string
		wantOK        bool
	}{
		{
			name:          "explicit packageName",
			request:       map[string]interface{}{"objectType": "PROCEDURE", "objectName": "run_mschk", "packageName": "dbx_mschk_pkg"},
			wantPackage:   "DBX_MSCHK_PKG",
			wantSubsystem: "RUN_MSCHK",
			wantOK:        true,
		},
		{
			name:          "qualified objectName",
			request:       map[string]interface{}{"objectType": "FUNCTION", "objectName": "DBX_MSCHK_PKG.F_MSCHK"},
			wantPackage:   "DBX_MSCHK_PKG",
			wantSubsystem: "F_MSCHK",
			wantOK:        true,
		},
		{
			name:    "a standalone routine has no package",
			request: map[string]interface{}{"objectType": "PROCEDURE", "objectName": "DBX_V1_PROC"},
			wantOK:  false,
		},
		{
			name:    "an anonymous block has no package",
			request: map[string]interface{}{"objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"},
			wantOK:  false,
		},
		{
			name:    "an unquoted-invalid name is refused",
			request: map[string]interface{}{"objectType": "PROCEDURE", "objectName": "RUN", "packageName": "PKG; DROP"},
			wantOK:  false,
		},
	} {
		packageName, subprogram, ok := plDebugTargetPackage(testCase.request)
		if ok != testCase.wantOK || packageName != testCase.wantPackage || subprogram != testCase.wantSubsystem {
			t.Fatalf("%s: plDebugTargetPackage = (%q, %q, %v), want (%q, %q, %v)", testCase.name,
				packageName, subprogram, ok, testCase.wantPackage, testCase.wantSubsystem, testCase.wantOK)
		}
	}

	target, err := plDebugResolveTarget("DBX_DEBUG", map[string]interface{}{
		"objectType": "PROCEDURE", "objectName": "RUN_MSCHK", "packageName": "DBX_MSCHK_PKG"})
	if err != nil {
		t.Fatalf("plDebugResolveTarget failed: %v", err)
	}
	if target.Package != "DBX_MSCHK_PKG" || target.Program != "DBX_MSCHK_PKG.RUN_MSCHK" {
		t.Fatalf("the resolved target lost the package: %#v", target)
	}
	if target.Block != "BEGIN\n  \"DBX_DEBUG\".\"DBX_MSCHK_PKG\".\"RUN_MSCHK\"();\n  :"+plDebugCaptureBind+
		" := \"DBX_DEBUG\".\"DBX_PL_DEBUG_PACKAGE\".DBX_FETCH_OUTPUT(32000);\nEND;" {
		t.Fatalf("the rendered block changed: %q", target.Block)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// countRoutine counts how often one helper-package routine was called, which is how
// the step-in bound (plDebugStartStepInLimit) and the "stop on the first frame"
// behaviour are asserted.
func countRoutine(routines []string, want string) int {
	count := 0
	for _, routine := range routines {
		if routine == want {
			count++
		}
	}
	return count
}

// plDebugRunInfo renders the run_info register exactly the way the helper package
// concatenates it, so the tests exercise the real parse path
// (plDebugSession.applyRunInfoMessage) instead of assigning session fields directly.
func plDebugRunInfo(program, owner string, breakpoint, depth, reason int) string {
	return fmt.Sprintf(" run_info.breakpoint = %d, run_info.stackdepth = %d, run_info.reason = %d,"+
		" run_info.programname = %s, run_info.programowner = %s", breakpoint, depth, reason, program, owner)
}

// oracleDebugGetLineDriver is a fake Oracle driver that answers the helper
// package's V6.3 DBX_FETCH_OUTPUT call the way go-ora's Exec path (Stmt._exec)
// does: the OUT bind is unpacked, its type is recorded and the scripted chunk is
// written into the destination. Any other statement is an error, so a QueryRow that
// bypasses Exec shows up as a failed drain.
type oracleDebugGetLineDriver struct {
	mu     sync.Mutex
	chunks []string
	failAt int
	calls  int
	binds  []string
	inputs []string
}

// openOracleDebugGetLineTestDB registers one fake driver per test and returns
// the pool plus a way to script the chunks DBX_FETCH_OUTPUT answers with. The last
// chunk of every script has to be "" (the end of the buffer), exactly as the helper
// returns it.
func openOracleDebugGetLineTestDB(t *testing.T, chunks ...string) (*sql.DB, *oracleDebugGetLineDriver) {
	t.Helper()
	drv := &oracleDebugGetLineDriver{chunks: chunks}
	name := "oracle-debug-get-line-" + strings.ReplaceAll(t.Name(), "/", "-")
	sql.Register(name, drv)
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db, drv
}

// failGetLineAt makes the n-th DBX_FETCH_OUTPUT call (1-based) fail, which is how a
// missing EXECUTE grant or a closed session behaves on a real server.
func (d *oracleDebugGetLineDriver) failGetLineAt(n int) {
	d.mu.Lock()
	d.failAt = n
	d.mu.Unlock()
}

func (d *oracleDebugGetLineDriver) bindKinds() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.binds...)
}

func (d *oracleDebugGetLineDriver) inputKinds() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.inputs...)
}

func (d *oracleDebugGetLineDriver) callCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

func (d *oracleDebugGetLineDriver) Open(string) (driver.Conn, error) {
	return &oracleDebugGetLineConn{driver: d}, nil
}

type oracleDebugGetLineConn struct {
	driver *oracleDebugGetLineDriver
}

var (
	_ driver.Conn              = (*oracleDebugGetLineConn)(nil)
	_ driver.ExecerContext     = (*oracleDebugGetLineConn)(nil)
	_ driver.NamedValueChecker = (*oracleDebugGetLineConn)(nil)
)

func (c *oracleDebugGetLineConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("use the context APIs")
}

func (c *oracleDebugGetLineConn) Close() error { return nil }

func (c *oracleDebugGetLineConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not supported")
}

// CheckNamedValue mirrors go-ora's Connection.CheckNamedValue: OUT bind values
// pass through untouched so the driver can unpack them while executing.
func (c *oracleDebugGetLineConn) CheckNamedValue(*driver.NamedValue) error { return nil }

func (c *oracleDebugGetLineConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	driverState := c.driver
	driverState.mu.Lock()
	defer driverState.mu.Unlock()
	if !strings.Contains(query, procFetchOutput) {
		return nil, fmt.Errorf("unexpected statement (the debug path must drain through %s on Exec): %s", procFetchOutput, query)
	}
	driverState.calls++
	driverState.binds = append(driverState.binds, describeOutBind(args, 0))
	driverState.inputs = append(driverState.inputs, fmt.Sprintf("%T", args[1].Value))
	if driverState.failAt > 0 && driverState.calls >= driverState.failAt {
		return nil, errors.New("ORA-06550: simulated DBX_FETCH_OUTPUT failure")
	}
	chunk := ""
	if len(driverState.chunks) > 0 {
		chunk, driverState.chunks = driverState.chunks[0], driverState.chunks[1:]
	}
	setOutDest(args, 0, chunk)
	return driver.RowsAffected(0), nil
}

// newTerminatedPLDebugSession builds the minimal finished session log() needs:
// log() reads DBMS_OUTPUT only after the interpreter released the debuggee.
func newTerminatedPLDebugSession(db *sql.DB, oci bool) *plDebugSession {
	return &plDebugSession{
		debugID:            "1",
		owner:              "CHZ",
		debuggee:           db,
		terminated:         true,
		oci:                oci,
		lastActivityMillis: nowMillis(),
	}
}

// go-ora's query path (Stmt.Query_ -> NewParam(..., Input)) binds every argument
// as an input and never fills an OUT destination in, so log() must reach the
// driver through Exec and must declare a buffer size for the chunk. Without the
// size go-ora cannot read the OUT string back and the DBMS Output pane stays
// empty. The size has to be plDebugLogChars and not plDebugLineChars: the drain
// reads whole DBMS_OUTPUT chunks, not one line.
func TestPLDebugLogBindsSizedGoOraOutForThinDriver(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "hello from the debuggee", "")
	output, err := newTerminatedPLDebugSession(db, false).log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	kinds := drv.bindKinds()
	if len(kinds) < 1 {
		t.Fatalf("DBX_FETCH_OUTPUT reached the driver 0 times, want at least one call: %v", kinds)
	}
	want := fmt.Sprintf("go_ora.Out(size=%d)", plDebugLogChars)
	if kinds[0] != want {
		t.Fatalf("thin driver bound DBX_FETCH_OUTPUT as %v, want [%s]", kinds, want)
	}
	if inputs := drv.inputKinds(); len(inputs) < 1 || inputs[0] != "int" {
		t.Fatalf("the chunk size argument was not bound as a plain int: %v", inputs)
	}
	if output["output"] != "hello from the debuggee" {
		t.Fatalf("thin driver log() returned %q, want the buffered line", output["output"])
	}
}

// The OCI (godror) driver sizes sql.Out itself, so its branch must not switch to
// go-ora's Out type.
func TestPLDebugLogBindsSqlOutForTheOCIDriver(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "hello from the debuggee", "")
	if _, err := newTerminatedPLDebugSession(db, true).log(); err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	kinds := drv.bindKinds()
	if len(kinds) < 1 || kinds[0] != "sql.Out" {
		t.Fatalf("OCI driver bound DBX_FETCH_OUTPUT as %v, want [sql.Out]", kinds)
	}
}

// An empty chunk means the buffer is drained, so the drain stops there instead of
// calling DBX_FETCH_OUTPUT forever. A chunk shorter than the requested size is
// already the end: the helper only stops early when the buffer ran out.
func TestPLDebugLogStopsAtTheEmptyChunk(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "first line\nsecond line", "")
	output, err := newTerminatedPLDebugSession(db, false).log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if output["output"] != "first line\nsecond line" {
		t.Fatalf("log() returned %q, want both buffered lines", output["output"])
	}
	// One short chunk is already the end of the buffer, so the drain must not ask
	// again; only a FULL chunk (a cut-off chunk boundary) justifies another call.
	if calls := drv.callCount(); calls != 1 {
		t.Fatalf("DBX_FETCH_OUTPUT was called %d times, want 1 (a short chunk ends the buffer)", calls)
	}
	if _, ok := output["message"]; ok {
		t.Fatalf("a complete drain must not report a message: %v", output["message"])
	}
}

// A full chunk means the helper stopped exactly at the requested size and may still
// hold more, so the drain continues -- and the second call is the cheap one,
// because the first one already lowered the session's own park.
func TestPLDebugLogContinuesAfterAFullChunk(t *testing.T) {
	full := strings.Repeat("x", plDebugLogChars)
	db, drv := openOracleDebugGetLineTestDB(t, full, "tail", "")
	output, err := newTerminatedPLDebugSession(db, false).log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if output["output"] != full+"\ntail" {
		t.Fatalf("log() returned %d characters, want the two chunks joined by a newline", len(output["output"].(string)))
	}
	if calls := drv.callCount(); calls != 2 {
		t.Fatalf("DBX_FETCH_OUTPUT was called %d times, want 2 (full chunk, then the short tail)", calls)
	}
}

// Reading the debug buffer is diagnostic: a failing DBX_FETCH_OUTPUT ends the drain
// and is reported next to what was read, but it must not fail the request or lose
// the chunk already read.
func TestPLDebugLogIgnoresFetchOutputFailure(t *testing.T) {
	full := strings.Repeat("y", plDebugLogChars)
	db, drv := openOracleDebugGetLineTestDB(t, full, "never reached")
	drv.failGetLineAt(2)
	session := newTerminatedPLDebugSession(db, false)
	output, err := session.log()
	if err != nil {
		t.Fatalf("a failing DBX_FETCH_OUTPUT must not fail log(): %v", err)
	}
	if output["output"] != full {
		t.Fatalf("log() returned %d characters, want the chunk read before the failure", len(output["output"].(string)))
	}
	if message, _ := output["message"].(string); !strings.Contains(message, "DBMS_OUTPUT could not be read") {
		t.Fatalf("the failed drain was not reported: %v", output["message"])
	}
	if session.logComplete {
		t.Fatal("a failed drain must not mark the buffer complete")
	}
}

// Once the buffer is drained the result is cached: a later request answers from
// memory and never touches the debuggee connection again, which is what keeps a
// finished session from paying the DBMS_DEBUG park on every log refresh.
func TestPLDebugLogCachesTheDrainedBuffer(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "cached", "")
	session := newTerminatedPLDebugSession(db, false)
	if _, err := session.log(); err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if _, err := session.log(); err != nil {
		t.Fatalf("second log() failed: %v", err)
	}
	if calls := drv.callCount(); calls != 1 {
		t.Fatalf("DBX_FETCH_OUTPUT was called %d times for two log() calls, want 1", calls)
	}
}

// The capture the target block runs for itself is the fast path: log() must publish
// it as-is, and it must publish nothing else when the capture already reached the
// end of the buffer.
func TestPLDebugLogPrefersTheCapturedOutput(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "from the connection", "")
	session := newTerminatedPLDebugSession(db, false)
	session.logText = "captured by the target block"
	session.logComplete = true
	output, err := session.log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if output["output"] != "captured by the target block" {
		t.Fatalf("log() returned %q, want the captured text", output["output"])
	}
	if calls := drv.callCount(); calls != 0 {
		t.Fatalf("the connection was touched %d times even though the block captured the output", calls)
	}
}

// A capture that filled a whole chunk may have left more behind, so the first
// log() request continues the read on the connection and joins the two parts.
func TestPLDebugLogContinuesTheCapturedChunk(t *testing.T) {
	full := strings.Repeat("z", plDebugLogChars)
	db, _ := openOracleDebugGetLineTestDB(t, "rest", "")
	session := newTerminatedPLDebugSession(db, false)
	session.logText = full
	session.logComplete = false
	output, err := session.log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if output["output"] != full+"\nrest" {
		t.Fatalf("log() did not join the captured chunk with the rest read from the connection")
	}
}

// The label rules have to work on the composed target label too: debugBefore
// publishes "PKG.SUB" before the first backtrace, so a session that ends up parked on
// a package line the target does not own (an initialization section longer than the
// step-in budget) must fall back to the BARE package name instead of keeping the
// label it was seeded with. Measured on 19c EE against DBX_G2_LONG, a package whose
// 45-statement initialization section exhausted the 40 step-in attempts.
func TestPLDebugCurrentProgramLabelFoldsTheSeededTargetLabel(t *testing.T) {
	session := &plDebugSession{
		targetProgram: "DBX_G2_LONG.RUN_LONG",
		targetPackage: "DBX_G2_LONG",
		targetLines:   plDebugLineRange{First: 2, Last: 5},
		lastProgram:   "DBX_G2_LONG.RUN_LONG",
		lastLine:      44,
	}
	frames := []plDebugFrame{{Line: 44, Source: "  DBMS_OUTPUT.PUT_LINE('long init 38');"}}
	if got := session.currentProgramLabel(frames); got != "DBX_G2_LONG" {
		t.Fatalf("label outside the target range = %q, want the bare package name DBX_G2_LONG", got)
	}
	// Inside the range it is still the target, and on the target's own declaration
	// line it is the subprogram the declaration names.
	session.lastLine = 4
	if got := session.currentProgramLabel(frames); got != "DBX_G2_LONG.RUN_LONG" {
		t.Fatalf("label inside the target range = %q, want DBX_G2_LONG.RUN_LONG", got)
	}
	session.lastLine = 2
	declaration := []plDebugFrame{{Line: 2, Source: "  PROCEDURE RUN_LONG IS"}}
	if got := session.currentProgramLabel(declaration); got != "DBX_G2_LONG.RUN_LONG" {
		t.Fatalf("label on the declaration line = %q, want DBX_G2_LONG.RUN_LONG", got)
	}
	// A sibling subprogram's declaration still names the sibling.
	sibling := []plDebugFrame{{Line: 12, Source: "  PROCEDURE RUN_SIBLING IS"}}
	session.lastLine = 12
	if got := session.currentProgramLabel(sibling); got != "DBX_G2_LONG.RUN_SIBLING" {
		t.Fatalf("label on a sibling's declaration line = %q, want DBX_G2_LONG.RUN_SIBLING", got)
	}
}

// A subprogram declared inside the target's declaration section owns its body lines
// even though they fall inside the target's own range. Measured on 19c EE against
// DBX_DEBUG.DBX_G2_NEST: a breakpoint inside the nested RUN_INNER stopped on line 7
// ("END RUN_INNER;") and the session used to name the enclosing RUN_OUTER.
func TestPLDebugNestedSubprogramRangesNameTheNestedRoutine(t *testing.T) {
	lines := []plDebugSourceLine{
		{Line: 1, Text: "PACKAGE BODY DBX_G2_NEST AS"},
		{Line: 2, Text: "  PROCEDURE RUN_OUTER IS"},
		{Line: 3, Text: "    V NUMBER := 0;"},
		{Line: 4, Text: "    PROCEDURE RUN_INNER IS"},
		{Line: 5, Text: "    BEGIN"},
		{Line: 6, Text: "      V := V + 1;"},
		{Line: 7, Text: "    END RUN_INNER;"},
		{Line: 8, Text: "  BEGIN"},
		{Line: 9, Text: "    RUN_INNER;"},
		{Line: 10, Text: "    DBMS_OUTPUT.PUT_LINE('outer v=' || V);"},
		{Line: 11, Text: "  END RUN_OUTER;"},
		{Line: 12, Text: "END DBX_G2_NEST;"},
	}
	target := plDebugLineRange{First: 2, Last: 11}
	nested := plDebugNestedSubprogramRanges(lines, target)
	if len(nested) != 1 || nested[0].Name != "RUN_INNER" || nested[0].First != 4 || nested[0].Last != 7 {
		t.Fatalf("nested ranges = %#v, want one RUN_INNER 4-7", nested)
	}
	session := &plDebugSession{
		targetProgram: "DBX_G2_NEST.RUN_OUTER",
		targetPackage: "DBX_G2_NEST",
		targetLines:   target,
		nestedLines:   nested,
		lastProgram:   "DBX_G2_NEST",
		lastLine:      6,
	}
	frames := []plDebugFrame{{Line: 6, Source: "      V := V + 1;"}}
	if got := session.currentProgramLabel(frames); got != "DBX_G2_NEST.RUN_INNER" {
		t.Fatalf("label inside the nested routine = %q, want DBX_G2_NEST.RUN_INNER", got)
	}
	// A line in the outer routine's own body still names the target.
	session.lastLine = 9
	if got := session.currentProgramLabel(frames); got != "DBX_G2_NEST.RUN_OUTER" {
		t.Fatalf("label in the outer routine's body = %q, want DBX_G2_NEST.RUN_OUTER", got)
	}
	if got := plDebugNestedLabel(nil, 6); got != "" {
		t.Fatalf("an empty nested list named %q", got)
	}
}

// A caller-supplied anonymous block gets the same trailing capture as a
// PROCEDURE/FUNCTION target, inserted in front of its own final END; so that every
// source line above it keeps its number (breakpoints are armed by line).
func TestPLDebugAnonymousWithCapture(t *testing.T) {
	source := "BEGIN\n  DBMS_OUTPUT.PUT_LINE('a');\nEND;"
	block, ok := plDebugAnonymousWithCapture(source, "CHZ")
	if !ok {
		t.Fatalf("a block ending in END; has to be capturable: %q", source)
	}
	want := "BEGIN\n  DBMS_OUTPUT.PUT_LINE('a');\n  :" + plDebugCaptureBind +
		" := \"CHZ\".\"DBX_PL_DEBUG_PACKAGE\".DBX_FETCH_OUTPUT(32000);\nEND;"
	if block != want {
		t.Fatalf("captured block = %q, want %q", block, want)
	}
	// The user's own lines must be untouched, so a line-numbered breakpoint still
	// points at the same statement.
	for line, text := range map[int]string{1: "BEGIN", 2: "  DBMS_OUTPUT.PUT_LINE('a');"} {
		if got := strings.Split(block, "\n")[line-1]; got != text {
			t.Fatalf("line %d became %q, want %q", line, got, text)
		}
	}

	declare := "DECLARE\n  n NUMBER := 1;\nBEGIN\n  DBMS_OUTPUT.PUT_LINE(n);\nEND;"
	if _, ok := plDebugAnonymousWithCapture(declare, "CHZ"); !ok {
		t.Fatalf("a DECLARE block has to be capturable: %q", declare)
	}

	for _, bad := range []string{
		"BEGIN NULL; END LOOP;",
		"BEGIN NULL; END; /* trailing comment */",
		"",
		"END;",
	} {
		if got, ok := plDebugAnonymousWithCapture(bad, "CHZ"); ok || got != bad {
			t.Fatalf("source %q must be submitted verbatim (ok=%v, got=%q)", bad, ok, got)
		}
	}
}

// log() must not read the debuggee while the target statement still holds the
// connection: terminated is reported by the interpreter a little before the
// statement hands its connection back, and the block's own capture runs inside that
// statement. A closed release channel means the statement is done, and the captured
// text has to be published as-is.
func TestPLDebugLogWaitsForTheTargetStatement(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "from the connection", "")
	session := newTerminatedPLDebugSession(db, false)
	released := make(chan struct{})
	close(released)
	session.targetDone = released
	session.logText = "captured"
	session.logComplete = true
	output, err := session.log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if output["output"] != "captured" {
		t.Fatalf("log() returned %q, want the captured text", output["output"])
	}
	if calls := drv.callCount(); calls != 0 {
		t.Fatalf("the connection was touched %d times after the capture completed", calls)
	}
}

// A session whose release channel is never closed must still answer: the wait is
// bounded, and log() falls through to the drain instead of blocking the RPC.
func TestPLDebugLogSurvivesAnUnreleasedTargetChannel(t *testing.T) {
	db, _ := openOracleDebugGetLineTestDB(t, "drained anyway", "")
	session := newTerminatedPLDebugSession(db, false)
	session.targetDone = make(chan struct{})
	session.logWaitTimeout = 20 * time.Millisecond
	done := make(chan map[string]interface{}, 1)
	go func() {
		output, err := session.log()
		if err != nil {
			done <- map[string]interface{}{"__error__": err.Error()}
			return
		}
		done <- output
	}()
	select {
	case output := <-done:
		if output["output"] != "drained anyway" {
			t.Fatalf("log() returned %q, want the drained text", output["output"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("log() blocked on the target release channel instead of using its bound")
	}
}
func TestPLDebugLogWithoutTerminationSkipsTheConnection(t *testing.T) {
	db, drv := openOracleDebugGetLineTestDB(t, "not readable yet")
	session := newTerminatedPLDebugSession(db, false)
	session.terminated = false
	output, err := session.log()
	if err != nil {
		t.Fatalf("log() failed: %v", err)
	}
	if output["output"] != "" {
		t.Fatalf("log() returned %q for a running session, want empty output", output["output"])
	}
	if calls := drv.callCount(); calls != 0 {
		t.Fatalf("log() called DBX_GET_LINE %d times for a running session, want 0", calls)
	}
}

// -- helper-package OUT bindings ---------------------------------------------
//
// go-ora only recognises OUT binds on its Exec path (Stmt._exec, command.go:1551)
// and reads a text register back only when the bind carries a size; its query path
// (Stmt.Query_ -> NewParam(..., 0, Input)) binds every argument as an input, so a
// sql.Out that reached it failed in setDataType ("call register type before use
// user defined type (UDT)") and no register was ever filled. The tests below drive
// every helper-package call site through a fake driver that records the binding
// type of each argument. They fail if a call site goes back to QueryRow (which
// reaches the driver as a Prepare, never as a recorded Exec) and they assert the
// size go-ora needs under the thin driver while the OCI (godror) driver keeps
// database/sql's sql.Out.

// oracleProgramInfoProbe labels the DBMS_DEBUG.PROGRAM_INFO capability probe. It
// is not a helper-package call, but it reports through one OUT register too.
const oracleProgramInfoProbe = "DBMS_DEBUG.PROGRAM_INFO probe"

// oracleDebugHelperRoutines are matched against the statement text. Where one
// routine name is a prefix of another the longer one comes first:
// DBX_SET_BREAKPOINT_ANONYMOUS / _ENTRY / _EX before DBX_SET_BREAKPOINT, and
// DBX_GET_VALUES before DBX_GET_VALUE.
var oracleDebugHelperRoutines = []string{
	procSetBreakpointAnonymous,
	procSetBreakpointEntry,
	procSetBreakpointEx,
	procSetBreakpoint,
	procGetValues,
	procGetValue,
	procCntNextBreakpoint,
	procCntNextLine,
	procCntStepIn,
	procCntStepOut,
	procCntAbort,
	procCntExit,
	procCntException,
	procEnableBreakpoint,
	procDisableBreakpoint,
	procSetValue,
	procPrintBacktrace,
	procShowBreakpoints,
	procGetRuntimeInfo,
	procSynchronize,
	procGetLine,
}

// oracleDebugRoutine names the helper-package routine a statement calls, or "" for
// any other statement (the debuggee's own blocks, DBMS_DEBUG.DEBUG_OFF, ...).
func oracleDebugRoutine(query string) string {
	if strings.Contains(query, "dbms_debug.program_info") {
		return oracleProgramInfoProbe
	}
	for _, routine := range oracleDebugHelperRoutines {
		if strings.Contains(query, routine) {
			return routine
		}
	}
	return ""
}

// oracleDebugCall is one recorded Exec: the routine it named, the statement text (the
// ALTER ... COMPILE DEBUG of the debug-information repair is not a helper-package routine,
// so only the text identifies it) and the binding kind of each argument, in order.
type oracleDebugCall struct {
	routine string
	query   string
	binds   []string
	// inValues records the text of every argument that is not an OUT bind, in
	// argument order; an OUT register records "". It is what lets a test assert the
	// *values* a helper call forwards (the "PKG.SUB" split of a package-subprogram
	// breakpoint), which the binding kinds alone cannot show.
	inValues []string
}

// oracleDebugCallDriver is a fake Oracle driver that answers helper-package calls
// the way go-ora's Exec path (Stmt._exec) does: the OUT bind is unpacked, its type
// is recorded and the scripted register value is written into the destination. Any
// other statement succeeds too (the session issues DEBUG_OFF / DETACH_SESSION on
// close), but only helper-package calls are matched by routine.
type oracleDebugCallDriver struct {
	mu    sync.Mutex
	calls []oracleDebugCall
	outs  map[string]map[int]any
	errs  map[string]error
	// blocked parks an Exec of a routine until its gate is closed: it stands in
	// for a DBMS_DEBUG call the server never answers, which is exactly what the
	// real Oracle 19c EE run produced.
	blocked map[string]chan struct{}
	// queries records every SELECT the session issued, so a test can assert that a
	// probe was (or was not) sent at all.
	queries []string
	// plsqlDebug is what the PLSQL_DEBUG probe answers. "" models a server that has no
	// ALL_PLSQL_OBJECT_SETTINGS row for the object (found == false).
	plsqlDebug string
	// closed counts the physical connections the pool really closed. It is what
	// separates "the teardown closed the connection" from "the teardown abandoned it":
	// database/sql's DB.Close only closes free connections, so a session whose
	// statement is still in flight leaves the server session behind.
	closed int
}

var _ driver.Driver = (*oracleDebugCallDriver)(nil)

// openOracleDebugCallTestDB registers one fake driver per test and returns the
// pool plus a way to script the registers an Exec writes back.
func openOracleDebugCallTestDB(t *testing.T) (*sql.DB, *oracleDebugCallDriver) {
	t.Helper()
	drv := &oracleDebugCallDriver{
		outs:    map[string]map[int]any{},
		errs:    map[string]error{},
		blocked: map[string]chan struct{}{},
	}
	name := "oracle-debug-call-" + strings.ReplaceAll(t.Name(), "/", "-")
	sql.Register(name, drv)
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db, drv
}

// blockRoutine makes every Exec of a routine park until the returned function is
// called. The block deliberately ignores the caller's context: go-ora cannot be
// relied on to interrupt a server-side PROBE call, so the fake driver must not
// pretend that it can either.
func (d *oracleDebugCallDriver) blockRoutine(routine string) (release func()) {
	gate := make(chan struct{})
	d.mu.Lock()
	d.blocked[routine] = gate
	d.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(gate) }) }
}

// scriptOut makes the next call of a routine write value into its index-th OUT
// register, the way the server would.
func (d *oracleDebugCallDriver) scriptOut(routine string, index int, value any) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.outs[routine] == nil {
		d.outs[routine] = map[int]any{}
	}
	d.outs[routine][index] = value
}

// scriptError makes the next call of a routine fail at the driver level.
func (d *oracleDebugCallDriver) scriptError(routine string, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.errs[routine] = err
}

func (d *oracleDebugCallDriver) recordedCalls() []oracleDebugCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]oracleDebugCall(nil), d.calls...)
}

// scriptPlsqlDebug makes the PLSQL_DEBUG probe answer one compile setting: "TRUE",
// "FALSE", or "" for "the dictionary has no row for this object".
func (d *oracleDebugCallDriver) scriptPlsqlDebug(setting string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.plsqlDebug = setting
}

// recordedQueries returns every SELECT the session issued, in order.
func (d *oracleDebugCallDriver) recordedQueries() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.queries...)
}

// recordedStatementContaining returns the first recorded Exec whose statement text
// contains needle, and whether there was one.
func (d *oracleDebugCallDriver) recordedStatementContaining(needle string) (oracleDebugCall, bool) {
	for _, call := range d.recordedCalls() {
		if strings.Contains(call.query, needle) {
			return call, true
		}
	}
	return oracleDebugCall{}, false
}

// recordedRoutines returns the routine of every recorded Exec, in order.
func (d *oracleDebugCallDriver) recordedRoutines() []string {
	routines := []string{}
	for _, call := range d.recordedCalls() {
		routines = append(routines, call.routine)
	}
	return routines
}

// closedConnections reports how many physical connections the pool closed.
func (d *oracleDebugCallDriver) closedConnections() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

// callFor returns the first recorded call that reached the given routine.
func (d *oracleDebugCallDriver) callFor(t *testing.T, routine string) oracleDebugCall {
	t.Helper()
	for _, call := range d.recordedCalls() {
		if call.routine == routine {
			return call
		}
	}
	t.Fatalf("no Exec reached %q; recorded routines: %q", routine, d.recordedRoutines())
	return oracleDebugCall{}
}

func (d *oracleDebugCallDriver) Open(string) (driver.Conn, error) {
	return &oracleDebugCallConn{driver: d}, nil
}

type oracleDebugCallConn struct {
	driver *oracleDebugCallDriver
}

var (
	_ driver.Conn              = (*oracleDebugCallConn)(nil)
	_ driver.ExecerContext     = (*oracleDebugCallConn)(nil)
	_ driver.QueryerContext    = (*oracleDebugCallConn)(nil)
	_ driver.NamedValueChecker = (*oracleDebugCallConn)(nil)
)

func (c *oracleDebugCallConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("use the context APIs")
}

func (c *oracleDebugCallConn) Close() error {
	c.driver.mu.Lock()
	c.driver.closed++
	c.driver.mu.Unlock()
	return nil
}

func (c *oracleDebugCallConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not supported")
}

// CheckNamedValue mirrors go-ora's Connection.CheckNamedValue: OUT bind values
// pass through untouched so the driver can unpack them while executing.
func (c *oracleDebugCallConn) CheckNamedValue(*driver.NamedValue) error { return nil }

// QueryContext answers the SELECTs the session issues: plDebugOverloadCount's
// SUBPROGRAM_ID probe with a single candidate (so no ambiguity warning fires) and the
// PLSQL_DEBUG probe of plDebugEnsureDebugInfo with whatever the test scripted.
func (c *oracleDebugCallConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	state := c.driver
	state.mu.Lock()
	state.queries = append(state.queries, query)
	setting := state.plsqlDebug
	state.mu.Unlock()
	if strings.Contains(query, "SUBPROGRAM_ID") {
		return &oracleDebugRows{columns: []string{"COUNT"}, values: [][]driver.Value{{int64(1)}}}, nil
	}
	if strings.Contains(query, "ALL_PLSQL_OBJECT_SETTINGS") {
		rows := &oracleDebugRows{columns: []string{"PLSQL_DEBUG"}}
		if setting != "" {
			rows.values = [][]driver.Value{{setting}}
		}
		return rows, nil
	}
	return nil, fmt.Errorf("unexpected query: %s", query)
}

// oracleDebugRows is the single-row result QueryContext hands back.
type oracleDebugRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

var _ driver.Rows = (*oracleDebugRows)(nil)

func (r *oracleDebugRows) Columns() []string { return r.columns }
func (r *oracleDebugRows) Close() error      { return nil }

func (r *oracleDebugRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func (c *oracleDebugCallConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	state := c.driver
	state.mu.Lock()
	routine := oracleDebugRoutine(query)
	call := oracleDebugCall{routine: routine, query: query}
	for index := range args {
		call.binds = append(call.binds, describeOutBind(args, index))
		call.inValues = append(call.inValues, describeInValue(args, index))
	}
	state.calls = append(state.calls, call)
	// The debug-information repair: a real server compiles the unit with debug
	// information, so the re-probe that follows the ALTER must answer TRUE.
	if strings.Contains(strings.ToUpper(query), "COMPILE DEBUG") {
		state.plsqlDebug = "TRUE"
	}
	if err := state.errs[routine]; err != nil {
		state.mu.Unlock()
		return nil, err
	}
	gate := state.blocked[routine]
	state.mu.Unlock()
	// The gate is waited on without the driver lock so the test can still read
	// the recorded calls while the Exec is parked -- and it ignores the context,
	// the way an uninterruptible server call does.
	if gate != nil {
		<-gate
	}
	state.mu.Lock()
	for index, value := range state.outs[routine] {
		setOutDest(args, index, value)
	}
	state.mu.Unlock()
	return driver.RowsAffected(0), nil
}

// newPLDebugCallSession builds the minimal session the debugger-side call sites
// need: the fake pool stands in for both the debugger and the debuggee connection.
func newPLDebugCallSession(db *sql.DB, oci bool) *plDebugSession {
	return &plDebugSession{
		debugID:            "1",
		owner:              "CHZ",
		debuggee:           db,
		debugger:           db,
		oci:                oci,
		lastActivityMillis: nowMillis(),
	}
}

// ociPLDebugBindKinds maps a thin-driver binding expectation to the OCI one:
// go-ora's sized Out becomes the sql.Out godror sizes itself, every other
// argument keeps its kind.
func ociPLDebugBindKinds(thin []string) []string {
	oci := make([]string, len(thin))
	for index, kind := range thin {
		if strings.HasPrefix(kind, "go_ora.Out(") {
			oci[index] = "sql.Out"
			continue
		}
		oci[index] = kind
	}
	return oci
}

func assertPLDebugBinds(t *testing.T, call oracleDebugCall, want []string) {
	t.Helper()
	if got := strings.Join(call.binds, ","); got != strings.Join(want, ",") {
		t.Fatalf("%s was bound as [%s], want [%s]", call.routine, got, strings.Join(want, ","))
	}
}

// Every helper-package call site has to reach the driver through Exec with the OUT
// binding its driver understands, and every text register has to be sized for
// go-ora. The thin expectation is written out per call; the OCI one is derived
// from it so a go_ora.Out leaking into the OCI path fails the comparison.
func TestPLDebugHelperCallsBindExecOutForEachDriver(t *testing.T) {
	const runInfoFields = " run_info.breakpoint = , run_info.stackdepth = 2, run_info.reason = 9, run_info.programname = PRO1, run_info.programowner = CHZ"
	const breakpointNumber = 7
	cases := []struct {
		name    string
		routine string
		thin    []string
		script  func(d *oracleDebugCallDriver)
		run     func(t *testing.T, p *plDebugSession) error
	}{
		{
			name:    "synchronizeDebuggee",
			routine: procSynchronize,
			// The wrapper's own order: (result OUT BINARY_INTEGER, message OUT VARCHAR2).
			thin: []string{"go_ora.Out(size=0)", "go_ora.Out(size=4000)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procSynchronize, 0, plDebugErrSuccess)
				d.scriptOut(procSynchronize, 1, " run_info.stackdepth = 2")
			},
			run: func(_ *testing.T, p *plDebugSession) error {
				p.synchronizeDebuggee()
				return nil
			},
		},
		{
			name:    "armAnonymousBreakpoint",
			routine: procSetBreakpointAnonymous,
			thin:    []string{"int", "go_ora.Out(size=0)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procSetBreakpointAnonymous, 1, breakpointNumber)
				d.scriptOut(procSetBreakpointAnonymous, 2, plDebugErrSuccess)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				number, result, err := p.armAnonymousBreakpoint(12)
				if number != breakpointNumber || result != plDebugErrSuccess {
					t.Fatalf("armAnonymousBreakpoint = %d/%d, want %d/0", number, result, breakpointNumber)
				}
				return err
			},
		},
		{
			name:    "setBreakpoint",
			routine: procSetBreakpoint,
			thin:    []string{"string", "string", "int", "go_ora.Out(size=0)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procSetBreakpoint, 3, breakpointNumber)
				d.scriptOut(procSetBreakpoint, 4, plDebugErrSuccess)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				created, err := p.setBreakpoints([]plDebugBreakpoint{{Owner: "CHZ", Name: "PROC", Line: 12}})
				if err != nil {
					return err
				}
				if len(created) != 1 || created[0].BreakpointNbr != breakpointNumber {
					t.Fatalf("setBreakpoints created %#v, want one breakpoint %d", created, breakpointNumber)
				}
				if created[0].Warning != "" {
					t.Fatalf("setBreakpoints warned %q for a single-candidate routine", created[0].Warning)
				}
				return nil
			},
		},
		{
			name:    "setBreakpointEx",
			routine: procSetBreakpointEx,
			thin:    []string{"string", "string", "int", "string", "int", "go_ora.Out(size=0)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procSetBreakpointEx, 5, breakpointNumber)
				d.scriptOut(procSetBreakpointEx, 6, plDebugErrSuccess)
			},
			run: func(_ *testing.T, p *plDebugSession) error {
				// Only a server that declares the attribute is asked for it.
				p.programInfoFields.Signature = true
				signature := "S"
				_, err := p.setBreakpoints([]plDebugBreakpoint{{Owner: "CHZ", Name: "PROC", Line: 12, Signature: &signature}})
				return err
			},
		},
		{
			name:    "setBreakpointEntry",
			routine: procSetBreakpointEntry,
			thin:    []string{"string", "string", "string", "int", "go_ora.Out(size=0)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procSetBreakpointEntry, 4, breakpointNumber)
				d.scriptOut(procSetBreakpointEntry, 5, plDebugErrSuccess)
			},
			run: func(_ *testing.T, p *plDebugSession) error {
				// The entry arm is only reachable when the server declares
				// program_info.entrypointname (see plDebugProgramInfoFields).
				p.programInfoFields.Entrypoint = true
				_, err := p.setBreakpoints([]plDebugBreakpoint{{Owner: "CHZ", Name: "PKG.PROC", Line: 12}})
				return err
			},
		},
		{
			name:    "continueWithStepOver",
			routine: procCntNextLine,
			thin:    []string{"go_ora.Out(size=0)", "go_ora.Out(size=4000)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procCntNextLine, 0, plDebugErrSuccess)
				d.scriptOut(procCntNextLine, 1, runInfoFields)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.stepOver()
				if err != nil {
					return err
				}
				if depth, ok := response["stackDepth"].(int); !ok || depth != 2 {
					t.Fatalf("stepOver did not apply the run_info register: %#v", response["stackDepth"])
				}
				return nil
			},
		},
		{
			name:    "continueWithStepIn",
			routine: procCntStepIn,
			thin:    []string{"go_ora.Out(size=0)", "go_ora.Out(size=4000)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procCntStepIn, 0, plDebugErrSuccess)
				d.scriptOut(procCntStepIn, 1, runInfoFields)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.stepIn()
				if err != nil {
					return err
				}
				if depth, ok := response["stackDepth"].(int); !ok || depth != 2 {
					t.Fatalf("stepIn did not apply the run_info register: %#v", response["stackDepth"])
				}
				return nil
			},
		},
		{
			name:    "resumeIgnoreBreakpoints",
			routine: procCntExit,
			thin:    []string{"go_ora.Out(size=4000)"},
			script:  func(d *oracleDebugCallDriver) { d.scriptOut(procCntExit, 0, " reason = 15") },
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.resumeIgnoreBreakpoints()
				if err != nil {
					return err
				}
				if terminated, ok := response["terminated"].(bool); !ok || !terminated {
					t.Fatalf("resumeIgnoreBreakpoints did not terminate the session: %#v", response["terminated"])
				}
				return nil
			},
		},
		{
			name:    "variablesGetValues",
			routine: procGetValues,
			thin:    []string{"go_ora.Out(size=4000)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procGetValues, 0, "*X*NUMBER*1\n")
				d.scriptOut(procGetValues, 1, plDebugErrSuccess)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.variables(0)
				if err != nil {
					return err
				}
				if response["scalarValues"] != "*X*NUMBER*1\n" {
					t.Fatalf("variables did not read the scalar_values register: %#v", response["scalarValues"])
				}
				return nil
			},
		},
		{
			name:    "frameGetValue",
			routine: procGetValue,
			thin:    []string{"string", "int", "go_ora.Out(size=4000)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procGetValue, 2, "1")
				d.scriptOut(procGetValue, 3, plDebugErrSuccess)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				listing, ok := p.frameScalarValues("*X*NUMBER*1\n", 1)
				if !ok || listing != "*X*NUMBER*1\n" {
					t.Fatalf("frameScalarValues = %q/%v, want the rebuilt listing", listing, ok)
				}
				return nil
			},
		},
		{
			name:    "setValue",
			routine: procSetValue,
			// The message register is a sql.NullString, which go-ora also treats as
			// NCHAR and therefore also needs a size for.
			thin:   []string{"int", "string", "go_ora.Out(size=0)", "go_ora.Out(size=4000)"},
			script: func(d *oracleDebugCallDriver) { d.scriptOut(procSetValue, 2, plDebugErrSuccess) },
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.setValue("X", 0, 0, "5")
				if err != nil {
					return err
				}
				if ok, _ := response["ok"].(bool); !ok {
					t.Fatalf("setValue reported %#v", response["ok"])
				}
				return nil
			},
		},
		{
			name:    "setBreakpointEnabled",
			routine: procEnableBreakpoint,
			thin:    []string{"int", "go_ora.Out(size=0)"},
			script:  func(d *oracleDebugCallDriver) { d.scriptOut(procEnableBreakpoint, 1, plDebugErrSuccess) },
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.setBreakpointEnabled(3, true)
				if err != nil {
					return err
				}
				if ok, _ := response["ok"].(bool); !ok {
					t.Fatalf("setBreakpointEnabled reported %#v", response)
				}
				return nil
			},
		},
		{
			name:    "stackPrintBacktrace",
			routine: procPrintBacktrace,
			thin:    []string{"go_ora.Out(size=4000)", "go_ora.Out(size=0)"},
			script: func(d *oracleDebugCallDriver) {
				d.scriptOut(procPrintBacktrace, 0, "[Line 8] PROC")
				d.scriptOut(procPrintBacktrace, 1, 0)
			},
			run: func(t *testing.T, p *plDebugSession) error {
				response, err := p.stack()
				if err != nil {
					return err
				}
				if response["backtrace"] != "[Line 8] PROC" {
					t.Fatalf("stack did not read the listing register: %#v", response["backtrace"])
				}
				return nil
			},
		},
		{
			name:    "closeAbortsTheDebuggee",
			routine: procCntAbort,
			thin:    []string{"go_ora.Out(size=0)", "go_ora.Out(size=4000)"},
			run: func(_ *testing.T, p *plDebugSession) error {
				return p.Close()
			},
		},
	}

	for _, testCase := range cases {
		testCase := testCase
		for _, oci := range []bool{false, true} {
			oci := oci
			driverName := "thin"
			want := testCase.thin
			if oci {
				driverName = "oci"
				want = ociPLDebugBindKinds(testCase.thin)
			}
			t.Run(testCase.name+"/"+driverName, func(t *testing.T) {
				db, drv := openOracleDebugCallTestDB(t)
				if testCase.script != nil {
					testCase.script(drv)
				}
				if err := testCase.run(t, newPLDebugCallSession(db, oci)); err != nil {
					t.Fatalf("%s failed: %v", testCase.name, err)
				}
				assertPLDebugBinds(t, drv.callFor(t, testCase.routine), want)
			})
		}
	}
}

// The capability probe assigns its answer to one OUT register. Bound as a query
// input it raised the UDT error and the probe always answered "no".
func TestPLDebugProbeProgramInfoFieldBindsExecOut(t *testing.T) {
	cases := []struct {
		name      string
		oci       bool
		supported any
		want      bool
	}{
		{"thin/supported", false, 1, true},
		{"thin/unsupported", false, 0, false},
		{"oci/supported", true, 1, true},
		{"oci/unsupported", true, 0, false},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			db, drv := openOracleDebugCallTestDB(t)
			drv.scriptOut(oracleProgramInfoProbe, 0, testCase.supported)
			if got := plDebugProbeProgramInfoField(db, testCase.oci, "signature", "''DBX''"); got != testCase.want {
				t.Fatalf("plDebugProbeProgramInfoField = %v, want %v", got, testCase.want)
			}
			want := []string{"go_ora.Out(size=0)"}
			if testCase.oci {
				want = ociPLDebugBindKinds(want)
			}
			assertPLDebugBinds(t, drv.callFor(t, oracleProgramInfoProbe), want)
		})
	}
}

// The debuggee call binds a function's return value and the target's OUT
// parameters; a bare sql.Out reached go-ora as an unsized input.
func TestPLDebugRunTargetBindsDriverOut(t *testing.T) {
	cases := []struct {
		name    string
		request map[string]interface{}
		thin    []string
	}{
		{
			name:    "functionResult",
			request: map[string]interface{}{"objectType": "FUNCTION", "objectName": "F_ADD"},
			thin:    []string{"go_ora.Out(size=4000)", "go_ora.Out(size=32000)"},
		},
		{
			name: "outParameter",
			request: map[string]interface{}{
				"objectType": "PROCEDURE",
				"objectName": "PROC",
				"params":     []interface{}{map[string]interface{}{"name": "B", "mode": "OUT"}},
			},
			thin: []string{"go_ora.Out(size=4000)", "go_ora.Out(size=32000)"},
		},
		{
			// A procedure with no OUT parameter still carries the capture bind of the
			// trailing DBMS_OUTPUT statement; a block with the statement and no
			// binding would fail on the server with ORA-01008 (not all variables bound).
			name:    "plainProcedure",
			request: map[string]interface{}{"objectType": "PROCEDURE", "objectName": "PROC"},
			thin:    []string{"go_ora.Out(size=32000)"},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		for _, oci := range []bool{false, true} {
			oci := oci
			driverName := "thin"
			want := testCase.thin
			if oci {
				driverName = "oci"
				want = ociPLDebugBindKinds(testCase.thin)
			}
			t.Run(testCase.name+"/"+driverName, func(t *testing.T) {
				db, drv := openOracleDebugCallTestDB(t)
				session := newPLDebugCallSession(db, oci)
				session.runTarget(testCase.request)
				if session.targetErr != "" {
					t.Fatalf("runTarget reported %q", session.targetErr)
				}
				// The target block is the first statement that names no helper routine.
				assertPLDebugBinds(t, drv.callFor(t, ""), want)
			})
		}
	}
}

// plDebugHelperSQL renders one placeholder per argument, in order, so the routine
// sees its arguments where PL/SQL declares them.
func TestPLDebugHelperSQLRendersOnePlaceholderPerArgument(t *testing.T) {
	for _, testCase := range []struct {
		routine string
		count   int
		want    string
	}{
		{procSynchronize, 2, `BEGIN "CHZ"."DBX_PL_DEBUG_PACKAGE"."DBX_SYNCHRONIZE"(:1, :2); END;`},
		{procCntExit, 1, `BEGIN "CHZ"."DBX_PL_DEBUG_PACKAGE"."DBX_CNT_EXIT"(:1); END;`},
		{procSetBreakpointEx, 7, `BEGIN "CHZ"."DBX_PL_DEBUG_PACKAGE"."DBX_SET_BREAKPOINT_EX"(:1, :2, :3, :4, :5, :6, :7); END;`},
	} {
		if got := plDebugHelperSQL("CHZ", testCase.routine, testCase.count); got != testCase.want {
			t.Fatalf("plDebugHelperSQL(%s, %d) = %q, want %q", testCase.routine, testCase.count, got, testCase.want)
		}
	}
}

// Only the text registers need a client-side buffer size under go-ora; the NUMBER
// registers are sized from their type. The OCI driver always gets sql.Out.
func TestPLDebugOutArgsSizeOnlyTextRegistersForTheThinDriver(t *testing.T) {
	var text string
	var message sql.NullString
	var number int
	thin := plDebugOutArgs(false, &text, &message, &number)
	gotThin := make([]string, 0, len(thin))
	for _, arg := range thin {
		gotThin = append(gotThin, describeOutBind([]driver.NamedValue{{Value: arg}}, 0))
	}
	wantThin := []string{"go_ora.Out(size=4000)", "go_ora.Out(size=4000)", "go_ora.Out(size=0)"}
	if got := strings.Join(gotThin, ","); got != strings.Join(wantThin, ",") {
		t.Fatalf("thin OUT args = [%s], want [%s]", got, strings.Join(wantThin, ","))
	}
	wantOCI := []string{"sql.Out", "sql.Out", "sql.Out"}
	gotOCI := make([]string, 0, len(thin))
	for _, arg := range plDebugOutArgs(true, &text, &message, &number) {
		gotOCI = append(gotOCI, describeOutBind([]driver.NamedValue{{Value: arg}}, 0))
	}
	if got := strings.Join(gotOCI, ","); got != strings.Join(wantOCI, ",") {
		t.Fatalf("OCI OUT args = [%s], want [%s]", got, strings.Join(wantOCI, ","))
	}
}

// DEBUG_OFF must not run on the target goroutine. The debuggee pool holds a single
// connection (SetMaxOpenConns(1)) and DEBUG_OFF blocks once the program has left the
// interpreter -- measured on Oracle 19c EE -- so issuing it there made the
// DBMS_OUTPUT drain in log() wait for that connection, give up after 5s and answer
// with an empty output even though the target had already printed. Close() turns
// debugging off after DETACH_SESSION, and that order lets the drain read first.
func TestPLDebugRunTargetLeavesDebugOffToClose(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	session := newPLDebugCallSession(db, false)
	session.runTarget(map[string]interface{}{"objectType": "PROCEDURE", "objectName": "PROC"})
	if session.targetErr != "" {
		t.Fatalf("runTarget reported %q", session.targetErr)
	}
	statements := 0
	for _, call := range drv.recordedCalls() {
		if call.routine == "" {
			statements++
		}
	}
	if statements != 1 {
		t.Fatalf("runTarget issued %d non-helper statements, want only the target block"+
			" (DEBUG_OFF belongs to Close, after DETACH_SESSION)", statements)
	}
	if !session.terminated {
		t.Fatal("runTarget did not mark the finished debuggee as terminated")
	}
}

// Switching QueryRow to Exec must not swallow a driver failure where the call site
// used to return one.
func TestPLDebugHelperCallPropagatesExecFailure(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptError(procCntNextLine, errors.New("ORA-06550: simulated DBX_CNT_NEXT_LINE failure"))
	response, err := newPLDebugCallSession(db, false).continueWith(procCntNextLine)
	if err == nil {
		t.Fatal("continueWith returned no error for a failing driver")
	}
	if response != nil {
		t.Fatalf("continueWith returned %#v next to its error", response)
	}
	if !strings.Contains(err.Error(), "simulated DBX_CNT_NEXT_LINE failure") {
		t.Fatalf("continueWith error = %v, want the driver's message", err)
	}
}

// synchronizeDebuggee is fatal, and deliberately single-shot. On Oracle 19c EE the
// handshake is what makes the debuggee signal its start event; without it
// CONTINUE(break_any_call) answers NULL with an empty run_info and nothing can ever be
// stopped (measured). A failed handshake therefore has to fail the start instead of
// being logged, and it must not be retried: a second SYNCHRONIZE on a debugger whose
// event has already been consumed did not return at all (measured, >25s).
func TestPLDebugSynchronizeFailureIsFatalAndNeverRetried(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptError(procSynchronize, errors.New("ORA-06550: simulated DBX_SYNCHRONIZE failure"))
	session := newPLDebugCallSession(db, false)
	before := session.lastActivityMillis

	err := session.synchronizeDebuggee()
	if err == nil {
		t.Fatal("a failing DBX_SYNCHRONIZE was tolerated; every later CONTINUE would be a no-op")
	}
	if !strings.Contains(err.Error(), "simulated DBX_SYNCHRONIZE failure") {
		t.Fatalf("the error does not carry the server's message: %v", err)
	}
	if got := countRoutine(drv.recordedRoutines(), procSynchronize); got != 1 {
		t.Fatalf("DBX_SYNCHRONIZE was attempted %d times; a retry wedges on a real server", got)
	}
	if session.lastActivityMillis != before {
		t.Fatal("a failing DBX_SYNCHRONIZE must not count as session activity")
	}

	// A non-zero result is just as fatal, and names the code as well as numbering it.
	t.Run("non-zero result", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procSynchronize, 0, plDebugErrTimeout)
		drv.scriptOut(procSynchronize, 1, " run_info.stackdepth = ")
		err := newPLDebugCallSession(db, false).synchronizeDebuggee()
		if err == nil {
			t.Fatal("a non-zero DBX_SYNCHRONIZE result was tolerated")
		}
		if !strings.Contains(err.Error(), "error_timeout (31)") {
			t.Fatalf("the error does not name and number the result: %v", err)
		}
	})
}

// plDebugPackageVersionCurrent must read the *body's* header line and nothing else.
//
// The query it used to run joined ALL_OBJECTS against ALL_SOURCE with no TYPE filter, so
// the PACKAGE head's lines survived the RIGHT JOIN as NULL-side rows and, because
// ORDER BY S.LINE ties at line 1, the very first row handed back was the head's
// "PACKAGE DBX_PL_DEBUG_PACKAGE AS" -- which carries neither note. Measured on the real
// 19c EE target: the head's line 1 came first out of 77 rows, so the check called a
// current body stale and every pl_debug_start re-issued CREATE OR REPLACE PACKAGE BODY.
// That rebuild is what then blocked for the full 30s DDL bound whenever another session
// still pinned the package, and it turned a concurrent session into
// "create DBX_PL_DEBUG_PACKAGE body did not return within 30s".
func TestPLDebugPackageVersionQueryReadsOnlyTheBody(t *testing.T) {
	if !strings.Contains(plDebugPackageVersionQuery, "S.TYPE = 'PACKAGE BODY'") {
		t.Fatalf("the version query no longer filters on the body, so the package head's "+
			"line 1 can be read as the body's header again:\n%s", plDebugPackageVersionQuery)
	}
	if !strings.Contains(plDebugPackageVersionQuery, "RIGHT JOIN ALL_SOURCE S") {
		t.Fatal("the ODC-shaped join was replaced; the TYPE filter is what makes it safe")
	}
	// The head's own first line is the trap, and it must not be a candidate row.
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_DEBUG")
	headFirstLine := firstLine(head)
	if strings.Contains(headFirstLine, plDebugVersionNote) || strings.Contains(headFirstLine, plDebugBodyFixNote) {
		t.Fatalf("the package head's first line now carries a version note, so the "+
			"filter no longer distinguishes it from the body: %q", headFirstLine)
	}
	header := firstLine(plDebugPackageBody("DBX_DEBUG", plDebugProgramInfoFields{}))
	if !strings.Contains(header, plDebugVersionNote) || !strings.Contains(header, plDebugBodyFixNote) {
		t.Fatalf("the body header no longer carries both notes: %q", header)
	}
}

// A target compiled with PLSQL_DEBUG=FALSE cannot be instrumented at all: DBMS_DEBUG
// answers reason_knl_exit for the CONTINUE that was supposed to enter it, so
// pl_debug_start used to fail with "the debuggee finished before <X> was reached" -- for
// an instantaneous procedure and for a looping one alike. The start sequence therefore
// restores the setting before anything is parked.
func TestPLDebugEnsureDebugInfoRestoresAMissingSetting(t *testing.T) {
	t.Run("missing setting is restored and reported", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptPlsqlDebug("FALSE")
		note, err := plDebugEnsureDebugInfo(db, "CHZ", map[string]interface{}{
			"objectType": "PROCEDURE", "objectName": "PROC"})
		if err != nil {
			t.Fatalf("the repair failed on a repairable target: %v", err)
		}
		if note == "" {
			t.Fatal("the repair ran but reported nothing, so the client cannot tell the object was recompiled")
		}
		alter, ok := drv.recordedStatementContaining("COMPILE DEBUG")
		if !ok {
			t.Fatalf("no ALTER ... COMPILE DEBUG was issued: %v", drv.recordedRoutines())
		}
		if !strings.Contains(alter.query, `ALTER PROCEDURE "CHZ"."PROC" COMPILE DEBUG`) {
			t.Fatalf("the repair statement is not the documented one: %q", alter.query)
		}
		// The note renders the statement with %q, so the quotes are escaped there.
		if !strings.Contains(note, alter.query) && !strings.Contains(note, strings.ReplaceAll(alter.query, `"`, `\"`)) {
			t.Fatalf("the note does not name the statement it ran: %q", note)
		}
		if got := len(drv.recordedQueries()); got != 2 {
			t.Fatalf("the setting was probed %d times, want the before/after pair that verifies the ALTER", got)
		}
	})

	t.Run("a target that already has debug information is left alone", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptPlsqlDebug("TRUE")
		note, err := plDebugEnsureDebugInfo(db, "CHZ", map[string]interface{}{
			"objectType": "PROCEDURE", "objectName": "PROC"})
		if err != nil {
			t.Fatalf("the probe failed: %v", err)
		}
		if note != "" {
			t.Fatalf("a debuggable target was reported as repaired: %q", note)
		}
		if _, ok := drv.recordedStatementContaining("COMPILE DEBUG"); ok {
			t.Fatal("a target that already carries debug information was recompiled anyway")
		}
		if routines := drv.recordedRoutines(); len(routines) != 0 {
			t.Fatalf("the repair touched the debugger: %v", routines)
		}
	})

	t.Run("a server without a row for the object is left alone", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		note, err := plDebugEnsureDebugInfo(db, "CHZ", map[string]interface{}{
			"objectType": "PROCEDURE", "objectName": "PROC"})
		if err != nil {
			t.Fatalf("an unknown setting must not fail the start: %v", err)
		}
		if note != "" {
			t.Fatalf("nothing was repaired but a note was returned: %q", note)
		}
		if _, ok := drv.recordedStatementContaining("COMPILE DEBUG"); ok {
			t.Fatal("a server that cannot tell was compiled against anyway")
		}
	})

	t.Run("a package subprogram compiles its package", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptPlsqlDebug("FALSE")
		note, err := plDebugEnsureDebugInfo(db, "CHZ", map[string]interface{}{
			"objectType": "PROCEDURE", "objectName": "RUN", "packageName": "PKG"})
		if err != nil {
			t.Fatalf("the repair failed: %v", err)
		}
		if note == "" {
			t.Fatal("the package body was not repaired")
		}
		if _, ok := drv.recordedStatementContaining(`ALTER PACKAGE "CHZ"."PKG" COMPILE DEBUG`); !ok {
			t.Fatal("a package subprogram target did not compile its package")
		}
	})

	t.Run("an anonymous block is never probed", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptPlsqlDebug("FALSE")
		note, err := plDebugEnsureDebugInfo(db, "CHZ", map[string]interface{}{
			"objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"})
		if err != nil || note != "" {
			t.Fatalf("an anonymous target was touched: note=%q err=%v", note, err)
		}
		if queries := drv.recordedQueries(); len(queries) != 0 {
			t.Fatalf("an anonymous target was probed: %v", queries)
		}
		if _, ok := drv.recordedStatementContaining("COMPILE DEBUG"); ok {
			t.Fatal("an anonymous target was compiled")
		}
	})

	t.Run("a compliant target is not reachable through an unvalidated identifier", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptPlsqlDebug("FALSE")
		// The name is interpolated into a DDL (it cannot be bound), so anything that is
		// not a plain identifier has to be refused rather than quoted into the statement.
		if _, err := plDebugEnsureDebugInfo(db, "CHZ", map[string]interface{}{
			"objectType": "PROCEDURE", "objectName": "PROC; DROP TABLE T"}); err != nil {
			t.Fatalf("an unvalidated name failed the start instead of being skipped: %v", err)
		}
		if _, ok := drv.recordedStatementContaining("COMPILE DEBUG"); ok {
			t.Fatal("an identifier that is not plain reached the ALTER statement")
		}
	})
}

// The failure that started the whole investigation must now name its own cause instead of
// reading like a timing problem.
func TestPLDebugFinishedBeforeReachedNamesTheCompileSetting(t *testing.T) {
	if !strings.Contains(plDebugDebugInfoHint, "PLSQL_DEBUG") {
		t.Fatalf("the hint does not name the compile setting: %q", plDebugDebugInfoHint)
	}
}

// The V6.1 fixes live in the body, so a body installed before them has to be replaced.
// The shared V6 identity literal is what the Java agent also asserts, so it must NOT be
// bumped; a second marker in the same header line is what forces the rebuild instead.
func TestPLDebugBodyFixNoteIsOnTheHeaderAndRequired(t *testing.T) {
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	header := firstLine(body)
	if !strings.Contains(header, plDebugVersionNote) {
		t.Fatalf("the shared V6 identity note is no longer on the body header: %q", header)
	}
	if !strings.Contains(header, plDebugBodyFixNote) {
		t.Fatalf("the fix note is not on the body header, so pre-fix bodies are never replaced: %q", header)
	}
	// The version check has to require BOTH, or the fixes are never installed.
	source := plDebugVersionNote + "\n" + body
	if !strings.Contains(source, plDebugVersionNote) || !strings.Contains(source, plDebugBodyFixNote) {
		t.Fatal("plDebugPackageVersionCurrent cannot see both notes")
	}
	if strings.Contains(plDebugVersionNote, "Fix: V6.1") {
		t.Fatal("the fix note was folded into the shared V6 literal, which would fork the Go and Java agents")
	}
	// The fix note moves with the body version. Older stamps are folded into the current
	// literal (the history is kept inside it), so the stamp itself is always the newest one
	// and it still names every fix it stands for. The Java agent writes the identical
	// literal, which is what keeps the two agents from rebuilding each other's body.
	for _, previous := range []string{
		"-- DBX PL Debug Package Fix: V6.1 namespace-aware set_breakpoint + explicit run_info mask",
		"-- DBX PL Debug Package Fix: V6.2 program_info.entrypointname arm for package subprograms",
		"-- DBX PL Debug Package Fix: V6.3 DBX_FETCH_OUTPUT one-call DBMS_OUTPUT drain",
	} {
		if plDebugBodyFixNote == previous || strings.HasPrefix(plDebugBodyFixNote, previous) {
			t.Fatalf("the fix note was not bumped past %q: %q", previous, plDebugBodyFixNote)
		}
	}
	if !strings.Contains(plDebugBodyFixNote, "Fix: V6.4") {
		t.Fatalf("the fix note does not carry the V6.4 stamp: %q", plDebugBodyFixNote)
	}
	if !strings.Contains(plDebugBodyFixNote, "entrypointname") {
		t.Fatalf("the fix note does not name the entrypoint fix it stands for: %q", plDebugBodyFixNote)
	}
	if !strings.Contains(plDebugBodyFixNote, procFetchOutput) {
		t.Fatalf("the fix note does not name the routine V6.3 adds: %q", plDebugBodyFixNote)
	}
	if !strings.Contains(plDebugBodyFixNote, procCntException) {
		t.Fatalf("the fix note does not name the routine V6.4 adds: %q", plDebugBodyFixNote)
	}
}

// The namespace-aware breakpoint is the difference between a by-name breakpoint that
// works and error_bad_handle (16): SET_BREAKPOINT without a namespace always answered 16
// on 19c EE, while namespace_pkgspec_or_toplevel answered 0 for a top-level procedure.
func TestPLDebugSetBreakpointFallsBackToProgramNamespaces(t *testing.T) {
	source := plDebugNamespaceFallbackDDL
	if !strings.Contains(source, "pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel") {
		t.Fatalf("the first namespace tried is not the measured working one:\n%s", source)
	}
	for _, namespace := range []string{
		"dbms_debug.namespace_pkg_body",
		"dbms_debug.namespace_cursor",
		"pro_info.namespace := NULL",
	} {
		if !strings.Contains(source, namespace) {
			t.Fatalf("the fallback chain is missing %s:\n%s", namespace, source)
		}
	}
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	if got := strings.Count(body, plDebugNamespaceFallbackDDL); got != 2 {
		t.Fatalf("the namespace fallback is used %d times, want 2 (DBX_SET_BREAKPOINT and _EX)", got)
	}
}

// The explicit run_info mask is the second measured fix: CONTINUE with the default
// info_requested returns NULL and fills only reason/terminated, while an explicit mask
// fills program/owner/namespace/line/depth -- which is what stepIntoRoutine matches on.
func TestPLDebugContinuationHelpersAskForTheRunInfoMask(t *testing.T) {
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	for _, flag := range []string{
		"dbms_debug.break_next_line",
		"dbms_debug.break_any_call",
		"dbms_debug.break_any_return",
		"dbms_debug.abort_execution",
	} {
		want := fmt.Sprintf("dbms_debug.continue(run_info, %s, %s)", flag, plDebugRunInfoMask)
		if !strings.Contains(body, want) {
			t.Fatalf("the wrapper continuing with %s does not ask for the run_info mask:\n\twant substring %q", flag, want)
		}
	}
}

// PRINT_BACKTRACE on Oracle 19c EE prints the SOURCE TEXT of the line, not the program
// name ODC's samples show: " [Line 2]   V_COUNT NUMBER := 0;" followed by
// "<source not available>". Publishing that as the session's program would put PL/SQL
// source in the snapshot, so only an identifier-shaped token is accepted; the
// authoritative name is the run_info register.
func TestPLDebugFetchBacktraceDoesNotPublishSourceTextAsTheProgram(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procPrintBacktrace, 0, " [Line 2]   V_COUNT NUMBER := 0;\n<source not available>")
	drv.scriptOut(procPrintBacktrace, 1, 0)
	session := newPLDebugCallSession(db, false)
	session.lastProgram = "DBX_V1_PROC"

	session.refreshBacktrace()
	if session.lastProgram != "DBX_V1_PROC" {
		t.Fatalf("the 19c listing overwrote the program with source text: %q", session.lastProgram)
	}
	if session.lastLine != 2 {
		t.Fatalf("the line from the listing was dropped: %d", session.lastLine)
	}

	// A listing that does carry a program name still updates it.
	t.Run("a listing with a program name", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procPrintBacktrace, 0, " [Line 8] PKG.F_ADD\n<source not available>")
		drv.scriptOut(procPrintBacktrace, 1, 0)
		session := newPLDebugCallSession(db, false)
		session.lastProgram = "DBX_V1_PROC"
		session.refreshBacktrace()
		if session.lastProgram != "PKG.F_ADD" {
			t.Fatalf("a real program name in the listing was ignored: %q", session.lastProgram)
		}
	})
}

// A stop has to report the line it stopped on. run_info carries only reason, stack
// depth and program, so the line can only come from PRINT_BACKTRACE -- measured on
// Oracle 19c EE as " [Line 10]     V_LABEL := 'iter-' || i;". Before the refresh was
// added to continueWith, every resume and every step answered line=1 (the routine
// entry) even though the breakpoint was hit on line 10: the real-machine run showed
// three reason=3 hits that all reported line=1.
func TestPLDebugContinueRefreshesTheStoppedLine(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntNextBreakpoint, 0, 0)
	drv.scriptOut(procCntNextBreakpoint, 1,
		plDebugRunInfo("DBX_V1_PROC", "DBX_DEBUG", 0, 2, plDebugReasonBreakpoint))
	drv.scriptOut(procPrintBacktrace, 0, " [Line 10]     V_LABEL := 'iter-' || i;\n<source not available>\n")
	drv.scriptOut(procPrintBacktrace, 1, 0)
	session := newPLDebugCallSession(db, false)
	session.lastProgram = "DBX_V1_PROC"
	session.lastLine = 1

	response, err := session.continueWith(procCntNextBreakpoint)
	if err != nil {
		t.Fatalf("continueWith failed: %v", err)
	}
	if response["line"] != 10 {
		t.Fatalf("the stopped line was not refreshed: line=%v, want 10", response["line"])
	}
	if session.lastLine != 10 {
		t.Fatalf("session.lastLine = %d, want 10", session.lastLine)
	}
	if session.lastProgram != "DBX_V1_PROC" {
		t.Fatalf("the 19c source text overwrote the program name: %q", session.lastProgram)
	}
	if countRoutine(drv.recordedRoutines(), procPrintBacktrace) == 0 {
		t.Fatal("a live stop did not ask for the backtrace, so its line stays stale")
	}
}

// reason_knl_exit (25) is what ABORT_EXECUTION reports once the interpreter has left
// the program: measured on Oracle 19c EE as
// `pl_debug_abort -> result=0, reason=25, programname = <empty>`. Leaving it out of
// the terminal set kept the session "live" after an abort, so pl_debug_get_log stayed
// gated off and the client could never read what the aborted run had printed.
func TestPLDebugKnlExitTerminatesTheSession(t *testing.T) {
	t.Run("knl_exit terminates", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procCntAbort, 0, 0)
		drv.scriptOut(procCntAbort, 1, plDebugRunInfo("", "", 0, 0, plDebugReasonKnlExit))
		session := newPLDebugCallSession(db, false)

		response, err := session.continueWith(procCntAbort)
		if err != nil {
			t.Fatalf("continueWith(abort) failed: %v", err)
		}
		if !session.terminated {
			t.Fatal("reason_knl_exit did not terminate the session")
		}
		if response["terminated"] != true {
			t.Fatalf("the snapshot still reports terminated=%v", response["terminated"])
		}
		if response["reason"] != plDebugReasonKnlExit {
			t.Fatalf("reason = %v, want %d", response["reason"], plDebugReasonKnlExit)
		}
		// The debuggee is gone, so there is nothing left to ask for a backtrace.
		if countRoutine(drv.recordedRoutines(), procPrintBacktrace) != 0 {
			t.Fatal("a terminated stop asked the finished debuggee for a backtrace")
		}
	})

	// reason_finish (8) must keep the session alive: a nested routine returning is
	// not the program ending, and ODC keeps stepping past it.
	t.Run("reason_finish does not terminate", func(t *testing.T) {
		db, drv := openOracleDebugCallTestDB(t)
		drv.scriptOut(procCntNextBreakpoint, 0, 0)
		drv.scriptOut(procCntNextBreakpoint, 1, plDebugRunInfo("DBX_V1_PROC", "DBX_DEBUG", 0, 2, 8))
		session := newPLDebugCallSession(db, false)
		response, err := session.continueWith(procCntNextBreakpoint)
		if err != nil {
			t.Fatalf("continueWith failed: %v", err)
		}
		if session.terminated {
			t.Fatal("reason_finish terminated the session")
		}
		if response["terminated"] == true {
			t.Fatal("the snapshot reports terminated=true for reason_finish")
		}
	})

	// reason_exit (15) and reason_aborting (21) stay terminal.
	for name, reason := range map[string]int{
		"reason_exit terminates":     plDebugReasonExit,
		"reason_aborting terminates": plDebugReasonAborting,
	} {
		t.Run(name, func(t *testing.T) {
			db, drv := openOracleDebugCallTestDB(t)
			drv.scriptOut(procCntNextBreakpoint, 0, 0)
			drv.scriptOut(procCntNextBreakpoint, 1, plDebugRunInfo("", "", 0, 0, reason))
			session := newPLDebugCallSession(db, false)
			if _, err := session.continueWith(procCntNextBreakpoint); err != nil {
				t.Fatalf("continueWith failed: %v", err)
			}
			if !session.terminated {
				t.Fatalf("reason=%d did not terminate the session", reason)
			}
		})
	}
}

// V6.4: an exception breakpoint is native. DBX_CNT_EXCEPTION continues with
// break_exception|break_handler, so the interpreter returns at the statement that raises
// (or at the handler that catches it) in one call. Before this the mode looped
// CONTINUE(break_any_return) and never saw the exception at all: measured on 19c EE, an
// unhandled RAISE_APPLICATION_ERROR ended the program, so the loop's first answer was
// reason_knl_exit (25) with terminated=true and no frames.
func TestPLDebugExceptionResumeUsesTheNativeFlagsFirst(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntException, 0, 0)
	drv.scriptOut(procCntException, 1,
		plDebugRunInfo("DBX_EXC_DEEP", "DBX_DEBUG", 0, 1, plDebugReasonException))
	drv.scriptOut(procPrintBacktrace, 0, " [Line 6]     RAISE_APPLICATION_ERROR(-20001, 'a6-deep-boom');\n")
	drv.scriptOut(procPrintBacktrace, 1, 0)
	session := newPLDebugCallSession(db, false)
	session.setExceptionBreakpoint(true)

	response, err := session.resumeUntilException()
	if err != nil {
		t.Fatalf("resumeUntilException failed: %v", err)
	}
	if response["reason"] != plDebugReasonException {
		t.Fatalf("reason = %v, want reason_exception (%d)", response["reason"], plDebugReasonException)
	}
	if response["stoppedOnException"] != true || !session.stoppedOnException {
		t.Fatalf("the native exception stop was not reported as such: %v", response)
	}
	if response["line"] != 6 {
		t.Fatalf("the stop did not report the raising line: %v", response["line"])
	}
	if countRoutine(drv.recordedRoutines(), procCntException) == 0 {
		t.Fatalf("the native flags were never used: %v", drv.recordedRoutines())
	}
	if got := countRoutine(drv.recordedRoutines(), procCntNextBreakpoint); got != 0 {
		t.Fatalf("the polling primitive ran %d times even though the native call answered: %v",
			got, drv.recordedRoutines())
	}
}

// A server that rejects break_exception/break_handler must not fail the RPC: the mode
// falls back to the pre-V6.4 polling primitive instead.
func TestPLDebugExceptionResumeFallsBackToPollingWhenTheFlagsAreRejected(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptError(procCntException, errors.New("ORA-00097: use of Oracle SQL feature not in this Oracle version"))
	drv.scriptOut(procCntNextBreakpoint, 0, 0)
	drv.scriptOut(procCntNextBreakpoint, 1,
		plDebugRunInfo("DBX_EXC_DEEP", "DBX_DEBUG", 0, 1, plDebugReasonException))
	session := newPLDebugCallSession(db, false)
	session.setExceptionBreakpoint(true)

	response, err := session.resumeUntilException()
	if err != nil {
		t.Fatalf("the fallback turned a rejected flag into a failed RPC: %v", err)
	}
	if response["stoppedOnException"] != true {
		t.Fatalf("the polling fallback did not report the exception stop: %v", response)
	}
	if countRoutine(drv.recordedRoutines(), procCntException) == 0 {
		t.Fatal("the native call was never attempted")
	}
	if countRoutine(drv.recordedRoutines(), procCntNextBreakpoint) == 0 {
		t.Fatal("the polling fallback never ran")
	}
}

// The handler flag stops the mode at the handler that catches a raised exception.
func TestPLDebugExceptionResumeStopsAtTheHandler(t *testing.T) {
	db, drv := openOracleDebugCallTestDB(t)
	drv.scriptOut(procCntException, 0, 0)
	drv.scriptOut(procCntException, 1,
		plDebugRunInfo("DBX_EXC_DEEP", "DBX_DEBUG", 0, 1, plDebugReasonHandler))
	session := newPLDebugCallSession(db, false)
	session.setExceptionBreakpoint(true)

	response, err := session.resumeUntilException()
	if err != nil {
		t.Fatalf("resumeUntilException failed: %v", err)
	}
	if response["reason"] != plDebugReasonHandler || response["stoppedOnException"] != true {
		t.Fatalf("a handler stop was not reported as an exception stop: %v", response)
	}
}

// The V6.4 routine has to be declared in the head and listed as required: the head is what
// makes the body's call resolvable, and without the requirement an installed head from
// before V6.4 is kept, so the Go agent's DBX_CNT_EXCEPTION call fails with PLS-00302.
func TestPLDebugExceptionRoutineIsDeclaredAndRequired(t *testing.T) {
	head := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	declaration := "PROCEDURE " + procCntException + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
	if !strings.Contains(head, declaration) {
		t.Fatalf("the head does not declare %s:\n%s", procCntException, head)
	}
	body := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	if !strings.Contains(body, "PROCEDURE "+procCntException+"(") {
		t.Fatalf("the body does not implement %s", procCntException)
	}
	// The flags are literals on purpose: a named reference would fail the whole PACKAGE
	// BODY at compile time on an engine whose DBMS_DEBUG does not declare the constants,
	// and this body is shared with the OceanBase Oracle agent.
	if !strings.Contains(body, "dbms_debug.continue(run_info, 2 + 2048, ") {
		t.Fatalf("the body does not continue with break_exception|break_handler:\n%s", body)
	}
	if strings.Contains(body, "dbms_debug.break_exception") || strings.Contains(body, "dbms_debug.break_handler") {
		t.Fatal("the body references the named flags, which not every engine declares")
	}
	if !strings.Contains(body, "-- V6.4 (real Oracle 19c EE verified): "+procCntException) {
		t.Fatalf("the V6.4 history comment is missing:\n%s", body)
	}
	if !containsString(plDebugHeadRequiredRoutines, procCntException) {
		t.Fatalf("%s is not required, so an older head is never replaced", procCntException)
	}
	if !containsString(plDebugHeadRequirements, procCntException) {
		t.Fatalf("%s is missing from plDebugHeadRequirements", procCntException)
	}
}

func TestPLDebugIsProgramNameAcceptsOnlyIdentifiers(t *testing.T) {
	for _, text := range []string{"PROC", "PKG.F_ADD", "DBX_DEBUG.DBX_V1_PROC", " v1_proc ", "A$B#C"} {
		if !plDebugIsProgramName(text) {
			t.Fatalf("%q is a program name but was rejected", text)
		}
	}
	// A quoted identifier is deliberately NOT accepted: the listing only ever fills a
	// display field, and allowing quotes would let quoted source text through as well.
	for _, text := range []string{
		"",
		"   ",
		`"QUOTED"`,
		"V_COUNT NUMBER := 0;",
		"V_LABEL VARCHAR2(100) := 'start';",
		"<source not available>",
		"DBX_V1_LEAF('tag-' || i);",
		"-- a comment",
	} {
		if plDebugIsProgramName(text) {
			t.Fatalf("%q is source text but was accepted as a program name", text)
		}
	}
}

// The frame match has to survive the owner qualification DBMS_DEBUG reports and the
// case/whitespace differences between the request and run_info, and an unresolved
// target must never match the first frame it is offered.
func TestPLDebugProgramKeyAndFrameMatch(t *testing.T) {
	for text, want := range map[string]string{
		"DBX_V1_PROC":               "DBX_V1_PROC",
		" dbx_v1_proc ":             "DBX_V1_PROC",
		"DBX_DEBUG.DBX_V1_PROC":     "DBX_V1_PROC",
		"DBX_DEBUG.PKG.F_ADD":       "F_ADD",
		"DBX_DEBUG.DBMS_LOCK.SLEEP": "SLEEP",
	} {
		if got := plDebugProgramKey(text); got != want {
			t.Fatalf("plDebugProgramKey(%q) = %q, want %q", text, got, want)
		}
	}
	if !plDebugFrameMatchesTarget("DBX_DEBUG.DBX_V1_PROC", "DBX_V1_PROC") {
		t.Fatal("an owner-qualified frame did not match the bare target")
	}
	if !plDebugFrameMatchesTarget("dbx_v1_proc", "DBX_V1_PROC") {
		t.Fatal("the match is case sensitive")
	}
	if plDebugFrameMatchesTarget("OTHER_PROC", "DBX_V1_PROC") {
		t.Fatal("a different routine matched")
	}
	if plDebugFrameMatchesTarget("DBX_V1_PROC", "") || plDebugFrameMatchesTarget("", "") {
		t.Fatal("an empty target matched a frame; an unresolved target must never match")
	}
}

// The server-side idle timeout is the difference between a target that gives up after
// two minutes and one that stays parked for the package default while its execution pin
// blocks every attempt to replace the helper package. ODC sets it (DebuggeeSession :68)
// and this agent did not.
func TestPLDebugStartSetsTheServerSideDebugTimeout(t *testing.T) {
	if plDebugServerTimeoutSeconds != 120 {
		t.Fatalf("the server timeout drifted from ODC's value: %d", plDebugServerTimeoutSeconds)
	}
	start, err := os.ReadFile("pldebug.go")
	if err != nil {
		t.Fatalf("cannot read pldebug.go: %v", err)
	}
	source := string(start)
	if !strings.Contains(source, "SELECT DBMS_DEBUG.SET_TIMEOUT(%d) FROM DUAL") {
		t.Fatal("SET_TIMEOUT is not selected; CALL raises PLS-00221 on 19c EE")
	}
	if strings.Contains(source, `Exec("CALL DBMS_DEBUG.SET_TIMEOUT(`) {
		t.Fatal("SET_TIMEOUT is called as a procedure, which is not a procedure")
	}
}

// -- pl_debug_probe capability detection -------------------------------------
// plDebugProbeDebugRoutines is the DBMS_DEBUG surface a stock Oracle (21c XE
// verified) exposes: every required routine is there, GET_VALUE is declared but
// GET_VALUES is not.
var plDebugProbeDebugRoutines = []string{
	"ATTACH_SESSION", "CONTINUE", "DEBUG_OFF", "DEBUG_ON", "GET_VALUE",
	"INITIALIZE", "PRINT_BACKTRACE", "SET_BREAKPOINT", "SET_TIMEOUT_BEHAVIOUR",
}

func plDebugProbeRoutineRows(names []string) [][]driver.Value {
	rows := make([][]driver.Value, 0, len(names))
	for _, name := range names {
		rows = append(rows, []driver.Value{name})
	}
	return rows
}

func plDebugProbePrivilegeRows(privileges []string) [][]driver.Value {
	rows := make([][]driver.Value, 0, len(privileges))
	for _, privilege := range privileges {
		rows = append(rows, []driver.Value{privilege})
	}
	return rows
}

// openOracleProbeTestDB scripts the probe's dictionary reads in the order
// plDebugProbe performs them: DBMS_DEBUG metadata, DBMS_OUTPUT metadata, the
// session privileges, and the current user (only read for the GRANT hints).
func openOracleProbeTestDB(
	t *testing.T,
	debugRoutines []string,
	outputRoutines []string,
	privileges []string,
	privilegesErr error,
	user string,
) *server {
	t.Helper()
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		{
			queryContains: "ALL_PROCEDURES",
			args:          []driver.Value{"DBMS_DEBUG"},
			columns:       []string{"PROCEDURE_NAME"},
			rows:          plDebugProbeRoutineRows(debugRoutines),
		},
		{
			queryContains: "ALL_PROCEDURES",
			args:          []driver.Value{"DBMS_OUTPUT"},
			columns:       []string{"PROCEDURE_NAME"},
			rows:          plDebugProbeRoutineRows(outputRoutines),
		},
		{
			queryContains: "SESSION_PRIVS",
			args:          []driver.Value{},
			columns:       []string{"PRIVILEGE"},
			rows:          plDebugProbePrivilegeRows(privileges),
			err:           privilegesErr,
		},
		{
			queryContains: "USER FROM DUAL",
			args:          []driver.Value{},
			columns:       []string{"USER"},
			rows:          [][]driver.Value{{user}},
		},
	})
	s := newServer()
	s.db = db
	return s
}

func probeReason(t *testing.T, response map[string]interface{}) string {
	t.Helper()
	reason, _ := response["reason"].(string)
	return reason
}

func probeWarnings(t *testing.T, response map[string]interface{}) []string {
	t.Helper()
	raw, _ := response["warnings"].([]string)
	return raw
}

// R1: EXECUTE ON DBMS_DEBUG is granted to PUBLIC, so ALL_PROCEDURES lists every
// subroutine for a user that cannot initialize DBMS_DEBUG at all. The probe must
// consult the session's real privileges and say what to grant.
func TestPLDebugProbeRejectsMissingDebugConnectSessionWithActionableReason(t *testing.T) {
	s := openOracleProbeTestDB(t,
		plDebugProbeDebugRoutines,
		[]string{"DISABLE", "ENABLE", "GET_LINE", "PUT_LINE"},
		[]string{"CREATE SESSION", "CREATE TABLE", "UNLIMITED TABLESPACE"},
		nil,
		"DBX_TEST",
	)
	response := s.plDebugProbe()
	if response["supported"] != false {
		t.Fatalf("supported = %v, want false without DEBUG CONNECT SESSION: %+v", response["supported"], response)
	}
	if missing, _ := response["missingProcedures"].([]string); len(missing) != 0 {
		t.Fatalf("the DBMS_DEBUG metadata is complete, missingProcedures must stay empty: %v", missing)
	}
	reason := probeReason(t, response)
	if reason == "" {
		t.Fatal("an unsupported verdict must always carry a reason")
	}
	for _, want := range []string{"DEBUG CONNECT SESSION", "GRANT DEBUG CONNECT SESSION TO DBX_TEST;", "ORA-01031"} {
		if !strings.Contains(reason, want) {
			t.Fatalf("reason %q must contain %q", reason, want)
		}
	}
	if warnings := probeWarnings(t, response); len(warnings) == 0 ||
		!strings.Contains(strings.Join(warnings, " "), "DEBUG ANY PROCEDURE") {
		t.Fatalf("warnings = %v, want the missing DEBUG ANY PROCEDURE reported as a warning", warnings)
	}
	// GET_VALUES is an OceanBase extension: its absence must only disable the
	// variable feature (verified behaviour, unchanged by this fix).
	if response["variablesSupported"] != false {
		t.Fatalf("variablesSupported = %v, want false without GET_VALUES", response["variablesSupported"])
	}
}

// DEBUG ANY PROCEDURE is not required to debug objects of the current schema, so
// its absence is a warning and must not turn the probe unsupported.
func TestPLDebugProbeAcceptsDebugConnectSessionWithoutDebugAnyProcedure(t *testing.T) {
	s := openOracleProbeTestDB(t,
		plDebugProbeDebugRoutines,
		[]string{"DISABLE", "ENABLE", "GET_LINE", "PUT_LINE"},
		[]string{"CREATE SESSION", "DEBUG CONNECT SESSION"},
		nil,
		"DBX_TEST",
	)
	response := s.plDebugProbe()
	if response["supported"] != true {
		t.Fatalf("supported = %v, want true with DEBUG CONNECT SESSION: %+v (reason %q)",
			response["supported"], response, probeReason(t, response))
	}
	if reason := probeReason(t, response); reason != "" {
		t.Fatalf("a supported verdict carries no reason, got %q", reason)
	}
	warnings := probeWarnings(t, response)
	if len(warnings) == 0 || !strings.Contains(strings.Join(warnings, " "), "DEBUG ANY PROCEDURE") {
		t.Fatalf("warnings = %v, want a DEBUG ANY PROCEDURE warning", warnings)
	}
	if !strings.Contains(strings.Join(warnings, " "), "GRANT DEBUG ANY PROCEDURE TO DBX_TEST;") {
		t.Fatalf("warnings = %v, want an actionable GRANT hint", warnings)
	}
}

// A server without SESSION_PRIVS (or without the right to read it) must keep the
// old dictionary-only verdict instead of claiming the privilege is missing.
func TestPLDebugProbeKeepsDictionaryVerdictWhenPrivilegesAreUnreadable(t *testing.T) {
	s := openOracleProbeTestDB(t,
		plDebugProbeDebugRoutines,
		[]string{"DISABLE", "ENABLE", "GET_LINE", "PUT_LINE"},
		nil,
		errors.New("ORA-00942: table or view does not exist"),
		"DBX_TEST",
	)
	response := s.plDebugProbe()
	if response["supported"] != true {
		t.Fatalf("supported = %v, want the dictionary verdict when SESSION_PRIVS is unreadable: %+v",
			response["supported"], response)
	}
	if !strings.Contains(strings.Join(probeWarnings(t, response), " "), "SESSION_PRIVS") {
		t.Fatalf("warnings = %v, want the unverifiable privileges reported", probeWarnings(t, response))
	}
}

// Every unsupported branch has to explain itself.
func TestPLDebugProbeAlwaysExplainsAnUnsupportedVerdict(t *testing.T) {
	cases := []struct {
		name       string
		debug      []string
		output     []string
		privileges []string
		wantReason string
	}{
		{
			name:       "DBMS_OUTPUT invisible",
			debug:      plDebugProbeDebugRoutines,
			output:     nil,
			privileges: []string{"DEBUG CONNECT SESSION"},
			wantReason: "DBMS_OUTPUT",
		},
		{
			name:       "required DBMS_DEBUG routine missing",
			debug:      []string{"INITIALIZE", "ATTACH_SESSION", "DEBUG_ON"},
			output:     []string{"ENABLE"},
			privileges: []string{"DEBUG CONNECT SESSION"},
			wantReason: "CONTINUE",
		},
		{
			name:       "no privileges at all",
			debug:      plDebugProbeDebugRoutines,
			output:     []string{"ENABLE"},
			privileges: nil,
			wantReason: "DEBUG CONNECT SESSION",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			s := openOracleProbeTestDB(t, testCase.debug, testCase.output, testCase.privileges, nil, "DBX_TEST")
			response := s.plDebugProbe()
			if response["supported"] != false {
				t.Fatalf("supported = %v, want false", response["supported"])
			}
			reason := probeReason(t, response)
			if reason == "" {
				t.Fatalf("unsupported verdict without a reason: %+v", response)
			}
			if !strings.Contains(reason, testCase.wantReason) {
				t.Fatalf("reason %q must mention %q", reason, testCase.wantReason)
			}
		})
	}
}

// The probe no longer needs ALL_ARGUMENTS; it must keep reading subroutine
// visibility from ALL_PROCEDURES and never issue a GRANT itself.
func TestPLDebugProbeOnlyReadsTheDictionary(t *testing.T) {
	s := openOracleProbeTestDB(t,
		plDebugProbeDebugRoutines,
		[]string{"DISABLE", "ENABLE", "GET_LINE", "PUT_LINE"},
		[]string{"DEBUG CONNECT SESSION", "DEBUG ANY PROCEDURE"},
		nil,
		"DBX_TEST",
	)
	response := s.plDebugProbe()
	if response["supported"] != true {
		t.Fatalf("supported = %v, want true: %+v", response["supported"], response)
	}
	if procedures, _ := response["procedures"].([]string); len(procedures) != len(plDebugProbeDebugRoutines) {
		t.Fatalf("procedures = %v, want the DBMS_DEBUG metadata list", procedures)
	}
	if warnings := probeWarnings(t, response); len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none when both privileges are held", warnings)
	}
	if len(s.dbmsOutput.attempted) != 0 {
		t.Fatal("the probe must not touch the capture bookkeeping")
	}
}

// Oracle prints the SOURCE line where a frame name would go, and for a package
// subprogram that line is the only place the CURRENT routine is named at all: run_info
// reports just the package. plDebugSubprogramFromDeclaration is what recovers it, so it
// has to accept exactly the declaration shapes and reject ordinary statements.
func TestPLDebugSubprogramFromDeclaration(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		source string
		want   string
	}{
		{"a procedure", "PROCEDURE RUN_MSBP IS", "RUN_MSBP"},
		{"a function with a return type", "FUNCTION F_ADD RETURN NUMBER IS", "F_ADD"},
		{"an indented declaration", "    PROCEDURE LEAF IS", "LEAF"},
		{"lower case keywords and name", "procedure lower_case is", "lower_case"},
		{"a declaration sharing its line with the body", "PROCEDURE RUN_MSBP IS BEGIN NULL; END;", "RUN_MSBP"},
		{"a declaration without a name", "PROCEDURE", ""},
		{"a variable declaration", "V_COUNT NUMBER := 0;", ""},
		{"a statement", "LEAF_A3;", ""},
		{"a quoted name", `PROCEDURE "My Proc" IS`, ""},
		{"an empty line", "", ""},
	} {
		if got := plDebugSubprogramFromDeclaration(testCase.source); got != testCase.want {
			t.Fatalf("%s: plDebugSubprogramFromDeclaration(%q) = %q, want %q",
				testCase.name, testCase.source, got, testCase.want)
		}
	}
}

// The published program label has to follow the routine the interpreter is actually in.
// The engine reports only the PACKAGE for a package subprogram, so the label is rebuilt
// from the current frame's source line and, failing that, from the session's own target.
func TestPLDebugCurrentProgramLabel(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		reported      string
		targetProgram string
		targetPackage string
		targetLines   plDebugLineRange
		lastLine      int
		frames        []plDebugFrame
		want          string
	}{
		{
			name:     "a top-level routine is reported as it stands",
			reported: "MY_PROC",
			want:     "MY_PROC",
		},
		{
			name:          "a declaration line names the sibling subprogram",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			frames:        []plDebugFrame{{Source: "PROCEDURE LEAF IS"}},
			want:          "DBX_PKG.LEAF",
		},
		{
			name:          "a line inside the target's own range names the target",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			targetLines:   plDebugLineRange{First: 6, Last: 14},
			lastLine:      10,
			frames:        []plDebugFrame{{Source: "V_COUNT := 0;"}},
			want:          "DBX_PKG.RUN_ME",
		},
		{
			name:          "a line past every known range keeps the package name",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			targetLines:   plDebugLineRange{First: 6, Last: 14},
			lastLine:      20,
			frames:        []plDebugFrame{{Source: "V_INIT := 1;"}},
			want:          "DBX_PKG",
		},
		{
			name:          "the initialization section belongs to the package, not the target",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			targetLines:   plDebugLineRange{First: 20, Last: 30},
			lastLine:      45,
			want:          "DBX_PKG",
		},
		{
			name:          "without frames the target range still decides",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			targetLines:   plDebugLineRange{First: 6, Last: 14},
			lastLine:      6,
			want:          "DBX_PKG.RUN_ME",
		},
		{
			name:          "an unknown target range never claims the target",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			lastLine:      10,
			want:          "DBX_PKG",
		},
		{
			name:     "without a target the reported name stands",
			reported: "DBX_PKG",
			want:     "DBX_PKG",
		},
		{
			name:          "the package comes from the target label when the field is empty",
			reported:      "DBX_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			frames:        []plDebugFrame{{Source: "PROCEDURE LEAF IS"}},
			want:          "DBX_PKG.LEAF",
		},
		{
			name:          "another program is never rewritten",
			reported:      "OTHER_PKG",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			frames:        []plDebugFrame{{Source: "PROCEDURE LEAF IS"}},
			want:          "OTHER_PKG",
		},
		{
			name:          "an empty reported name is never composed",
			reported:      "",
			targetProgram: "DBX_PKG.RUN_ME",
			targetPackage: "DBX_PKG",
			frames:        []plDebugFrame{{Source: "PROCEDURE LEAF IS"}},
			want:          "",
		},
	} {
		session := &plDebugSession{
			lastProgram:   testCase.reported,
			targetProgram: testCase.targetProgram,
			targetPackage: testCase.targetPackage,
			targetLines:   testCase.targetLines,
			lastLine:      testCase.lastLine,
		}
		if got := session.currentProgramLabel(testCase.frames); got != testCase.want {
			t.Fatalf("%s: currentProgramLabel(%+v, line %d) = %q, want %q",
				testCase.name, testCase.frames, testCase.lastLine, got, testCase.want)
		}
	}
}

// Oracle prints structural keywords as whole source lines ("BEGIN", "END", ...), so an
// identifier-shaped token is not automatically a routine name. Measured on 19c EE: a
// step onto the BEGIN line of a subprogram published "BEGIN" as the program.
func TestPLDebugIsProgramNameRejectsKeywords(t *testing.T) {
	for _, testCase := range []struct {
		name string
		text string
		want bool
	}{
		{"a routine name", "RUN_MSBP", true},
		{"a qualified routine name", "DBX_PKG.RUN_MSBP", true},
		{"a lower case name", "run_msbp", true},
		{"a dollar and hash name", "F$1#", true},
		{"begin", "BEGIN", false},
		{"a lower case end", "end", false},
		{"else", "ELSE", false},
		{"loop", "LOOP", false},
		{"exception", "EXCEPTION", false},
		{"a padded keyword", "  BEGIN  ", false},
		{"a statement", "V_COUNT := 0;", false},
		{"an empty token", "", false},
	} {
		if got := plDebugIsProgramName(testCase.text); got != testCase.want {
			t.Fatalf("%s: plDebugIsProgramName(%q) = %v, want %v",
				testCase.name, testCase.text, got, testCase.want)
		}
	}
}
