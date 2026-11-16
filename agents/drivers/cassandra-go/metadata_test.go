package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

type testCassandraRequestError struct {
	code    int
	message string
}

func (e *testCassandraRequestError) Error() string   { return e.message }
func (e *testCassandraRequestError) Code() int       { return e.code }
func (e *testCassandraRequestError) Message() string { return e.message }

type triggerMetadataIterator struct {
	rows []struct {
		name    string
		options map[string]string
	}
	index    int
	closeErr error
}

func (i *triggerMetadataIterator) Scan(dest ...any) bool {
	if i.index >= len(i.rows) {
		return false
	}
	row := i.rows[i.index]
	i.index++
	*dest[0].(*string) = row.name
	*dest[1].(*map[string]string) = row.options
	return true
}

func (i *triggerMetadataIterator) Close() error {
	return i.closeErr
}

func TestColumnsIndexesAndDDLFromMetadata(t *testing.T) {
	textType := gocql.NewNativeType(4, gocql.TypeVarchar, "")
	intType := gocql.NewNativeType(4, gocql.TypeInt, "")
	id := &gocql.ColumnMetadata{Name: "tenant", Kind: gocql.ColumnPartitionKey, Type: textType}
	bucket := &gocql.ColumnMetadata{Name: "bucket", Kind: gocql.ColumnPartitionKey, Type: intType}
	created := &gocql.ColumnMetadata{Name: "created_at", Kind: gocql.ColumnClusteringKey, Type: textType, Order: gocql.DESC}
	email := &gocql.ColumnMetadata{
		Name: "email", Kind: gocql.ColumnRegular, Type: textType,
		Index: gocql.ColumnIndexMetadata{Name: "users_email_idx", Type: "COMPOSITES"},
	}
	metadata := &gocql.TableMetadata{
		OrderedColumns:    []string{"tenant", "bucket", "created_at", "email"},
		PartitionKey:      []*gocql.ColumnMetadata{id, bucket},
		ClusteringColumns: []*gocql.ColumnMetadata{created},
		Columns: map[string]*gocql.ColumnMetadata{
			"tenant": id, "bucket": bucket, "created_at": created, "email": email,
		},
	}

	columns := columnsFromMetadata(metadata)
	if len(columns) != 4 || !columns[0].IsPrimaryKey || columns[0].IsNullable || columns[3].IsPrimaryKey || !columns[3].IsNullable {
		t.Fatalf("unexpected columns: %#v", columns)
	}
	if columns[2].Extra == nil || *columns[2].Extra != "clustering_key" {
		t.Fatalf("unexpected clustering metadata: %#v", columns[2])
	}

	indexes := indexesFromMetadata(metadata)
	if len(indexes) != 1 || indexes[0].Name != "users_email_idx" || !reflect.DeepEqual(indexes[0].Columns, []string{"email"}) {
		t.Fatalf("unexpected indexes: %#v", indexes)
	}

	ddl, err := tableDDLFromMetadata("app", "users", metadata)
	if err != nil {
		t.Fatal(err)
	}
	want := "CREATE TABLE \"app\".\"users\" (\n" +
		"  \"tenant\" text,\n" +
		"  \"bucket\" int,\n" +
		"  \"created_at\" text,\n" +
		"  \"email\" text,\n" +
		"  PRIMARY KEY ((\"tenant\", \"bucket\"), \"created_at\")\n" +
		") WITH CLUSTERING ORDER BY (\"created_at\" DESC);"
	if ddl != want {
		t.Fatalf("unexpected DDL:\n%s\nwant:\n%s", ddl, want)
	}
}

