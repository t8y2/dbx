package main

import (
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
)

func TestModeAndCatalogAvailabilityAreIndependent(t *testing.T) {
	for _, mode := range []string{"oracle", "pg", "mysql", "sqlserver", "future_mode"} {
		t.Run(mode, func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if strings.Contains(query, "pg_catalog.pg_settings") {
					return &valueRows{columns: []string{"setting"}, rows: [][]driver.Value{{"  " + strings.ToUpper(mode) + "  "}}}, nil
				}
				if strings.Contains(query, "pg_catalog.pg_namespace") {
					return &valueRows{columns: []string{"value"}}, nil
				}
				return nil, errors.New("unavailable")
			}}
			got := detectKingbaseMode(openMetadataDB(t, state), false)
			if got.compatibilityMode != mode || !got.postgresCatalog || got.mysqlCompat != (mode == "mysql") {
				t.Fatalf("unexpected profile: %+v", got)
			}
			for _, query := range state.snapshotQueries() {
				if strings.Contains(query, "dbx_identifier_probe") {
					t.Fatal("a reported mode must not be overridden by a syntax probe")
				}
			}
		})
	}
}

func TestDatabaseModeFallsBackAcrossCatalogGenerations(t *testing.T) {
	for _, source := range []string{"pg_catalog.pg_settings", "SHOW database_mode"} {
		t.Run(source, func(t *testing.T) {
			state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
				if strings.Contains(query, source) {
					return &valueRows{columns: []string{"setting"}, rows: [][]driver.Value{{"oracle"}}}, nil
				}
				return nil, errors.New("catalog is not available on this release")
			}}
			if got := detectDatabaseMode(openMetadataDB(t, state)); got != "oracle" {
				t.Fatalf("database mode = %q; queries: %v", got, state.snapshotQueries())
			}
		})
	}
}
