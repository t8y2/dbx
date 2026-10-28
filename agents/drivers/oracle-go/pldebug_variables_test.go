package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestPLDebugNativeDeclarationDiscoveryKeepsQuotedAndOuterNames(t *testing.T) {
	for _, sample := range []struct {
		source string
		names  []string
	}{
		{"DECLARE\n V_N\n NUMBER; V_NULL VARCHAR2(10); BEGIN NULL; END;", []string{"V_N", "V_NULL"}},
		{"DECLARE\n \"a.b\" VARCHAR2(20) := 'BEGIN;';\n TYPE r IS RECORD (hidden NUMBER);\n e EXCEPTION;\n PROCEDURE nested IS inner_only NUMBER; BEGIN NULL; END;\n outer_only NUMBER;\n BEGIN nested; END;", []string{`"a.b"`, "OUTER_ONLY"}},
		{"BEGIN NULL; END;", []string{}},
	} {
		got, message := plDebugNativeDeclarationNames(sample.source, 0)
		if message != "" || !reflect.DeepEqual(got, sample.names) {
			t.Fatalf("discovery=%#v error=%q want=%#v", got, message, sample.names)
		}
	}
}

func TestPLDebugNativeFrameDiscoveryUsesExactBoundContainerOnOriginalConnection(t *testing.T) {
	metadata := plDebugTargetFixture()
	metadata.objects = [][]driver.Value{{"900719925474099312345", "PROCEDURE"}}
	metadata.sourceRows = [][]driver.Value{{"900719925474099312345", "VALID", "2026-10-25 00:00:00", int64(1), "PROCEDURE \" P.\"\"x \" IS\n"}, {"900719925474099312345", "VALID", "2026-10-25 00:00:00", int64(2), " V NUMBER; BEGIN NULL; END;\n"}}
	db := sql.OpenDB(metadata)
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	source, err := plDebugLoadNativeFrameSource(context.Background(), conn, " Owner.Mixed ", " P.\"x ", plDebugNativeNamespaceTopLevel)
	if err != nil || source.ObjectID != "900719925474099312345" || len(source.Lines) != 2 {
		t.Fatalf("source=%+v error=%v", source, err)
	}
	if len(metadata.bindings) != 2 || metadata.bindings[0][0].Value != " Owner.Mixed " || metadata.bindings[0][1].Value != " P.\"x " || metadata.bindings[1][2].Value != "PROCEDURE" {
		t.Fatalf("source identity was guessed or normalized: %#v", metadata.bindings)
	}
	before := len(metadata.queries)
	if _, err := plDebugLoadNativeFrameSource(context.Background(), conn, "x", "y", 99); err == nil || len(metadata.queries) != before {
		t.Fatal("unknown namespace dispatched dictionary SQL")
	}
	metadata.objects = append(metadata.objects, metadata.objects[0])
	if _, err := plDebugLoadNativeFrameSource(context.Background(), conn, "x", "y", plDebugNativeNamespaceTopLevel); err == nil {
		t.Fatal("ambiguous frame source was accepted")
	}
}

func TestPLDebugNativeDeclarationTypesExcludeInitializersAndConstraints(t *testing.T) {
	types := map[string]string{}
	names, message := plDebugNativeDeclarations("DECLARE\n n CONSTANT NUMBER(38, 0) := 1;\n text_value VARCHAR2(40) NOT NULL DEFAULT 'x';\n rec pkg.record_type;\n BEGIN NULL; END;", 0, types)
	if message != "" || len(names) != 3 || !reflect.DeepEqual(types, map[string]string{"N": "NUMBER(38, 0)", "TEXT_VALUE": "VARCHAR2(40)", "REC": "pkg.record_type"}) {
		t.Fatalf("declared type discovery=%#v names=%#v error=%q", types, names, message)
	}
}

func TestPLDebugNativeDeclarationDiscoveryCRLF(t *testing.T) {
	types := map[string]string{}
	names, message := plDebugNativeDeclarations("-- heading\r\nDECLARE\r\n n NUMBER;\r\n value_text VARCHAR2(40);\r\nBEGIN NULL; END;", 5, types)
	if message != "" || !reflect.DeepEqual(names, []string{"N", "VALUE_TEXT"}) || !reflect.DeepEqual(types, map[string]string{"N": "NUMBER", "VALUE_TEXT": "VARCHAR2(40)"}) {
		t.Fatalf("names=%#v types=%#v error=%q", names, types, message)
	}
}

