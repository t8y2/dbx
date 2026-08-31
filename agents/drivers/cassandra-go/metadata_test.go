package main

import (
	"errors"
	"reflect"
	"testing"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

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
