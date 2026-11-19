package main

import (
	"strings"
	"testing"
)

func plDebugLegacyDeclarationSource(text string) plDebugNativeSource {
	source := plDebugNativeSource{Name: "P", ObjectType: "PACKAGE"}
	for i, line := range strings.Split(text, "\n") {
		source.Lines = append(source.Lines, plDebugNativeSourceLine{Number: int64(i + 1), Text: line})
	}
	return source
}

func TestPLDebugLegacyCompiledCollectionDeclarations(t *testing.T) {
	source := plDebugLegacyDeclarationSource(`PACKAGE P AUTHID DEFINER AS
 SUBTYPE IX IS PLS_INTEGER;
 SUBTYPE IX2 IS IX;
 SUBTYPE SK IS VARCHAR2(30 CHAR);
 TYPE R IS RECORD("INDEX" VARCHAR2(30), N NUMBER := F('TYPE BAD IS TABLE OF NUMBER;'));
 TYPE A IS TABLE OF R INDEX BY IX2;
 TYPE S IS TABLE OF R INDEX BY SK;
 TYPE NT IS TABLE OF R NOT NULL;
 TYPE VA IS VARRAY(17) OF R;
 TYPE "small" IS VARYING ARRAY(7) OF R;
 FUNCTION F RETURN R%TYPE;
END;`)
	for _, test := range []struct{ name, kind, index, bound string }{{"A", "PL/SQL INDEX TABLE", "PLS_INTEGER", ""}, {"S", "PL/SQL INDEX TABLE", "VARCHAR2", ""}, {"NT", "TABLE", "", ""}, {"VA", "VARRAY", "", "17"}, {"small", "VARRAY", "", "7"}} {
		got, err := plDebugLegacyCollectionFromSource(source, test.name)
		if err != nil || got.kind != test.kind || got.indexType != test.index || got.upperBound != test.bound || len(got.element) != 1 || got.element[0].Text != "R" {
			t.Fatalf("collection %s changed declared identity or shape: %+v %v", test.name, got, err)
		}
		if got.elementNotNull != (test.name == "NT") || test.name == "S" && (got.indexLength != "30" || got.indexLengthUnit != "CHAR") {
			t.Fatalf("collection %s lost declared constraints: %+v", test.name, got)
		}
	}
	if _, err := plDebugLegacyCollectionFromSource(source, "SMALL"); err == nil {
		t.Fatal("quoted collection identity was case-folded")
	}
}

func TestPLDebugLegacyCollectionDeclarationsRejectUnresolvedSource(t *testing.T) {
	for _, declaration := range []string{
		"TYPE A IS VARRAY(LIMIT_VALUE) OF NUMBER;",
		"TYPE A IS VARRAY(1+2) OF NUMBER;",
		"TYPE A IS VARRAY(0) OF NUMBER;",
		"TYPE A IS TABLE OF NUMBER INDEX BY UNKNOWN_INDEX;",
		"SUBTYPE IX IS IX; TYPE A IS TABLE OF NUMBER INDEX BY IX;",
		"TYPE A IS TABLE OF NUMBER INDEX BY OTHER_PACKAGE.IX;",
		"TYPE A IS VARRAY(7) OF NUMBER INDEX BY PLS_INTEGER;",
		"TYPE A IS TABLE OF NUMBER; TYPE A IS TABLE OF VARCHAR2(10);",
	} {
		if _, err := plDebugLegacyCollectionFromSource(plDebugLegacyDeclarationSource("PACKAGE P AS "+declaration+" END;"), "A"); err == nil {
			t.Fatalf("unresolved source was accepted: %s", declaration)
		}
	}
	for _, text := range []string{"PACKAGE Q AS TYPE A IS TABLE OF NUMBER; END;", "PACKAGE BODY P AS TYPE A IS TABLE OF NUMBER; END;", "PACKAGE P WRAPPED"} {
		if _, err := plDebugLegacyCollectionFromSource(plDebugLegacyDeclarationSource(text), "A"); err == nil {
			t.Fatal("wrong or unavailable compiled package source was accepted")
		}
	}
}
