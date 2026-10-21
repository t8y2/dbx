package main

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	gokb "gitea.com/kingbase/gokb"
)

func TestIndexMetadataPreservesExpressionsIncludesAndPredicate(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		for _, pgCatalog := range []bool{false, true} {
			t.Run(fmt.Sprintf("legacy=%v/pgCatalog=%v", legacy, pgCatalog), func(t *testing.T) {
				state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
					switch {
					case strings.Contains(query, "WITH ORDINALITY"):
						if legacy {
							return nil, &gokb.Error{Code: "42601", Message: `syntax error at or near "WITH ORDINALITY"`}
						}
						if !strings.Contains(query, "pos.attnum = 0") {
							return &valueRows{columns: []string{"name", "type", "unique", "primary", "column", "ordinal"}, rows: [][]driver.Value{
								{"expression_idx", "btree", false, false, "id", int64(2)},
								{"expression_idx", "btree", false, false, "payload", int64(3)},
							}}, nil
						}
						if !strings.Contains(query, "LEFT JOIN ") || !strings.Contains(query, "ix.indnkeyatts") || !strings.Contains(query, "get_indexdef(ix.indexrelid, CAST(pos.n AS integer), true)") {
							return nil, errors.New("query must preserve expression rows and INCLUDE ordinals: " + query)
						}
						return &valueRows{columns: []string{"name", "type", "unique", "primary", "column", "ordinal", "expression", "included", "predicate", "options"}, rows: [][]driver.Value{
							{"expression_idx", "btree", false, false, "lower(name)", int64(1), true, false, "active = 1", "0 3"},
							{"expression_idx", "btree", false, false, "id", int64(2), false, false, "active = 1", "0 3"},
							{"expression_idx", "btree", false, false, "payload", int64(3), false, true, "active = 1", "0 3"},
						}}, nil
					case strings.Contains(query, "SELECT i.relname, am.amname"):
						columns := []string{"name", "type", "unique", "primary", "indkey"}
						values := []driver.Value{"expression_idx", "btree", false, false, "0 1 2"}
						if strings.Contains(query, "ix.indexrelid,") {
							columns = append(columns, "oid", "key_count", "predicate", "options")
							values = append(values, int64(123), int64(2), "active = 1", "0 3")
						}
						return &valueRows{columns: columns, rows: [][]driver.Value{values}}, nil
					case strings.Contains(query, "SELECT a.attnum, a.attname"):
						return &valueRows{columns: []string{"attnum", "attname"}, rows: [][]driver.Value{{int64(1), "id"}, {int64(2), "payload"}}}, nil
					case strings.Contains(query, "get_indexdef(123, 1, true)"):
						return &valueRows{columns: []string{"expression"}, rows: [][]driver.Value{{"lower(name)"}}}, nil
					default:
						return nil, errors.New("unexpected query: " + query)
					}
				}}
				srv := newServer()
				srv.db = openMetadataDB(t, state)
				srv.mode.postgresCatalog = pgCatalog
				indexes, err := srv.listIndexes("public", "orders")
				if err != nil || len(indexes) != 1 {
					t.Fatalf("unexpected indexes: %#v (%v)", indexes, err)
				}
				index := indexes[0]
				if strings.Join(index.Columns, ",") != "lower(name),id" || strings.Join(index.IncludedColumns, ",") != "payload" || index.Filter == nil || *index.Filter != "active = 1" {
					t.Fatalf("expression/INCLUDE/predicate metadata lost: %#v", index)
				}
				payload, err := json.Marshal(index)
				if err != nil {
					t.Fatal(err)
				}
				var wire struct {
					Expressions []bool `json:"key_is_expression"`
					Options     []int  `json:"key_options"`
				}
				if err := json.Unmarshal(payload, &wire); err != nil || len(wire.Expressions) != 2 || !wire.Expressions[0] || wire.Expressions[1] || fmt.Sprint(wire.Options) != "[0 3]" {
					t.Fatalf("aligned key metadata must survive the existing protocol: %s (%v)", payload, err)
				}
			})
		}
	}
}

