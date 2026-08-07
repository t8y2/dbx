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

// TestVastbaseListIndexesToleratesNullColumnName 复刻 #5602：Vastbase G100 在 UNION ALL
// 索引查询中对 column_name（column index 7）返回 NULL，裸 string 扫描会报
// "converting NULL to string is unsupported"。修复后用 sql.NullString 容错，NULL 行被跳过不崩。
func TestVastbaseListIndexesToleratesNullColumnName(t *testing.T) {
	state := &vastbaseIndexMetadataTestState{
		rows: [][]driver.Value{
			// 分支1（row_kind=0）的 column_name 占位列也可能为 NULL，不应影响索引元数据解析。
			{int64(0), "orders_pkey", "btree", true, true, "1 3", int64(0), nil},
			{int64(1), "", "", false, false, "", int64(1), "id"},
			// 模拟 Vastbase 对某 attribute 行的 column_name 返回 NULL，该行应被跳过。
			{int64(1), "", "", false, false, "", int64(2), nil},
			{int64(1), "", "", false, false, "", int64(3), "code"},
		},
	}
	driverName := fmt.Sprintf("vastbase-index-null-%d", vastbaseIndexMetadataDriverSequence.Add(1))
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
		t.Fatalf("listIndexes should tolerate NULL column_name, got error: %v", err)
	}
	// orders_pkey 的 indkey 为 "1 3"，对应 id(1) 和 code(3)；attribute 2 的 NULL 行被跳过，
	// 但 id 与 code 仍可解析，因此索引应正常返回。
	if len(indexes) != 1 {
		t.Fatalf("listIndexes returned %d indexes, want 1: %+v", len(indexes), indexes)
	}
	assertVastbaseIndex(t, indexes[0], "orders_pkey", []string{"id", "code"}, true, true, "btree")
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

var vastbaseCustomTypesDriverSequence atomic.Uint64

type vastbaseCustomTypesTestState struct {
	query func(string) (driver.Rows, error)
}

type valueRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (rows *valueRows) Columns() []string {
	if len(rows.columns) > 0 {
		return rows.columns
	}
	return []string{"value"}
}

func (rows *valueRows) Close() error { return nil }

func (rows *valueRows) Next(destination []driver.Value) error {
	if rows.index >= len(rows.rows) {
		return io.EOF
	}
	copy(destination, rows.rows[rows.index])
	rows.index++
	return nil
}

type vastbaseCustomTypesTestDriver struct {
	state *vastbaseCustomTypesTestState
}

func (testDriver *vastbaseCustomTypesTestDriver) Open(string) (driver.Conn, error) {
	return &vastbaseCustomTypesTestConn{state: testDriver.state}, nil
}

type vastbaseCustomTypesTestConn struct {
	state *vastbaseCustomTypesTestState
}

