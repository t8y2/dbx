package main

import (
	"strings"
	"testing"
)

// 期望的公共尾部：显式时区（godror 的 DSN 解析器没有 prefetchRows/
// fetchArraySize 键，取数批量是 per-statement 选项，不进连接串）
const ociDSNTail = ` timezone="Local"`

func TestBuildOCIDSNDerivesDescriptorFromPlainParams(t *testing.T) {
	dsn, err := buildOCIDSN(connectParams{
		Host:     "db.example.com",
		Port:     1522,
		Database: "ORCLPDB1",
		Username: "scott",
		Password: "tiger",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := `connectString="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example.com)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))"` +
		` user="scott" password="tiger"` + ociDSNTail
	if dsn != want {
		t.Fatalf("dsn = %q, want %q", dsn, want)
	}
}

func TestBuildOCIDSNDefaultsThePort(t *testing.T) {
	dsn, err := buildOCIDSN(connectParams{Host: "h", Database: "svc", Username: "u", Password: "p"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(dsn, "(PORT=1521)") {
		t.Fatalf("dsn = %q, want the default port 1521", dsn)
	}
}

func TestBuildOCIDSNKeepsTheOci8ConnectionString(t *testing.T) {
	cases := []struct {
		name             string
		connectionString string
		wantTarget       string
	}{
		{
			name:             "service",
			connectionString: "jdbc:oracle:oci8:@//db.example.com:1521/ORCLPDB1",
			wantTarget:       "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))",
		},
		{
			name:             "sid",
			connectionString: "jdbc:oracle:oci8:@db.example.com:1521:ORCL",
			wantTarget:       "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))",
		},
		{
			name:             "descriptor",
			connectionString: "jdbc:oracle:oci8:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SID=x)))",
			wantTarget:       "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SID=x)))",
		},
		{
			name:             "tns alias",
			connectionString: "jdbc:oracle:oci8:@ORCLPDB1",
			wantTarget:       "ORCLPDB1",
		},
		{
			name:             "thin form is accepted too",
			connectionString: "jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1",
			wantTarget:       "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			dsn, err := buildOCIDSN(connectParams{
				ConnectionString: testCase.connectionString,
				Username:         "u",
				Password:         "p",
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			want := `connectString="` + testCase.wantTarget + `" user="u" password="p"` + ociDSNTail
			if dsn != want {
				t.Fatalf("dsn = %q, want %q", dsn, want)
			}
		})
	}
}

func TestBuildOCIDSNAddsSysdba(t *testing.T) {
	dsn, err := buildOCIDSN(connectParams{
		ConnectionString: "jdbc:oracle:oci8:@ORCLPDB1",
		Username:         "sys",
		Password:         "change_on_install",
		SysDBA:           true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasSuffix(dsn, "sysdba=1") {
		t.Fatalf("dsn = %q, want a sysdba=1 suffix", dsn)
	}
}

func TestBuildOCIDSNQuotesCredentials(t *testing.T) {
	dsn, err := buildOCIDSN(connectParams{
		ConnectionString: "jdbc:oracle:oci8:@ORCLPDB1",
		Username:         `do@main\user`,
		Password:         "pa\"ss\nword",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(dsn, `user="do@main\\user"`) {
		t.Fatalf("dsn = %q, want a quoted, escaped user", dsn)
	}
	if !strings.Contains(dsn, `password="pa\"ss\nword"`) {
		t.Fatalf("dsn = %q, want a quoted, escaped password", dsn)
	}
}

func TestBuildOCIDSNOmitsPerStatementFetchParams(t *testing.T) {
	dsn, err := buildOCIDSN(connectParams{
		ConnectionString: "jdbc:oracle:oci8:@ORCLPDB1",
		Username:         "u",
		Password:         "p",
		URLParams:        "prefetch_rows=2000&useSSL=false",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(dsn, "prefetchRows=") || strings.Contains(dsn, "fetchArraySize=") {
		t.Fatalf("dsn = %q, want no per-statement fetch params in the DSN", dsn)
	}
}

func TestBuildOCIDSNRejectsMissingTarget(t *testing.T) {
	if _, err := buildOCIDSN(connectParams{Username: "u", Password: "p"}); err == nil {
		t.Fatal("expected an error when neither a connection string nor host+service is given")
	}
}

func TestOCIProfileDetection(t *testing.T) {
	if !usesOCIProfile(connectParams{DriverProfile: "OCI"}) {
		t.Fatal("the oci driver profile must be detected case-insensitively")
	}
	if usesOCIProfile(connectParams{DriverProfile: "oracle"}) || usesOCIProfile(connectParams{}) {
		t.Fatal("plain Oracle connections must keep using the thin driver")
	}
}
