package main

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestPLDebugLegacyDictionaryRequiresConfirmedVersionAndDoesNotFallbackOnErrors(t *testing.T) {
	for _, test := range []struct {
		name                                  string
		version, release                      int64
		missing, readError, wantError, legacy bool
	}{
		{"11.2", 11, 2, false, false, false, true},
		{"12.1-expanded-uses-modern-views", 12, 1, false, false, false, false},
		{"18-modern", 18, 0, false, false, false, false},
		{"21-modern", 21, 0, false, false, false, false},
		{"unverified-11.1", 11, 1, false, false, true, false},
		{"unverified-10.2", 10, 2, false, false, true, false},
		{"missing-version", 11, 2, true, false, true, false},
		{"permission-error", 11, 2, false, true, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			connector := &plDebugGraphTestConnector{dictionaryVersion: [2]sql.NullInt64{{Int64: test.version, Valid: !test.missing}, {Int64: test.release, Valid: true}}}
			if test.readError {
				connector.dictionaryVersionError = errors.New("ORA-00942: test dictionary permission error")
			}
			db := sql.OpenDB(connector)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			loader := plDebugNativeTypeLoader{ctx: context.Background(), conn: conn}
			layout, err := loader.legacyDictionaryLayout()
			if (err != nil) != test.wantError || (layout != nil) != test.legacy || connector.dictionaryVersionCalls != 1 || len(connector.queries) != 0 {
				t.Fatalf("layout=%+v error=%v versionCalls=%d queries=%v", layout, err, connector.dictionaryVersionCalls, connector.queries)
			}
			if layout != nil && (layout.Version != 11 || layout.Release != 2 || layout.Layout != "expanded-all-arguments") {
				t.Fatal("legacy layout froze a guessed version")
			}
		})
	}
}

func TestPLDebugLegacyDerivedGraphKeepsNominalIdentityAndOrigin(t *testing.T) {
	candidate, details := plDebugLegacyArgumentFixture()
	roots, err := plDebugLegacyArgumentTree(candidate, details)
	if err != nil {
		t.Fatal(err)
	}
	source := plDebugLegacyDeclarationSource("PACKAGE P AS TYPE R IS RECORD(N NUMBER,T VARCHAR2(30)); TYPE A IS TABLE OF R INDEX BY PLS_INTEGER; END;")
	source.Owner = "S"
	record, err := plDebugLegacyDerivedType(roots[0], source)
	if err != nil || record.Definition.text("TYPECODE") != "PL/SQL RECORD" || len(record.Attributes) != 2 || record.Attributes[1].text("ATTR_NAME") != "T" || record.Attributes[1].text("ATTR_TYPE_NAME") != "VARCHAR2" || record.LegacyOrigin == nil || record.LegacyOrigin.Source != "argument-tree" {
		t.Fatalf("derived record: %+v %v", record, err)
	}
	array, err := plDebugLegacyDerivedType(roots[1], source)
	if err != nil || len(array.Collections) != 1 || array.Collections[0].text("COLL_TYPE") != "PL/SQL INDEX TABLE" || array.Collections[0].text("INDEX_BY") != "PLS_INTEGER" || array.Collections[0].text("ELEM_TYPE_NAME") != "R" || array.Collections[0].text("ELEM_TYPE_PACKAGE") != "P" || array.LegacyOrigin.Sequence != 4 {
		t.Fatalf("derived array: %+v %v", array, err)
	}
	for _, ddl := range []string{"TYPE A IS TABLE OF NUMBER INDEX BY PLS_INTEGER;", "TYPE A IS TABLE OF OTHER.R INDEX BY PLS_INTEGER;", "TYPE A IS TABLE OF R;", "TYPE A IS VARRAY(7) OF R;"} {
		bad := plDebugLegacyDeclarationSource("PACKAGE P AS " + ddl + " END;")
		bad.Owner = "S"
		if _, err := plDebugLegacyDerivedType(roots[1], bad); err == nil {
			t.Fatalf("contradictory source accepted: %s", ddl)
		}
	}
	if len(details) != 7 || details[4].text("SEQUENCE") != "5" || details[4]["ARGUMENT_NAME"] != nil {
		t.Fatal("derived graph changed raw expanded evidence")
	}
}

func TestPLDebugLegacyDerivedCollectionRetainsSourceConstraints(t *testing.T) {
	candidate, details := plDebugLegacyArgumentFixture()
	roots, err := plDebugLegacyArgumentTree(candidate, details)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ declaration, argumentType, kind, index, length, unit, capacity, nulls string }{
		{"TABLE OF R INDEX BY VARCHAR2(30 CHAR)", "PL/SQL TABLE", "PL/SQL INDEX TABLE", "VARCHAR2", "30", "CHAR", "", "YES"},
		{"TABLE OF R INDEX BY VARCHAR2(30 BYTE)", "PL/SQL TABLE", "PL/SQL INDEX TABLE", "VARCHAR2", "30", "BYTE", "", "YES"},
		{"TABLE OF R NOT NULL", "TABLE", "TABLE", "", "", "", "", "NO"},
		{"VARRAY(7) OF R", "VARRAY", "VARYING ARRAY", "", "", "", "7", "YES"},
	} {
		tree := *roots[1]
		tree.argument.Type = test.argumentType
		source := plDebugLegacyDeclarationSource("PACKAGE P AS TYPE A IS " + test.declaration + "; END;")
		source.Owner = "S"
		node, err := plDebugLegacyDerivedType(&tree, source)
		if err != nil {
			t.Fatalf("%s: %v", test.declaration, err)
		}
		row := node.Collections[0]
		for key, want := range map[string]string{"COLL_TYPE": test.kind, "INDEX_BY": test.index, "INDEX_LENGTH": test.length, "INDEX_LENGTH_UNIT": test.unit, "UPPER_BOUND": test.capacity, "NULLS_STORED": test.nulls} {
			if row.text(key) != want {
				t.Fatalf("%s %s: got %q want %q", test.declaration, key, row.text(key), want)
			}
		}
		if node.Definition["TYPE_OID"] != nil || node.LegacyOrigin == nil {
			t.Fatal("derived type claimed native dictionary identity")
		}
	}
}
