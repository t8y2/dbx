package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestXuguTypeMemberQueriesUseLowPrivilegeDictionary(t *testing.T) {
	for name, query := range map[string]string{
		"object type": xuguObjectTypeSQL,
		"attributes":  xuguTypeAttributesSQL,
		"methods":     xuguTypeMethodsSQL,
		"parameters":  xuguTypeMethodParametersSQL,
	} {
		upper := strings.ToUpper(query)
		if !strings.Contains(upper, "ALL_") {
			t.Fatalf("%s metadata should query ALL_* views: %s", name, query)
		}
		if strings.Contains(upper, "SYS_") {
			t.Fatalf("%s metadata must not require SYS_* privileges: %s", name, query)
		}
	}
	if !strings.Contains(xuguObjectTypeCaseFoldedSQL, "CASE WHEN s.SCHEMA_NAME = ? THEN 0 ELSE 1 END") {
		t.Fatalf("case-folded type lookup must retain exact-match priority: %s", xuguObjectTypeCaseFoldedSQL)
	}
	if !strings.Contains(xuguTypeMethodsCaseFoldedSQL, "CASE WHEN M.TYPE_NAME = ? THEN 0 ELSE 1 END") {
		t.Fatalf("case-folded method lookup must retain exact-match priority: %s", xuguTypeMethodsCaseFoldedSQL)
	}
}

func TestXuguCompletionAssistantListsTypeAttributesAndMethods(t *testing.T) {
	db, err := sql.Open("xugu-test-type-members", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	s.params.Database = "TEST_DB"
	s.currentDatabase = "TEST_DB"

	response, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":1,"method":"completion_assistant_search_v1","params":{"database":"TEST_DB","schema":"AppSchema","parent_schema":"AppSchema","parent_name":"OrderType","parent_type":"type","object_kinds":["column","routine"],"max_results":20}}`)
	if shutdown || response.Error != nil {
		t.Fatalf("type member request failed: shutdown=%v error=%v", shutdown, response.Error)
	}
	encoded, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result completionAssistantResponse
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Candidates) != 4 {
		t.Fatalf("candidate count = %d, want 4: %#v", len(result.Candidates), result.Candidates)
	}
	if got := result.Candidates[0]; got.Kind != "column" || got.Name != "orderId" || got.DataType == nil || *got.DataType != "INTEGER" {
		t.Fatalf("unexpected type attribute: %#v", got)
	}
	if got := result.Candidates[2]; got.Kind != "function" || got.Name != "Total" || got.Signature == nil || *got.Signature != "quantity INTEGER, price NUMERIC(12,2)" || got.DataType == nil || *got.DataType != "NUMERIC(18,2)" {
		t.Fatalf("unexpected type function: %#v", got)
	}
	if got := result.Candidates[3]; got.Kind != "procedure" || got.Name != "Rename" || got.Signature == nil || *got.Signature != "NEW_LABEL VARCHAR(40)" {
		t.Fatalf("unexpected type procedure: %#v", got)
	}
	for _, candidate := range result.Candidates {
		if candidate.ParentSchema == nil || *candidate.ParentSchema != "AppSchema" || candidate.ParentName == nil || *candidate.ParentName != "OrderType" {
			t.Fatalf("candidate must retain its owning type: %#v", candidate)
		}
	}
}

