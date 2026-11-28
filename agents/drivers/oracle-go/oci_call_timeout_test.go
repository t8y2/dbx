//go:build oci

package main

import (
	"context"
	"runtime/debug"
	"strconv"
	"strings"
	"testing"
	"time"
)

// godror <= v0.52.0 omitted `defer cleanup()` in statement.ExecContext and
// queryContextNotLocked, leaving dpiConn_setCallTimeout stuck on the physical
// OCI connection after any deadline-scoped ExecContext (such as
// ensureDBMSOutput's 2-second DBMS_OUTPUT.DISABLE/ENABLE reset). Subsequent
// queries without a context deadline (queryRowsWithTimeout / MCP 0s / desktop
// 60s) then failed around ~2s with ORA-03156 / DPI-1067 (issue #15520).
const minFixedGodrorPseudoTimestamp = "20261120194600"

func godrorVersionResetsCallTimeout(version string) bool {
	trimmed := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if trimmed == "" {
		return false
	}
	core, pre, hasPre := strings.Cut(trimmed, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	patch, err := strconv.Atoi(parts[2])
	if err != nil {
		return false
	}
	if major != 0 {
		return major > 0
	}
	if minor != 52 {
		return minor > 52
	}
	if patch != 1 {
		return patch > 1
	}
	// v0.52.1 final release or a v0.52.1-0.<timestamp>-<rev> pseudo-version at
	// or after the commit that added defer cleanup() to ExecContext/QueryContext.
	if !hasPre {
		return true
	}
	pseudoParts := strings.Split(pre, "-")
	if len(pseudoParts) >= 2 {
		// Standard pseudo-version format: 0.<YYYYMMDDHHMMSS>-<rev>
		if _, ts, ok := strings.Cut(pseudoParts[0], "."); ok && len(ts) == len(minFixedGodrorPseudoTimestamp) {
			return ts >= minFixedGodrorPseudoTimestamp
		}
	}
	return false
}

func TestOCIBuildUsesGodrorWithCallTimeoutCleanup(t *testing.T) {
	for _, tc := range []struct {
		version string
		want    bool
	}{
		{version: "v0.51.5", want: false},
		{version: "v0.51.6", want: false},
		{version: "v0.52.0", want: false},
		{version: "v0.52.1-0.20261119000000-000000000000", want: false},
		{version: "v0.52.1-0.20261120194600-bc8b643b56ac", want: true},
		{version: "v0.52.1", want: true},
		{version: "v0.53.0", want: true},
		{version: "v1.0.0", want: true},
	} {
		if got := godrorVersionResetsCallTimeout(tc.version); got != tc.want {
			t.Fatalf("godrorVersionResetsCallTimeout(%q) = %v, want %v", tc.version, got, tc.want)
		}
	}

	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("debug.ReadBuildInfo returned ok=false")
	}
	var godrorVersion string
	for _, dep := range info.Deps {
		if dep.Path == "github.com/godror/godror" {
			godrorVersion = dep.Version
			if dep.Replace != nil && dep.Replace.Version != "" {
				godrorVersion = dep.Replace.Version
			}
			break
		}
	}
	if godrorVersion == "" {
		t.Fatal("github.com/godror/godror dependency not found in OCI build info")
	}
	if !godrorVersionResetsCallTimeout(godrorVersion) {
		t.Fatalf("OCI build uses github.com/godror/godror %s, which leaks dpiConn_setCallTimeout after ExecContext (issue #15520)", godrorVersion)
	}

	// Verify openOCIDB still registers and parses DSN cleanly with the upgraded driver.
	db, err := openOCIDB(connectParams{
		DriverProfile: "oci",
		Host:          "127.0.0.1",
		Port:          1521,
		Database:      "ORCLPDB1",
		Username:      "scott",
		Password:      "tiger",
	})
	if err != nil {
		t.Fatalf("openOCIDB failed: %v", err)
	}
	_ = db.Close()
}

// Opt-in live OCI integration test for issue #15520.
// Supply a JSON file with connectParams via DBX_LIVE_ORACLE_OCI_CONFIG and have
// Oracle Instant Client on PATH. Verifies that a 2-second ExecContext (and
// ensureDBMSOutput's 2-second DBMS_OUTPUT reset) does not leave a stale ~2s OCI
// call timeout on the physical connection for a subsequent >2s SELECT across
// desktop (60s, paged and non-paged) and MCP (0s) execution paths.
func TestLiveOracleOCICallTimeoutNotLeakedAfterDBMSOutputReset(t *testing.T) {
	params := legacyLiveConfig(t, "DBX_LIVE_ORACLE_OCI_CONFIG")
	params.DriverProfile = "oci"

	db, err := openOCIDB(params)
	if err != nil {
		t.Fatalf("openOCIDB failed: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	const slowSelectSQL = "WITH FUNCTION dbx_sleep_15520 RETURN NUMBER IS BEGIN DBMS_SESSION.SLEEP(3); RETURN 1; END; SELECT dbx_sleep_15520 AS V FROM DUAL"

	t.Run("direct_conn_exec_with_2s_timeout_then_slow_select", func(t *testing.T) {
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatalf("db.Conn failed: %v", err)
		}
		defer conn.Close()

		shortCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, err = conn.ExecContext(shortCtx, "BEGIN NULL; END;")
		cancel()
		if err != nil {
			t.Fatalf("short ExecContext failed: %v", err)
		}

		var got int
		if err := conn.QueryRowContext(context.Background(), slowSelectSQL).Scan(&got); err != nil {
			t.Fatalf("slow SELECT after 2s ExecContext failed (stale OCI call timeout?): %v", err)
		}
		if got != 1 {
			t.Fatalf("slow SELECT returned %d, want 1", got)
		}
	})

	for _, tc := range []struct {
		name        string
		timeoutSecs int
		paged       bool
	}{
		{name: "desktop_execute_query_60s", timeoutSecs: 60, paged: false},
		{name: "mcp_execute_query_unlimited", timeoutSecs: 0, paged: false},
		{name: "desktop_execute_query_page_60s", timeoutSecs: 60, paged: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newServer()
			s.db = db
			s.params = params
			// Force ensureDBMSOutput to run its 2s DISABLE/ENABLE reset before the SELECT.
			s.dbmsOutput.markDirty(nil)

			if tc.paged {
				page, err := s.executeQueryPage(queryOptions{SQL: slowSelectSQL, TimeoutSecs: tc.timeoutSecs}, 10)
				if err != nil {
					t.Fatalf("executeQueryPage failed: %v", err)
				}
				if page.SessionID != nil {
					s.closeQuerySession(*page.SessionID)
				}
				if len(page.Rows) != 1 {
					t.Fatalf("got %d rows, want 1", len(page.Rows))
				}
				return
			}

			result, err := s.executeQuery(queryOptions{SQL: slowSelectSQL, TimeoutSecs: tc.timeoutSecs})
			if err != nil {
				t.Fatalf("executeQuery failed: %v", err)
			}
			if len(result.Rows) != 1 {
				t.Fatalf("got %d rows, want 1", len(result.Rows))
			}
		})
	}
}
