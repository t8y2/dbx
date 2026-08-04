package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
)

func TestVastbaseListIndexesMapsCatalogVectorsInOneQuery(t *testing.T) {
	state := &vastbaseIndexMetadataTestState{}
	driverName := fmt.Sprintf("vastbase-index-metadata-%d", vastbaseIndexMetadataDriverSequence.Add(1))
	sql.Register(driverName, &vastbaseIndexMetadataTestDriver{state: state})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	server := newServer()
	server.db = db
	server.mode.postgresCatalog = true
	indexes, err := server.listIndexes("app", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if state.queryCount != 1 {
		t.Fatalf("listIndexes executed %d metadata queries, want 1", state.queryCount)
	}
	lowerQuery := strings.ToLower(state.query)
	for _, unsupported := range []string{"unnest(", "with ordinality", "generate_series(", "array_length("} {
		if strings.Contains(lowerQuery, unsupported) {
			t.Fatalf("index query contains legacy-incompatible array SQL %q: %s", unsupported, state.query)
		}
	}
	if !strings.Contains(lowerQuery, "union all") || !strings.Contains(lowerQuery, "cast(ix.indkey as varchar)") {
		t.Fatalf("index query must return raw catalog vectors and attributes in one statement: %s", state.query)
	}
	if len(indexes) != 2 {
		t.Fatalf("listIndexes returned %d indexes, want 2: %+v", len(indexes), indexes)
	}
	assertVastbaseIndex(t, indexes[0], "orders_code_idx", []string{"code", "tenant_id"}, true, false, "btree")
	assertVastbaseIndex(t, indexes[1], "orders_pkey", []string{"id", "tenant_id"}, true, true, "btree")
}

func TestParseVastbaseAttributeNumbersSupportsCatalogRepresentations(t *testing.T) {
	for _, test := range []struct {
		raw      string
		expected string
	}{
		{raw: "1 2", expected: "1,2"},
		{raw: "{3,2}", expected: "3,2"},
		{raw: "[4, 5]", expected: "4,5"},
		{raw: "", expected: ""},
	} {
		values := parseVastbaseAttributeNumbers(test.raw)
		parts := make([]string, 0, len(values))
		for _, value := range values {
			parts = append(parts, fmt.Sprint(value))
		}
		if actual := strings.Join(parts, ","); actual != test.expected {
			t.Fatalf("parseVastbaseAttributeNumbers(%q) = %q, want %q", test.raw, actual, test.expected)
		}
	}
}

func assertVastbaseIndex(t *testing.T, index indexInfo, name string, columns []string, unique, primary bool, indexType string) {
	t.Helper()
	if index.Name != name || strings.Join(index.Columns, ",") != strings.Join(columns, ",") || index.IsUnique != unique || index.IsPrimary != primary || index.IndexType == nil || *index.IndexType != indexType {
		t.Fatalf("unexpected index: %+v", index)
	}
}

var vastbaseIndexMetadataDriverSequence atomic.Uint64

type vastbaseIndexMetadataTestState struct {
	queryCount int
	query      string
}

type vastbaseIndexMetadataTestDriver struct {
	state *vastbaseIndexMetadataTestState
}

func (testDriver *vastbaseIndexMetadataTestDriver) Open(string) (driver.Conn, error) {
	return &vastbaseIndexMetadataTestConn{state: testDriver.state}, nil
}

type vastbaseIndexMetadataTestConn struct {
	state *vastbaseIndexMetadataTestState
}

func (*vastbaseIndexMetadataTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}
func (*vastbaseIndexMetadataTestConn) Close() error              { return nil }
func (*vastbaseIndexMetadataTestConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (conn *vastbaseIndexMetadataTestConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	conn.state.queryCount++
	conn.state.query = query
	return &vastbaseIndexMetadataTestRows{
		rows: [][]driver.Value{
			{int64(0), "orders_code_idx", "btree", true, false, "3 2", int64(0), ""},
			{int64(0), "orders_expression_idx", "btree", false, false, "0 2", int64(0), ""},
			{int64(0), "orders_pkey", "btree", true, true, "1 2", int64(0), ""},
			{int64(1), "", "", false, false, "", int64(1), "id"},
			{int64(1), "", "", false, false, "", int64(2), "tenant_id"},
			{int64(1), "", "", false, false, "", int64(3), "code"},
		},
	}, nil
}

type vastbaseIndexMetadataTestRows struct {
	rows  [][]driver.Value
	index int
}

func (*vastbaseIndexMetadataTestRows) Columns() []string {
	return []string{"row_kind", "index_name", "index_type", "is_unique", "is_primary", "column_numbers", "attribute_number", "column_name"}
}

func (*vastbaseIndexMetadataTestRows) Close() error { return nil }

func (rows *vastbaseIndexMetadataTestRows) Next(destination []driver.Value) error {
	if rows.index >= len(rows.rows) {
		return io.EOF
	}
	copy(destination, rows.rows[rows.index])
	rows.index++
	return nil
}
