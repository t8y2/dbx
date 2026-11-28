package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
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
	columns  []string
	rows     [][]driver.Value
	index    int
	nextErr  error
	closeErr error
}

func (rows *valueRows) Columns() []string {
	if len(rows.columns) > 0 {
		return rows.columns
	}
	return []string{"value"}
}

func (rows *valueRows) Close() error { return rows.closeErr }

func (rows *valueRows) Next(destination []driver.Value) error {
	if rows.index >= len(rows.rows) {
		if rows.nextErr != nil {
			return rows.nextErr
		}
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

func TestVastbaseConstraintStatusParsing(t *testing.T) {
	for _, test := range []struct {
		name    string
		raw     any
		valid   bool
		enabled bool
	}{
		{name: "boolean true", raw: true, valid: true, enabled: true},
		{name: "boolean false", raw: false, valid: false, enabled: false},
		{name: "text true", raw: "t", valid: true, enabled: true},
		{name: "text false", raw: "f", valid: false, enabled: false},
		{name: "one", raw: "1", valid: true, enabled: true},
		{name: "zero", raw: "0", valid: false, enabled: false},
		{name: "oracle enabled", raw: "E", valid: true, enabled: true},
		{name: "oracle disabled", raw: "D", valid: true, enabled: false},
		{name: "enabled label", raw: "enabled", valid: true, enabled: true},
		{name: "disabled label", raw: "disabled", valid: true, enabled: false},
		{name: "not validated", raw: "N", valid: false, enabled: true},
		{name: "no", raw: "no", valid: false, enabled: true},
		{name: "bytes false", raw: []byte("false"), valid: false, enabled: false},
		{name: "null defaults true", raw: nil, valid: true, enabled: true},
		{name: "unknown defaults true", raw: "future-state", valid: true, enabled: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if actual := parseVastbaseConstraintValid(test.raw); actual != test.valid {
				t.Fatalf("parseVastbaseConstraintValid(%#v) = %v, want %v", test.raw, actual, test.valid)
			}
			if actual := parseVastbaseConstraintEnabled(test.raw); actual != test.enabled {
				t.Fatalf("parseVastbaseConstraintEnabled(%#v) = %v, want %v", test.raw, actual, test.enabled)
			}
		})
	}
}

func TestVastbaseConstraintAttributeNumbersAreStrict(t *testing.T) {
	for _, raw := range []string{"1 2", "{3,2}", "[4, 5]", ""} {
		if _, err := parseVastbaseConstraintAttributeNumbers(raw); err != nil {
			t.Fatalf("valid vector %q failed: %v", raw, err)
		}
	}
	if _, err := parseVastbaseConstraintAttributeNumbers("1 bad 3"); err == nil {
		t.Fatal("invalid constraint vector must return an error")
	}
}

func TestVastbaseConstraintQueryNormalizesCatalogCapabilities(t *testing.T) {
	query := vastbaseConstraintsQuery("pg_catalog", "pg", "public", "orders", false, false, false)
	for _, expected := range []string{
		"pg_catalog.pg_get_constraintdef",
		"COALESCE(CAST(c.convalidated AS text), 'T')",
		"CAST(c.conkey AS text)",
		"CAST(c.confkey AS text)",
	} {
		if !strings.Contains(query, expected) {
			t.Fatalf("constraint query missing %q: %s", expected, query)
		}
	}
	fallback := vastbaseConstraintsQuery("pg_catalog", "pg", "public", "orders", true, true, true)
	if strings.Contains(fallback, "pg_get_constraintdef") || strings.Contains(fallback, "convalidated") || strings.Contains(fallback, "conenable") {
		t.Fatalf("fallback constraint query still contains unsupported fields: %s", fallback)
	}
}

func TestVastbaseConstraintRelationResolvesFoldedNames(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "LOWER(n.nspname) = LOWER('app')") || !strings.Contains(query, "LOWER(c.relname) = LOWER('orders')") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{columns: []string{"nspname", "relname"}, rows: [][]driver.Value{{"APP", "ORDERS"}}}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	schema, table, err := server.resolveConstraintRelation("pg_catalog", "pg", "app", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if schema != "APP" || table != "ORDERS" {
		t.Fatalf("folded relation was not resolved: %s.%s", schema, table)
	}
}

func TestVastbaseConstraintRelationRejectsAmbiguousFoldedNames(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(string) (driver.Rows, error) {
		return &valueRows{columns: []string{"nspname", "relname"}, rows: [][]driver.Value{{"APP", "ORDERS"}, {"App", "Orders"}}}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)

	if _, _, err := server.resolveConstraintRelation("pg_catalog", "pg", "app", "orders"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous folded relation must fail, got %v", err)
	}
}

func TestVastbaseListConstraintsResolvesCatalogVectors(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "LOWER(n.nspname) = LOWER('public')") && strings.Contains(query, "LOWER(c.relname) = LOWER('orders')"):
			return &valueRows{columns: []string{"nspname", "relname"}, rows: [][]driver.Value{{"public", "orders"}}}, nil
		case strings.Contains(query, "FROM pg_catalog.pg_constraint c"):
			return &valueRows{
				columns: []string{"conname", "contype", "definition", "conkey", "ref_schema", "ref_table", "confkey", "match_type", "on_update", "on_delete", "condeferrable", "condeferred", "valid", "enabled"},
				rows: [][]driver.Value{
					{"orders_check", "c", "CHECK (amount > 0)", "{4}", nil, nil, nil, nil, nil, nil, false, false, []byte("t"), []byte("D")},
					{"orders_customer_fkey", "f", "FOREIGN KEY (customer_id, region_id) REFERENCES customers(id, region_id)", "{2,3}", "public", "customers", "{1,2}", "s", "a", "c", true, true, "f", true},
				},
			}, nil
		case strings.Contains(query, "SELECT a.attnum, a.attname") && strings.Contains(query, "c.relname = 'orders'"):
			return &valueRows{columns: []string{"attnum", "attname"}, rows: [][]driver.Value{{int64(2), "customer_id"}, {int64(3), "region_id"}, {int64(4), "amount"}}}, nil
		case strings.Contains(query, "SELECT a.attnum, a.attname") && strings.Contains(query, "c.relname = 'customers'"):
			return &valueRows{columns: []string{"attnum", "attname"}, rows: [][]driver.Value{{int64(1), "id"}, {int64(2), "region_id"}}}, nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	server.mode.postgresCatalog = true

	constraints, err := server.listConstraints("public", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if len(constraints) != 2 {
		t.Fatalf("unexpected constraints: %#v", constraints)
	}
	check, fk := constraints[0], constraints[1]
	if check.ConstraintType != "CHECK" || !check.Valid || check.Enabled || !equalVastbaseStrings(check.Columns, []string{"amount"}) {
		t.Fatalf("unexpected check constraint: %#v", check)
	}
	if fk.ConstraintType != "FOREIGN KEY" || fk.Valid || !fk.Enabled || !fk.Deferrable || !fk.InitiallyDeferred || !equalVastbaseStrings(fk.Columns, []string{"customer_id", "region_id"}) || !equalVastbaseStrings(fk.RefColumns, []string{"id", "region_id"}) {
		t.Fatalf("unexpected foreign key constraint: %#v", fk)
	}
	if fk.MatchType == nil || *fk.MatchType != "SIMPLE" || fk.OnUpdate == nil || *fk.OnUpdate != "NO ACTION" || fk.OnDelete == nil || *fk.OnDelete != "CASCADE" {
		t.Fatalf("unexpected foreign key actions: %#v", fk)
	}
}

func equalVastbaseStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestVastbaseGetColumnsResolvesVisibleRelationSchemaInCatalogQuery(t *testing.T) {
	queries := []string{}
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		queries = append(queries, query)
		switch {
		case strings.Contains(query, "FROM pg_catalog.pg_attribute a"):
			if !strings.Contains(query, "pg_catalog.pg_table_is_visible(c.oid)") || strings.Contains(query, "current_schema()") {
				return nil, fmt.Errorf("unqualified columns query did not resolve the visible relation: %s", query)
			}
			return &valueRows{
				columns: []string{"nspname", "attname", "format_type", "nullable", "default", "comment", "precision", "scale", "length", "identity"},
				rows:    [][]driver.Value{{"tenant_b", "ID", "bigint", false, nil, nil, nil, nil, nil, nil}},
			}, nil
		case strings.Contains(query, "FROM information_schema.table_constraints"):
			if !strings.Contains(query, "tc.table_schema='tenant_b'") {
				return nil, fmt.Errorf("primary-key lookup did not use resolved schema: %s", query)
			}
			return &valueRows{columns: []string{"column_name"}, rows: [][]driver.Value{{"ID"}}}, nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	server.mode.postgresCatalog = true

	columns, err := server.getColumns("", "TBLCUSPOSTMATERIALLOG")
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 2 {
		t.Fatalf("getColumns executed %d metadata queries, want 2: %v", len(queries), queries)
	}
	if len(columns) != 1 || columns[0].ResolvedSchema == nil || *columns[0].ResolvedSchema != "tenant_b" || !columns[0].IsPrimaryKey {
		t.Fatalf("resolved relation metadata was lost: %#v", columns)
	}
}

func TestVastbaseListCustomTypesUsesPostgresCatalog(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "FROM pg_catalog.pg_type t") || !strings.Contains(query, "t.typtype IN ('b','c','d','e','r','m')") || !strings.Contains(query, "t.typisdefined") || !strings.Contains(query, "t.typelem = 0") || !strings.Contains(query, "(t.typrelid = 0 OR c.relkind = 'c')") || !strings.Contains(query, "d.classoid = 'pg_catalog.pg_type'::regclass") || !strings.Contains(query, "n.nspname <> 'pg_catalog'") || !strings.Contains(query, "n.nspname <> 'information_schema'") || !strings.Contains(query, "n.nspname NOT LIKE 'pg_toast%'") || !strings.Contains(query, "n.nspname NOT LIKE 'pg_temp%'") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{
			columns: []string{"typname", "description", "typtype", "has_members"},
			rows: [][]driver.Value{
				{"status", "order status", "e", true},
				{"email", nil, "d", false},
				{"address", nil, "c", true},
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
	if types[0].CustomTypeKind == nil || *types[0].CustomTypeKind != "enum" || types[0].HasMembers == nil || !*types[0].HasMembers {
		t.Fatalf("type kind/member metadata was lost: %#v", types[0])
	}
	if types[1].CustomTypeKind == nil || *types[1].CustomTypeKind != "domain" || types[1].HasMembers == nil || *types[1].HasMembers {
		t.Fatalf("leaf type metadata was lost: %#v", types[1])
	}
}

func TestVastbaseListCustomTypesUsesSystemCatalog(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "FROM sys_catalog.sys_type t") || strings.Contains(query, "FROM pg_catalog") || !strings.Contains(query, "t.typisdefined") || !strings.Contains(query, "n.nspname <> 'pg_catalog'") || !strings.Contains(query, "d.classoid = 'pg_catalog.pg_type'::regclass") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return &valueRows{
			columns: []string{"typname", "description", "typtype", "has_members"},
			rows:    [][]driver.Value{{"status", "order status", "e", true}},
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

func TestVastbaseCustomTypeQueriesFollowCatalog(t *testing.T) {
	pgQueries := customTypeCatalogQueriesFor("pg_catalog", "pg", "app", "status")
	for _, fragment := range []string{
		"pg_catalog.pg_type", "pg_catalog.pg_namespace", "pg_catalog.pg_description", "pg_catalog.pg_proc",
		"pg_get_expr", "pg_get_constraintdef",
		"n.nspname = 'app' AND t.typname = 'status'",
	} {
		if !strings.Contains(pgQueries.general, fragment) && !strings.Contains(pgQueries.compositeMembers, fragment) && !strings.Contains(pgQueries.domainConstraints, fragment) {
			t.Fatalf("pg catalog queries missing %q: %s", fragment, pgQueries.general)
		}
	}
	sysQueries := customTypeCatalogQueriesFor("sys_catalog", "sys", "app", "status")
	for _, fragment := range []string{"sys_catalog.sys_type", "sys_catalog.sys_namespace", "sys_get_expr", "sys_get_constraintdef"} {
		if !strings.Contains(sysQueries.general, fragment) && !strings.Contains(sysQueries.compositeMembers, fragment) && !strings.Contains(sysQueries.domainConstraints, fragment) {
			t.Fatalf("sys catalog queries missing %q: %s", fragment, sysQueries.general)
		}
	}
	if strings.Contains(sysQueries.general, "FROM pg_catalog") || strings.Contains(sysQueries.general, "pg_get_expr") {
		t.Fatalf("sys catalog general query leaked pg_catalog references: %s", sysQueries.general)
	}
	if strings.Contains(pgQueries.general, "pg_get_expr") || strings.Contains(sysQueries.general, "sys_get_expr") {
		t.Fatal("general type lookup must not depend on default-expression rendering")
	}
	if !strings.Contains(pgQueries.domainRenderedDefault, "pg_get_expr") || !strings.Contains(sysQueries.domainRenderedDefault, "sys_get_expr") {
		t.Fatal("domain default renderer must follow the selected catalog")
	}
	for _, fragment := range []string{"JOIN pg_catalog.pg_type at", "quote_ident(atn.nspname)", "LEFT JOIN pg_catalog.pg_type elem"} {
		if !strings.Contains(pgQueries.compositeMembers, fragment) {
			t.Fatalf("composite query must schema-qualify member types; missing %q: %s", fragment, pgQueries.compositeMembers)
		}
	}
	for _, fragment := range []string{"JOIN pg_catalog.pg_namespace n", "quote_ident(n.nspname)", "WHERE t.oid = %[1]d"} {
		if !strings.Contains(pgQueries.domainBaseType, fragment) {
			t.Fatalf("domain query must schema-qualify its base type; missing %q: %s", fragment, pgQueries.domainBaseType)
		}
	}
	formattedDomainBaseType := fmt.Sprintf(pgQueries.domainBaseType, 25, -1)
	if strings.Contains(formattedDomainBaseType, "%") || !strings.Contains(formattedDomainBaseType, "format_type(t.oid, -1::int4)") {
		t.Fatalf("domain base type query must format both OID and typmod: %s", formattedDomainBaseType)
	}
	for _, query := range []string{pgQueries.rangeAttributes, pgQueries.rangeAttributesForMultirange} {
		for _, fragment := range []string{"JOIN pg_catalog.pg_type st", "quote_ident(stn.nspname)", "quote_ident(ncan.nspname)", "quote_ident(ndiff.nspname)", "quote_ident(nopc.nspname)", "ncan.oid = pcan.pronamespace", "ndiff.oid = pdiff.pronamespace", "nopc.oid = opc.opcnamespace"} {
			if !strings.Contains(query, fragment) {
				t.Fatalf("range query must qualify catalog names with schema; missing %q: %s", fragment, query)
			}
		}
		if strings.Contains(query, "%!") {
			t.Fatalf("range query contains an unresolved format directive: %s", query)
		}
	}
}

func TestVastbaseDomainDefaultRenderFailureIsDegradable(t *testing.T) {
	bin := sql.NullString{String: "{CONST ...}", Valid: true}
	value, warnings := resolveCustomTypeDomainDefault(bin, sql.NullString{}, func() (string, error) {
		return "", errors.New("function sys_get_expr does not exist")
	})
	if value != nil || len(warnings) != 1 || !strings.Contains(warnings[0], "DDL is incomplete") {
		t.Fatalf("unexpected fallback result: value=%v warnings=%v", value, warnings)
	}
}

func TestVastbaseDomainConstraintReadFailuresMarkDDLIncomplete(t *testing.T) {
	queries := customTypeCatalogQueriesFor("pg_catalog", "pg", "app", "email")
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "WHERE t.oid = 1"):
			return &valueRows{columns: []string{"base_type"}, rows: [][]driver.Value{{"text"}}}, nil
		case strings.Contains(query, "WHERE c.contypid = 9"):
			return &valueRows{columns: []string{"conname", "definition"}, rows: [][]driver.Value{{"email_valid"}}}, nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	properties := customTypeProperties{DomainConstraints: []customTypeDomainConstraint{}}
	warnings := server.customTypeDomainAttributes(queries, &properties, 9, 1, -1, false, sql.NullString{}, sql.NullString{}, 0, sql.NullString{})
	if len(warnings) != 1 || !strings.Contains(warnings[0], "domain constraints could not be decoded") {
		t.Fatalf("constraint scan failures must be retained as warnings: %v", warnings)
	}
	ddl := buildCustomTypeDDL("app", "email", customTypeKindDomain, sql.NullString{}, &[]customTypeMember{}, &properties, warnings)
	if ddl.Complete {
		t.Fatalf("domain DDL must be incomplete after a constraint scan failure: %+v", ddl)
	}
}

func TestVastbaseGetTypeDetailsRejectsMySQLCompat(t *testing.T) {
	server := newServer()
	server.mode.mysqlCompat = true
	_, err := server.getTypeDetails("public", "status")
	if err == nil || !strings.Contains(err.Error(), "MySQL compatibility mode") {
		t.Fatalf("expected MySQL compat rejection, got %v", err)
	}
}

func TestVastbaseGetTypeDetailsPropagatesRowIterationError(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(string) (driver.Rows, error) {
		return &valueRows{nextErr: errors.New("row stream failed")}, nil
	}}
	server := newServer()
	server.db = openVastbaseCustomTypesDB(t, state)
	_, err := server.getTypeDetails("public", "status")
	if err == nil || !strings.Contains(err.Error(), "failed to read type") || !strings.Contains(err.Error(), "row stream failed") {
		t.Fatalf("expected row iteration error to be propagated, got %v", err)
	}
}

func TestVastbaseSystemSchemasAreRejectedForCustomTypeDetails(t *testing.T) {
	for _, schema := range []string{"pg_catalog", "information_schema", "pg_toast", "pg_toast_temp_5", "pg_temp_5"} {
		if !isSystemSchema(schema) {
			t.Fatalf("%q should be recognized as a system schema", schema)
		}
	}
	if isSystemSchema("public") || isSystemSchema("app") {
		t.Fatal("user schemas must remain eligible for custom type details")
	}
	server := newServer()
	if _, err := server.getTypeDetails("pg_catalog", "int4"); err == nil || !strings.Contains(err.Error(), "system schema") {
		t.Fatalf("system schema must be rejected before catalog access, got %v", err)
	}
}

func TestVastbaseCustomTypeDDL(t *testing.T) {
	nullInput := sql.NullString{}
	enumMembers := []customTypeMember{
		{Ordinal: 1, EnumValue: stringPtr("draft")},
		{Ordinal: 2, EnumValue: stringPtr("已归档")},
	}
	enumDDL := buildCustomTypeDDL("app", "status", customTypeKindEnum, nullInput, &enumMembers, &customTypeProperties{}, nil)
	if enumDDL.SQL != "CREATE TYPE \"app\".\"status\" AS ENUM ('draft', '已归档');" || !enumDDL.Complete {
		t.Fatalf("unexpected enum DDL: %+v", enumDDL)
	}
	notNull := true
	domainProps := customTypeProperties{BaseType: stringPtr("text"), NotNull: &notNull, DomainConstraints: []customTypeDomainConstraint{{Name: "email_valid", Definition: "CHECK ((VALUE <> ''::text))"}}}
	domainDDL := buildCustomTypeDDL("app", "email", customTypeKindDomain, nullInput, &[]customTypeMember{}, &domainProps, nil)
	if !strings.Contains(domainDDL.SQL, "CREATE DOMAIN \"app\".\"email\" AS text") || !strings.Contains(domainDDL.SQL, "NOT NULL") {
		t.Fatalf("unexpected domain DDL: %+v", domainDDL)
	}
	rangeProps := customTypeProperties{RangeSubtype: stringPtr("numeric"), RangeCanonicalFunction: stringPtr("\"extensions\".\"numeric_range_canonical\"")}
	rangeDDL := buildCustomTypeDDL("app", "price_range", customTypeKindRange, nullInput, &[]customTypeMember{}, &rangeProps, nil)
	if !rangeDDL.Complete || !strings.Contains(rangeDDL.SQL, "canonical = \"extensions\".\"numeric_range_canonical\"") {
		t.Fatalf("unexpected range DDL: %+v", rangeDDL)
	}
	missingSubtype := buildCustomTypeDDL("app", "price_range", customTypeKindRange, nullInput, &[]customTypeMember{}, &customTypeProperties{RangeMultirangeName: stringPtr("price_multirange")}, nil)
	if missingSubtype.Complete || missingSubtype.SQL != "CREATE TYPE \"app\".\"price_range\" AS RANGE (subtype = unknown);" {
		t.Fatalf("range DDL without subtype must be incomplete: %+v", missingSubtype)
	}
	multirangeDDL := buildCustomTypeDDL("app", "_price_range", customTypeKindMultirange, nullInput, &[]customTypeMember{}, &customTypeProperties{}, nil)
	if multirangeDDL.Complete || len(multirangeDDL.Warnings) == 0 {
		t.Fatalf("multirange DDL must be incomplete with warnings: %+v", multirangeDDL)
	}
	baseDDL := buildCustomTypeDDL("app", "point2d", customTypeKindBase, nullInput, &[]customTypeMember{}, &customTypeProperties{}, nil)
	if baseDDL.Complete || len(baseDDL.Warnings) == 0 {
		t.Fatalf("base DDL must be incomplete with warnings: %+v", baseDDL)
	}
}

func TestVastbaseListObjectsIncludesCustomTypesWhenUnfiltered(t *testing.T) {
	state := &vastbaseCustomTypesTestState{query: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "sys_type t"):
			return &valueRows{
				columns: []string{"typname", "description", "typtype", "has_members"},
				rows: [][]driver.Value{
					{"status", "order status", "e", true},
					{"email", nil, "d", false},
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
			columns: []string{"typname", "description", "typtype", "has_members"},
			rows:    [][]driver.Value{{"status", "order status", "e", true}},
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

// vastbaseListObjectsState answers the object-listing queries and records every
// statement so a test can prove which catalogs were scanned.
type vastbaseListObjectsState struct {
	queries []string
	rows    map[string][][]driver.Value
	columns map[string][]string
}

func (state *vastbaseListObjectsState) query(statement string) (driver.Rows, error) {
	state.queries = append(state.queries, statement)
	for _, marker := range state.markerOrder() {
		if strings.Contains(statement, marker) {
			return &valueRows{columns: state.columns[marker], rows: state.rows[marker]}, nil
		}
	}
	// Unmatched statements are a test bug, not a production path: name the
	// statement instead of silently answering it with an empty result set.
	return nil, fmt.Errorf("unexpected metadata query: %s", statement)
}

// markerOrder keeps marker matching deterministic; a map range would let a
// generic marker win over a specific one between runs.
func (state *vastbaseListObjectsState) markerOrder() []string {
	return []string{"pkgspecsrc", "gs_package", "datcompatibility", "_database", "_class c", "_proc p", "pg_type t", "sys_type t"}
}

func (state *vastbaseListObjectsState) scanned(marker string) bool {
	for _, statement := range state.queries {
		if strings.Contains(statement, marker) {
			return true
		}
	}
	return false
}

func newVastbaseListObjectsState() *vastbaseListObjectsState {
	return &vastbaseListObjectsState{
		columns: map[string][]string{
			"gs_package": {"pkgname", "description", "has_body"},
			"pkgspecsrc": {"pkgspecsrc", "pkgbodydeclsrc", "pkgbodyinitsrc", "pkgsecdef"},
			"_proc p":    {"proname", "kind", "comment"},
			"_class c":   {"relname", "relkind", "comment"},
			"sys_type t": {"typname", "description", "typtype", "has_members"},
			"pg_type t":  {"typname", "description", "typtype", "has_members"},
		},
		rows: map[string][][]driver.Value{
			// Packages live in gs_package only; the routine scan (pg_proc /
			// sys_proc) never returns them, which is the #15359 gap.
			"gs_package": {
				{"pkg_order", "order helpers", true},
				{"pkg_util", nil, false},
			},
			// openGauss stores kernel-rewritten fragments: the declaration starts
			// with the "PACKAGE  DECLARE" marker and the initialization section
			// is wrapped in "INSTANTIATION".
			"pkgspecsrc": {
				{
					" PACKAGE  DECLARE\n  PROCEDURE touch(order_id INTEGER);\nEND ",
					" PACKAGE  DECLARE\n  PROCEDURE touch(order_id INTEGER) IS\n  BEGIN\n    NULL;\n  END;\nEND ",
					" INSTANTIATION \nBEGIN\n  NULL;\nEND",
					true,
				},
			},
			"_proc p": {
				{"generic_proc", "PROCEDURE", nil},
			},
			"_class c": {
				{"orders", "TABLE", nil},
			},
			"sys_type t": {},
			"pg_type t":  {},
		},
	}
}

func openVastbaseListObjectsDB(t *testing.T, state *vastbaseListObjectsState) *sql.DB {
	t.Helper()
	return openVastbaseCustomTypesDB(t, &vastbaseCustomTypesTestState{query: state.query})
}

func TestVastbaseListObjectsIncludesPackages(t *testing.T) {
	state := newVastbaseListObjectsState()
	server := newServer()
	server.mode = vastbaseMode{compatibilityMode: "oracle", compatibilityModeRaw: "A", postgresCatalog: true}
	server.db = openVastbaseListObjectsDB(t, state)

	// Ask for the groups the sidebar loads together. Types are excluded on
	// purpose: the custom-type scan is unrelated to packages and has its own
	// tests, so keeping it out here keeps this test focused.
	objects, err := server.listObjects("app", metadataListConstraints{
		ObjectTypes: []string{"TABLE", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var packages, bodies []objectInfo
	for _, item := range objects {
		switch item.ObjectType {
		case "PACKAGE":
			packages = append(packages, item)
		case "PACKAGE_BODY":
			bodies = append(bodies, item)
		}
	}
	if len(packages) != 2 {
		t.Fatalf("expected two packages in the object list, got %#v (objects=%#v)", packages, objects)
	}
	if packages[0].Name != "pkg_order" || packages[1].Name != "pkg_util" {
		t.Fatalf("unexpected package names/order: %#v", packages)
	}
	if packages[0].Schema != "app" || packages[0].Comment == nil || *packages[0].Comment != "order helpers" {
		t.Fatalf("package row lost its schema or comment: %#v", packages[0])
	}
	if packages[1].Comment != nil {
		t.Fatalf("NULL package comment must stay nil, got %q", *packages[1].Comment)
	}
	// Only the package that actually stores a body reports a PACKAGE_BODY node,
	// so the body group never carries empty entries.
	if len(bodies) != 1 || bodies[0].Name != "pkg_order" {
		t.Fatalf("expected one package body for pkg_order, got %#v", bodies)
	}
}

// A package-only request must not fall back to scanning relations or routines;
// the sidebar asks for PACKAGE/PACKAGE_BODY as its own group.
func TestVastbasePackageRequestSkipsTablesAndRoutines(t *testing.T) {
	state := newVastbaseListObjectsState()
	server := newServer()
	server.mode = vastbaseMode{compatibilityMode: "oracle", compatibilityModeRaw: "A", postgresCatalog: true}
	server.db = openVastbaseListObjectsDB(t, state)

	objects, err := server.listObjects("app", metadataListConstraints{ObjectTypes: []string{"PACKAGE", "PACKAGE_BODY"}})
	if err != nil {
		t.Fatal(err)
	}
	if state.scanned("_class c") || state.scanned("_proc p") {
		t.Fatalf("package request must not scan relations or routines: %#v", state.queries)
	}
	if len(objects) != 3 {
		t.Fatalf("expected two packages plus the stored body, got %#v", objects)
	}
	var seenBody bool
	for _, item := range objects {
		switch item.ObjectType {
		case "PACKAGE":
		case "PACKAGE_BODY":
			seenBody = true
		default:
			t.Fatalf("package request returned a non-package object: %#v", item)
		}
	}
	if !seenBody {
		t.Fatalf("package request dropped the stored body: %#v", objects)
	}
}

// A table-only request must not leak packages into the table group.
func TestVastbaseTableRequestSkipsPackages(t *testing.T) {
	state := newVastbaseListObjectsState()
	server := newServer()
	server.db = openVastbaseListObjectsDB(t, state)

	objects, err := server.listObjects("app", metadataListConstraints{ObjectTypes: []string{"TABLE"}})
	if err != nil {
		t.Fatal(err)
	}
	if state.scanned("gs_package") {
		t.Fatalf("table request must not scan packages: %#v", state.queries)
	}
	for _, item := range objects {
		if item.ObjectType == "PACKAGE" || item.ObjectType == "PACKAGE_BODY" {
			t.Fatalf("table request returned a package object: %#v", item)
		}
	}
}

func TestVastbaseObjectSourceReturnsPackageText(t *testing.T) {
	// openGauss keeps kernel-rewritten fragments, so the returned source has to
	// be rebuilt into runnable DDL rather than echoed back.
	const declFragment = " PACKAGE  DECLARE\n  PROCEDURE touch(order_id INTEGER);\nEND "
	const bodyFragment = " PACKAGE  DECLARE\n  PROCEDURE touch(order_id INTEGER) IS\n  BEGIN\n    NULL;\n  END;\nEND "
	const initFragment = " INSTANTIATION \nBEGIN\n  NULL;\nEND"
	state := &vastbaseListObjectsState{
		columns: map[string][]string{"pkgspecsrc": {"pkgspecsrc", "pkgbodydeclsrc", "pkgbodyinitsrc", "pkgsecdef"}},
		rows:    map[string][][]driver.Value{"pkgspecsrc": {{declFragment, bodyFragment, initFragment, false}}},
	}
	server := newServer()
	server.mode = vastbaseMode{compatibilityMode: "oracle", compatibilityModeRaw: "A", postgresCatalog: true}
	server.db = openVastbaseListObjectsDB(t, state)

	want := map[string]string{
		"PACKAGE": `CREATE OR REPLACE PACKAGE "app"."pkg_order" AUTHID CURRENT_USER AS
  PROCEDURE touch(order_id INTEGER);
END "pkg_order";`,
		// The body keeps the member declarations and the initialization block.
		"PACKAGE_BODY": `CREATE OR REPLACE PACKAGE BODY "app"."pkg_order" AS
  PROCEDURE touch(order_id INTEGER) IS
  BEGIN
    NULL;
  END;
BEGIN
  NULL;
END "pkg_order";`,
	}
	for objectType, expected := range want {
		source, err := server.getObjectSource("app", "pkg_order", objectType)
		if err != nil {
			t.Fatalf("getObjectSource(%q) failed: %v", objectType, err)
		}
		if got, _ := source["source"].(string); got != expected {
			t.Fatalf("getObjectSource(%q) source = %q, want %q", objectType, got, expected)
		}
		if got, _ := source["object_type"].(string); got != objectType {
			t.Fatalf("getObjectSource(%q) echoed object_type %q", objectType, got)
		}
	}
}

// Kernels that already store complete DDL must not be rewritten into invalid
// statements: without the fragment marker the text is returned as stored.
func TestVastbaseObjectSourceKeepsCompleteDdl(t *testing.T) {
	const spec = "CREATE OR REPLACE PACKAGE pkg_order AS\n  PROCEDURE touch;\nEND pkg_order;"
	state := &vastbaseListObjectsState{
		columns: map[string][]string{"pkgspecsrc": {"pkgspecsrc", "pkgbodydeclsrc", "pkgbodyinitsrc", "pkgsecdef"}},
		rows:    map[string][][]driver.Value{"pkgspecsrc": {{spec, "", "", true}}},
	}
	server := newServer()
	server.mode = vastbaseMode{compatibilityMode: "oracle", compatibilityModeRaw: "A", postgresCatalog: true}
	server.db = openVastbaseListObjectsDB(t, state)

	source, err := server.getObjectSource("app", "pkg_order", "PACKAGE")
	if err != nil {
		t.Fatalf("getObjectSource failed: %v", err)
	}
	if got, _ := source["source"].(string); got != spec {
		t.Fatalf("source = %q, want the stored DDL %q", got, spec)
	}
}

// Packages only exist in Oracle-compatible databases, so the other modes must
// not pay for (or break on) a gs_package scan.
func TestVastbaseListObjectsSkipsPackagesOutsideOracleMode(t *testing.T) {
	state := newVastbaseListObjectsState()
	server := newServer()
	server.mode = vastbaseMode{compatibilityMode: "postgres", compatibilityModeRaw: "PG", postgresCatalog: true}
	server.db = openVastbaseListObjectsDB(t, state)

	if _, err := server.listObjects("app", metadataListConstraints{ObjectTypes: []string{"PACKAGE", "PACKAGE_BODY"}}); err != nil {
		t.Fatal(err)
	}
	if state.scanned("gs_package") {
		t.Fatalf("postgres-compatible database scanned packages: %#v", state.queries)
	}
}

// The object tree keys its A-mode package entry off the compatibility mode that
// list_databases reports, so agent connections have to publish it.
func TestVastbaseListDatabasesReportsCompatibilityMode(t *testing.T) {
	state := &vastbaseListObjectsState{
		columns: map[string][]string{"datcompatibility": {"datname", "datcompatibility"}},
		rows:    map[string][][]driver.Value{"datcompatibility": {{"vastbase_a", "A"}, {"vastbase_pg", "PG"}}},
	}
	server := newServer()
	server.db = openVastbaseListObjectsDB(t, state)

	databases, err := server.listDatabases()
	if err != nil {
		t.Fatalf("listDatabases failed: %v", err)
	}
	if len(databases) != 2 {
		t.Fatalf("expected two databases, got %#v", databases)
	}
	if databases[0].Name != "vastbase_a" || databases[0].CompatibilityMode != "A" {
		t.Fatalf("A-mode database lost its compatibility mode: %#v", databases[0])
	}
	if databases[1].CompatibilityMode != "PG" {
		t.Fatalf("unexpected compatibility mode: %#v", databases[1])
	}
}

// Older catalogs without datcompatibility still have to produce a database
// picker; the name-only listing is the fallback.
func TestVastbaseListDatabasesFallsBackWithoutCompatibilityColumn(t *testing.T) {
	state := &vastbaseListObjectsState{
		columns: map[string][]string{"_database": {"datname"}},
		rows:    map[string][][]driver.Value{"_database": {{"vastbase_a"}}},
	}
	server := newServer()
	server.db = openVastbaseListObjectsDB(t, state)

	databases, err := server.listDatabases()
	if err != nil {
		t.Fatalf("listDatabases failed: %v", err)
	}
	if len(databases) != 1 || databases[0].Name != "vastbase_a" || databases[0].CompatibilityMode != "" {
		t.Fatalf("unexpected fallback databases: %#v", databases)
	}
}
