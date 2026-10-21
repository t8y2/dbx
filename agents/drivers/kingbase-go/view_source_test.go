package main

import (
	"database/sql/driver"
	"errors"
	"strings"
	"testing"

	"gitea.com/kingbase/gokb"
)

func TestOrdinaryViewSourceFallsBackFromHiddenInformationSchemaDefinition(t *testing.T) {
	for _, test := range []struct {
		name string
		rows [][]driver.Value
	}{
		{name: "NULL", rows: [][]driver.Value{{nil}}},
		{name: "empty", rows: [][]driver.Value{{""}}},
		{name: "whitespace", rows: [][]driver.Value{{" \t\n"}}},
		{name: "no rows"},
	} {
		t.Run(test.name, func(t *testing.T) {
			const definition = "  SELECT 'kept verbatim' AS value;\n"
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if strings.Contains(query, "information_schema.views") {
					if !strings.Contains(query, "table_schema = 'app''s'") || !strings.Contains(query, "table_name = 'View''s'") {
						return nil, errors.New("information schema query lost its quoted object identity: " + query)
					}
					return &valueRows{columns: []string{"view_definition"}, rows: test.rows}, nil
				}
				for _, fragment := range []string{"SELECT sys_get_viewdef(c.oid)", "FROM sys_catalog.sys_class", "n.nspname='app''s'", "c.relname='View''s'", "c.relkind = 'v'"} {
					if !strings.Contains(query, fragment) {
						return nil, errors.New("fallback query lost its catalog or object identity: " + query)
					}
				}
				return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{definition}}}, nil
			}}
			server := newServer()
			server.db = openMetadataDB(t, state)
			server.mode.mysqlCompat = true

			source, err := server.getObjectSource("app's", "View's", "VIEW")
			if err != nil || source["source"] != definition || source["schema"] != "app's" || source["name"] != "View's" {
				t.Fatalf("non-owner view definition was not recovered: source=%#v err=%v", source, err)
			}
			if queries := state.snapshotQueries(); len(queries) != 2 {
				t.Fatalf("expected one information schema query and one catalog fallback: %v", queries)
			}
			if server.usePgViewDefinition {
				t.Fatal("an object-specific missing definition must not change the function capability cache")
			}
		})
	}
}

func TestOrdinaryViewSourceUsesPostgresCatalog(t *testing.T) {
	for _, mysqlCompat := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "information schema fallback"}[mysqlCompat], func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if mysqlCompat && strings.Contains(query, "information_schema.views") {
					return &valueRows{columns: []string{"view_definition"}, rows: [][]driver.Value{{nil}}}, nil
				}
				for _, fragment := range []string{"SELECT pg_get_viewdef(c.oid)", "FROM pg_catalog.pg_class", "pg_catalog.pg_namespace", "n.nspname='app'", "c.relname='orders'", "c.relkind = 'v'"} {
					if !strings.Contains(query, fragment) {
						return nil, errors.New("unexpected PostgreSQL catalog query: " + query)
					}
				}
				return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"SELECT 1 AS order_id"}}}, nil
			}}
			server := newServer()
			server.db = openMetadataDB(t, state)
			server.mode.mysqlCompat = mysqlCompat
			server.mode.postgresCatalog = true

			source, err := server.getObjectSource("app", "orders", "VIEW")
			if err != nil || source["source"] != "SELECT 1 AS order_id" {
				t.Fatalf("unexpected PostgreSQL catalog source: source=%#v err=%v", source, err)
			}
			wantQueries := 1
			if mysqlCompat {
				wantQueries++
			}
			if queries := state.snapshotQueries(); len(queries) != wantQueries {
				t.Fatalf("unexpected catalog probes: %v", queries)
			}
		})
	}
}

func TestOrdinaryViewSourceCachesUndefinedSysFunction(t *testing.T) {
	state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "information_schema.views"):
			return &valueRows{columns: []string{"view_definition"}, rows: [][]driver.Value{{nil}}}, nil
		case strings.Contains(query, "sys_get_viewdef("):
			return nil, &gokb.Error{Code: gokb.ErrorCode("42883"), Message: "function sys_get_viewdef(oid) does not exist"}
		case strings.Contains(query, "pg_get_viewdef("):
			return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"SELECT 1"}}}, nil
		default:
			return nil, errors.New("unexpected query: " + query)
		}
	}}
	server := newServer()
	server.db = openMetadataDB(t, state)
	server.mode.mysqlCompat = true

	for _, name := range []string{"first_view", "second_view"} {
		source, err := server.getObjectSource("app", name, "VIEW")
		if err != nil || source["source"] != "SELECT 1" {
			t.Fatalf("view %s failed: source=%#v err=%v", name, source, err)
		}
	}
	queries := state.snapshotQueries()
	if !server.usePgViewDefinition || len(queries) != 5 || !strings.Contains(queries[1], "sys_get_viewdef(") || !strings.Contains(queries[2], "pg_get_viewdef(") || !strings.Contains(queries[4], "pg_get_viewdef(") {
		t.Fatalf("missing sys function was not cached correctly: cached=%v queries=%v", server.usePgViewDefinition, queries)
	}
}

