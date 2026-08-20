package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestLiveXuguSelectableDataTypes verifies the table-editor choices through the
// same database/sql + go-xugu-driver path used by the agent. It is intentionally
// opt-in because CI does not provide a XuguDB service.
func TestLiveXuguSelectableDataTypes(t *testing.T) {
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
	assertLiveXuguDataTypeCatalog(t, ctx, db)

	type dataTypeCase struct {
		name       string
		definition string
		valueSQL   string
	}
	tests := []dataTypeCase{
		{name: "tinyint", definition: "TINYINT", valueSQL: "7"},
		{name: "double", definition: "DOUBLE", valueSQL: "1.25"},
		{name: "datetime", definition: "DATETIME", valueSQL: "'2025-06-20 15:16:25'"},
		{name: "datetime_tz", definition: "DATETIME WITH TIME ZONE", valueSQL: "'2025-06-21 17:16:25+08:00'"},
		{name: "time_tz", definition: "TIME(3) WITH TIME ZONE", valueSQL: "'17:30:29.123+08:00'"},
		{name: "timestamp_tz", definition: "TIMESTAMP(6) WITH TIME ZONE", valueSQL: "'2025-06-21 17:16:25.123456+08:00'"},
		{name: "interval_year", definition: "INTERVAL YEAR", valueSQL: "2025"},
		{name: "interval_year_month", definition: "INTERVAL YEAR TO MONTH", valueSQL: "'2025-11'"},
		{name: "interval_month", definition: "INTERVAL MONTH", valueSQL: "1000"},
		{name: "interval_day", definition: "INTERVAL DAY", valueSQL: "1996"},
		{name: "interval_day_hour", definition: "INTERVAL DAY TO HOUR", valueSQL: "'66666 23'"},
		{name: "interval_hour", definition: "INTERVAL HOUR", valueSQL: "5200"},
		{name: "interval_day_minute", definition: "INTERVAL DAY TO MINUTE", valueSQL: "'9999 23:56'"},
		{name: "interval_hour_minute", definition: "INTERVAL HOUR TO MINUTE", valueSQL: "'888:26'"},
		{name: "interval_minute", definition: "INTERVAL MINUTE", valueSQL: "12345"},
		{name: "interval_day_second", definition: "INTERVAL DAY TO SECOND", valueSQL: "'2222 12:56:24.233'"},
		{name: "interval_hour_second", definition: "INTERVAL HOUR TO SECOND", valueSQL: "'9999999:59:59.999999'"},
		{name: "interval_minute_second", definition: "INTERVAL MINUTE TO SECOND", valueSQL: "'9999999:59.999999'"},
		{name: "interval_second", definition: "INTERVAL SECOND", valueSQL: "1999.9898"},
		{name: "guid", definition: "GUID", valueSQL: "SYS_GUID()"},
		{name: "rowid", definition: "ROWID", valueSQL: "NULL"},
		{name: "json", definition: "JSON", valueSQL: `' {"driver":"ok"}'`},
		{name: "bit", definition: "BIT", valueSQL: "B'1'"},
		{name: "varbit", definition: "VARBIT", valueSQL: "B'1010'"},
		{name: "integer_array", definition: "INTEGER[]", valueSQL: "ARRAY[1, 2, 3]"},
		{name: "double_array", definition: "DOUBLE[]", valueSQL: "ARRAY[1.25, 2.5]"},
		{name: "char_array", definition: "CHAR[]", valueSQL: "ARRAY['a', 'b']"},
		{name: "clob_array", definition: "CLOB[]", valueSQL: "ARRAY['first', 'second']"},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tableName := fmt.Sprintf("DBX_DATA_TYPE_%02d", index)
			qualifiedTable := quoteIdentifier(params.Username) + "." + quoteIdentifier(tableName)
			_, _ = db.ExecContext(ctx, "DROP TABLE "+qualifiedTable)
			defer func() { _, _ = db.ExecContext(context.Background(), "DROP TABLE "+qualifiedTable) }()

			if _, err := db.ExecContext(ctx, "CREATE TABLE "+qualifiedTable+" (\"TYPE_VALUE\" "+test.definition+")"); err != nil {
				t.Fatalf("create %s column through go-xugu-driver: %v", test.definition, err)
			}
			if _, err := db.ExecContext(ctx, "INSERT INTO "+qualifiedTable+" VALUES ("+test.valueSQL+")"); err != nil {
				t.Fatalf("insert %s value through go-xugu-driver: %v", test.definition, err)
			}
			var value any
			if err := db.QueryRowContext(ctx, "SELECT \"TYPE_VALUE\" FROM "+qualifiedTable).Scan(&value); err != nil {
				t.Fatalf("read %s value through go-xugu-driver: %v", test.definition, err)
			}
		})
	}
}

func assertLiveXuguDataTypeCatalog(t *testing.T, ctx context.Context, db queryer) {
	t.Helper()
	rows, err := db.QueryContext(ctx, "SHOW DATA_TYPES")
	if err != nil {
		t.Fatalf("SHOW DATA_TYPES through go-xugu-driver: %v", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatalf("read SHOW DATA_TYPES columns: %v", err)
	}
	domainNameIndex := -1
	for index, column := range columns {
		if strings.EqualFold(column, "DOMAIN_NAME") {
			domainNameIndex = index
			break
		}
	}
	if domainNameIndex < 0 {
		t.Fatalf("SHOW DATA_TYPES does not expose DOMAIN_NAME: %v", columns)
	}
	found := make(map[string]bool)
	for rows.Next() {
		values, err := scanRow(rows, len(columns))
		if err != nil {
			t.Fatalf("scan SHOW DATA_TYPES: %v", err)
		}
		if name, ok := values[domainNameIndex].(string); ok {
			found[strings.ToUpper(strings.TrimSpace(name))] = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate SHOW DATA_TYPES: %v", err)
	}
	for _, required := range []string{"TINYINT", "DOUBLE", "DATETIME", "DATETIME WITH TIME ZONE", "TIME WITH TIME ZONE", "TIMESTAMP WITH TIME ZONE", "INTERVAL DAY TO SECOND", "GUID", "ROWID", "JSON", "BIT", "VARBIT"} {
		if !found[required] {
			t.Fatalf("SHOW DATA_TYPES is missing %q; returned %v", required, found)
		}
	}
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}
