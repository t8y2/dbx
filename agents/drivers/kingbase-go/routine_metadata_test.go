package main

import (
	"database/sql/driver"
	"errors"
	"strings"
	"testing"

	"gitea.com/kingbase/gokb"
)

func TestRoutineMetadataUsesCatalogKindAndPreservesOverloads(t *testing.T) {
	for _, mode := range []struct {
		name    string
		mode    kingbaseMode
		catalog string
	}{
		{name: "mysql", mode: kingbaseMode{mysqlCompat: true}, catalog: "sys_catalog.sys_proc"},
		{name: "sys", catalog: "sys_catalog.sys_proc"},
		{name: "pg", mode: kingbaseMode{postgresCatalog: true}, catalog: "pg_catalog.pg_proc"},
	} {
		t.Run(mode.name, func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if !strings.Contains(query, "FROM "+mode.catalog+" p") || !strings.Contains(query, "p.prokind") || !strings.Contains(query, "'team''s'") {
					return nil, errors.New("routine query lost its catalog, kind or schema: " + query)
				}
				if strings.Contains(strings.ToLower(query), "routine_comment") || strings.Contains(query, "prorettype") {
					return nil, errors.New("routine query must not rely on a missing comment column or a return-type classification: " + query)
				}
				if !strings.Contains(query, "ORDER BY p.proname, signature") {
					return nil, errors.New("overloads need a stable database order before paging: " + query)
				}
				return &valueRows{columns: []string{"name", "kind", "comment", "signature"}, rows: [][]driver.Value{
					{"inout_procedure", "PROCEDURE", "INOUT comment", "INOUT value integer"},
					{"overloaded", "PROCEDURE", nil, ""},
					{"overloaded", "PROCEDURE", nil, "value integer"},
					{"overloaded", "PROCEDURE", nil, "value text"},
					{"void_function", "FUNCTION", nil, ""},
				}}, nil
			}}
			s := newServer()
			s.db = openMetadataDB(t, state)
			s.mode = mode.mode

			objects, err := s.listObjects("team's", metadataListConstraints{ObjectTypes: []string{"PROCEDURE", "FUNCTION"}})
			if err != nil || len(objects) != 5 {
				t.Fatalf("routine list failed: objects=%+v err=%v", objects, err)
			}
			if objects[0].Name != "inout_procedure" || objects[0].ObjectType != "PROCEDURE" || objects[0].Comment == nil || *objects[0].Comment != "INOUT comment" {
				t.Fatalf("INOUT procedure identity/comment was lost: %+v", objects[0])
			}
			if objects[4].Name != "void_function" || objects[4].ObjectType != "FUNCTION" {
				t.Fatalf("void function was classified as a procedure: %+v", objects[4])
			}
			for index, signature := range []string{"", "value integer", "value text"} {
				item := objects[index+1]
				if item.Name != "overloaded" || item.Signature == nil || *item.Signature != signature || item.Schema != "team's" {
					t.Fatalf("overload identity/order was lost: %+v; want signature %q", item, signature)
				}
			}
			page, err := s.listObjects("team's", metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}, Filter: "overloaded", Limit: 1, Offset: 1})
			if err != nil || len(page) != 1 || page[0].Signature == nil || *page[0].Signature != "value integer" {
				t.Fatalf("overload paging was not stable: page=%+v err=%v", page, err)
			}
		})
	}
}

func TestRoutineMetadataPropagatesErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		rows *valueRows
		err  error
	}{
		{name: "permission", err: &gokb.Error{Code: gokb.ErrorCode("42501"), Message: "permission denied for sys_proc"}},
		{name: "network", err: errors.New("connection reset by peer")},
		{name: "unrelated missing column", err: &gokb.Error{Code: gokb.ErrorCode("42703"), Message: "column unknown_column does not exist"}},
		{name: "scan", rows: &valueRows{columns: []string{"name", "kind", "comment", "signature"}, rows: [][]driver.Value{{nil, "PROCEDURE", nil, ""}}}},
		{name: "stream", rows: &valueRows{columns: []string{"name", "kind", "comment", "signature"}, rows: [][]driver.Value{{"first", "PROCEDURE", nil, ""}}, nextErr: errors.New("routine stream interrupted")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := &metadataDriverState{query: func(string) (driver.Rows, error) { return test.rows, test.err }}
			s := newServer()
			s.db = openMetadataDB(t, state)
			s.mode.mysqlCompat = true
			_, err := s.listObjects("public", metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}})
			if err == nil {
				t.Fatal("routine failure was silently returned as an empty or partial list")
			}
			if test.err != nil && !errors.Is(err, test.err) {
				t.Fatalf("query error was replaced: want %v, got %v", test.err, err)
			}
			if test.rows != nil && test.rows.nextErr != nil && !errors.Is(err, test.rows.nextErr) {
				t.Fatalf("stream error was replaced: want %v, got %v", test.rows.nextErr, err)
			}
			if queries := state.snapshotQueries(); len(queries) != 1 {
				t.Fatalf("unrelated error triggered a fallback: %v", queries)
			}
		})
	}
}

func TestRoutineMetadataFallsBackOnlyWhenKindColumnIsMissing(t *testing.T) {
	state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "p.prokind") {
			return nil, &gokb.Error{Code: gokb.ErrorCode("42703"), Message: "column p.prokind does not exist"}
		}
		if !strings.Contains(query, "prorettype") {
			return nil, errors.New("legacy routine query lost its compatibility classification: " + query)
		}
		return &valueRows{columns: []string{"name", "kind", "comment", "signature"}, rows: [][]driver.Value{{"legacy_proc", "PROCEDURE", nil, ""}}}, nil
	}}
	s := newServer()
	s.db = openMetadataDB(t, state)
	for call := 0; call < 2; call++ {
		objects, err := s.listObjects("public", metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}})
		if err != nil || len(objects) != 1 {
			t.Fatalf("legacy routine fallback failed: objects=%+v err=%v", objects, err)
		}
	}
	queries := state.snapshotQueries()
	if len(queries) != 3 || strings.Contains(queries[1], "p.prokind") || strings.Contains(queries[2], "p.prokind") {
		t.Fatalf("missing kind-column capability was not cached: %v", queries)
	}
}

