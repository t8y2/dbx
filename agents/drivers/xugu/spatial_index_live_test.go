package main

import (
	"os"
	"strings"
	"testing"
)

// TestLiveXuguSpatialIndexDDL verifies the Xugu-specific spatial index
// contract against a real server. Xugu reports spatial indexes as RTREE and
// reconstructed DDL must retain INDEXTYPE IS RTREE; emitting PostgreSQL's
// USING GIST syntax would not be executable on XuguDB.
func TestLiveXuguSpatialIndexDDL(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}
	params := connectParams{
		Host:     os.Getenv("XUGU_LIVE_HOST"),
		Port:     parsePort(os.Getenv("XUGU_LIVE_PORT")),
		Database: os.Getenv("XUGU_LIVE_DATABASE"),
		Username: os.Getenv("XUGU_LIVE_USERNAME"),
		Password: os.Getenv("XUGU_LIVE_PASSWORD"),
	}
	if params.Host == "" || params.Database == "" || params.Username == "" || params.Password == "" {
		t.Fatal("XUGU_LIVE_HOST, XUGU_LIVE_DATABASE, XUGU_LIVE_USERNAME, and XUGU_LIVE_PASSWORD are required")
	}

	s := newServer()
	db, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.params = params
	s.currentDatabase = params.Database
	defer s.disconnect()

	const (
		table = "DBX_SPATIAL_INDEX_LIVE_T"
		index = "DBX_SPATIAL_INDEX_LIVE_I"
	)
	_ = s.execWithReconnect("DROP TABLE IF EXISTS " + table)
	defer func() { _ = s.execWithReconnect("DROP TABLE IF EXISTS " + table) }()

	for _, statement := range []string{
		"CREATE TABLE " + table + " (ID INTEGER, GEOM GEOMETRY)",
		"CREATE INDEX " + index + " ON " + table + " (GEOM) INDEXTYPE IS RTREE",
	} {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatalf("setup statement failed: %s: %v", statement, err)
		}
	}

	indexes, err := s.listIndexes(params.Username, table)
	if err != nil {
		t.Fatal(err)
	}
	var spatial *indexInfo
	for i := range indexes {
		if strings.EqualFold(indexes[i].Name, index) {
			spatial = &indexes[i]
			break
		}
	}
	if spatial == nil {
		t.Fatalf("spatial index %s was not listed: %#v", index, indexes)
	}
	if spatial.IndexType == nil || !strings.EqualFold(strings.TrimSpace(*spatial.IndexType), "RTREE") {
		t.Fatalf("spatial index type = %#v, want RTREE: %#v", spatial.IndexType, *spatial)
	}
	if len(spatial.Columns) != 1 || !strings.EqualFold(spatial.Columns[0], "GEOM") {
		t.Fatalf("spatial index columns = %#v, want [GEOM]", spatial.Columns)
	}

	ddl, err := s.getTableDDL(params.Username, table)
	if err != nil {
		t.Fatal(err)
	}
	upperDDL := strings.ToUpper(ddl)
	if !strings.Contains(upperDDL, "CREATE INDEX") || !strings.Contains(upperDDL, strings.ToUpper(index)) {
		t.Fatalf("table DDL omitted spatial index: %s", ddl)
	}
	if !strings.Contains(upperDDL, "INDEXTYPE IS RTREE") {
		t.Fatalf("table DDL did not preserve Xugu RTREE syntax: %s", ddl)
	}
	if strings.Contains(upperDDL, "USING GIST") {
		t.Fatalf("table DDL emitted PostgreSQL-only GIST syntax: %s", ddl)
	}
}
