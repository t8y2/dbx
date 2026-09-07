package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveXuguCommonIntegration is the compact, opt-in XuguDB integration
// baseline. It intentionally follows the size and scope of the Kingbase and
// Vastbase live tests instead of duplicating the much larger TEST-01
// certification matrix. The fixture contains only synthetic names and values
// and is removed on every exit path.
//
// Coverage is deliberately limited to the common DBX contract:
//   - connection and session reuse;
//   - table, view, index, key and column metadata;
//   - comments, source and reconstructed table DDL;
//   - query execution, DML transactions and cursor paging; and
//   - structured SQL-error recovery in the same session.
//
// Run it with XUGU_LIVE_TEST=1 and the XUGU_LIVE_HOST, XUGU_LIVE_PORT,
// XUGU_LIVE_DATABASE, XUGU_LIVE_USERNAME and XUGU_LIVE_PASSWORD variables.
func TestLiveXuguCommonIntegration(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}

	params := liveXuguParams(t)
	s := newServer()
	db, err := openDB(params)
	if err != nil {
		t.Skipf("live XuguDB is unavailable: %v", err)
	}
	s.db = db
	s.params = params
	s.currentDatabase = params.Database
	t.Cleanup(func() { _ = s.disconnect() })

	if err := s.validateConnection(); err != nil {
		t.Fatalf("validate live connection: %v", err)
	}
	schema, err := s.currentSchema()
	if err != nil {
		t.Fatalf("resolve current schema: %v", err)
	}

	fixture := newXuguCommonFixture(schema)
	cleanupXuguCommonFixture(t, s, fixture)
	t.Cleanup(func() { cleanupXuguCommonFixture(t, s, fixture) })

	createXuguCommonFixture(t, s, fixture)
	t.Run("connection_reuse", func(t *testing.T) {
		if err := s.validateConnection(); err != nil {
			t.Fatalf("connection is not reusable after fixture setup: %v", err)
		}
	})

	t.Run("table_and_view_catalog", func(t *testing.T) {
		tables, err := s.listTables(schema, metadataListConstraints{Filter: fixture.suffix})
		if err != nil {
			t.Fatalf("list tables: %v", err)
		}
		if !containsXuguTable(tables, fixture.parent, "TABLE") ||
			!containsXuguTable(tables, fixture.child, "TABLE") ||
			!containsXuguTable(tables, fixture.view, "VIEW") {
			t.Fatalf("fixture tables/views missing from catalog: %#v", tables)
		}

		views, err := s.listTables(schema, metadataListConstraints{ObjectTypes: []string{"VIEW"}, Filter: fixture.view})
		if err != nil {
			t.Fatalf("list views: %v", err)
		}
		if len(views) != 1 || !strings.EqualFold(views[0].Name, fixture.view) || views[0].TableType != "VIEW" {
			t.Fatalf("filtered view catalog mismatch: %#v", views)
		}

		objects, err := s.listObjects(schema, metadataListConstraints{Filter: fixture.suffix})
		if err != nil {
			t.Fatalf("list objects: %v", err)
		}
		if !containsXuguObjectType(objects, fixture.parent, "TABLE") ||
			!containsXuguObjectType(objects, fixture.view, "VIEW") {
			t.Fatalf("fixture objects missing from object catalog: %#v", objects)
		}
	})

	t.Run("column_and_constraint_metadata", func(t *testing.T) {
		columns, err := s.getColumns(schema, fixture.parent)
		if err != nil {
			t.Fatalf("get parent columns: %v", err)
		}
		if len(columns) != 5 {
			t.Fatalf("parent column count = %d, want 5: %#v", len(columns), columns)
		}
		byName := make(map[string]columnInfo, len(columns))
		for _, column := range columns {
			byName[strings.ToUpper(column.Name)] = column
		}
		for _, name := range []string{"ID", "NAME", "AMOUNT", "ACTIVE", "CREATED_AT"} {
			if _, ok := byName[name]; !ok {
				t.Fatalf("column %q missing: %#v", name, columns)
			}
		}
		if !byName["ID"].IsPrimaryKey || byName["NAME"].IsNullable {
			t.Fatalf("primary-key/not-null mapping is incorrect: %#v", byName)
		}
		if byName["NAME"].Comment == nil || *byName["NAME"].Comment != "synthetic display name" {
			t.Fatalf("column comment was not preserved: %#v", byName["NAME"])
		}

		constraints, err := s.listConstraints(schema, fixture.parent)
		if err != nil {
			t.Fatalf("list parent constraints: %v", err)
		}
		if !containsXuguConstraint(constraints, fixture.parentPK) {
			t.Fatalf("primary-key constraint missing: %#v", constraints)
		}

		foreignKeys, err := s.listForeignKeys(schema, fixture.child)
		if err != nil {
			t.Fatalf("list child foreign keys: %v", err)
		}
		if len(foreignKeys) != 1 || !strings.EqualFold(foreignKeys[0].RefTable, fixture.parent) ||
			!strings.EqualFold(foreignKeys[0].Column, "PARENT_ID") || !strings.EqualFold(foreignKeys[0].RefColumn, "ID") {
			t.Fatalf("foreign-key mapping mismatch: %#v", foreignKeys)
		}

		indexes, err := s.listIndexes(schema, fixture.child)
		if err != nil {
			t.Fatalf("list child indexes: %v", err)
		}
		if !containsXuguIndex(indexes, fixture.childIndex) {
			t.Fatalf("child index missing: %#v", indexes)
		}
		for _, index := range indexes {
			if strings.EqualFold(index.Name, fixture.childIndex) && index.IsUnique {
				t.Fatalf("ordinary fixture index must not be reported unique: %#v", index)
			}
		}
	})

	t.Run("ddl_and_object_source", func(t *testing.T) {
		ddl, err := s.getTableDDL(schema, fixture.parent)
		if err != nil {
			t.Fatalf("get parent table DDL: %v", err)
		}
		upperDDL := strings.ToUpper(ddl)
		for _, expected := range []string{"CREATE TABLE", fixture.parent, "ID", "NAME", "AMOUNT"} {
			if !strings.Contains(upperDDL, strings.ToUpper(expected)) {
				t.Fatalf("table DDL missing %q:\n%s", expected, ddl)
			}
		}
		if !strings.Contains(ddl, "synthetic table") || !strings.Contains(ddl, "synthetic display name") {
			t.Fatalf("table comments were not included in reconstructed DDL:\n%s", ddl)
		}

		source, err := s.getObjectSource(schema, fixture.view, "VIEW")
		if err != nil {
			t.Fatalf("get view source: %v", err)
		}
		viewSource := fmt.Sprint(source["source"])
		if !strings.Contains(strings.ToUpper(viewSource), "CREATE") ||
			!strings.Contains(strings.ToUpper(viewSource), fixture.parent) {
			t.Fatalf("view source does not reference its parent: %#v", source)
		}

		objects, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: []string{"VIEW"}, Filter: fixture.view})
		if err != nil || len(objects) != 1 {
			t.Fatalf("view object lookup failed: objects=%#v err=%v", objects, err)
		}
	})

	t.Run("query_and_dml", func(t *testing.T) {
		result, err := s.executeQuery(queryOptions{
			SQL:      "SELECT ID, NAME, AMOUNT, ACTIVE FROM " + fixture.qualifiedParent() + " ORDER BY ID",
			MaxRows:  20,
			Database: params.Database,
			Schema:   schema,
		})
		if err != nil {
			t.Fatalf("select fixture rows: %v", err)
		}
		if len(result.Rows) != 2 || len(result.Columns) != 4 {
			t.Fatalf("initial query shape = columns=%#v rows=%#v", result.Columns, result.Rows)
		}
		if result.Rows[0][1] == nil || fmt.Sprint(result.Rows[0][1]) != "alpha" {
			t.Fatalf("unexpected first fixture row: %#v", result.Rows[0])
		}

		transaction := xuguRawTransaction(t, schema, []string{
			"INSERT INTO " + fixture.qualifiedParent() + " VALUES (3, 'gamma', 3.75, TRUE, CURRENT_TIMESTAMP)",
			"INSERT INTO " + fixture.qualifiedChild() + " VALUES (3, 1, 'third child')",
		})
		committed, err := s.executeTransaction(transaction)
		if err != nil {
			t.Fatalf("execute transaction: %v", err)
		}
		if committed.AffectedRows != 2 {
			t.Fatalf("transaction affected rows = %d, want 2: %#v", committed.AffectedRows, committed)
		}

		count, err := s.executeQuery(queryOptions{SQL: "SELECT COUNT(*) FROM " + fixture.qualifiedParent(), MaxRows: 2})
		if err != nil {
			t.Fatalf("count committed rows: %v", err)
		}
		if len(count.Rows) != 1 || len(count.Rows[0]) != 1 || fmt.Sprint(count.Rows[0][0]) != "3" {
			t.Fatalf("committed row count = %#v", count.Rows)
		}
	})

	t.Run("cursor_paging", func(t *testing.T) {
		page, err := s.executeQueryPage(queryOptions{
			SQL:      "SELECT ID, NAME FROM " + fixture.qualifiedParent() + " ORDER BY ID",
			MaxRows:  3,
			Database: params.Database,
			Schema:   schema,
		}, 2)
		if err != nil {
			t.Fatalf("first query page: %v", err)
		}
		if len(page.Rows) != 2 || !page.HasMore || page.SessionID == nil {
			t.Fatalf("first page = %#v, want two rows and a cursor", page)
		}
		second, err := s.fetchQueryPage(*page.SessionID, 2)
		if err != nil {
			t.Fatalf("second query page: %v", err)
		}
		if len(second.Rows) != 1 || second.HasMore || second.SessionID != nil {
			t.Fatalf("second page = %#v, want final row without cursor", second)
		}
	})

	t.Run("sql_error_recovery", func(t *testing.T) {
		_, err := s.executeQuery(queryOptions{SQL: "SELECT * FROM " + quoteIdentifier("DBX_COMMON_MISSING_") + "", MaxRows: 1})
		if err == nil {
			t.Fatal("missing table query unexpectedly succeeded")
		}
		if err := s.validateConnection(); err != nil {
			t.Fatalf("connection was not reusable after SQL error: %v", err)
		}
		result, err := s.executeQuery(queryOptions{SQL: "SELECT 1", MaxRows: 1})
		if err != nil || len(result.Rows) != 1 {
			t.Fatalf("post-error SELECT 1 failed: result=%#v err=%v", result, err)
		}
	})
}