func TestPLDebugNativeDeclarationDiscoveryKeepsLocalsWithComplexFormals(t *testing.T) {
	for _, declaredType := range []string{"pkg.record_type", "tab.col%TYPE", "TIMESTAMP WITH TIME ZONE"} {
		types := map[string]string{}
		names, message := plDebugNativeDeclarations("PROCEDURE p(arg IN "+declaredType+") IS\n n NUMBER;\nBEGIN\n NULL;\nEND;", 4, types)
		if message != "" || !reflect.DeepEqual(names, []string{"ARG", "N"}) || types["ARG"] != declaredType || types["N"] != "NUMBER" {
			t.Fatalf("type=%q names=%#v types=%#v error=%q", declaredType, names, types, message)
		}
	}
	types := map[string]string{}
	source := "FUNCTION f(arg IN \"Pkg\".\"RecordType\" DEFAULT NULL) RETURN pkg.record_type IS\n PROCEDURE nested(p tab.col%TYPE);\n n NUMBER;\nBEGIN\n NULL;\nEND;"
	names, message := plDebugNativeDeclarations(source, 5, types)
	if message != "" || !reflect.DeepEqual(names, []string{"ARG", "N"}) || types["ARG"] != `"Pkg"."RecordType"` {
		t.Fatalf("function names=%#v types=%#v error=%q", names, types, message)
	}
}

func TestPLDebugNativePackageDeclarationsMergeFrozenSpecWithoutShadowOverwrite(t *testing.T) {
	types := map[string]string{}
	names, message := plDebugNativePackageDeclarations("PACKAGE BODY pkg IS\n PROCEDURE run IS\n shared_name VARCHAR2(10);\n BEGIN\n NULL;\n END;\nEND pkg;", 5, "PACKAGE pkg IS\n public_value NUMBER;\n shared_name NUMBER;\n PROCEDURE run;\nEND pkg;", types)
	if message != "" || !reflect.DeepEqual(names, []string{"SHARED_NAME", "PUBLIC_VALUE"}) || types["SHARED_NAME"] != "VARCHAR2(10)" || types["PUBLIC_VALUE"] != "NUMBER" {
		t.Fatalf("names=%#v types=%#v error=%q", names, types, message)
	}
}

func plDebugExternalPackageVariableFixture(t *testing.T) (*plDebugNativeEntry, *plDebugTargetTestConnector) {
	t.Helper()
	c := plDebugTargetFixture()
	owner, name, bodyID, specID := " Mixed Owner ", " External.\" Pkg ", "9007199254740993124", "9007199254740993123"
	body := "PACKAGE BODY pkg IS\n PROCEDURE run IS local_value NUMBER;\n BEGIN\n NULL;\n END;\nEND pkg;\n"
	spec := "PACKAGE pkg IS\n public_value NUMBER;\n PROCEDURE run;\nEND pkg;\n"
	rows := func(id, source string) [][]driver.Value {
		result := [][]driver.Value{}
		for i, text := range strings.SplitAfter(source, "\n") {
			if text != "" {
				result = append(result, []driver.Value{id, "VALID", "2026-10-25 00:00:00", int64(i + 1), text})
			}
		}
		return result
	}
	c.sourceRows = rows(bodyID, body)
	c.specRows = rows(specID, spec)
	c.objectsByType = map[string][][]driver.Value{"PACKAGE BODY": {{bodyID, "VALID"}}, "PACKAGE": {{specID, "VALID"}}}
	db := sql.OpenDB(c)
	t.Cleanup(func() { db.Close() })
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	namespace, line := int64(plDebugNativeNamespacePackageBody), int64(4)
	entry := &plDebugNativeEntry{server: &server{plConnection: conn}, nativeStack: &plDebugNativeStack{StopRevision: 7, Frames: []plDebugNativeStackFrame{{plDebugNativeStackRecord: plDebugNativeStackRecord{NativeFrameID: 1, Owner: &owner, Program: &name, Namespace: &namespace, Line: &line}, FrameIndex: 0, IdentityState: "native", SourceLine: &line, SourceRef: &plDebugNativeSourceRef{StopRevision: 7, NativeFrameID: 1, Owner: &owner, Name: &name, Namespace: &namespace, ObjectType: "PACKAGE BODY", ObjectID: &bodyID, Source: body, IdentityState: "native", LineBasis: "all_source"}}}}}
	return entry, c
}