func TestSchemaObjectDDLChoosesMaterializedViewBeforeMirroredTableMetadata(t *testing.T) {
	id := &gocql.ColumnMetadata{Name: "id", Kind: gocql.ColumnPartitionKey, Type: gocql.NewNativeType(4, gocql.TypeInt, "")}
	tableMetadata := &gocql.TableMetadata{
		OrderedColumns: []string{"id"},
		PartitionKey:   []*gocql.ColumnMetadata{id},
		Columns:        map[string]*gocql.ColumnMetadata{"id": id},
	}
	keyspace := &gocql.KeyspaceMetadata{
		Tables: map[string]*gocql.TableMetadata{
			"users":          tableMetadata,
			"users_by_email": tableMetadata,
		},
		MaterializedViews: map[string]*gocql.MaterializedViewMetadata{
			"users_by_email": {Name: "users_by_email", BaseTable: tableMetadata},
		},
	}

	viewCalls := 0
	ddl, err := schemaObjectDDLFromMetadata("app", "users_by_email", keyspace, func() (string, error) {
		viewCalls++
		return "CREATE MATERIALIZED VIEW app.users_by_email", nil
	})
	if err != nil || ddl != "CREATE MATERIALIZED VIEW app.users_by_email" || viewCalls != 1 {
		t.Fatalf("materialized view dispatch = %q, calls = %d, err = %v", ddl, viewCalls, err)
	}

	tableDDL, err := schemaObjectDDLFromMetadata("app", "users", keyspace, func() (string, error) {
		t.Fatal("ordinary table DDL must not use the materialized-view loader")
		return "", nil
	})
	if err != nil || !strings.HasPrefix(tableDDL, `CREATE TABLE "app"."users"`) {
		t.Fatalf("ordinary table DDL = %q, err = %v", tableDDL, err)
	}
	if _, err := schemaObjectDDLFromMetadata("app", "missing", keyspace, func() (string, error) {
		return "", errors.New("unexpected")
	}); err == nil || !strings.Contains(err.Error(), "table not found") {
		t.Fatalf("missing object error = %v", err)
	}
}

