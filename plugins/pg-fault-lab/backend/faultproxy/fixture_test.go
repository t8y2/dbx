package faultproxy

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

var fixtureAddress = "127.0.0.1:55432" // Unit tests never dial this fallback.

// Real integration tests cannot accept an arbitrary DSN. They create their own
// PGDATA and role, choose a loopback port, and destroy that exact child on exit.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "dbx-pg-fault-test-home-")
	if err != nil {
		os.Exit(1)
	}
	// Hermetic client defaults apply even to protocol-only unit fixtures.
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "PG") {
			os.Unsetenv(name)
		}
	}
	os.Setenv("HOME", dir)
	os.Setenv("PGPASSFILE", filepath.Join(dir, "absent-passfile"))
	os.Setenv("PGSERVICEFILE", filepath.Join(dir, "absent-servicefile"))
	os.Setenv("PGSYSCONFDIR", dir)
	var code int
	if os.Getenv("DBX_FAULT_LAB_TEST") != "1" {
		code = m.Run()
	} else {
		code = runWithFixture(m)
	}
	os.RemoveAll(dir)
	os.Exit(code)
}
func runWithFixture(m *testing.M) int {
	bin := os.Getenv("DBX_FAULT_PG_BIN")
	if !filepath.IsAbs(bin) {
		fmt.Fprintln(os.Stderr, "DBX_FAULT_PG_BIN must name the absolute PostgreSQL 17 bin directory")
		return 1
	}
	initdb := filepath.Join(bin, "initdb")
	version, err := exec.Command(initdb, "--version").Output()
	if err != nil || !strings.Contains(string(version), "PostgreSQL) 17.") {
		fmt.Fprintln(os.Stderr, "fixture requires PostgreSQL 17 binaries")
		return 1
	}
	dir, err := os.MkdirTemp("", "dbx-pg-fault-fixture-")
	if err != nil {
		return 1
	}
	defer os.RemoveAll(dir)
	env := []string{"PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir, "LANG=C", "LC_ALL=C", "TZ=UTC"}
	data := filepath.Join(dir, "data")
	cmd := exec.Command(initdb, "-D", data, "-A", "trust", "--no-locale", "-E", "UTF8", "-U", "dbx_fault_fixture")
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintln(os.Stderr, "fixture initdb failed:", string(out))
		return 1
	}
	// SCRAM is tested with one synthetic fixture role; no existing account is read.
	hba := "host all dbx_fault_scram 127.0.0.1/32 scram-sha-256\nhost all dbx_fault_fixture 127.0.0.1/32 trust\n"
	if err = os.WriteFile(filepath.Join(data, "pg_hba.conf"), []byte(hba), 0600); err != nil {
		return 1
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 1
	}
	fixtureAddress = l.Addr().String()
	_, port, _ := net.SplitHostPort(fixtureAddress)
	l.Close()
	log, err := os.Create(filepath.Join(dir, "postgres.log"))
	if err != nil {
		return 1
	}
	defer log.Close()
	pg := exec.Command(filepath.Join(bin, "postgres"), "-D", data, "-h", "127.0.0.1", "-p", port, "-k", "", "-c", "shared_buffers=16MB", "-c", "max_connections=30", "-c", "ssl=off")
	pg.Env = env
	pg.Stdout = log
	pg.Stderr = log
	if err = pg.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "fixture postgres start failed")
		return 1
	}
	done := make(chan error, 1)
	go func() { done <- pg.Wait() }()
	defer func() {
		pg.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			pg.Process.Kill()
			<-done
		}
	}()
	ready := false
	for until := time.Now().Add(5 * time.Second); time.Now().Before(until); {
		b, _ := os.ReadFile(filepath.Join(dir, "postgres.log"))
		if bytes.Contains(b, []byte("ready to accept connections")) {
			ready = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		fmt.Fprintln(os.Stderr, "disposable PostgreSQL did not become ready; no integration queries sent")
		return 1
	}
	// Prevent libpq/pgx from consulting the operator's profiles or credentials.
	for _, name := range []string{"PGSERVICE", "PGPASSWORD", "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGDATABASE", "PGOPTIONS", "PGMINPROTOCOLVERSION", "PGMAXPROTOCOLVERSION"} {
		os.Unsetenv(name)
	}
	os.Setenv("PGPASSFILE", filepath.Join(dir, "absent-passfile"))
	os.Setenv("PGSERVICEFILE", filepath.Join(dir, "absent-servicefile"))
	os.Setenv("PGSYSCONFDIR", dir)
	return m.Run()
}
