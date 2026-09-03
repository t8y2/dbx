package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestLiveXuguTablespaces exercises the read-only storage metadata path with
// the same database/sql driver used by the agent. It is opt-in because CI does
// not provide a XuguDB service and it never creates or changes database data.
func TestLiveXuguTablespaces(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}
	params := connectParams{
		Host:     os.Getenv("XUGU_LIVE_HOST"),
		Port:     defaultXuguPort,
		Database: os.Getenv("XUGU_LIVE_DATABASE"),
		Username: os.Getenv("XUGU_LIVE_USERNAME"),
		Password: os.Getenv("XUGU_LIVE_PASSWORD"),
	}
	if port, err := strconv.Atoi(os.Getenv("XUGU_LIVE_PORT")); err == nil && port > 0 {
		params.Port = port
	}
	if params.Host == "" || params.Database == "" || params.Username == "" || params.Password == "" {
		t.Skip("XUGU_LIVE_HOST, XUGU_LIVE_DATABASE, XUGU_LIVE_USERNAME, and XUGU_LIVE_PASSWORD are required")
	}
	db, err := openDB(params)
	if err != nil {
		t.Skipf("live XuguDB is unavailable: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	tablespaceRows, err := db.QueryContext(ctx, xuguListTablespacesSQL)
	if err != nil {
		t.Fatalf("query SYS_TABLESPACES through go-xugu-driver: %v", err)
	}
	defer tablespaceRows.Close()
	columns, err := tablespaceRows.Columns()
	if err != nil {
		t.Fatalf("read SYS_TABLESPACES columns: %v", err)
	}
	if !hasColumns(columns, []string{"NODEID", "SPACE_ID", "SPACE_NAME", "DATAFILE_NUM", "SPACE_TYPE"}) {
		t.Fatalf("SYS_TABLESPACES is missing required columns: %v", columns)
	}
	spaceIDs := make(map[int64]bool)
	for tablespaceRows.Next() {
		values, err := scanRow(tablespaceRows, len(columns))
		if err != nil {
			t.Fatalf("scan SYS_TABLESPACES: %v", err)
		}
		spaceID := xuguInt64(values[columnIndex(columns, "SPACE_ID")])
		spaceIDs[spaceID] = true
	}
	if err := tablespaceRows.Err(); err != nil {
		t.Fatalf("iterate SYS_TABLESPACES: %v", err)
	}
	if len(spaceIDs) == 0 {
		t.Fatal("SYS_TABLESPACES returned no rows")
	}

	datafileRows, err := db.QueryContext(ctx, xuguListDatafilesSQL)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			t.Skipf("SYS_DATAFILES is unavailable for this account: %v", err)
		}
		t.Fatalf("query SYS_DATAFILES through go-xugu-driver: %v", err)
	}
	defer datafileRows.Close()
	datafileColumns, err := datafileRows.Columns()
	if err != nil {
		t.Fatalf("read SYS_DATAFILES columns: %v", err)
	}
	if !hasColumns(datafileColumns, []string{"NODEID", "SPACE_ID", "PATH", "FILE_NO", "CURR_SIZE"}) {
		t.Fatalf("SYS_DATAFILES is missing required columns: %v", datafileColumns)
	}
	datafileCount := 0
	for datafileRows.Next() {
		values, err := scanRow(datafileRows, len(datafileColumns))
		if err != nil {
			t.Fatalf("scan SYS_DATAFILES: %v", err)
		}
		spaceID := xuguInt64(values[columnIndex(datafileColumns, "SPACE_ID")])
		if !spaceIDs[spaceID] {
			t.Fatalf("SYS_DATAFILES references unknown SPACE_ID %d", spaceID)
		}
		path := optionalStringPtr(values[columnIndex(datafileColumns, "PATH")])
		if path == nil || strings.TrimSpace(*path) == "" {
			t.Fatal("SYS_DATAFILES returned an empty PATH")
		}
		datafileCount++
	}
	if err := datafileRows.Err(); err != nil {
		t.Fatalf("iterate SYS_DATAFILES: %v", err)
	}
	if datafileCount == 0 {
		t.Fatal("SYS_DATAFILES returned no rows")
	}

	server := newServer()
	server.db = db
	server.params = params
	server.currentDatabase = params.Database
	spaces, err := server.listTablespaces()
	if err != nil {
		t.Fatalf("listTablespaces mapping through the agent: %v", err)
	}
	if len(spaces) != len(spaceIDs) {
		t.Fatalf("agent returned %d tablespaces, direct query returned %d", len(spaces), len(spaceIDs))
	}
	attachedFiles := 0
	for _, space := range spaces {
		attachedFiles += len(space.Datafiles)
	}
	if attachedFiles != datafileCount {
		t.Fatalf("agent attached %d datafiles, direct query returned %d", attachedFiles, datafileCount)
	}
}

func hasColumns(columns []string, required []string) bool {
	seen := make(map[string]bool, len(columns))
	for _, column := range columns {
		seen[strings.ToUpper(column)] = true
	}
	for _, column := range required {
		if !seen[strings.ToUpper(column)] {
			return false
		}
	}
	return true
}

func columnIndex(columns []string, name string) int {
	for index, column := range columns {
		if strings.EqualFold(column, name) {
			return index
		}
	}
	return -1
}
