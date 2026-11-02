package main

import (
	"database/sql"
	"encoding/hex"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

func TestOracleLegacyCharsetBytes(t *testing.T) {
	for _, tc := range []struct{ charset, text, hex string }{
		{"ZHS16GBK", "中文", "d6d0cec4"},
		{"ZHS32GB18030", "中文😀", "d6d0cec49439fc36"},
		{"AL32UTF8", "中文😀", "e4b8ade69687f09f9880"},
		{"ZHT16MSWIN950", "中文", "a4a4a4e5"},
	} {
		t.Run(tc.charset, func(t *testing.T) {
			_, codec, err := oracleLegacyOptions(connectParams{URLParams: oracleLegacyCharsetOption + "=" + tc.charset})
			if err != nil {
				t.Fatal(err)
			}
			if err := codec.validate(tc.text); err != nil {
				t.Fatal(err)
			}
			if got := hex.EncodeToString(codec.Encode(tc.text)); got != tc.hex {
				t.Fatalf("bytes=%s, want %s", got, tc.hex)
			}
			raw, _ := hex.DecodeString(tc.hex)
			if got := codec.Clone().Decode(raw); got != tc.text {
				t.Fatalf("decoded=%q, want %q", got, tc.text)
			}
			if codec.GetLangID() != 1 || codec.Clone().GetLangID() != 1 {
				t.Fatal("must advertise US7ASCII to avoid server conversion")
			}
		})
	}
}

func TestOracleLegacyOptions(t *testing.T) {
	for _, tc := range []struct{ name, options, connection, profile, wantError string }{
		{"separate", "dbx_legacy_charset=zhs16gbk&PREFETCH_ROWS=42", "", "", ""},
		{"embedded", "", "oracle://u:p@localhost/XE?DBX_LEGACY_CHARSET=ZHS16GBK&PREFETCH_ROWS=42", "", ""},
		{"jdbc", "", "jdbc:oracle:thin:@localhost:1521:XE?DBX_LEGACY_CHARSET=ZHS16GBK", "", ""},
		{"oci", "DBX_LEGACY_CHARSET=ZHS16GBK", "", "oci", "requires the Oracle Thin driver"},
		{"unsupported", "DBX_LEGACY_CHARSET=BAD", "", "", "must be"},
		{"conflict", "DBX_LEGACY_CHARSET=ZHS16GBK&CHARSET=ZHS16GBK", "", "", "cannot be combined"},
		{"client conflict", "DBX_LEGACY_CHARSET=ZHS16GBK&CLIENT+CHARSET=US7ASCII", "", "", "cannot be combined"},
		{"duplicates", "DBX_LEGACY_CHARSET=ZHS16GBK&DBX_LEGACY_CHARSET=AL32UTF8", "", "", "conflicting"},
		{"cross conflict", "DBX_LEGACY_CHARSET=ZHS16GBK", "oracle://u:p@localhost/XE?DBX_LEGACY_CHARSET=AL32UTF8", "", "conflicting"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clean, codec, err := oracleLegacyOptions(connectParams{URLParams: tc.options, ConnectionString: tc.connection, DriverProfile: tc.profile})
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("error=%v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if codec.name != "ZHS16GBK" {
				t.Fatal(codec.name)
			}
			if strings.Contains(strings.ToUpper(clean.URLParams+clean.ConnectionString), oracleLegacyCharsetOption) {
				t.Fatal("DBX option leaked into driver DSN")
			}
		})
	}
	original := connectParams{URLParams: "CHARSET=ZHS16GBK&prefetch_rows=42", ConnectionString: "jdbc:oracle:thin:@//h:1521/XE"}
	clean, codec, err := oracleLegacyOptions(original)
	if err != nil || codec != nil || clean != original {
		t.Fatalf("ordinary connection changed: %#v %v", clean, err)
	}
}

func TestOracleLegacyRejectsUnrepresentableText(t *testing.T) {
	_, codec, _ := oracleLegacyOptions(connectParams{URLParams: "DBX_LEGACY_CHARSET=ZHS16GBK"})
	bad := "😀"
	for _, value := range []any{bad, &bad, sql.NullString{String: bad, Valid: true}, []string{bad}, []any{bad}, sql.Out{Dest: &bad, In: true}, go_ora.Clob{String: bad, Valid: true}} {
		if err := codec.validateValue(value); err == nil {
			t.Fatalf("must reject %T before writing replacement bytes", value)
		}
	}
	if err := codec.validateValue(go_ora.NVarChar(bad)); err != nil {
		t.Fatal("national data must keep its Unicode converter", err)
	}
	if err := codec.validateValue([]byte{0xd6, 0xd0}); err != nil {
		t.Fatal("RAW must stay binary", err)
	}
}
