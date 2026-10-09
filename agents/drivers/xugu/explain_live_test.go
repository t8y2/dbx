package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// Read-only opt-in coverage of the exact query path used by the visual plan.
// Run for SYSTEM/business databases and ordinary/DBA/SYSDBA users using the
// existing XUGU_LIVE_* settings. It creates no objects and changes no grants.
func TestLiveXuguExplain(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* settings")
	}
	params := liveXuguParams(t)
	db, err := openDB(params)
	if err != nil {
		t.Fatalf("open live Xugu connection: %v", err)
	}
	s := newServer()
	s.db, s.params, s.currentDatabase = db, params, params.Database
	t.Cleanup(func() { _ = s.disconnect() })
	if err := s.validateConnection(); err != nil {
		t.Fatalf("validate connection: %v", err)
	}
	schema, err := s.currentSchema()
	if err != nil {
		t.Fatalf("current schema: %v", err)
	}

	for name, sql := range map[string]string{
		"constant":    "SELECT 1 FROM DUAL",
		"filter":      "SELECT TABLE_NAME FROM ALL_TABLES WHERE TABLE_NAME LIKE 'DBX%'",
		"sort_limit":  "SELECT TABLE_NAME FROM ALL_TABLES ORDER BY TABLE_NAME LIMIT 10",
		"aggregate":   "SELECT TABLE_NAME, COUNT(*) FROM ALL_TABLES GROUP BY TABLE_NAME",
		"join":        "SELECT A.TABLE_NAME FROM ALL_TABLES A JOIN ALL_TABLES B ON A.TABLE_NAME = B.TABLE_NAME WHERE A.TABLE_NAME LIKE 'DBX%'",
		"subquery":    "SELECT TABLE_NAME FROM ALL_TABLES WHERE TABLE_NAME IN (SELECT TABLE_NAME FROM ALL_TABLES WHERE TABLE_NAME LIKE 'DBX%')",
		"cte":         "WITH Q AS (SELECT TABLE_NAME FROM ALL_TABLES) SELECT * FROM Q LIMIT 10",
		"complex_cte": "WITH Q AS (SELECT TABLE_NAME FROM ALL_TABLES) SELECT A.TABLE_NAME, COUNT(*) FROM Q A JOIN ALL_TABLES B ON A.TABLE_NAME = B.TABLE_NAME JOIN ALL_TABLES C ON A.TABLE_NAME = C.TABLE_NAME WHERE A.TABLE_NAME LIKE 'DBX%' GROUP BY A.TABLE_NAME ORDER BY A.TABLE_NAME LIMIT 10",
		"union":       "SELECT TABLE_NAME FROM ALL_TABLES UNION ALL SELECT TABLE_NAME FROM ALL_TABLES",
	} {
		t.Run(name, func(t *testing.T) {
			result, err := s.executeQuery(queryOptions{SQL: "EXPLAIN VERBOSE " + sql, Database: params.Database, Schema: schema, MaxRows: 100, TimeoutSecs: 30})
			if err != nil {
				t.Fatalf("explain query: %v", err)
			}
			if len(result.Columns) != 1 || !strings.EqualFold(result.Columns[0], "plan_path") {
				t.Fatalf("unexpected columns: %#v", result.Columns)
			}
			if len(result.Rows) == 0 || len(result.Rows[0]) == 0 || result.Rows[0][0] == nil || strings.TrimSpace(fmt.Sprint(result.Rows[0][0])) == "" {
				t.Fatal("empty explain plan")
			}
			plan := fmt.Sprint(result.Rows[0][0])
			t.Logf("native plan:\n%s", plan)
			if !strings.Contains(plan, "Scan") && !strings.Contains(plan, "Join") && !strings.Contains(plan, "Group") {
				t.Fatalf("no operator in plan: %s", plan)
			}
		})
	}
	if err := s.validateConnection(); err != nil {
		t.Fatalf("session not reusable after EXPLAIN: %v", err)
	}
}