func (conn *vastbaseCustomTypesTestConn) Prepare(query string) (driver.Stmt, error) {
	return &vastbaseCustomTypesTestStmt{state: conn.state, query: query}, nil
}
func (*vastbaseCustomTypesTestConn) Close() error              { return nil }
func (*vastbaseCustomTypesTestConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (conn *vastbaseCustomTypesTestConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	return conn.state.query(query)
}

type vastbaseCustomTypesTestStmt struct {
	state *vastbaseCustomTypesTestState
	query string
}

func (*vastbaseCustomTypesTestStmt) Close() error  { return nil }
func (*vastbaseCustomTypesTestStmt) NumInput() int { return 1 }
func (*vastbaseCustomTypesTestStmt) Exec([]driver.Value) (driver.Result, error) {
	return nil, driver.ErrSkip
}
func (stmt *vastbaseCustomTypesTestStmt) Query([]driver.Value) (driver.Rows, error) {
	return stmt.state.query(stmt.query)
}

func openVastbaseCustomTypesDB(t *testing.T, state *vastbaseCustomTypesTestState) *sql.DB {
	t.Helper()
	driverName := fmt.Sprintf("vastbase-custom-types-%d", vastbaseCustomTypesDriverSequence.Add(1))
	sql.Register(driverName, &vastbaseCustomTypesTestDriver{state: state})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestVastbaseListCustomTypesUsesPostgresCatalog(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "FROM pg_catalog.pg_type t") || !strings.Contains(query, "t.typtype IN ('b','c','d','e','r','m')") || !strings.Contains(query, "t.typelem = 0") || !strings.Contains(query, "(t.typrelid = 0 OR c.relkind = 'c')") || !strings.Contains(query, "d.classoid = 'pg_catalog.pg_type'::regclass") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{
			columns: []string{"typname", "description"},
			rows: [][]driver.Value{
				{"status", "order status"},
				{"email", nil},
				{"address", nil},
			},
		}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	server.mode.postgresCatalog = true

	types, err := server.listCustomTypes("public")
	if err != nil {
		t.Fatal(err)
	}
	if len(types) != 3 {
		t.Fatalf("unexpected types: %#v", types)
	}
	for _, item := range types {
		if item.ObjectType != "TYPE" || item.Schema != "public" {
			t.Fatalf("type metadata was lost: %#v", item)
		}
	}
	if types[0].Comment == nil || *types[0].Comment != "order status" {
		t.Fatalf("type comment was lost: %#v", types[0])
	}
	if types[1].Comment != nil {
		t.Fatalf("nil comment became non-nil: %#v", types[1])
	}
}

func TestVastbaseListCustomTypesUsesSystemCatalog(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "FROM sys_catalog.sys_type t") || strings.Contains(query, "FROM pg_catalog") || !strings.Contains(query, "d.classoid = 'pg_catalog.pg_type'::regclass") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{
			columns: []string{"typname", "description"},
			rows:    [][]driver.Value{{"status", "order status"}},
		}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	server.mode.postgresCatalog = false

	types, err := server.listCustomTypes("public")
	if err != nil {
		t.Fatal(err)
	}
	if len(types) != 1 || types[0].Name != "status" {
		t.Fatalf("unexpected types: %#v", types)
	}
}

func TestVastbaseListCustomTypesSkipsMySQLCompatMode(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		return nil, fmt.Errorf("custom types query must not run in mysql compat mode: %s", query)
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	server.mode.mysqlCompat = true

	types, err := server.listCustomTypes("public")
	if err != nil {
		t.Fatal(err)
	}
	if len(types) != 0 {
		t.Fatalf("expected no types in mysql compat mode: %#v", types)
	}
}

func TestVastbaseListObjectsIncludesCustomTypesWhenUnfiltered(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "sys_type t"):
			return &valueRows{
				columns: []string{"typname", "description"},
				rows: [][]driver.Value{
					{"status", "order status"},
					{"email", nil},
				},
			}, nil
		case strings.Contains(query, "sys_proc p"):
			return &valueRows{
				columns: []string{"proname", "kind", "comment"},
				rows:    [][]driver.Value{{"format_name", "FUNCTION", nil}},
			}, nil
		case strings.Contains(query, "sys_class c"):
			return &valueRows{
				columns: []string{"relname", "relkind", "comment"},
				rows:    [][]driver.Value{{"orders", "TABLE", nil}},
			}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	objects, err := server.listObjects("public", metadataListConstraints{})
	if err != nil {
		t.Fatal(err)
	}
	var typeNames []string
	for _, item := range objects {
		if item.ObjectType == "TYPE" {
			typeNames = append(typeNames, item.Name)
		}
	}
	if len(typeNames) != 2 || typeNames[0] != "email" || typeNames[1] != "status" {
		t.Fatalf("unexpected types in object list: %v (objects=%#v)", typeNames, objects)
	}
	if len(objects) != 4 {
		t.Fatalf("expected table + function + 2 types, got %#v", objects)
	}
}

func TestVastbaseListObjectsOnlyCustomTypesWhenTypeRequested(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "FROM sys_catalog.sys_class c") || strings.Contains(query, "sys_proc p") {
			return nil, fmt.Errorf("type-only request must not scan relations or routines: %s", query)
		}
		if !strings.Contains(query, "sys_type t") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{
			columns: []string{"typname", "description"},
			rows:    [][]driver.Value{{"status", "order status"}},
		}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	// The sidebar type group sends TYPE together with the TYPE_BODY companion;
	// both must resolve to a type-only request that never scans tables.
	for _, objectTypes := range [][]string{{"TYPE"}, {"TYPE", "TYPE_BODY"}} {
		objects, err := server.listObjects("public", metadataListConstraints{ObjectTypes: objectTypes})
		if err != nil {
			t.Fatal(err)
		}
		if len(objects) != 1 || objects[0].Name != "status" || objects[0].ObjectType != "TYPE" || objects[0].Schema != "public" {
			t.Fatalf("expected only the TYPE object for %v: %#v", objectTypes, objects)
		}
	}
}

