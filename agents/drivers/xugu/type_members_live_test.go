package main

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestLiveXuguTypeMemberCatalog(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}
	params := connectParams{
		Host:     os.Getenv("XUGU_LIVE_HOST"),
		Port:     defaultXuguPort,
		Database: os.Getenv("XUGU_LIVE_DATABASE"),
		Username: os.Getenv("XUGU_LIVE_USERNAME"),
		Password: os.Getenv("XUGU_LIVE_PASSWORD"),
	}
	if params.Host == "" || params.Database == "" || params.Username == "" || params.Password == "" {
		t.Skip("XUGU_LIVE_HOST, XUGU_LIVE_DATABASE, XUGU_LIVE_USERNAME, and XUGU_LIVE_PASSWORD are required")
	}
	db, err := openDB(params)
	if err != nil {
		t.Skipf("live XuguDB is unavailable: %v", err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	typeName := "DBX_TYPE_MEMBER_LIVE"
	_, _ = db.ExecContext(ctx, "DROP TYPE "+quoteIdentifier(typeName))
	_, err = db.ExecContext(ctx, `CREATE OR REPLACE TYPE DBX_TYPE_MEMBER_LIVE AS OBJECT (
  item_id INTEGER,
  item_name VARCHAR(80),
  STATIC FUNCTION compute_total(quantity INTEGER, price NUMERIC(12,2)) RETURN NUMERIC(18,2),
  MEMBER PROCEDURE rename_item(new_name VARCHAR(40))
)`)
	if err != nil {
		t.Skipf("cannot create live test type: %v", err)
	}
	defer func() { _, _ = db.ExecContext(context.Background(), "DROP TYPE "+quoteIdentifier(typeName)) }()
	_, err = db.ExecContext(ctx, `CREATE OR REPLACE TYPE BODY DBX_TYPE_MEMBER_LIVE AS
  STATIC FUNCTION compute_total(quantity INTEGER, price NUMERIC(12,2)) RETURN NUMERIC(18,2) IS
  BEGIN RETURN quantity * price; END;
  MEMBER PROCEDURE rename_item(new_name VARCHAR(40)) IS
  BEGIN item_name := new_name; END;
END;`)
	if err != nil {
		t.Fatalf("create type body: %v", err)
	}
	s := newServer()
	s.db = db
	s.params = params
	s.currentDatabase = params.Database
	result, err := s.completionAssistantSearch(completionAssistantRequest{
		Database: params.Database, Schema: params.Username, ParentSchema: params.Username, ParentName: typeName, ParentType: "type",
		ObjectKinds: []string{"column", "routine"}, MaxResults: 50,
	})
	if err != nil {
		t.Fatalf("read type members: %v", err)
	}
	if len(result.Candidates) != 4 {
		t.Fatalf("member count = %d, want 4: %#v", len(result.Candidates), result.Candidates)
	}
	want := map[string]string{"item_id": "column", "item_name": "column", "compute_total": "function", "rename_item": "procedure"}
	for _, candidate := range result.Candidates {
		if want[candidate.Name] != candidate.Kind {
			t.Fatalf("unexpected member %#v", candidate)
		}
	}
	for _, candidate := range result.Candidates {
		if candidate.Name == "compute_total" && (candidate.Signature == nil || *candidate.Signature != "quantity INTEGER, price NUMERIC(12,2)") {
			t.Fatalf("function signature = %#v", candidate.Signature)
		}
		if candidate.Name == "rename_item" && (candidate.Signature == nil || *candidate.Signature != "new_name VARCHAR(40)") {
			t.Fatalf("procedure signature = %#v", candidate.Signature)
		}
	}

	if _, err := db.ExecContext(ctx, "DROP TYPE "+quoteIdentifier(typeName)); err != nil {
		t.Fatalf("drop live type: %v", err)
	}
	_, err = db.ExecContext(ctx, "CREATE OR REPLACE TYPE DBX_TYPE_MEMBER_LIVE AS VARRAY(3) OF INTEGER")
	if err != nil {
		t.Fatalf("create live collection type: %v", err)
	}
	result, err = s.completionAssistantSearch(completionAssistantRequest{
		Database: params.Database, Schema: params.Username, ParentSchema: params.Username, ParentName: typeName, ParentType: "type",
		ObjectKinds: []string{"column", "routine"}, MaxResults: 50,
	})
	if err != nil {
		t.Fatalf("read collection members: %v", err)
	}
	if len(result.Candidates) != 0 {
		t.Fatalf("collection type must not expose object members: %#v", result.Candidates)
	}
	if _, err := db.ExecContext(ctx, "DROP TYPE "+quoteIdentifier(typeName)); err != nil {
		t.Fatalf("drop live collection type: %v", err)
	}
	if _, err := db.ExecContext(ctx, "SELECT 1"); err != nil {
		t.Fatalf("live connection should remain usable after metadata reads: %v", err)
	}
}
