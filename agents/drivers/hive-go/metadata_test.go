package main

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
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

func TestKyuubiConnectionInfoReportsNativeIdentity(t *testing.T) {
	behavior := &scriptedBehavior{
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			switch query {
			case "SELECT VERSION()":
				return newScriptedRows(ctx, []string{"version"}, []string{"STRING"}, [][]driver.Value{{"3.5.8"}}), nil
			case "SELECT CURRENT_USER()":
				return newScriptedRows(ctx, []string{"current_user"}, []string{"STRING"}, [][]driver.Value{{"dbx"}}), nil
			default:
				return nil, errors.New("unexpected query: " + query)
			}
		},
	}
	server := newScriptedServer(t, behavior)
	server.params.DatabaseType = "kyuubi"
	server.config.Username = "fallback"

	info, err := server.connectionInfo()
	if err != nil {
		t.Fatal(err)
	}
	if info["compatibilityMode"] != "kyuubi" || info["username"] != "dbx" || info["version"] != "3.5.8" {
		t.Fatalf("unexpected Kyuubi connection info: %#v", info)
	}
	databaseInfo, ok := info["databaseInfo"].(map[string]string)
	if !ok || databaseInfo["productName"] != "Apache Kyuubi" || databaseInfo["driverName"] != "DBX Kyuubi Go Agent" {
		t.Fatalf("unexpected Kyuubi database identity: %#v", info["databaseInfo"])
	}
}

