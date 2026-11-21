package main

import (
	"reflect"
	"testing"
)

func TestParseOracleCompiledObject(t *testing.T) {
	cases := []struct {
		sql    string
		owner  string
		name   string
		types  []string
		action string
	}{
		{"CREATE PROCEDURE p IS BEGIN NULL; END;", "", "P", []string{"PROCEDURE"}, "created"},
		{"create or replace function app.f return number is begin return 1; end;", "APP", "F", []string{"FUNCTION"}, "created"},
		{"CREATE OR REPLACE EDITIONABLE PROCEDURE app.\"Mixed\"(a NUMBER) IS BEGIN NULL; END;", "APP", "Mixed", []string{"PROCEDURE"}, "created"},
		{"CREATE OR REPLACE NONEDITIONABLE PACKAGE p AS END;", "", "P", []string{"PACKAGE"}, "created"},
		{"CREATE OR REPLACE PACKAGE  BODY \"A\" . \"B\" AS END;", "A", "B", []string{"PACKAGE BODY"}, "created"},
		{"CREATE TRIGGER t\nBEFORE INSERT ON x BEGIN NULL; END;", "", "T", []string{"TRIGGER"}, "created"},
		{"CREATE TYPE t AS OBJECT (a NUMBER)", "", "T", []string{"TYPE"}, "created"},
		{"CREATE TYPE BODY t AS END;", "", "T", []string{"TYPE BODY"}, "created"},
		{"CREATE OR REPLACE FORCE EDITIONABLE VIEW v(a) AS SELECT 1 FROM DUAL", "", "V", []string{"VIEW"}, "created"},
		{"CREATE PROCEDURE IF NOT EXISTS p IS BEGIN NULL; END;", "", "P", []string{"PROCEDURE"}, "created"},
		{"-- note\n/* block */ CREATE /* inner */ PROCEDURE p IS BEGIN NULL; END;", "", "P", []string{"PROCEDURE"}, "created"},
		{"ALTER PROCEDURE p COMPILE", "", "P", []string{"PROCEDURE"}, "compiled"},
		{"ALTER TRIGGER app.t COMPILE DEBUG", "APP", "T", []string{"TRIGGER"}, "compiled"},
		{"ALTER PACKAGE p COMPILE", "", "P", []string{"PACKAGE", "PACKAGE BODY"}, "compiled"},
		{"ALTER PACKAGE p COMPILE PACKAGE", "", "P", []string{"PACKAGE", "PACKAGE BODY"}, "compiled"},
		{"ALTER PACKAGE p COMPILE BODY", "", "P", []string{"PACKAGE BODY"}, "compiled"},
		{"ALTER PACKAGE p COMPILE DEBUG SPECIFICATION", "", "P", []string{"PACKAGE"}, "compiled"},
		{"ALTER TYPE t COMPILE", "", "T", []string{"TYPE", "TYPE BODY"}, "compiled"},
	}
	for _, tc := range cases {
		object, ok := parseOracleCompiledObject(tc.sql)
		if !ok {
			t.Fatalf("%q was not recognised", tc.sql)
		}
		if object.owner != tc.owner || object.name != tc.name || object.action != tc.action || !reflect.DeepEqual(object.types, tc.types) {
			t.Fatalf("%q parsed as %+v", tc.sql, object)
		}
	}
}

func TestParseOracleCompiledObjectIgnoresOtherStatements(t *testing.T) {
	for _, sqlText := range []string{
		"SELECT 'CREATE PROCEDURE p' FROM DUAL",
		"INSERT INTO t VALUES ('CREATE PROCEDURE p')",
		"CREATE TABLE t (id NUMBER)",
		"CREATE INDEX i ON t (id)",
		"ALTER TRIGGER t DISABLE",
		"ALTER TABLE t ADD c NUMBER",
		"ALTER SESSION SET PLSQL_WARNINGS='ENABLE:ALL'",
		"DROP PROCEDURE p",
		"BEGIN NULL; END;",
		"-- CREATE PROCEDURE p IS\nBEGIN NULL; END;",
	} {
		if object, ok := parseOracleCompiledObject(sqlText); ok {
			t.Fatalf("%q unexpectedly parsed as %+v", sqlText, object)
		}
	}
}

func TestOracleCompilationErrorsSQLBindsOwnerOnlyWhenQualified(t *testing.T) {
	query, args := oracleCompilationErrorsSQL(oracleCompiledObject{name: "P", types: []string{"PACKAGE", "PACKAGE BODY"}})
	want := "SELECT OWNER, NAME, TYPE, LINE, POSITION, TEXT FROM ALL_ERRORS WHERE NAME = :1 AND OWNER = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AND TYPE IN (:2, :3) AND ATTRIBUTE = 'ERROR' ORDER BY TYPE, SEQUENCE"
	if query != want || !reflect.DeepEqual(args, []any{"P", "PACKAGE", "PACKAGE BODY"}) {
		t.Fatalf("query %q args %v", query, args)
	}
	query, args = oracleCompilationErrorsSQL(oracleCompiledObject{owner: "APP", name: "P", types: []string{"PROCEDURE"}})
	want = "SELECT OWNER, NAME, TYPE, LINE, POSITION, TEXT FROM ALL_ERRORS WHERE NAME = :1 AND OWNER = :2 AND TYPE IN (:3) AND ATTRIBUTE = 'ERROR' ORDER BY TYPE, SEQUENCE"
	if query != want || !reflect.DeepEqual(args, []any{"P", "APP", "PROCEDURE"}) {
		t.Fatalf("query %q args %v", query, args)
	}
}

func TestOracleCompilationErrorCarriesVendorCode(t *testing.T) {
	code := oracleVendorCode(oracleCompilationError{message: "x"})
	if code == nil || *code != oracleCompilationErrorCode {
		t.Fatalf("vendor code %v", code)
	}
}