func TestVastbaseTypeBodyConstraintIsNotTableLike(t *testing.T) {
	constraints := metadataListConstraints{ObjectTypes: []string{"TYPE", "TYPE_BODY"}}
	if !constraintsAllowTypes(constraints) {
		t.Fatal("TYPE/TYPE_BODY request must allow types")
	}
	if constraintsAllowsTableLike(constraints) {
		t.Fatal("TYPE/TYPE_BODY request must not be table-like; normalizeTableType must not map TYPE_BODY to TABLE")
	}
	if constraintsAllowRoutines(constraints) {
		t.Fatal("TYPE/TYPE_BODY request must not be routine-like")
	}
}

func TestVastbaseListObjectsSkipsCustomTypesWhenTableRequested(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "sys_type t") || strings.Contains(query, "sys_proc p") {
			return nil, fmt.Errorf("table-only request must not scan types or routines: %s", query)
		}
		if !strings.Contains(query, "FROM sys_catalog.sys_class c") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{
			columns: []string{"relname", "relkind", "comment"},
			rows:    [][]driver.Value{{"orders", "TABLE", nil}},
		}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	objects, err := server.listObjects("public", metadataListConstraints{ObjectTypes: []string{"TABLE"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range objects {
		if item.ObjectType == "TYPE" {
			t.Fatalf("table-only request must not return types: %#v", objects)
		}
	}
	if len(objects) == 0 {
		t.Fatalf("expected the table to remain listed: %#v", objects)
	}
}

func TestVastbaseListObjectsTypeOnlyPropagatesCustomTypesError(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		return nil, fmt.Errorf("catalog unavailable: %s", query)
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	_, err := server.listObjects("public", metadataListConstraints{ObjectTypes: []string{"TYPE"}})
	if err == nil {
		t.Fatal("dedicated type request must propagate the catalog error")
	}
	if !strings.Contains(err.Error(), "list custom types") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVastbaseListObjectsUnfilteredPropagatesCustomTypesError(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "sys_type t") {
			return nil, fmt.Errorf("pg_type unavailable")
		}
		switch {
		case strings.Contains(query, "sys_proc p"):
			return &valueRows{
				columns: []string{"proname", "kind", "comment"},
				rows:    [][]driver.Value{{"format_name", "FUNCTION", nil}},
			}, nil
		case strings.Contains(query, "FROM sys_catalog.sys_class c"):
			return &valueRows{
				columns: []string{"relname", "relkind", "comment"},
				rows:    [][]driver.Value{{"orders", "TABLE", nil}},
			}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	// A failing type catalog must surface as an error even for the unfiltered
	// “all objects” listing, so users never see a silently incomplete list.
	_, err := server.listObjects("public", metadataListConstraints{})
	if err == nil {
		t.Fatal("unfiltered request must propagate the type catalog error")
	}
	if !strings.Contains(err.Error(), "list custom types") {
		t.Fatalf("unexpected error: %v", err)
	}
}

var vastbaseIndexMetadataDriverSequence atomic.Uint64

type vastbaseIndexMetadataTestState struct {
	queryCount int
	query      string
	// rows 为非空时覆盖默认返回数据，用于注入 NULL 等边界场景。
	rows [][]driver.Value
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
	rows := conn.state.rows
	if rows == nil {
		rows = [][]driver.Value{
			{int64(0), "orders_code_idx", "btree", true, false, "3 2", int64(0), ""},
			{int64(0), "orders_expression_idx", "btree", false, false, "0 2", int64(0), ""},
			{int64(0), "orders_pkey", "btree", true, true, "1 2", int64(0), ""},
			{int64(1), "", "", false, false, "", int64(1), "id"},
			{int64(1), "", "", false, false, "", int64(2), "tenant_id"},
			{int64(1), "", "", false, false, "", int64(3), "code"},
		}
	}
	return &vastbaseIndexMetadataTestRows{rows: rows}, nil
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