func TestOrdinaryViewSourceEmptySysDefinitionDoesNotPoisonCache(t *testing.T) {
	for _, test := range []struct {
		name string
		rows [][]driver.Value
	}{
		{name: "NULL", rows: [][]driver.Value{{nil}}},
		{name: "whitespace", rows: [][]driver.Value{{" \t"}}},
		{name: "no rows"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				switch {
				case strings.Contains(query, "sys_get_viewdef(") && strings.Contains(query, "c.relname='first_view'"):
					return &valueRows{columns: []string{"source"}, rows: test.rows}, nil
				case strings.Contains(query, "sys_get_viewdef(") && strings.Contains(query, "c.relname='second_view'"):
					return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"SELECT 'sys'"}}}, nil
				case strings.Contains(query, "pg_get_viewdef("):
					return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"SELECT 'pg'"}}}, nil
				default:
					return nil, errors.New("unexpected query: " + query)
				}
			}}
			server := newServer()
			server.db = openMetadataDB(t, state)

			for _, testView := range []struct{ name, source string }{{"first_view", "SELECT 'pg'"}, {"second_view", "SELECT 'sys'"}} {
				source, err := server.getObjectSource("app", testView.name, "VIEW")
				if err != nil || source["source"] != testView.source {
					t.Fatalf("view-specific fallback failed: source=%#v err=%v", source, err)
				}
			}
			if queries := state.snapshotQueries(); len(queries) != 3 || server.usePgViewDefinition {
				t.Fatalf("object-specific empty definition poisoned the cache: cached=%v queries=%v", server.usePgViewDefinition, queries)
			}
		})
	}
}

func TestOrdinaryViewSourceRejectsUnavailableDefinition(t *testing.T) {
	for _, mode := range []struct {
		name            string
		mysql, postgres bool
		wantQueries     int
	}{
		{name: "mysql", mysql: true, wantQueries: 3},
		{name: "sys", wantQueries: 2},
		{name: "postgres", postgres: true, wantQueries: 1},
	} {
		for _, empty := range []struct {
			name string
			rows [][]driver.Value
		}{
			{name: "NULL", rows: [][]driver.Value{{nil}}},
			{name: "blank", rows: [][]driver.Value{{" \n"}}},
			{name: "no rows"},
		} {
			t.Run(mode.name+"/"+empty.name, func(t *testing.T) {
				state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
					return &valueRows{columns: []string{"view_definition"}, rows: empty.rows}, nil
				}}
				server := newServer()
				server.db = openMetadataDB(t, state)
				server.mode.mysqlCompat = mode.mysql
				server.mode.postgresCatalog = mode.postgres

				_, err := server.getObjectSource("app", "unavailable_view", "VIEW")
				if err == nil || !strings.Contains(err.Error(), "view") || !strings.Contains(err.Error(), "source") || strings.Contains(err.Error(), "Scan error") {
					t.Fatalf("expected an explicit unavailable view source error, got %v", err)
				}
				if queries := state.snapshotQueries(); len(queries) != mode.wantQueries || server.usePgViewDefinition {
					t.Fatalf("unbounded probes or invalid capability cache: cached=%v queries=%v", server.usePgViewDefinition, queries)
				}
			})
		}
	}
}

func TestOrdinaryViewSourcePreservesQueryErrors(t *testing.T) {
	for _, stage := range []struct {
		name        string
		wantQueries int
	}{
		{name: "information_schema.views", wantQueries: 1},
		{name: "sys_get_viewdef(", wantQueries: 2},
		{name: "pg_get_viewdef(", wantQueries: 3},
	} {
		for _, queryErr := range []error{
			&gokb.Error{Code: gokb.ErrorCode("42501"), Message: "permission denied"},
			errors.New("connection reset by peer"),
		} {
			t.Run(stage.name+"/"+queryErr.Error(), func(t *testing.T) {
				state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
					if strings.Contains(query, stage.name) {
						return nil, queryErr
					}
					return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{nil}}}, nil
				}}
				server := newServer()
				server.db = openMetadataDB(t, state)
				server.mode.mysqlCompat = true

				_, err := server.getObjectSource("app", "orders", "VIEW")
				if !errors.Is(err, queryErr) {
					t.Fatalf("query error was swallowed or replaced: want=%v got=%v", queryErr, err)
				}
				if queries := state.snapshotQueries(); len(queries) != stage.wantQueries || server.usePgViewDefinition {
					t.Fatalf("unrelated error triggered fallback or poisoned cache: cached=%v queries=%v", server.usePgViewDefinition, queries)
				}
			})
		}
	}
}