func TestPLDebugNativeVariableNamesLoadsExternalPackageSpecOnOriginalConnection(t *testing.T) {
	entry, c := plDebugExternalPackageVariableFixture(t)
	types := map[string]string{}
	names, message := entry.nativeVariableNames(context.Background(), 0, 1, 7, types)
	if message != "" || !reflect.DeepEqual(names, []string{"LOCAL_VALUE", "PUBLIC_VALUE"}) || types["PUBLIC_VALUE"] != "NUMBER" {
		t.Fatalf("external names=%#v types=%#v error=%q", names, types, message)
	}
	if c.sourceReads != 2 || c.specReads != 2 {
		t.Fatalf("unpaired source reads: body=%d spec=%d", c.sourceReads, c.specReads)
	}
}

func TestPLDebugNativeExternalPackageFailuresPreserveOnlyStableLocals(t *testing.T) {
	for _, scenario := range []string{"missing_spec", "invalid_spec", "spec_gap", "spec_permission", "spec_budget", "spec_changed_same_ddl", "body_changed_same_ddl", "source_ref_mismatch", "remote_frame", "closed", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			entry, c := plDebugExternalPackageVariableFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			wantLocal := true
			zeroQueries := false
			switch scenario {
			case "spec_budget":
				c.specRows = nil
				for i := 0; i < 8190; i++ {
					c.specRows = append(c.specRows, []driver.Value{"9007199254740993123", "VALID", "2026-10-25 00:00:00", int64(i + 1), "\n"})
				}
			case "spec_permission":
				c.queryHook = func(n int) error {
					if n == 4 {
						return errors.New("spec permission denied")
					}
					return nil
				}
			case "missing_spec":
				c.objectsByType["PACKAGE"] = nil
			case "invalid_spec":
				c.specRows[0][1] = "INVALID"
			case "spec_gap":
				c.specRows[1][3] = int64(3)
			case "spec_changed_same_ddl":
				c.specNext = make([][]driver.Value, len(c.specRows))
				for i, row := range c.specRows {
					c.specNext[i] = append([]driver.Value(nil), row...)
				}
				c.specNext[1][4] = " changed_value NUMBER;\n"
			case "body_changed_same_ddl":
				c.sourceNext = make([][]driver.Value, len(c.sourceRows))
				for i, row := range c.sourceRows {
					c.sourceNext[i] = append([]driver.Value(nil), row...)
				}
				c.sourceNext[1][4] = " PROCEDURE run IS other_value NUMBER;\n"
				wantLocal = false
			case "source_ref_mismatch":
				other := "OTHER"
				entry.nativeStack.Frames[0].SourceRef.Name = &other
				wantLocal = false
				zeroQueries = true
			case "remote_frame":
				link := "REMOTE"
				entry.nativeStack.Frames[0].DBLink = &link
				wantLocal = false
				zeroQueries = true
			case "closed":
				entry.closeRequested = true
				wantLocal = false
				zeroQueries = true
			case "cancelled":
				cancel()
				wantLocal = false
				zeroQueries = true
			}
			types := map[string]string{}
			names, message := entry.nativeVariableNames(ctx, 0, 1, 7, types)
			if message == "" {
				t.Fatal("unconfirmed source reported complete")
			}
			if wantLocal {
				if !reflect.DeepEqual(names, []string{"LOCAL_VALUE"}) || types["LOCAL_VALUE"] != "NUMBER" {
					t.Fatalf("reliable locals lost: %#v %#v", names, types)
				}
			} else if len(names) != 0 || len(types) != 0 {
				t.Fatalf("unreliable frame declarations leaked: %#v %#v", names, types)
			}
			if zeroQueries && len(c.queries) != 0 {
				t.Fatalf("rejected frame queried metadata %d times", len(c.queries))
			}
		})
	}
}

func TestPLDebugNativeExternalPackageCancellationStopsEveryQueryStage(t *testing.T) {
	for stage := 1; stage <= 8; stage++ {
		entry, c := plDebugExternalPackageVariableFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		c.queryHook = func(n int) error {
			if n == stage {
				cancel()
			}
			return nil
		}
		_, message := entry.nativeVariableNames(ctx, 0, 1, 7, nil)
		cancel()
		if message == "" || len(c.queries) != stage {
			t.Fatalf("stage=%d message=%q queries=%d", stage, message, len(c.queries))
		}
	}
}