func TestXuguCompletionAssistantLeavesCollectionTypesWithoutMembers(t *testing.T) {
	db, err := sql.Open("xugu-test-type-members", "collection")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := newServer()
	s.db = db
	result, err := s.completionAssistantSearch(completionAssistantRequest{
		Database:     "TEST_DB",
		Schema:       "AppSchema",
		ParentSchema: "AppSchema",
		ParentName:   "OrderList",
		ParentType:   "type",
		ObjectKinds:  []string{"column", "routine"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Candidates) != 0 || result.FallbackUsed {
		t.Fatalf("collection type should expose no object members, got %#v", result)
	}
}

func TestXuguCompletionAssistantFiltersAndLimitsTypeMembers(t *testing.T) {
	db, err := sql.Open("xugu-test-type-members", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := newServer()
	s.db = db
	result, err := s.completionAssistantSearch(completionAssistantRequest{
		Database:      "TEST_DB",
		Schema:        "AppSchema",
		ParentSchema:  "AppSchema",
		ParentName:    "OrderType",
		ParentType:    "type",
		ObjectKinds:   []string{"routine"},
		Mask:          "re",
		MatchMode:     "prefix",
		CaseSensitive: false,
		MaxResults:    1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Candidates) != 1 || result.Candidates[0].Name != "Rename" || result.Incomplete {
		t.Fatalf("unexpected filtered members: %#v", result)
	}
}

func TestXuguCompletionAssistantDispatchesPackageAndTypeMembersSeparately(t *testing.T) {
	db, err := sql.Open("xugu-test-type-members", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := newServer()
	s.db = db

	packageResult, err := s.completionAssistantSearch(completionAssistantRequest{
		Database: "TEST_DB", Schema: "AppSchema", ParentSchema: "AppSchema", ParentName: "OrderAPI", ParentType: "package", ObjectKinds: []string{"routine"},
	})
	if err != nil {
		t.Fatalf("package member request failed: %v", err)
	}
	if len(packageResult.Candidates) != 2 || packageResult.Candidates[0].Name != "create_order" || packageResult.Candidates[1].Name != "order_total" {
		t.Fatalf("unexpected package members: %#v", packageResult.Candidates)
	}

	legacyPackageResult, err := s.completionAssistantSearch(completionAssistantRequest{
		Database: "TEST_DB", Schema: "AppSchema", ParentSchema: "AppSchema", ParentName: "OrderAPI", ObjectKinds: []string{"routine"},
	})
	if err != nil || len(legacyPackageResult.Candidates) != 2 {
		t.Fatalf("legacy package request must remain supported, result=%#v err=%v", legacyPackageResult, err)
	}
}

func TestParseXuguObjectTypeMembersPreservesQuotedNamesAndSignatures(t *testing.T) {
	attributes, methods := parseXuguObjectTypeMembers(`CREATE TYPE "Order Type" AS OBJECT (
  /* attributes may use quoted identifiers */
  "line""Code" VARCHAR(40),
  amount NUMERIC(12, 2),
  STATIC FUNCTION normalize(p_value IN VARCHAR(100), p_result OUT VARCHAR(100)) RETURN VARCHAR(100),
  MEMBER FUNCTION normalize(p_value INTEGER) RETURN INTEGER PIPELINED,
  CONSTRUCTOR PROCEDURE "Order Type"(p_id INTEGER) RETURN SELF AS RESULT,
  -- A quoted routine name and IN OUT parameter are both significant.
  MEMBER PROCEDURE "set Label"(p_label IN OUT VARCHAR(80))
)`)

	if len(attributes) != 2 {
		t.Fatalf("attribute count = %d, want 2: %#v", len(attributes), attributes)
	}
	if got := attributes[0]; got.Name != `line"Code` || got.DataType != "VARCHAR(40)" {
		t.Fatalf("unexpected quoted attribute: %#v", got)
	}
	if got := attributes[1]; got.Name != "amount" || got.DataType != "NUMERIC(12, 2)" {
		t.Fatalf("unexpected numeric attribute: %#v", got)
	}
	if len(methods) != 4 {
		t.Fatalf("method count = %d, want 4: %#v", len(methods), methods)
	}
	if got := methods[0]; got.Kind != "FUNCTION" || got.Name != "normalize" || got.Signature != "p_value VARCHAR(100), p_result OUT VARCHAR(100)" || got.ReturnType != "VARCHAR(100)" {
		t.Fatalf("unexpected static function: %#v", got)
	}
	if got := methods[1]; got.Kind != "FUNCTION" || got.Signature != "p_value INTEGER" || got.ReturnType != "INTEGER" {
		t.Fatalf("unexpected overloaded function: %#v", got)
	}
	if got := methods[2]; got.Kind != "PROCEDURE" || got.Name != "Order Type" || got.Signature != "p_id INTEGER" {
		t.Fatalf("unexpected constructor procedure: %#v", got)
	}
	if got := methods[3]; got.Kind != "PROCEDURE" || got.Name != "set Label" || got.Signature != "p_label IN OUT VARCHAR(80)" {
		t.Fatalf("unexpected quoted procedure: %#v", got)
	}
}

type xuguTypeMembersDriver struct{}

func (d *xuguTypeMembersDriver) Open(name string) (driver.Conn, error) {
	return &xuguTypeMembersConn{collection: name == "collection"}, nil
}

type xuguTypeMembersConn struct {
	collection bool
}

func (c *xuguTypeMembersConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguTypeMembersConn) Close() error              { return nil }
func (c *xuguTypeMembersConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

func (c *xuguTypeMembersConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	upper := strings.ToUpper(query)
	switch {
	case strings.Contains(upper, "FROM ALL_PACKAGES"):
		return &xuguStaticRows{columns: []string{"SPEC"}, values: [][]driver.Value{{`CREATE PACKAGE OrderAPI AS
  PROCEDURE create_order(p_id IN INTEGER);
  FUNCTION order_total(p_id IN INTEGER) RETURN NUMERIC;
END;`}}}, nil
	case strings.Contains(upper, "FROM ALL_TYPES"):
		kind := int64(xuguObjectTypeKind)
		if c.collection {
			kind = 1005
		}
		return &xuguStaticRows{columns: []string{"UDT_TYPE", "SPEC"}, values: [][]driver.Value{{kind, ""}}}, nil
	case strings.Contains(upper, "FROM ALL_TYPE_ATTRS"):
		return &xuguStaticRows{
			columns: []string{"ATTR_NAME", "ATTR_NO", "ATTR_TYPE_OWNER", "ATTR_TYPE_NAME", "ATTR_TYPE_MOD"},
			values:  [][]driver.Value{{"orderId", int64(1), nil, "INTEGER", nil}, {"displayName", int64(2), nil, "VARCHAR", "(80)"}},
		}, nil
	case strings.Contains(upper, "FROM ALL_TYPE_METHODS"):
		return &xuguStaticRows{
			columns: []string{"METHOD_NAME", "METHOD_NO", "METHOD_TYPE", "RESULT_TYPE_OWNER", "RESULT_TYPE_NAME", "RESULT_TYPE_MOD"},
			values:  [][]driver.Value{{"Total", int64(1), "FUNCTION", nil, "NUMERIC", "(18,2)"}, {"Rename", int64(2), "PROCEDURE", nil, nil, nil}},
		}, nil
	case strings.Contains(upper, "FROM ALL_METHOD_PARAMS"):
		if len(args) > 3 && args[3].Value == int64(2) {
			return &xuguStaticRows{
				columns: []string{"PARAM_NAME", "PARAM_NO", "PARAM_MODE", "PARAM_TYPE_OWNER", "PARAM_TYPE_NAME", "PARAM_TYPE_MOD"},
				values:  [][]driver.Value{{"NEW_LABEL", int64(1), "IN", nil, "VARCHAR", "(40)"}},
			}, nil
		}
		return &xuguStaticRows{
			columns: []string{"PARAM_NAME", "PARAM_NO", "PARAM_MODE", "PARAM_TYPE_OWNER", "PARAM_TYPE_NAME", "PARAM_TYPE_MOD"},
			values:  [][]driver.Value{{"quantity", int64(1), "IN", nil, "INTEGER", nil}, {"price", int64(2), "IN", nil, "NUMERIC", "(12,2)"}},
		}, nil
	}
	return nil, fmt.Errorf("unexpected query: %s", query)
}

func init() {
	sql.Register("xugu-test-type-members", &xuguTypeMembersDriver{})
}
