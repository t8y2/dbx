package main

import (
	"strings"
	"testing"
)

func plDebugNativeRoutineFixture(code, kind, name string) plDebugNativeSource {
	source := plDebugNativeSource{Owner: "OWNER", Name: name, ObjectType: kind, State: "candidate", Lines: []plDebugNativeSourceLine{}}
	for i, line := range strings.Split(code, "\n") {
		source.Lines = append(source.Lines, plDebugNativeSourceLine{Number: int64(i + 1), Text: line + "\n"})
	}
	return source
}
func plDebugNativeRoutineTarget(name, param, kind string) plDebugNativeCandidate {
	pkg := "P"
	arg := "X"
	return plDebugNativeCandidate{Schema: "OWNER", PackageName: &pkg, ObjectName: name, ObjectType: "FUNCTION", SubprogramID: 7, Arguments: []plDebugNativeArgument{{Position: 0, Mode: "OUT", Type: kind}, {Name: &arg, Position: 1, Mode: "IN", Type: param}}}
}

func TestPLDebugNativeRoutineScopesUseSignaturesAndInnermostOwnership(t *testing.T) {
	code := `PACKAGE BODY P AS
 FUNCTION F(X NUMBER) RETURN NUMBER;
 FUNCTION F(X VARCHAR2) RETURN VARCHAR2 IS
 BEGIN
  RETURN X;
 END F;
 FUNCTION F(X IN NUMBER) RETURN NUMBER IS
  FUNCTION F(X VARCHAR2) RETURN VARCHAR2 IS
  BEGIN
   RETURN q'[ END F; FUNCTION FAKE(X NUMBER) RETURN NUMBER IS BEGIN END; ]';
  END F;
  V NUMBER := CASE WHEN X > 0 THEN 1 ELSE 0 END;
 BEGIN
  IF X > 0 THEN
   FOR I IN 1..2 LOOP
    V := CASE WHEN X = 1 THEN 3 ELSE 4 END;
   END LOOP;
  END IF;
  RETURN V;
 END F;
BEGIN
 NULL;
END P;`
	source := plDebugNativeRoutineFixture(code, "PACKAGE BODY", "P")
	target := plDebugNativeRoutineTarget("F", "NUMBER", "NUMBER")
	for _, test := range []struct {
		line  int
		state string
	}{{5, "other_routine"}, {10, "other_routine"}, {16, "verified"}, {22, "package_initialization"}} {
		got := plDebugNativeIdentifyRoutine(source, target, test.line)
		if got.State != test.state {
			t.Fatalf("line%d: %+v", test.line, got)
		}
		if test.state == "verified" && (got.SubprogramID == nil || *got.SubprogramID != 7 || got.FirstLine != 7 || got.LastLine != 20) {
			t.Fatalf("wrong unique declaration range: %+v", got)
		}
		if test.state == "other_routine" && got.SubprogramID != nil {
			t.Fatal("nested or other overload borrowed the selected SUBPROGRAM_ID")
		}
	}
}

func TestPLDebugNativeRoutineScopesPreserveQuotedIdentifiersAcrossLines(t *testing.T) {
	code := `PACKAGE BODY " Pkg.x " AS
 FUNCTION " f.
x "(" X.y " VARCHAR2 DEFAULT q'{ END; /* not a declaration */ }') RETURN VARCHAR2 IS
 BEGIN
  RETURN " X.y ";
 END " f.
x ";
END " Pkg.x ";`
	source := plDebugNativeRoutineFixture(code, "PACKAGE BODY", " Pkg.x ")
	pkg, arg := " Pkg.x ", " X.y "
	target := plDebugNativeCandidate{Schema: "OWNER", PackageName: &pkg, ObjectName: " f.\nx ", ObjectType: "FUNCTION", SubprogramID: 9, Arguments: []plDebugNativeArgument{{Position: 0, Mode: "OUT", Type: "VARCHAR2"}, {Name: &arg, Position: 1, Mode: "IN", Type: "VARCHAR2"}}}
	got := plDebugNativeIdentifyRoutine(source, target, 5)
	if got.State != "verified" || got.Name == nil || *got.Name != target.ObjectName {
		t.Fatalf("quoted source identity changed: %+v", got)
	}
	target.ObjectName = "F.X"
	if got := plDebugNativeIdentifyRoutine(source, target, 5); got.State == "verified" {
		t.Fatal("quoted name was folded or split")
	}
}

func TestPLDebugNativeRoutineScopesRejectAmbiguousOrUnclosedSources(t *testing.T) {
	for _, test := range []struct {
		name, code, state string
		line              int
	}{
		{"same_line", `PACKAGE BODY P AS FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END F; FUNCTION G(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END G; END P;`, "ambiguous", 1},
		{"duplicate", `PACKAGE BODY P AS
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END F;
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END F;
END P;`, "ambiguous", 2},
		{"alias", `PACKAGE BODY P AS
 SUBTYPE LOCAL_NUMBER IS NUMBER;
 FUNCTION F(X LOCAL_NUMBER) RETURN NUMBER IS BEGIN RETURN X; END F;
END P;`, "unresolved", 3},
		{"wrong_end", `PACKAGE BODY P AS
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END OTHER;
END P;`, "unresolved", 2},
		{"unclosed", `PACKAGE BODY P AS
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN X;`, "unresolved", 2},
		{"conditional", `PACKAGE BODY P AS
 $IF $$FLAG $THEN
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END F;
 $END
END P;`, "unresolved", 3},
		{"literal", `PACKAGE BODY P AS
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN 'unterminated; END F;
END P;`, "unresolved", 2},
		{"q_literal", `PACKAGE BODY P AS
 FUNCTION F(X NUMBER) RETURN NUMBER IS BEGIN RETURN q'[unterminated; END F;
END P;`, "unresolved", 2},
		{"comment", `PACKAGE BODY P AS /* unterminated`, "unresolved", 1},
		{"trailing_comma", `PACKAGE BODY P AS
 FUNCTION F(X NUMBER,) RETURN NUMBER IS BEGIN RETURN X; END F;
END P;`, "unresolved", 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := plDebugNativeIdentifyRoutine(plDebugNativeRoutineFixture(test.code, "PACKAGE BODY", "P"), plDebugNativeRoutineTarget("F", "NUMBER", "NUMBER"), test.line)
			if got.State != test.state {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestPLDebugNativeRoutineScopesHandleNestedDeclareAndStandalone(t *testing.T) {
	code := `FUNCTION F(X NUMBER) RETURN NUMBER IS
BEGIN
 DECLARE
  FUNCTION INNER_F RETURN NUMBER IS
  BEGIN
   RETURN 2;
  END INNER_F;
 BEGIN
  RETURN INNER_F;
 END;
END F;`
	source := plDebugNativeRoutineFixture(code, "FUNCTION", "F")
	target := plDebugNativeRoutineTarget("F", "NUMBER", "NUMBER")
	target.PackageName = nil
	if got := plDebugNativeIdentifyRoutine(source, target, 6); got.State != "other_routine" {
		t.Fatalf("nested declaration was assigned to parent: %+v", got)
	}
	if got := plDebugNativeIdentifyRoutine(source, target, 9); got.State != "verified" {
		t.Fatalf("anonymous nested block lost its owning routine: %+v", got)
	}
}