func TestIndexMetadataCachesLegacyCatalogAndExpressionFallbacks(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			var keyCountProbes, expressionProbes int
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if legacy && strings.Contains(query, "WITH ORDINALITY") {
					return nil, &gokb.Error{Code: "42601", Message: `syntax error at or near "WITH ORDINALITY"`}
				}
				if strings.Contains(query, "ix.indnkeyatts") {
					keyCountProbes++
					return nil, &gokb.Error{Code: "42703", Message: "column ix.indnkeyatts does not exist"}
				}
				if strings.Contains(query, "sys_get_expr(") {
					expressionProbes++
					return nil, &gokb.Error{Code: "42883", Message: "function sys_get_expr(pg_node_tree, oid) does not exist"}
				}
				if strings.Contains(query, "SELECT a.attnum, a.attname") {
					return &valueRows{columns: []string{"number", "name"}, rows: [][]driver.Value{{int64(1), " "}}}, nil
				}
				if !strings.Contains(query, "ix.indnatts") || !strings.Contains(query, "pg_get_expr(ix.indpred, ix.indrelid)") {
					return nil, errors.New("missing legacy metadata fallback: " + query)
				}
				if legacy {
					return &valueRows{columns: []string{"name", "type", "unique", "primary", "indkey", "oid", "count", "predicate", "options"}, rows: [][]driver.Value{{"key_idx", "btree", false, false, "1", int64(123), int64(1), nil, "0"}}}, nil
				}
				return &valueRows{columns: []string{"name", "type", "unique", "primary", "column", "ordinal", "expression", "included", "predicate", "options"}, rows: [][]driver.Value{{"key_idx", "btree", false, false, " ", int64(1), false, false, nil, "0"}}}, nil
			}}
			srv := newServer()
			srv.db = openMetadataDB(t, state)
			for call := 0; call < 2; call++ {
				indexes, err := srv.listIndexes("public", "orders")
				if err != nil || len(indexes) != 1 || strings.Join(indexes[0].Columns, ",") != " " {
					t.Fatalf("legacy index metadata or quoted identifier lost: %#v (%v)", indexes, err)
				}
			}
			if keyCountProbes != 1 || expressionProbes != 1 {
				t.Fatalf("fallbacks must be cached: keyCount=%d expression=%d", keyCountProbes, expressionProbes)
			}
			if err := srv.disconnect(); err != nil || srv.indexKeyCountUnsupported || srv.indexOrdinalityUnsupported {
				t.Fatalf("index capability cache must be connection-local: %v", err)
			}
		})
	}
}

func TestIndexMetadataDoesNotSuppressQueryFailures(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		for _, failure := range []error{
			&gokb.Error{Code: "42501", Message: "permission denied for column indnkeyatts"},
			errors.New("metadata connection reset"),
		} {
			t.Run(fmt.Sprintf("legacy=%v/%s", legacy, failure), func(t *testing.T) {
				state := &metadataDriverState{query: func(string) (driver.Rows, error) { return nil, failure }}
				srv := newServer()
				srv.db = openMetadataDB(t, state)
				srv.indexOrdinalityUnsupported = legacy
				_, err := srv.listIndexes("public", "orders")
				if !errors.Is(err, failure) || len(state.snapshotQueries()) != 1 || srv.indexKeyCountUnsupported || srv.usePgDefaultExpression {
					t.Fatalf("index failure must not be hidden by capability fallback: %v", err)
				}
			})
		}
	}
}

func TestIndexMetadataRejectsIncompleteDefinitions(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		for _, incompleteOptions := range []bool{false, true} {
			t.Run(fmt.Sprintf("legacy=%v/incompleteOptions=%v", legacy, incompleteOptions), func(t *testing.T) {
				state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
					if strings.Contains(query, "SELECT a.attnum, a.attname") {
						return &valueRows{columns: []string{"number", "name"}}, nil
					}
					if strings.Contains(query, "get_indexdef(123, 1, true)") {
						return &valueRows{columns: []string{"definition"}}, nil
					}
					options := "0"
					if incompleteOptions {
						options = ""
					}
					if legacy {
						return &valueRows{columns: []string{"name", "type", "unique", "primary", "indkey", "oid", "count", "predicate", "options"}, rows: [][]driver.Value{{"broken_idx", "btree", false, false, "0", int64(123), int64(1), nil, options}}}, nil
					}
					var definition driver.Value
					if incompleteOptions {
						definition = "lower(name)"
					}
					return &valueRows{columns: []string{"name", "type", "unique", "primary", "column", "ordinal", "expression", "included", "predicate", "options"}, rows: [][]driver.Value{{"broken_idx", "btree", false, false, definition, int64(1), true, false, nil, options}}}, nil
				}}
				srv := newServer()
				srv.db = openMetadataDB(t, state)
				srv.indexOrdinalityUnsupported = legacy
				if _, err := srv.listIndexes("public", "orders"); err == nil || !strings.Contains(err.Error(), "broken_idx") {
					t.Fatalf("incomplete index metadata must not produce a partial definition: %v", err)
				}
			})
		}
	}
}

func TestIndexExpressionProjectionUsesUnboundedText(t *testing.T) {
	for _, catalog := range []struct{ name, prefix string }{{"sys_catalog", "sys"}, {"pg_catalog", "pg"}} {
		t.Run(catalog.name, func(t *testing.T) {
			query := kingbaseListIndexesQuery(catalog.name, catalog.prefix, "public", "orders", "ix.indnkeyatts", kingbaseCatalogFunction(catalog.name, "sys_get_expr", "pg_get_expr"))
			if !strings.Contains(query, "ELSE CAST(a.attname AS text) END") {
				t.Fatalf("CASE must resolve to text, not name which truncates expression keys: %s", query)
			}
		})
	}
}