type xuguCommonFixture struct {
	schema     string
	suffix     string
	parent     string
	child      string
	view       string
	childIndex string
	parentPK   string
}

func newXuguCommonFixture(schema string) xuguCommonFixture {
	suffix := strings.ToUpper(fmt.Sprintf("%x", time.Now().UnixNano()))
	// Keep generated identifiers comfortably below Xugu's identifier limit.
	suffix = suffix[len(suffix)-10:]
	return xuguCommonFixture{
		schema:     schema,
		suffix:     suffix,
		parent:     "DBX_IT_PARENT_" + suffix,
		child:      "DBX_IT_CHILD_" + suffix,
		view:       "DBX_IT_VIEW_" + suffix,
		childIndex: "DBX_IT_CHILD_I_" + suffix,
		parentPK:   "DBX_IT_PARENT_PK_" + suffix,
	}
}

func (f xuguCommonFixture) qualified(name string) string {
	return quoteIdentifier(f.schema) + "." + quoteIdentifier(name)
}

func (f xuguCommonFixture) qualifiedParent() string { return f.qualified(f.parent) }
func (f xuguCommonFixture) qualifiedChild() string  { return f.qualified(f.child) }
func (f xuguCommonFixture) qualifiedView() string   { return f.qualified(f.view) }

func createXuguCommonFixture(t *testing.T, s *server, f xuguCommonFixture) {
	t.Helper()
	statements := []string{
		"CREATE TABLE " + f.qualifiedParent() + " (" +
			quoteIdentifier("ID") + " INTEGER NOT NULL, " +
			quoteIdentifier("NAME") + " VARCHAR(64) NOT NULL, " +
			quoteIdentifier("AMOUNT") + " NUMERIC(12,2), " +
			quoteIdentifier("ACTIVE") + " BOOLEAN, " +
			quoteIdentifier("CREATED_AT") + " DATETIME, " +
			"CONSTRAINT " + quoteIdentifier(f.parentPK) + " PRIMARY KEY (" + quoteIdentifier("ID") + "))",
		"COMMENT ON TABLE " + f.qualifiedParent() + " IS 'synthetic table'",
		"COMMENT ON COLUMN " + f.qualifiedParent() + "." + quoteIdentifier("NAME") + " IS 'synthetic display name'",
		"CREATE TABLE " + f.qualifiedChild() + " (" +
			quoteIdentifier("ID") + " INTEGER NOT NULL PRIMARY KEY, " +
			quoteIdentifier("PARENT_ID") + " INTEGER REFERENCES " + f.qualifiedParent() + " (" + quoteIdentifier("ID") + "), " +
			quoteIdentifier("LABEL") + " VARCHAR(64))",
		"CREATE INDEX " + quoteIdentifier(f.childIndex) + " ON " + f.qualifiedChild() + " (" + quoteIdentifier("LABEL") + ")",
		"CREATE OR REPLACE VIEW " + f.qualifiedView() + " AS SELECT " + quoteIdentifier("ID") + ", " + quoteIdentifier("NAME") + " FROM " + f.qualifiedParent(),
		"INSERT INTO " + f.qualifiedParent() + " VALUES (1, 'alpha', 10.50, TRUE, CURRENT_TIMESTAMP)",
		"INSERT INTO " + f.qualifiedParent() + " VALUES (2, 'beta', 20.25, FALSE, CURRENT_TIMESTAMP)",
		"INSERT INTO " + f.qualifiedChild() + " VALUES (1, 1, 'first child')",
		"INSERT INTO " + f.qualifiedChild() + " VALUES (2, 2, 'second child')",
	}
	for _, statement := range statements {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatalf("fixture statement failed: %s: %v", statement, err)
		}
	}
}

