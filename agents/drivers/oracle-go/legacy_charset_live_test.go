package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

// Opt-in integration test. The supplied JSON contains connectParams for a
// disposable US7ASCII database with CREATE TABLE permission. Credentials never
// appear in test output. Each test owns and removes its tables.
func legacyLiveConfig(t *testing.T, variable string) connectParams {
	t.Helper()
	path := os.Getenv(variable)
	if path == "" {
		t.Skip(variable + " is not set")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var params connectParams
	if err := json.Unmarshal(data, &params); err != nil {
		t.Fatal(err)
	}
	return params
}

func TestLiveOracleLegacyCharset(t *testing.T) {
	params := legacyLiveConfig(t, "DBX_LIVE_ORACLE_LEGACY_CONFIG")
	for _, tc := range []struct{ charset, text, hex string }{
		{"ZHS16GBK", "中文", "D6D0CEC4"},
		{"AL32UTF8", "中文😀", "E4B8ADE69687F09F9880"},
		{"ZHS32GB18030", "中文😀", "D6D0CEC49439FC36"},
		{"ZHT16MSWIN950", "中文", "A4A4A4E5"},
	} {
		t.Run(tc.charset, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			raw, err := openDB(params)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			var charset string
			if err := raw.QueryRowContext(ctx, "SELECT VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER='NLS_CHARACTERSET'").Scan(&charset); err != nil {
				t.Fatal(err)
			}
			if charset != "US7ASCII" {
				t.Fatal("test requires a US7ASCII database")
			}
			table := fmt.Sprintf("DBX_LGC_%X", time.Now().UnixNano())
			if _, err := raw.ExecContext(ctx, "CREATE TABLE "+table+" (ID NUMBER, V VARCHAR2(200), N NVARCHAR2(100), C CLOB, B RAW(100))"); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := raw.Exec("DROP TABLE " + table + " PURGE"); err != nil {
					t.Error(err)
				}
			}()
			fixture := "UTL_RAW.CAST_TO_VARCHAR2(HEXTORAW('" + tc.hex + "'))"
			if _, err := raw.ExecContext(ctx, "INSERT INTO "+table+" VALUES (1,"+fixture+",UNISTR('\\4E2D\\6587\\D83D\\DE00'),TO_CLOB("+fixture+"),HEXTORAW('D6D0CEC4'))"); err != nil {
				t.Fatal(err)
			}
			var before string
			if err := raw.QueryRowContext(ctx, "SELECT V FROM "+table+" WHERE ID=1").Scan(&before); err != nil {
				t.Fatal(err)
			}
			if before == tc.text {
				t.Fatal("fixture did not reproduce the original mis-decoding")
			}
			t.Logf("before: %q; stored bytes: %s", before, tc.hex)

			legacyParams := params
			legacyParams.URLParams = oracleLegacyCharsetOption + "=" + tc.charset
			fixed, err := openDB(legacyParams)
			if err != nil {
				t.Fatal(err)
			}
			defer fixed.Close()
			assertRow := func(id int) {
				t.Helper()
				var text, national, clob, binary string
				if err := fixed.QueryRowContext(ctx, "SELECT V,N,C,RAWTOHEX(B) FROM "+table+" WHERE ID=:1", id).Scan(&text, &national, &clob, &binary); err != nil {
					t.Fatal(err)
				}
				if text != tc.text || clob != tc.text || national != "中文😀" || binary != "D6D0CEC4" {
					t.Fatalf("row: text=%q national=%q clob=%q raw=%q", text, national, clob, binary)
				}
			}
			assertRow(1)
			t.Logf("after: %q; national: 中文😀; CLOB and RAW preserved", tc.text)
			if _, err := fixed.ExecContext(ctx, "INSERT INTO "+table+" VALUES (:1,:2,:3,:4,:5)", 2, tc.text, go_ora.NVarChar("中文😀"), go_ora.Clob{String: tc.text, Valid: true}, []byte{0xd6, 0xd0, 0xce, 0xc4}); err != nil {
				t.Fatal(err)
			}
			assertRow(2)
			var stored string
			if err := raw.QueryRowContext(ctx, "SELECT RAWTOHEX(UTL_RAW.CAST_TO_RAW(V)) FROM "+table+" WHERE ID=2").Scan(&stored); err != nil {
				t.Fatal(err)
			}
			if stored != tc.hex {
				t.Fatalf("write changed encoding: %s != %s", stored, tc.hex)
			}
			stmt, err := fixed.PrepareContext(ctx, "INSERT INTO "+table+" (ID,V) VALUES (:1,:2)")
			if err != nil {
				t.Fatal(err)
			}
			defer stmt.Close()
			if _, err := stmt.ExecContext(ctx, 3, tc.text); err != nil {
				t.Fatal(err)
			}
			if tc.charset == "ZHS16GBK" || tc.charset == "ZHT16MSWIN950" {
				if _, err := stmt.ExecContext(ctx, 4, "😀"); err == nil || !strings.Contains(err.Error(), "cannot be represented") {
					t.Fatalf("unsupported text must fail before execution: %v", err)
				}
			}
			tx, err := fixed.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO "+table+" (ID,V) VALUES (5,:1)", tc.text); err != nil {
				_ = tx.Rollback()
				t.Fatal(err)
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := raw.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table+" WHERE ID IN (4,5)").Scan(&count); err != nil || count != 0 {
				t.Fatalf("rejected/rolled back writes persisted: %d %v", count, err)
			}
			if _, err := fixed.ExecContext(ctx, "COMMENT ON TABLE "+table+" IS '中文'"); err != nil {
				t.Fatal(err)
			}
			var comment string
			if err := fixed.QueryRowContext(ctx, "SELECT COMMENTS FROM USER_TAB_COMMENTS WHERE TABLE_NAME=:1", table).Scan(&comment); err != nil || comment != "中文" {
				t.Fatalf("metadata: %q %v", comment, err)
			}
			rows, err := fixed.QueryContext(ctx, "SELECT V AS \"中文列\" FROM "+table+" WHERE ID=1")
			if err != nil {
				t.Fatal(err)
			}
			columns, err := rows.Columns()
			_ = rows.Close()
			if err != nil || len(columns) != 1 || columns[0] != "中文列" {
				t.Fatalf("column names: %v %v", columns, err)
			}
			// A second raw connection must not inherit this connector's decoder.
			var stillRaw string
			if err := raw.QueryRowContext(ctx, "SELECT V FROM "+table+" WHERE ID=1").Scan(&stillRaw); err != nil || stillRaw != before {
				t.Fatalf("converter leaked to another connection: %q %v", stillRaw, err)
			}
		})
	}
}

func TestLiveOracleLegacyRejectsUnicodeDatabase(t *testing.T) {
	params := legacyLiveConfig(t, "DBX_LIVE_ORACLE_UNICODE_CONFIG")
	params.URLParams = oracleLegacyCharsetOption + "=ZHS16GBK"
	db, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err == nil || !strings.Contains(err.Error(), "only supported for US7ASCII") {
		t.Fatalf("must reject a Unicode database: %v", err)
	}
}
