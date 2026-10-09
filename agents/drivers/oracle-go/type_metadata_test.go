package main

import (
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestTypeSourceUsesExactIdentityAndRetainsBodyLines(t *testing.T) {
	owner, name := " Owner\" ", " Mixed.Type "
	lines := []string{"TYPE BODY \" Mixed.Type \" AS\n", "MEMBER FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END;\n", "END;\n"}
	db, calls := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{{
		queryContains: "FROM ALL_SOURCE", args: []driver.Value{owner, name, "TYPE BODY"},
		rows: [][]driver.Value{{lines[0]}, {lines[1]}, {lines[2]}},
	}})
	s := &server{db: db}
	value, err := s.getObjectSource(owner, name, "TYPE_BODY")
	if err != nil {
		t.Fatal(err)
	}
	if value["schema"] != owner || value["name"] != name || value["object_type"] != "TYPE_BODY" || value["editable"] != false {
		t.Fatalf("identity or read-only contract changed: %#v", value)
	}
	if value["source"] != "CREATE OR REPLACE "+strings.Join(lines, "") || calls.next != 1 {
		t.Fatalf("incomplete type body or extra lookup: %#v", value)
	}
}

func TestTypeSourceFallsBackToExactDDLAndRejectsMissingSource(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "ddl", true: "missing"}[missing], func(t *testing.T) {
			ddl := oracleViewSourceQueryStep{queryContains: "DBMS_METADATA.GET_DDL", args: []driver.Value{"TYPE", "Mixed", "Owner"}, rows: [][]driver.Value{{"CREATE TYPE \"Owner\".\"Mixed\" AS TABLE OF NUMBER"}}}
			if missing {
				ddl.err = errors.New("ORA-31603: object not found")
			}
			db, calls := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
				{queryContains: "FROM ALL_SOURCE", args: []driver.Value{"Owner", "Mixed", "TYPE"}}, ddl,
			})
			s := &server{db: db}
			value, err := s.getObjectSource("Owner", "Mixed", "TYPE")
			if missing {
				if err == nil || value != nil {
					t.Fatalf("missing source returned success: %#v", value)
				}
			} else if err != nil || value["source"] != ddl.rows[0][0] {
				t.Fatalf("full DDL was not preserved: %#v, %v", value, err)
			}
			if calls.next != 2 {
				t.Fatalf("unexpected case fallback queries: %d", calls.next)
			}
		})
	}
}

func TestTypeListQueryPreservesExactOwnerAndSpecBodyFilters(t *testing.T) {
	query := oracleListObjectsQuery(" Mixed.Owner\" ", metadataListConstraints{ObjectTypes: []string{"TYPE", "TYPE_BODY"}, Limit: 2, Offset: 1})
	if !reflect.DeepEqual(query.Args[:3], []any{" Mixed.Owner\" ", " Mixed.Owner\" ", " Mixed.Owner\" "}) {
		t.Fatalf("quoted owner changed: %#v", query.Args)
	}
	for _, predicate := range []string{"t.PREDEFINED = 'NO'", "NVL(o.GENERATED, 'N') = 'N'", "WHEN 'TYPE BODY' THEN 'TYPE_BODY'"} {
		if !strings.Contains(query.SQL, predicate) {
			t.Fatalf("missing dictionary filter %s", predicate)
		}
	}
	if !reflect.DeepEqual(query.Args[3:], []any{"TYPE", "TYPE_BODY", 3, 1}) {
		t.Fatalf("unexpected paging/filter args: %#v", query.Args)
	}
}

func TestOracleObjectValidityDoesNotInventValidStatus(t *testing.T) {
	for _, value := range []sql.NullString{{}, {String: "N/A", Valid: true}, {String: "UNKNOWN", Valid: true}} {
		if oracleObjectValidity(value) != nil {
			t.Fatalf("unknown state must stay unknown: %#v", value)
		}
	}
	if value := oracleObjectValidity(sql.NullString{String: "VALID", Valid: true}); value == nil || !*value {
		t.Fatal("VALID not preserved")
	}
	if value := oracleObjectValidity(sql.NullString{String: "INVALID", Valid: true}); value == nil || *value {
		t.Fatal("INVALID not preserved")
	}
}