func cleanupXuguCommonFixture(t *testing.T, s *server, f xuguCommonFixture) {
	t.Helper()
	for _, statement := range []string{
		"DROP VIEW IF EXISTS " + f.qualifiedView(),
		"DROP TABLE IF EXISTS " + f.qualifiedChild(),
		"DROP TABLE IF EXISTS " + f.qualifiedParent(),
	} {
		if err := s.execWithReconnect(statement); err != nil && !isXuguObjectMissingError(err) {
			t.Logf("fixture cleanup statement failed: %s: %v", statement, err)
		}
	}
}

func containsXuguTable(tables []tableInfo, name, tableType string) bool {
	for _, table := range tables {
		if strings.EqualFold(table.Name, name) && strings.EqualFold(table.TableType, tableType) {
			return true
		}
	}
	return false
}

func containsXuguObjectType(objects []objectInfo, name, objectType string) bool {
	for _, object := range objects {
		if strings.EqualFold(object.Name, name) && strings.EqualFold(object.ObjectType, objectType) {
			return true
		}
	}
	return false
}

func containsXuguConstraint(constraints []constraintInfo, name string) bool {
	for _, constraint := range constraints {
		if strings.EqualFold(constraint.Name, name) {
			return true
		}
	}
	return false
}

func xuguRawTransaction(t *testing.T, schema string, statements []string) map[string]json.RawMessage {
	t.Helper()
	schemaValue, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}
	statementsValue, err := json.Marshal(statements)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]json.RawMessage{
		"schema":     schemaValue,
		"statements": statementsValue,
	}
}

func isXuguObjectMissingError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToUpper(err.Error())
	return strings.Contains(message, "NOT FOUND") || strings.Contains(message, "DOES NOT EXIST") || strings.Contains(message, "DOESN'T EXIST")
}