func TestGetObjectSourceReturnsProtocolObject(t *testing.T) {
	behavior := &scriptedBehavior{
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			if query != "SHOW CREATE TABLE `dbx_kyuubi_demo`.`high_value_orders`" {
				t.Fatalf("unexpected query: %q", query)
			}
			return newScriptedRows(
				ctx,
				[]string{"createtab_stmt"},
				[]string{"STRING"},
				[][]driver.Value{
					{"CREATE VIEW dbx_kyuubi_demo.high_value_orders"},
					{"AS SELECT id, customer, amount FROM dbx_kyuubi_demo.orders WHERE amount >= 50"},
				},
			), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()

	result, _, err := server.dispatch("get_object_source", map[string]json.RawMessage{
		"schema":      json.RawMessage(`"dbx_kyuubi_demo"`),
		"name":        json.RawMessage(`"high_value_orders"`),
		"object_type": json.RawMessage(`"VIEW"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	source, ok := result.(objectSource)
	if !ok {
		t.Fatalf("get_object_source returned %T instead of objectSource", result)
	}
	if source.Name != "high_value_orders" || source.ObjectType != "VIEW" || source.Schema == nil || *source.Schema != "dbx_kyuubi_demo" {
		t.Fatalf("unexpected object source metadata: %#v", source)
	}
	expected := "CREATE VIEW dbx_kyuubi_demo.high_value_orders\nAS SELECT id, customer, amount FROM dbx_kyuubi_demo.orders WHERE amount >= 50\n"
	if source.Source != expected {
		t.Fatalf("unexpected object source DDL: %q", source.Source)
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
				[]driver.Value{"name", "string", int64(255), nil, int64(1), "显示名称", "unknown"},
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
	if values[0].Name != "name" || !values[0].IsNullable || values[0].CharacterMaximumLength == nil || *values[0].CharacterMaximumLength != 255 || values[0].ColumnDefault == nil || *values[0].ColumnDefault != "unknown" || values[0].Comment == nil || *values[0].Comment != "显示名称" {
		t.Fatalf("unexpected string column: %#v", values[0])
	}
	if values[1].Name != "amount" || values[1].IsNullable || values[1].NumericPrecision == nil || *values[1].NumericPrecision != 18 || values[1].NumericScale == nil || *values[1].NumericScale != 2 || values[1].CharacterMaximumLength != nil {
		t.Fatalf("unexpected decimal column: %#v", values[1])
	}
}

func TestGetColumnsPreservesChineseDescribeFallbackComments(t *testing.T) {
	behavior := &scriptedBehavior{
		getColumns: func(context.Context, string, string, string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unavailable")
		},
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			if query != "DESCRIBE `analytics`.`events`" {
				t.Fatalf("unexpected DESCRIBE query: %q", query)
			}
			return newScriptedRows(
				ctx,
				[]string{"col_name", "data_type", "comment"},
				[]string{"STRING", "STRING", "STRING"},
				[][]driver.Value{{"name", "string", "显示名称"}, {"amount", "decimal(18,2)", "含税金额"}},
			), nil
		},
	}
	server := newScriptedServer(t, behavior)
	values, err := server.getColumns("analytics", "events")
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || values[0].Comment == nil || *values[0].Comment != "显示名称" || values[1].Comment == nil || *values[1].Comment != "含税金额" {
		t.Fatalf("DESCRIBE comments changed: %#v", values)
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

func TestListTablesFallsBackToShowTablesAndViews(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(context.Context, string, string, []string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unsupported")
		},
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			switch query {
			case "SHOW TABLES IN `analytics`":
				return newScriptedRows(
					ctx,
					[]string{"tab_name"},
					[]string{"STRING"},
					[][]driver.Value{{"events"}, {"shared_name"}},
				), nil
			case "SHOW VIEWS IN `analytics`":
				return newScriptedRows(
					ctx,
					[]string{"view_name"},
					[]string{"STRING"},
					[][]driver.Value{{"events_view"}, {"shared_name"}},
				), nil
			default:
				t.Fatalf("unexpected fallback query: %q", query)
				return nil, errors.New("unexpected fallback query")
			}
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.listTables("analytics", metadataListConstraints{})
	if err != nil {
		t.Fatal(err)
	}
	expected := []tableInfo{
		{Name: "events", TableType: "TABLE"},
		{Name: "events_view", TableType: "VIEW"},
		{Name: "shared_name", TableType: "VIEW"},
	}
	if !reflect.DeepEqual(values, expected) {
		t.Fatalf("unexpected fallback tables: %#v", values)
	}
}

func TestListTablesKeepsShowTablesResultsWhenShowViewsIsUnsupported(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(context.Context, string, string, []string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unsupported")
		},
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			switch query {
			case "SHOW TABLES IN `analytics`":
				return newScriptedRows(ctx, []string{"tab_name"}, []string{"STRING"}, [][]driver.Value{{"events"}}), nil
			case "SHOW VIEWS IN `analytics`":
				return nil, errors.New("SHOW VIEWS is unsupported")
			default:
				t.Fatalf("unexpected fallback query: %q", query)
				return nil, errors.New("unexpected fallback query")
			}
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

func TestListTablesReturnsNonCapabilityShowViewsError(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(context.Context, string, string, []string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unsupported")
		},
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			switch query {
			case "SHOW TABLES IN `analytics`":
				return newScriptedRows(ctx, []string{"tab_name"}, []string{"STRING"}, [][]driver.Value{{"events"}}), nil
			case "SHOW VIEWS IN `analytics`":
				return nil, errors.New("permission denied for SHOW VIEWS")
			default:
				t.Fatalf("unexpected fallback query: %q", query)
				return nil, errors.New("unexpected fallback query")
			}
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()

	_, err := server.listTables("analytics", metadataListConstraints{})
	if err == nil || !strings.Contains(err.Error(), "SHOW VIEWS fallback failed: permission denied") {
		t.Fatalf("unexpected mixed fallback error: %v", err)
	}
}

func TestShowViewsUnsupported(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		unsupported bool
	}{
		{name: "explicit unsupported", err: errors.New("SHOW VIEWS is unsupported"), unsupported: true},
		{name: "not supported", err: errors.New("SHOW VIEWS is not supported before Hive 2.2"), unsupported: true},
		{name: "old parser", err: errors.New("ParseException: syntax error at or near VIEWS"), unsupported: true},
		{name: "permission", err: errors.New("permission denied for SHOW VIEWS")},
		{name: "timeout", err: context.DeadlineExceeded},
		{name: "cancel", err: context.Canceled},
		{name: "authentication", err: errors.New("authentication failed")},
		{name: "unsupported authentication", err: errors.New("unsupported authentication mechanism")},
		{name: "transport", err: errors.New("transport is closed")},
		{name: "unsupported transport", err: errors.New("transport does not support SASL")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if actual := showViewsUnsupported(test.err); actual != test.unsupported {
				t.Fatalf("showViewsUnsupported(%v) = %v, want %v", test.err, actual, test.unsupported)
			}
		})
	}
}

func TestListTablesFallbackHonorsExplicitTableType(t *testing.T) {
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

	values, err := server.listTables("analytics", metadataListConstraints{ObjectTypes: []string{"TABLE"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, []tableInfo{{Name: "events", TableType: "TABLE"}}) {
		t.Fatalf("unexpected fallback tables: %#v", values)
	}
}

func TestListViewsFallsBackToShowViews(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(context.Context, string, string, []string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unsupported")
		},
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			if query != "SHOW VIEWS IN `analytics`" {
				t.Fatalf("unexpected fallback query: %q", query)
			}
			return newScriptedRows(ctx, []string{"view_name"}, []string{"STRING"}, [][]driver.Value{{"events_view"}}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	values, err := server.listTables("analytics", metadataListConstraints{ObjectTypes: []string{"VIEW"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, []tableInfo{{Name: "events_view", TableType: "VIEW"}}) {
		t.Fatalf("unexpected fallback views: %#v", values)
	}
}

func TestListViewsReturnsFallbackErrorWhenShowViewsIsUnsupported(t *testing.T) {
	behavior := &scriptedBehavior{
		getTables: func(context.Context, string, string, []string) (gohive.MetadataResult, error) {
			return gohive.MetadataResult{}, errors.New("metadata unsupported")
		},
		query: func(_ context.Context, query string) (driver.Rows, error) {
			if query != "SHOW VIEWS IN `analytics`" {
				t.Fatalf("unexpected fallback query: %q", query)
			}
			return nil, errors.New("SHOW VIEWS is unsupported")
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()

	_, err := server.listTables("analytics", metadataListConstraints{ObjectTypes: []string{"VIEW"}})
	if err == nil || !strings.Contains(err.Error(), "SHOW VIEWS fallback failed") {
		t.Fatalf("unexpected explicit view fallback error: %v", err)
	}
}

func metadataResult(columns []string, rows ...[]driver.Value) gohive.MetadataResult {
	return gohive.MetadataResult{Columns: columns, Rows: rows}
}

func TestListObjectsIncludesProceduresAndFunctionsFromSystemViews(t *testing.T) {
	proceduresQuery := "SELECT procedure_name FROM system.procedures_v WHERE lower(database_name) = lower('ods') AND lower(procedure_name) LIKE '%sp%' ORDER BY procedure_name"
	functionsQuery := "SELECT function_name FROM system.functions_v WHERE lower(database_name) = lower('ods') AND lower(function_name) LIKE '%sp%' ORDER BY function_name"
	behavior := &scriptedBehavior{
		query: func(_ context.Context, query string) (driver.Rows, error) {
			switch query {
			case proceduresQuery:
				return newScriptedRows(context.Background(), []string{"procedure_name"}, []string{"STRING"}, [][]driver.Value{
					{"sp_daily_etl"}, {"sp_hourly_agg"},
				}), nil
			case functionsQuery:
				return newScriptedRows(context.Background(), []string{"function_name"}, []string{"STRING"}, [][]driver.Value{
					{"fn_clean"},
				}), nil
			default:
				return nil, errors.New("unexpected query: " + query)
			}
		},
	}
	server := newScriptedServer(t, behavior)
	server.params.DatabaseType = "argo"
	defer server.disconnect()

	values, err := server.listObjects("ods", metadataListConstraints{
		ObjectTypes: []string{"PROCEDURE", "FUNCTION"},
		Filter:      "sp", // "sp" overlaps the procedure filter; both lists get "%sp%" applied
	})
	if err != nil {
		t.Fatalf("listObjects: %v", err)
	}
	t.Logf("values: %+v", values)
	// listObjects applies the same filter pattern to procedures and functions;
	// we passed "sp" so procedures match and functions don't (because the function
	// list returns rows regardless of filter — that is, listObjects calls each
	// listRoutines call with the same Filter). Verify both queries ran and
	// the procedure name is present.
	queries, _, _, _ := behavior.snapshot()
	t.Logf("queries count: %d", len(queries))
	for i, q := range queries {
		t.Logf("query[%d]: %q", i, q)
	}
	if len(queries) != 2 {
		t.Fatalf("expected exactly 2 routine queries, got %d: %v", len(queries), queries)
	}
	if values == nil {
		t.Fatal("expected non-nil object list")
	}
	names := make([]string, len(values))
	for i, v := range values {
		names[i] = v.Name + ":" + v.ObjectType
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "sp_daily_etl:PROCEDURE") {
		t.Fatalf("expected procedures in result, got %v", values)
	}
	if !strings.Contains(joined, "fn_clean:FUNCTION") {
		t.Fatalf("expected functions in result, got %v", values)
	}
}

func TestGetObjectSourceRoutesProceduresToSystemProceduresView(t *testing.T) {
	expectedSQL := "SELECT full_text FROM system.procedures_v WHERE lower(database_name) = lower('ods') AND procedure_name = 'sp_daily_etl'"
	behavior := &scriptedBehavior{
		query: func(_ context.Context, query string) (driver.Rows, error) {
			if query != expectedSQL {
				return nil, errors.New("unexpected query: " + query)
			}
			return newScriptedRows(context.Background(), []string{"full_text"}, []string{"STRING"}, [][]driver.Value{
				{"-- daily ETL pipeline"},
				{"INSERT OVERWRITE TABLE ods.daily_summary SELECT * FROM staging.events"},
			}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	server.params.DatabaseType = "argo"
	defer server.disconnect()

	result, _, err := server.dispatch("get_object_source", map[string]json.RawMessage{
		"schema":      json.RawMessage(`"ods"`),
		"name":        json.RawMessage(`"sp_daily_etl"`),
		"object_type": json.RawMessage(`"PROCEDURE"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	source, ok := result.(objectSource)
	if !ok {
		t.Fatalf("get_object_source returned %T instead of objectSource", result)
	}
	if source.Name != "sp_daily_etl" || source.ObjectType != "PROCEDURE" {
		t.Fatalf("unexpected object source metadata: %#v", source)
	}
	expected := "-- daily ETL pipeline\nINSERT OVERWRITE TABLE ods.daily_summary SELECT * FROM staging.events\n"
	if source.Source != expected {
		t.Fatalf("unexpected procedure source: %q", source.Source)
	}
}

func TestGetObjectSourceRoutesFunctionsToSystemFunctionsView(t *testing.T) {
	expectedSQL := "SELECT full_text FROM system.functions_v WHERE lower(database_name) = lower('ods') AND function_name = 'fn_clean'"
	behavior := &scriptedBehavior{
		query: func(_ context.Context, query string) (driver.Rows, error) {
			if query != expectedSQL {
				return nil, errors.New("unexpected query: " + query)
			}
			return newScriptedRows(context.Background(), []string{"full_text"}, []string{"STRING"}, [][]driver.Value{
				{"-- cleanup helper"},
			}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	server.params.DatabaseType = "argo"
	defer server.disconnect()

	result, _, err := server.dispatch("get_object_source", map[string]json.RawMessage{
		"schema":      json.RawMessage(`"ods"`),
		"name":        json.RawMessage(`"fn_clean"`),
		"object_type": json.RawMessage(`"FUNCTION"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	source, ok := result.(objectSource)
	if !ok {
		t.Fatalf("get_object_source returned %T instead of objectSource", result)
	}
	if source.Source != "-- cleanup helper\n" {
		t.Fatalf("unexpected function source: %q", source.Source)
	}
}

func TestListObjectsDoesNotQueryRoutinesForVanillaHive(t *testing.T) {
	behavior := &scriptedBehavior{
		query: func(ctx context.Context, query string) (driver.Rows, error) {
			if strings.Contains(strings.ToUpper(query), "PROCEDURES_V") || strings.Contains(strings.ToUpper(query), "FUNCTIONS_V") {
				t.Fatalf("vanilla Hive must not query routine views, got: %s", query)
			}
			return newScriptedRows(ctx, []string{"tab_name"}, []string{"STRING"}, [][]driver.Value{{"events"}}), nil
		},
	}
	server := newScriptedServer(t, behavior)
	server.params.DatabaseType = "hive"
	defer server.disconnect()

	values, err := server.listObjects("ods", metadataListConstraints{
		ObjectTypes: []string{"PROCEDURE", "FUNCTION"},
	})
	if err != nil {
		t.Fatalf("listObjects: %v", err)
	}
	for _, v := range values {
		if v.ObjectType == "PROCEDURE" || v.ObjectType == "FUNCTION" {
			t.Fatalf("vanilla Hive should not surface routines, got: %+v", v)
		}
	}
}
