package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseXuguPackageMembers(t *testing.T) {
	spec := `
CREATE OR REPLACE PACKAGE "DbxPackage" AS
  -- PROCEDURE ignored_comment(p_value INT);
  TYPE rec_type IS RECORD (
    procedure_name VARCHAR(40),
    function_name VARCHAR(40)
  );
  PROCEDURE ping;
  PROCEDURE echo_value(p_value IN VARCHAR DEFAULT 'a,b');
  PROCEDURE echo_value(
    p_value IN NUMERIC(12, 2),
    p_result OUT VARCHAR
  );
  FUNCTION total_value(
    p_left IN NUMERIC,
    p_right IN NUMERIC DEFAULT ROUND(1.25, 1)
  ) RETURN NUMERIC(18, 2);
  FUNCTION "MixedCase"() RETURN VARCHAR;
  value_text VARCHAR := 'FUNCTION fake() RETURN INT;';
END "DbxPackage";`

	got := parseXuguPackageMembers(spec)
	want := []xuguPackageMember{
		{Name: "ping", Kind: "PROCEDURE"},
		{Name: "echo_value", Kind: "PROCEDURE", Signature: "p_value IN VARCHAR DEFAULT 'a,b'"},
		{Name: "echo_value", Kind: "PROCEDURE", Signature: "p_value IN NUMERIC(12, 2), p_result OUT VARCHAR"},
		{Name: "total_value", Kind: "FUNCTION", Signature: "p_left IN NUMERIC, p_right IN NUMERIC DEFAULT ROUND(1.25, 1)", ReturnType: "NUMERIC(18, 2)"},
		{Name: "MixedCase", Kind: "FUNCTION", ReturnType: "VARCHAR"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected package members:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestParseXuguPackageMembersHandlesEscapedIdentifiersAndComments(t *testing.T) {
	spec := `CREATE PACKAGE pkg AS
/* FUNCTION hidden RETURN INT; */
PROCEDURE "a""b"(p_text VARCHAR DEFAULT 'it''s -- not a comment');
FUNCTION f_value /* inline */ (p_value IN VARCHAR) RETURN /* type */ VARCHAR;
END;`
	got := parseXuguPackageMembers(spec)
	want := []xuguPackageMember{
		{Name: `a"b`, Kind: "PROCEDURE", Signature: "p_text VARCHAR DEFAULT 'it''s -- not a comment'"},
		{Name: "f_value", Kind: "FUNCTION", Signature: "p_value IN VARCHAR", ReturnType: "VARCHAR"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected escaped package members:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestParseXuguPackageMembersHandlesUnicodeIdentifiers(t *testing.T) {
	spec := `CREATE PACKAGE 中文包 AS
PROCEDURE 处理订单(订单号 IN VARCHAR, 数量 IN NUMERIC);
FUNCTION 统计数量(分类 IN VARCHAR) RETURN NUMERIC;
END;`
	got := parseXuguPackageMembers(spec)
	want := []xuguPackageMember{
		{Name: "处理订单", Kind: "PROCEDURE", Signature: "订单号 IN VARCHAR, 数量 IN NUMERIC"},
		{Name: "统计数量", Kind: "FUNCTION", Signature: "分类 IN VARCHAR", ReturnType: "NUMERIC"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected Unicode package members:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestParseXuguPackageMembersIgnoresBodyOnlyDeclarations(t *testing.T) {
	spec := `CREATE PACKAGE pkg AS
PROCEDURE public_proc(p_value INT);
END;`
	body := `CREATE PACKAGE BODY pkg AS
PROCEDURE private_proc IS BEGIN NULL; END;
PROCEDURE public_proc(p_value INT) IS BEGIN NULL; END;
END;`
	got := parseXuguPackageMembers(spec)
	if len(got) != 1 || got[0].Name != "public_proc" {
		t.Fatalf("package specification should expose only public members: %#v", got)
	}
	if strings.Contains(spec, "private_proc") || !strings.Contains(body, "private_proc") {
		t.Fatal("invalid test fixture")
	}
}

func TestXuguCompletionRoutineKindsAndFiltering(t *testing.T) {
	if !xuguCompletionRequestsRoutines([]string{"table", "function"}) {
		t.Fatal("function requests should enable package member lookup")
	}
	if xuguCompletionRequestsRoutines([]string{"table", "view"}) {
		t.Fatal("non-routine requests must keep using the generic completion fallback")
	}
	allowed := xuguCompletionRoutineKinds([]string{"procedure"})
	if !allowed["PROCEDURE"] || allowed["FUNCTION"] {
		t.Fatalf("unexpected procedure filter: %#v", allowed)
	}
	request := completionAssistantRequest{Mask: "VALUE", CaseSensitive: false, MatchMode: "contains"}
	if !xuguCompletionNameMatches("total_value", request) || xuguCompletionNameMatches("ping", request) {
		t.Fatal("case-insensitive contains filtering is incorrect")
	}
}

func TestXuguPackageSpecQueriesScopeCurrentDatabaseAndPreferExactIdentity(t *testing.T) {
	exact := strings.ToUpper(xuguPackageSpecSQL)
	if !strings.Contains(exact, "S.DB_ID = CURRENT_DB_ID") || !strings.Contains(exact, "S.SCHEMA_NAME = ?") || !strings.Contains(exact, "P.PACK_NAME = ?") {
		t.Fatalf("exact package lookup must be database-scoped and case-preserving: %s", xuguPackageSpecSQL)
	}
	fallback := strings.ToUpper(xuguPackageSpecCaseFoldedSQL)
	if !strings.Contains(fallback, "UPPER(S.SCHEMA_NAME) = UPPER(?)") || !strings.Contains(fallback, "UPPER(P.PACK_NAME) = UPPER(?)") {
		t.Fatalf("case-folded package lookup is incomplete: %s", xuguPackageSpecCaseFoldedSQL)
	}
	if !strings.Contains(fallback, "CASE WHEN S.SCHEMA_NAME = ? THEN 0") || !strings.Contains(fallback, "CASE WHEN P.PACK_NAME = ? THEN 0") {
		t.Fatalf("case-folded lookup must preserve exact-match priority: %s", xuguPackageSpecCaseFoldedSQL)
	}
}