func TestMaterializedViewObjectSourcePreservesProtocolShape(t *testing.T) {
	result, err := materializedViewObjectSource("app", "users_by_email", "MATERIALIZED_VIEW", func() (string, error) {
		return "CREATE MATERIALIZED VIEW app.users_by_email", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Name != "users_by_email" || result.ObjectType != "MATERIALIZED_VIEW" || result.Schema == nil || *result.Schema != "app" || result.Source != "CREATE MATERIALIZED VIEW app.users_by_email" {
		t.Fatalf("unexpected object source: %#v", result)
	}

	loaderCalled := false
	_, err = materializedViewObjectSource("app", "users", "TABLE", func() (string, error) {
		loaderCalled = true
		return "unexpected", nil
	})
	if err == nil || loaderCalled || err.Error() != "object source is not supported by Cassandra" {
		t.Fatalf("unsupported source err = %v, loader called = %v", err, loaderCalled)
	}

	wantErr := errors.New("definition unavailable")
	_, err = materializedViewObjectSource("app", "users_by_email", "materialized view", func() (string, error) {
		return "", wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("object-source loader error = %v", err)
	}
}

func TestMaterializedViewDDLFromLegacyCatalogPreservesDefinition(t *testing.T) {
	catalog := materializedViewCatalog{
		BaseTable:         `Base"Events`,
		IncludeAllColumns: false,
		WhereClause:       `"Tenant Id" IS NOT NULL AND "Category" IS NOT NULL`,
		Columns: []materializedViewColumn{
			{Name: "Bucket", Kind: "clustering", Position: 1, ClusteringOrder: "asc"},
			{Name: "Payload", Kind: "regular", Position: -1},
			{Name: "Category", Kind: "partition_key", Position: 1},
			{Name: "Event Time", Kind: "clustering", Position: 0, ClusteringOrder: "desc"},
			{Name: "Tenant Id", Kind: "partition_key", Position: 0},
		},
		Options: map[string]any{
			"caching":                    map[string]string{"rows_per_partition": "NONE", "keys": "ALL"},
			"comment":                    "owner's view",
			"default_time_to_live":       0,
			"extensions":                 map[string][]byte{},
			"gc_grace_seconds":           86401,
			"speculative_retry":          "99PERCENTILE",
			"read_repair_chance":         0.0,
			"dclocal_read_repair_chance": 0.1,
		},
	}

	ddl, err := materializedViewDDLFromCatalog(`App"Ks`, `Events"ByCategory`, catalog)
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{
		`CREATE MATERIALIZED VIEW "App""Ks"."Events""ByCategory" AS`,
		`SELECT "Tenant Id", "Category", "Event Time", "Bucket", "Payload"`,
		`FROM "App""Ks"."Base""Events"`,
		`WHERE "Tenant Id" IS NOT NULL AND "Category" IS NOT NULL`,
		`PRIMARY KEY (("Tenant Id", "Category"), "Event Time", "Bucket")`,
		`CLUSTERING ORDER BY ("Event Time" DESC, "Bucket" ASC)`,
		`caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}`,
		`comment = 'owner''s view'`,
		`dclocal_read_repair_chance = 0.1`,
		`gc_grace_seconds = 86401`,
		`read_repair_chance = 0`,
		`speculative_retry = '99PERCENTILE'`,
	} {
		if !strings.Contains(ddl, fragment) {
			t.Fatalf("materialized view DDL omitted %q:\n%s", fragment, ddl)
		}
	}
	if strings.Contains(ddl, "default_time_to_live") || strings.Contains(ddl, "extensions") {
		t.Fatalf("materialized view DDL emitted non-applicable empty options:\n%s", ddl)
	}
}

func TestLegacyMaterializedViewOptionsUseVersionAppropriateReadRepair(t *testing.T) {
	modern, err := legacyMaterializedViewOptions(map[string]any{
		"read_repair":                "BLOCKING",
		"read_repair_chance":         0.0,
		"dclocal_read_repair_chance": 0.0,
		"memtable":                   "",
		"default_time_to_live":       0,
		"extensions":                 map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if modern["read_repair"] != "BLOCKING" || modern["read_repair_chance"] != nil || modern["dclocal_read_repair_chance"] != nil || modern["memtable"] != nil {
		t.Fatalf("unexpected modern options: %#v", modern)
	}

	legacy, err := legacyMaterializedViewOptions(map[string]any{
		"read_repair_chance":         0.0,
		"dclocal_read_repair_chance": 0.1,
		"default_time_to_live":       0,
		"extensions":                 map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacy["read_repair_chance"] != 0.0 || legacy["dclocal_read_repair_chance"] != 0.1 {
		t.Fatalf("unexpected Cassandra 3 options: %#v", legacy)
	}
}

func TestMaterializedViewDDLFromLegacyCatalogPreservesSelectStar(t *testing.T) {
	ddl, err := materializedViewDDLFromCatalog("app", "users_by_email", materializedViewCatalog{
		BaseTable:         "users",
		IncludeAllColumns: true,
		WhereClause:       "email IS NOT NULL AND id IS NOT NULL",
		Columns: []materializedViewColumn{
			{Name: "email", Kind: "partition_key", Position: 0},
			{Name: "id", Kind: "clustering", Position: 0, ClusteringOrder: "asc"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "SELECT *") {
		t.Fatalf("materialized view DDL did not preserve SELECT *:\n%s", ddl)
	}
}

func TestMaterializedViewDDLOnlyFallsBackForUnsupportedDescribeSyntax(t *testing.T) {
	legacyCalls := 0
	ddl, err := materializedViewDDLWithFallback(
		func() (string, error) { return "CREATE MATERIALIZED VIEW native", nil },
		func() (string, error) {
			legacyCalls++
			return "unexpected", nil
		},
	)
	if err != nil || ddl != "CREATE MATERIALIZED VIEW native" || legacyCalls != 0 {
		t.Fatalf("native DDL = %q, legacy calls = %d, err = %v", ddl, legacyCalls, err)
	}

	legacyCalls = 0
	ddl, err = materializedViewDDLWithFallback(
		func() (string, error) {
			return "", &testCassandraRequestError{code: gocql.ErrCodeSyntax, message: "no viable alternative at input 'DESCRIBE'"}
		},
		func() (string, error) {
			legacyCalls++
			return "CREATE MATERIALIZED VIEW legacy", nil
		},
	)
	if err != nil || ddl != "CREATE MATERIALIZED VIEW legacy" || legacyCalls != 1 {
		t.Fatalf("syntax fallback = %q, calls = %d, err = %v", ddl, legacyCalls, err)
	}

	permissionErr := &testCassandraRequestError{code: gocql.ErrCodeUnauthorized, message: "not authorized"}
	legacyCalls = 0
	_, err = materializedViewDDLWithFallback(
		func() (string, error) { return "", permissionErr },
		func() (string, error) {
			legacyCalls++
			return "unexpected", nil
		},
	)
	if !errors.Is(err, permissionErr) || legacyCalls != 0 {
		t.Fatalf("permission error = %v, legacy calls = %d", err, legacyCalls)
	}

	networkErr := errors.New("connection reset")
	_, err = materializedViewDDLWithFallback(
		func() (string, error) { return "", networkErr },
		func() (string, error) {
			legacyCalls++
			return "unexpected", nil
		},
	)
	if !errors.Is(err, networkErr) || legacyCalls != 0 {
		t.Fatalf("network error = %v, legacy calls = %d", err, legacyCalls)
	}
}

func TestLegacyMaterializedViewOptionsRejectLossyDefinitions(t *testing.T) {
	for name, row := range map[string]map[string]any{
		"unknown option": {
			"base_table_name": "users",
			"future_option":   "cannot safely reproduce",
		},
		"non-zero default TTL": {
			"base_table_name":      "users",
			"default_time_to_live": 60,
		},
		"non-empty extensions": {
			"base_table_name": "users",
			"extensions":      map[string][]byte{"custom": {0x01}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := legacyMaterializedViewOptions(row); err == nil {
				t.Fatal("expected an explicit error instead of a lossy legacy DDL")
			}
		})
	}
}

func TestMetadataWindowAndFilter(t *testing.T) {
	values := []string{"a", "b", "c", "d"}
	if got := applyMetadataWindow(values, 1, 2); !reflect.DeepEqual(got, []string{"b", "c"}) {
		t.Fatalf("unexpected window: %#v", got)
	}
	if !metadataNameMatches("CustomerEvents", "event") || metadataNameMatches("users", "event") {
		t.Fatal("metadata filter mismatch")
	}
}

func TestTargetColumnsHandlesCollectionIndexes(t *testing.T) {
	for input, want := range map[string]string{
		"txt":              "txt",
		"values(tags)":     "tags",
		"keys(attrs)":      "attrs",
		`entries("attrs")`: "attrs",
	} {
		got := targetColumns(input)
		if !reflect.DeepEqual(got, []string{want}) {
			t.Fatalf("targetColumns(%q) = %#v", input, got)
		}
	}
}

func TestQuoteCQLIdentifierEscapesQuotes(t *testing.T) {
	if got := quoteCQLIdentifier(`a"b`); got != `"a""b"` {
		t.Fatalf("unexpected quoted identifier: %s", got)
	}
}

func TestListTriggersQueriesExactTableAndMapsMetadata(t *testing.T) {
	var statement string
	var values []any
	triggers, err := listTriggersWithQuery(func(query string, args ...any) metadataIterator {
		statement = query
		values = args
		return &triggerMetadataIterator{rows: []struct {
			name    string
			options map[string]string
		}{
			{name: "capture_changes", options: map[string]string{"class": "example.CaptureDataTrigger"}},
		}}
	}, "dev", "example")
	if err != nil {
		t.Fatal(err)
	}
	if statement != cassandraListTriggersCQL {
		t.Fatalf("unexpected trigger query: %s", statement)
	}
	if !reflect.DeepEqual(values, []any{"dev", "example"}) {
		t.Fatalf("trigger filters = %#v", values)
	}
	want := []triggerInfo{{Name: "capture_changes", Event: "DML", Timing: "BEFORE"}}
	if !reflect.DeepEqual(triggers, want) {
		t.Fatalf("triggers = %#v, want %#v", triggers, want)
	}
}

func TestListTriggersReturnsEmptySlice(t *testing.T) {
	triggers, err := listTriggersWithQuery(func(string, ...any) metadataIterator {
		return &triggerMetadataIterator{}
	}, "dev", "empty_table")
	if err != nil {
		t.Fatal(err)
	}
	if triggers == nil || len(triggers) != 0 {
		t.Fatalf("triggers = %#v, want a non-nil empty slice", triggers)
	}
}

func TestListTriggersReturnsQueryError(t *testing.T) {
	wantErr := errors.New("trigger metadata unavailable")
	triggers, err := listTriggersWithQuery(func(string, ...any) metadataIterator {
		return &triggerMetadataIterator{closeErr: wantErr}
	}, "dev", "example")
	if !errors.Is(err, wantErr) || triggers != nil {
		t.Fatalf("triggers = %#v, err = %v", triggers, err)
	}
}

func keyspaceWithTablesAndViews() *gocql.KeyspaceMetadata {
	return &gocql.KeyspaceMetadata{
		Tables: map[string]*gocql.TableMetadata{
			"users":  {},
			"events": {},
		},
		MaterializedViews: map[string]*gocql.MaterializedViewMetadata{
			"users_by_email": {Name: "users_by_email"},
		},
	}
}

func TestTableInfosReportMaterializedViewsAsTheirOwnType(t *testing.T) {
	tables := tableInfosFromKeyspaceMetadata(keyspaceWithTablesAndViews(), metadataListConstraints{})
	want := []tableInfo{
		{Name: "events", TableType: "TABLE"},
		{Name: "users", TableType: "TABLE"},
		{Name: "users_by_email", TableType: "MATERIALIZED_VIEW"},
	}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("tables = %#v, want %#v", tables, want)
	}
}

func TestTableInfosFilterAppliesToTablesAndViews(t *testing.T) {
	tables := tableInfosFromKeyspaceMetadata(keyspaceWithTablesAndViews(), metadataListConstraints{Filter: "users"})
	want := []tableInfo{
		{Name: "users", TableType: "TABLE"},
		{Name: "users_by_email", TableType: "MATERIALIZED_VIEW"},
	}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("tables = %#v, want %#v", tables, want)
	}
}

func TestObjectInfosIncludeMaterializedViews(t *testing.T) {
	objects := objectInfosFromKeyspaceMetadata(keyspaceWithTablesAndViews(), "dev", metadataListConstraints{})
	want := []objectInfo{
		{Name: "events", ObjectType: "TABLE", Schema: "dev"},
		{Name: "users", ObjectType: "TABLE", Schema: "dev"},
		{Name: "users_by_email", ObjectType: "MATERIALIZED_VIEW", Schema: "dev"},
	}
	if !reflect.DeepEqual(objects, want) {
		t.Fatalf("objects = %#v, want %#v", objects, want)
	}
}

func TestObjectInfosRespectObjectTypeFilters(t *testing.T) {
	keyspace := keyspaceWithTablesAndViews()

	tablesOnly := objectInfosFromKeyspaceMetadata(keyspace, "dev", metadataListConstraints{ObjectTypes: []string{"table"}})
	if len(tablesOnly) != 2 || tablesOnly[0].Name != "events" || tablesOnly[1].Name != "users" {
		t.Fatalf("tablesOnly = %#v", tablesOnly)
	}

	viewsOnly := objectInfosFromKeyspaceMetadata(keyspace, "dev", metadataListConstraints{ObjectTypes: []string{"view"}})
	want := []objectInfo{{Name: "users_by_email", ObjectType: "MATERIALIZED_VIEW", Schema: "dev"}}
	if !reflect.DeepEqual(viewsOnly, want) {
		t.Fatalf("viewsOnly = %#v, want %#v", viewsOnly, want)
	}

	materializedOnly := objectInfosFromKeyspaceMetadata(keyspace, "dev", metadataListConstraints{ObjectTypes: []string{"materialized_view"}})
	if !reflect.DeepEqual(materializedOnly, want) {
		t.Fatalf("materializedOnly = %#v, want %#v", materializedOnly, want)
	}
}

func TestColumnsForSchemaObjectResolvesViewColumnsFromBaseTable(t *testing.T) {
	textType := gocql.NewNativeType(4, gocql.TypeVarchar, "")
	id := &gocql.ColumnMetadata{Name: "email", Kind: gocql.ColumnPartitionKey, Type: textType}
	name := &gocql.ColumnMetadata{Name: "username", Kind: gocql.ColumnRegular, Type: textType}
	baseTable := &gocql.TableMetadata{
		OrderedColumns: []string{"email", "username"},
		PartitionKey:   []*gocql.ColumnMetadata{id},
		Columns:        map[string]*gocql.ColumnMetadata{"email": id, "username": name},
	}
	keyspace := &gocql.KeyspaceMetadata{
		Tables: map[string]*gocql.TableMetadata{"users": baseTable},
		MaterializedViews: map[string]*gocql.MaterializedViewMetadata{
			"users_by_email": {Name: "users_by_email", BaseTable: baseTable},
		},
	}

	columns, err := columnsForSchemaObject(keyspace, "dev", "users_by_email")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"email", "username"}
	if len(columns) != len(want) {
		t.Fatalf("columns = %#v", columns)
	}
	for index, column := range columns {
		if column.Name != want[index] {
			t.Fatalf("columns[%d] = %s, want %s", index, column.Name, want[index])
		}
		if column.IsPrimaryKey != (index == 0) {
			t.Fatalf("columns[%d].IsPrimaryKey = %v", index, column.IsPrimaryKey)
		}
	}

	tableColumns, err := columnsForSchemaObject(keyspace, "dev", "users")
	if err != nil {
		t.Fatal(err)
	}
	if len(tableColumns) != 2 || tableColumns[0].Name != "email" {
		t.Fatalf("tableColumns = %#v", tableColumns)
	}

	if _, err := columnsForSchemaObject(keyspace, "dev", "missing"); err == nil {
		t.Fatal("expected an error for a missing table")
	}

	orphanKeyspace := &gocql.KeyspaceMetadata{
		MaterializedViews: map[string]*gocql.MaterializedViewMetadata{
			"users_by_email": {Name: "users_by_email"},
		},
	}
	if _, err := columnsForSchemaObject(orphanKeyspace, "dev", "users_by_email"); err == nil {
		t.Fatal("expected an error when view base table metadata is unavailable")
	}
}
