package main

import (
	"os"
	"strings"
	"testing"
)

// TestLiveXuguIndexPartitionDDL verifies the four index cases that are easy to
// conflate in reconstructed DDL: an ordinary index, a LOCAL index, a GLOBAL
// index with explicit partitions, and a GLOBAL index with subpartitions. It is
// opt-in because CI does not provide a XuguDB service.
func TestLiveXuguIndexPartitionDDL(t *testing.T) {
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
		ordinaryTable = "DBX_IDX_SCOPE_LIVE_ORD_T"
		localTable    = "DBX_IDX_SCOPE_LIVE_LOC_T"
		globalTable   = "DBX_IDX_SCOPE_LIVE_GLB_T"
		subTable      = "DBX_IDX_SCOPE_LIVE_SUB_T"
		ordinaryIndex = "DBX_IDX_SCOPE_LIVE_ORD_I"
		localIndex    = "DBX_IDX_SCOPE_LIVE_LOC_I"
		globalIndex   = "DBX_IDX_SCOPE_LIVE_GLB_I"
		subIndex      = "DBX_IDX_SCOPE_LIVE_SUB_I"
	)
	tables := []string{ordinaryTable, localTable, globalTable, subTable}
	for _, table := range tables {
		_ = s.execWithReconnect("DROP TABLE IF EXISTS " + table)
	}
	defer func() {
		for _, table := range tables {
			_ = s.execWithReconnect("DROP TABLE IF EXISTS " + table)
		}
	}()

	statements := []string{
		"CREATE TABLE " + ordinaryTable + " (ID INTEGER, VALUE VARCHAR(20))",
		"CREATE INDEX " + ordinaryIndex + " ON " + ordinaryTable + " (ID)",
		"CREATE TABLE " + localTable + " (ID INTEGER, VALUE VARCHAR(20)) PARTITION BY RANGE (ID) PARTITIONS (P1 VALUES LESS THAN (100), P2 VALUES LESS THAN (MAXVALUES))",
		"CREATE INDEX " + localIndex + " ON " + localTable + " (VALUE) LOCAL",
		"CREATE TABLE " + globalTable + " (ID INTEGER, REGION VARCHAR(20))",
		"CREATE INDEX " + globalIndex + " ON " + globalTable + " (ID) GLOBAL PARTITION BY LIST (REGION) PARTITIONS (P_CN VALUES ('CN'), P_US VALUES ('US'), P_OTHER VALUES (OTHERVALUES))",
		"CREATE TABLE " + subTable + " (ID INTEGER, REGION VARCHAR(20))",
		"CREATE INDEX " + subIndex + " ON " + subTable + " (ID) GLOBAL PARTITION BY RANGE (ID) PARTITIONS (P1 VALUES LESS THAN (100), P2 VALUES LESS THAN (MAXVALUES)) SUBPARTITION BY HASH (REGION) SUBPARTITIONS 2",
	}
	for _, statement := range statements {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatalf("setup statement failed: %s: %v", statement, err)
		}
	}

	tests := []struct {
		name       string
		table      string
		index      string
		wantLocal  bool
		wantGlobal bool
		wantSub    bool
	}{
		{name: "ordinary", table: ordinaryTable, index: ordinaryIndex},
		{name: "local", table: localTable, index: localIndex, wantLocal: true},
		{name: "global", table: globalTable, index: globalIndex, wantGlobal: true},
		{name: "global with subpartitions", table: subTable, index: subIndex, wantGlobal: true, wantSub: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Exercise the same reconstructed DDL path used by interactive table
			// inspection and by the database-export metadata prefetcher.  The
			// lower-level index fragment assertion below is not sufficient: a
			// regression in table/partition assembly could still omit the index.
			fullDDL, err := s.getTableDDL(params.Username, tc.table)
			if err != nil {
				t.Fatalf("getTableDDL failed: %v", err)
			}
			if !strings.Contains(strings.ToUpper(fullDDL), "CREATE TABLE") {
				t.Fatalf("getTableDDL did not return a CREATE TABLE statement: %s", fullDDL)
			}
			if !strings.Contains(strings.ToUpper(fullDDL), strings.ToUpper(tc.index)) {
				t.Fatalf("getTableDDL omitted index %s: %s", tc.index, fullDDL)
			}
			t.Logf("full reconstructed table DDL: %s", fullDDL)

			indexes, err := s.listIndexes(params.Username, tc.table)
			if err != nil {
				t.Fatal(err)
			}
			var got *indexInfo
			for i := range indexes {
				if strings.EqualFold(indexes[i].Name, tc.index) {
					got = &indexes[i]
					break
				}
			}
			if got == nil {
				t.Fatalf("index %s was not listed: %#v", tc.index, indexes)
			}
			if got.IsLocal != tc.wantLocal {
				t.Fatalf("IsLocal=%v, want %v: %#v", got.IsLocal, tc.wantLocal, *got)
			}
			if tc.wantGlobal && (got.PartitionType == 0 || !got.PartitionRowsLoaded || len(got.IndexPartitions) == 0) {
				t.Fatalf("global partition metadata incomplete: %#v", *got)
			}
			if tc.wantSub && (got.SubpartitionType == 0 || len(got.IndexSubpartitions) == 0) {
				t.Fatalf("subpartition metadata incomplete: %#v", *got)
			}
			// The table already exists; keep a harmless placeholder statement so
			// appendDDLStatement produces the same script shape as a real table
			// DDL request without attempting to recreate the table during replay.
			ddl := s.appendTableIndexDDL(params.Username, tc.table, "/* existing table DDL */")
			t.Logf("reconstructed DDL: %s", ddl)
			if tc.wantLocal && !strings.Contains(ddl, " LOCAL") {
				t.Fatalf("LOCAL was lost from DDL: %s", ddl)
			}
			if !tc.wantLocal && !tc.wantGlobal && strings.Contains(ddl, " GLOBAL") {
				t.Fatalf("ordinary index was incorrectly labeled GLOBAL: %s", ddl)
			}
			if tc.wantGlobal && !strings.Contains(ddl, " GLOBAL PARTITION BY ") {
				t.Fatalf("GLOBAL partition clause was lost from DDL: %s", ddl)
			}
			if tc.wantSub && !strings.Contains(ddl, " SUBPARTITION BY HASH ") {
				t.Fatalf("GLOBAL subpartition clause was lost from DDL: %s", ddl)
			}

			// Replay the exact reconstructed index DDL after dropping only this
			// isolated test index. This catches syntactically plausible output
			// that Xugu nevertheless rejects, especially LOCAL/GLOBAL ordering.
			if err := s.execWithReconnect("DROP INDEX IF EXISTS " + tc.table + "." + tc.index); err != nil {
				t.Fatalf("drop index before replay: %v", err)
			}
			if err := s.execWithReconnect(ddl); err != nil {
				t.Fatalf("replay reconstructed DDL: %v\nDDL: %s", err, ddl)
			}

			// Replay the complete table DDL as the database-export path writes it:
			// one script containing CREATE TABLE followed by any dependent ALTER
			// and CREATE INDEX statements.  The agent executes one statement per
			// request, so split only the generated statement terminators here.
			if err := s.execWithReconnect("DROP TABLE IF EXISTS " + tc.table); err != nil {
				t.Fatalf("drop table before full DDL replay: %v", err)
			}
			for _, statement := range splitGeneratedXuguDDL(fullDDL) {
				if err := s.execWithReconnect(statement); err != nil {
					t.Fatalf("replay full table DDL: %v\nStatement: %s\nFull DDL: %s", err, statement, fullDDL)
				}
			}
			replayedIndexes, err := s.listIndexes(params.Username, tc.table)
			if err != nil {
				t.Fatalf("list indexes after full DDL replay: %v", err)
			}
			if !containsXuguIndex(replayedIndexes, tc.index) {
				t.Fatalf("full DDL replay did not recreate index %s: %#v", tc.index, replayedIndexes)
			}
		})
	}
}

func splitGeneratedXuguDDL(ddl string) []string {
	var statements []string
	for _, part := range strings.Split(ddl, ";") {
		part = strings.TrimSpace(part)
		if part != "" {
			statements = append(statements, part+";")
		}
	}
	return statements
}

func containsXuguIndex(indexes []indexInfo, name string) bool {
	for _, index := range indexes {
		if strings.EqualFold(index.Name, name) {
			return true
		}
	}
	return false
}
