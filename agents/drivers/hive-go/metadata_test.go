package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"reflect"
	"testing"

	"github.com/t8y2/dbx/agents/go-common/gohive"
)

func TestShowTablesRowName(t *testing.T) {
	if value := showTablesRowName([]string{"database", "tableName", "isTemporary"}, []any{"default", "events", false}); value != "events" {
		t.Fatalf("unexpected table name: %q", value)
	}
	if value := showTablesRowName([]string{"tab_name"}, []any{"fallback"}); value != "fallback" {
		t.Fatalf("unexpected fallback table name: %q", value)
	}
}

func TestListDatabasesUsesShowDatabasesBeforeHiveServerMetadata(t *testing.T) {
	behavior := &scriptedBehavior{
		query: func(ctx context.Context, sql string) (driver.Rows, error) {
			if sql != "SHOW DATABASES" {
				t.Fatalf("unexpected query: %q", sql)
			}
			return newScriptedRows(ctx, []string{"database_name"}, []string{"STRING"}, [][]driver.Value{{"warehouse"}, {"default"}, {"default"}}), nil
		},
		getSchemas: func(_ context.Context, pattern string) (gohive.MetadataResult, error) {
			t.Fatalf("metadata fallback must not run after SHOW DATABASES succeeds: %q", pattern)
			return gohive.MetadataResult{}, nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.listDatabases()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, []databaseInfo{{Name: "default"}, {Name: "warehouse"}}) {
		t.Fatalf("unexpected databases: %#v", values)
	}
}

func TestListDatabasesFallsBackToHiveServerMetadata(t *testing.T) {
	behavior := &scriptedBehavior{
		query: func(context.Context, string) (driver.Rows, error) {
			return nil, errors.New("SHOW DATABASES unsupported")
		},
		getSchemas: func(_ context.Context, pattern string) (gohive.MetadataResult, error) {
			if pattern != "%" {
				t.Fatalf("unexpected schema pattern: %q", pattern)
			}
			return metadataResult([]string{"TABLE_SCHEM", "TABLE_CATALOG"}, []driver.Value{"warehouse", ""}, []driver.Value{"default", ""}, []driver.Value{"default", ""}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.listDatabases()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, []databaseInfo{{Name: "default"}, {Name: "warehouse"}}) {
		t.Fatalf("unexpected databases: %#v", values)
	}
}

func TestListSchemasHonorsVisibleSchemaFilter(t *testing.T) {
	behavior := &scriptedBehavior{
		query: func(ctx context.Context, sql string) (driver.Rows, error) {
			if sql != "SHOW DATABASES" {
				t.Fatalf("unexpected query: %q", sql)
			}
			return newScriptedRows(
				ctx,
				[]string{"database_name"},
				[]string{"STRING"},
				[][]driver.Value{{"default"}, {"analytics"}, {"system"}},
			), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()

	values, err := server.listSchemas([]string{"analytics", "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, []string{"analytics"}) {
		t.Fatalf("unexpected visible schemas: %#v", values)
	}

	values, err = server.listSchemas([]string{})
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 0 {
		t.Fatalf("explicit empty visible schema filter must hide all schemas: %#v", values)
	}
}

func TestListTablesPreservesViewTypeCommentAndWindow(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(_ context.Context, schema, table string, tableTypes []string) (gohive.MetadataResult, error) {
			if schema != "analytics" || table != "%" || !reflect.DeepEqual(tableTypes, []string{"TABLE", "VIEW", "MATERIALIZED VIEW"}) {
				t.Fatalf("unexpected GetTables request: schema=%q table=%q types=%#v", schema, table, tableTypes)
			}
			return metadataResult(
				[]string{"TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS"},
				[]driver.Value{"", "analytics", "events", "TABLE", "event data"},
				[]driver.Value{"", "analytics", "events_view", "VIEW", "view data"},
				[]driver.Value{"", "analytics", "other", "TABLE", nil},
			), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.listTables("analytics", metadataListConstraints{Filter: "events", Offset: 1, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	comment := "view data"
	expected := []tableInfo{{Name: "events_view", TableType: "VIEW", Comment: &comment}}
	if !reflect.DeepEqual(values, expected) {
		t.Fatalf("unexpected tables: %#v", values)
	}
}

func TestGetColumnsUsesHiveServerMetadataFields(t *testing.T) {
	behavior := &scriptedBehavior{
		getColumns: func(_ context.Context, schema, table, column string) (gohive.MetadataResult, error) {
			if schema != "analytics" || table != "events" || column != "%" {
				t.Fatalf("unexpected GetColumns request: %q %q %q", schema, table, column)
			}
			return metadataResult(
				[]string{"COLUMN_NAME", "TYPE_NAME", "COLUMN_SIZE", "DECIMAL_DIGITS", "NULLABLE", "REMARKS", "COLUMN_DEF"},
				[]driver.Value{"name", "string", int64(255), nil, int64(1), "display name", "unknown"},
				[]driver.Value{"amount", "decimal(18,2)", int64(18), int64(2), int64(0), nil, nil},
			), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.getColumns("analytics", "events")
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 {
		t.Fatalf("unexpected columns: %#v", values)
	}
	if values[0].Name != "name" || !values[0].IsNullable || values[0].CharacterMaximumLength == nil || *values[0].CharacterMaximumLength != 255 || values[0].ColumnDefault == nil || *values[0].ColumnDefault != "unknown" {
		t.Fatalf("unexpected string column: %#v", values[0])
	}
	if values[1].Name != "amount" || values[1].IsNullable || values[1].NumericPrecision == nil || *values[1].NumericPrecision != 18 || values[1].NumericScale == nil || *values[1].NumericScale != 2 || values[1].CharacterMaximumLength != nil {
		t.Fatalf("unexpected decimal column: %#v", values[1])
	}
}

func TestTableCommentAndTypeInfoUseHiveServerMetadata(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(_ context.Context, schema, table string, tableTypes []string) (gohive.MetadataResult, error) {
			return metadataResult(
				[]string{"TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS"},
				[]driver.Value{schema, table, "TABLE", "table comment"},
			), nil
		},
		getTypeInfo: func(context.Context) (gohive.MetadataResult, error) {
			return metadataResult([]string{"TYPE_NAME"}, []driver.Value{"STRING"}, []driver.Value{"decimal"}, []driver.Value{"STRING"}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	comment, err := server.getTableComment("analytics", "events")
	if err != nil || comment == nil || *comment != "table comment" {
		t.Fatalf("unexpected table comment: %v, %v", comment, err)
	}
	types, err := server.listDataTypes()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(types, []string{"decimal", "string"}) {
		t.Fatalf("unexpected data types: %#v", types)
	}
}

func TestListTablesFallsBackToShowTables(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(context.Context, string, string, []string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unsupported")
		},
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			if query != "SHOW TABLES IN `analytics`" {
				t.Fatalf("unexpected fallback query: %q", query)
			}
			return newScriptedRows(ctx, []string{"tab_name"}, []string{"STRING"}, [][]driver.Value{{"events"}}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.listTables("analytics", metadataListConstraints{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, []tableInfo{{Name: "events", TableType: "TABLE"}}) {
		t.Fatalf("unexpected fallback tables: %#v", values)
	}
}

func metadataResult(columns []string, rows ...[]driver.Value) gohive.MetadataResult {
	return gohive.MetadataResult{Columns: columns, Rows: rows}
}