func TestRoutineMetadataCachesSignatureFunctionFallback(t *testing.T) {
	for _, fallback := range []string{"pg", "oidvectortypes"} {
		t.Run(fallback, func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				for _, function := range []string{"sys_get_function_identity_arguments", "pg_get_function_identity_arguments"} {
					if strings.Contains(query, function+"(") && (strings.HasPrefix(function, "sys_") || fallback == "oidvectortypes") {
						return nil, &gokb.Error{Code: gokb.ErrorCode("42883"), Message: "function " + function + "(oid) does not exist"}
					}
				}
				want := "pg_get_function_identity_arguments("
				if fallback == "oidvectortypes" {
					want = "oidvectortypes("
				}
				if !strings.Contains(query, want) {
					return nil, errors.New("unexpected signature fallback: " + query)
				}
				return &valueRows{columns: []string{"name", "kind", "comment", "signature"}, rows: [][]driver.Value{{"overloaded", "PROCEDURE", nil, "integer"}}}, nil
			}}
			s := newServer()
			s.db = openMetadataDB(t, state)
			for call := 0; call < 2; call++ {
				objects, err := s.listObjects("public", metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}})
				if err != nil || len(objects) != 1 || objects[0].Signature == nil || *objects[0].Signature != "integer" {
					t.Fatalf("signature fallback failed: objects=%+v err=%v", objects, err)
				}
			}
			wantQueries := 3
			if fallback == "oidvectortypes" {
				wantQueries = 4
			}
			if queries := state.snapshotQueries(); len(queries) != wantQueries {
				t.Fatalf("signature capability fallback was not cached: %v", queries)
			}
		})
	}
}

func TestRoutineSourceUsesExplicitSignatureAndDetectsAmbiguity(t *testing.T) {
	for _, signature := range []string{"", "value integer", "value \"Type's\""} {
		t.Run(signature, func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				for _, fragment := range []string{"'team''s'", "'proc''s'", "p.prokind", "identity_arguments(", quoteLiteral(signature)} {
					if !strings.Contains(query, fragment) {
						return nil, errors.New("routine source query lost a quoted identity component: " + query)
					}
				}
				return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"selected overload"}}}, nil
			}}
			s := newServer()
			s.db = openMetadataDB(t, state)
			source, err := s.getObjectSourceWithSignature("team's", "proc's", "PROCEDURE", "", &signature)
			if err != nil || source["source"] != "selected overload" {
				t.Fatalf("explicit overload source failed: source=%v err=%v", source, err)
			}
		})
	}
	t.Run("missing signature", func(t *testing.T) {
		state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
			return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"first overload"}, {"second overload"}}}, nil
		}}
		s := newServer()
		s.db = openMetadataDB(t, state)
		_, err := s.getObjectSource("public", "overloaded", "PROCEDURE")
		if err == nil || !strings.Contains(strings.ToLower(err.Error()), "ambiguous") {
			t.Fatalf("missing signature silently selected one overload: %v", err)
		}
	})
}

func TestLegacyRoutineSourceDoesNotIgnoreOverloadIdentity(t *testing.T) {
	for _, signature := range []*string{nil, stringPtr("value integer")} {
		t.Run("overloaded", func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if !strings.Contains(query, "SELECT COUNT(*)") || strings.Contains(query, "DBMS_METADATA") {
					return nil, errors.New("legacy name-only DDL must not run for an ambiguous name: " + query)
				}
				return &valueRows{columns: []string{"count"}, rows: [][]driver.Value{{int64(2)}}}, nil
			}}
			s := newServer()
			s.db = openMetadataDB(t, state)
			s.useLegacyRoutineDefinition = true
			_, err := s.getObjectSourceWithSignature("public", "overloaded", "PROCEDURE", "", signature)
			if err == nil || !strings.Contains(err.Error(), "overloaded") {
				t.Fatalf("legacy name-only API must reject overloaded source, got %v", err)
			}
			if queries := state.snapshotQueries(); len(queries) != 1 {
				t.Fatalf("legacy fallback ignored ambiguity: %v", queries)
			}
		})
	}
	t.Run("wrong signature", func(t *testing.T) {
		state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
			if !strings.Contains(query, "SELECT COUNT(*)") || strings.Contains(query, "DBMS_METADATA") {
				return nil, errors.New("legacy name-only DDL must not run for a mismatched signature: " + query)
			}
			var count int64 = 1
			if strings.Contains(query, "identity_arguments(") {
				count = 0
			}
			return &valueRows{columns: []string{"count"}, rows: [][]driver.Value{{count}}}, nil
		}}
		s := newServer()
		s.db = openMetadataDB(t, state)
		s.useLegacyRoutineDefinition = true
		_, err := s.getObjectSourceWithSignature("public", "unique_name", "PROCEDURE", "", stringPtr("wrong_type"))
		if err == nil || !strings.Contains(err.Error(), "does not exist") {
			t.Fatalf("legacy fallback silently ignored the requested signature: %v", err)
		}
		if queries := state.snapshotQueries(); len(queries) != 2 {
			t.Fatalf("unexpected signature validation queries: %v", queries)
		}
	})
}