func TestPLDebugNativeVariableNamesUsesOnlyMatchingFrozenPackageSpec(t *testing.T) {
	owner, name := "OWNER", "PKG"
	namespace, line := int64(plDebugNativeNamespacePackageBody), int64(4)
	entry := &plDebugNativeEntry{
		targetSignatureSource: &plDebugNativeSource{Owner: owner, Name: name, State: "candidate", Lines: []plDebugNativeSourceLine{{Number: 1, Text: "PACKAGE pkg IS public_value NUMBER; END pkg;"}}},
		nativeStack: &plDebugNativeStack{StopRevision: 7, Frames: []plDebugNativeStackFrame{{
			plDebugNativeStackRecord: plDebugNativeStackRecord{NativeFrameID: 1, Owner: &owner, Program: &name, Namespace: &namespace},
			FrameIndex:               0, SourceLine: &line,
			SourceRef: &plDebugNativeSourceRef{StopRevision: 7, NativeFrameID: 1, Source: "PACKAGE BODY pkg IS\n PROCEDURE run IS local_value NUMBER;\n BEGIN\n NULL;\n END;\nEND pkg;"},
		}}},
	}
	names, message := entry.nativeVariableNames(context.Background(), 0, 1, 7, map[string]string{})
	if message != "" || !reflect.DeepEqual(names, []string{"LOCAL_VALUE", "PUBLIC_VALUE"}) {
		t.Fatalf("matching spec names=%#v error=%q", names, message)
	}
	entry.targetSignatureSource.Name = "OTHER"
	names, message = entry.nativeVariableNames(context.Background(), 0, 1, 7, nil)
	if message == "" || !reflect.DeepEqual(names, []string{"LOCAL_VALUE"}) {
		t.Fatalf("foreign spec used or missing spec reported complete: %#v / %q", names, message)
	}
}

func TestPLDebugNativeDeclarationDiscoveryTracksNestedBlockScopeAndShadowing(t *testing.T) {
	source := "DECLARE\n n NUMBER;\n outer_value NUMBER;\nBEGIN\n DECLARE\n n VARCHAR2(10);\n inner_value NUMBER;\n BEGIN\n NULL;\n END;\n NULL;\nEND;"
	if names, message := plDebugNativeDeclarationNames(source, 0); message == "" || len(names) != 0 {
		t.Fatalf("missing native line guessed nested shadowing: %#v / %q", names, message)
	}
	for _, sample := range []struct {
		line  int
		names []string
		nType string
	}{
		{9, []string{"N", "INNER_VALUE", "OUTER_VALUE"}, "VARCHAR2(10)"},
		{11, []string{"N", "OUTER_VALUE"}, "NUMBER"},
	} {
		types := map[string]string{}
		names, message := plDebugNativeDeclarations(source, sample.line, types)
		if message != "" || !reflect.DeepEqual(names, sample.names) || types["N"] != sample.nType {
			t.Fatalf("line=%d names=%#v types=%#v error=%q", sample.line, names, types, message)
		}
	}
}

func TestPLDebugNativeDeclarationDiscoveryIncludesLexicalParentButNotSibling(t *testing.T) {
	source := "PROCEDURE outer_proc(p_outer NUMBER) IS\n outer_local NUMBER;\n PROCEDURE sibling IS sibling_only NUMBER; BEGIN NULL; END;\n PROCEDURE inner_proc(p_inner VARCHAR2) IS\n inner_local NUMBER;\n BEGIN\n NULL;\n END;\nBEGIN inner_proc('x'); END;"
	names, message := plDebugNativeDeclarationNames(source, 7)
	if message != "" || !reflect.DeepEqual(names, []string{"P_INNER", "INNER_LOCAL", "P_OUTER", "OUTER_LOCAL"}) {
		t.Fatalf("names=%#v error=%q", names, message)
	}
	packageSource := "PACKAGE BODY pkg IS\n global_value NUMBER;\n PROCEDURE run(p NUMBER) IS\n local_value NUMBER;\n BEGIN\n NULL;\n END;\nEND pkg;"
	names, message = plDebugNativeDeclarationNames(packageSource, 6)
	if message != "" || !reflect.DeepEqual(names, []string{"P", "LOCAL_VALUE", "GLOBAL_VALUE"}) {
		t.Fatalf("package names=%#v error=%q", names, message)
	}
}
