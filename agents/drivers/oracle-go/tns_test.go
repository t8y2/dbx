package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildDSNForConnectResolvesTNSAlias(t *testing.T) {
	tnsAdmin := t.TempDir()
	descriptor := `(DESCRIPTION=(FAILOVER=ON)(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=db1.example.com)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=db2.example.com)(PORT=1521)))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))`
	writeTNSNames(t, tnsAdmin, "DBX_FAILOVER =\n  "+descriptor+"\n")

	dsn, err := buildDSNForConnect(connectParams{
		Username:         "scott",
		Password:         "tiger",
		ConnectionString: oracleTNSJDBCURL("DBX_FAILOVER", tnsAdmin),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dsn, "connStr=") || !strings.Contains(dsn, "db1.example.com") || !strings.Contains(dsn, "db2.example.com") {
		t.Fatalf("TNS descriptor should preserve all failover addresses, got: %s", dsn)
	}
}

func TestBuildDSNForConnectRejectsMissingTNSAdmin(t *testing.T) {
	_, err := buildDSNForConnect(connectParams{ConnectionString: "jdbc:oracle:thin:@DBX_FAILOVER"})
	if err == nil || !strings.Contains(err.Error(), "TNS_ADMIN") {
		t.Fatalf("expected a clear TNS_ADMIN error, got: %v", err)
	}
}

func TestBuildDSNForConnectRejectsUnknownAlias(t *testing.T) {
	tnsAdmin := t.TempDir()
	writeTNSNames(t, tnsAdmin, "KNOWN = (DESCRIPTION=(ADDRESS=(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))\n")

	_, err := buildDSNForConnect(connectParams{ConnectionString: oracleTNSJDBCURL("MISSING", tnsAdmin)})
	if err == nil || !strings.Contains(err.Error(), `alias "MISSING" was not found`) {
		t.Fatalf("expected an unknown alias error, got: %v", err)
	}
}

func TestBuildDSNForConnectRejectsInvalidTNSAdmin(t *testing.T) {
	_, err := buildDSNForConnect(connectParams{ConnectionString: oracleTNSJDBCURL("DBX", filepath.Join(t.TempDir(), "missing"))})
	if err == nil || !strings.Contains(err.Error(), "not accessible") {
		t.Fatalf("expected an invalid directory error, got: %v", err)
	}
}

func TestReadOracleTNSAliasesSupportsIFILEAndMultipleAliases(t *testing.T) {
	tnsAdmin := t.TempDir()
	includePath := filepath.Join(tnsAdmin, "included.ora")
	if err := os.WriteFile(includePath, []byte("DBX_A, DBX_B = (DESCRIPTION=(ADDRESS=(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeTNSNames(t, tnsAdmin, "IFILE = included.ora\n")

	aliases, err := readOracleTNSAliases(filepath.Join(tnsAdmin, "tnsnames.ora"), make(map[string]bool), 0)
	if err != nil {
		t.Fatal(err)
	}
	if aliases["DBX_A"] == "" || aliases["DBX_B"] == "" {
		t.Fatalf("expected both aliases from IFILE, got: %#v", aliases)
	}
}

func TestReadOracleTNSAliasesSupportsIndentedEntriesAndInlineComments(t *testing.T) {
	tnsAdmin := t.TempDir()
	writeTNSNames(t, tnsAdmin, `
  DBX_INDENTED =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = db.example.com)(PORT = 1521)) # preferred listener
      (CONNECT_DATA = (SERVICE_NAME = ORCL))
    )
`)

	aliases, err := readOracleTNSAliases(filepath.Join(tnsAdmin, "tnsnames.ora"), make(map[string]bool), 0)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := aliases["DBX_INDENTED"]
	if !strings.Contains(descriptor, "HOST = db.example.com") || strings.Contains(descriptor, "preferred listener") {
		t.Fatalf("expected an indented descriptor without comments, got: %q", descriptor)
	}
}

func oracleTNSJDBCURL(alias, tnsAdmin string) string {
	return oracleJDBCThinPrefix + alias + "?TNS_ADMIN=" + url.QueryEscape(tnsAdmin)
}

func writeTNSNames(t *testing.T, dir, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "tnsnames.ora"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
