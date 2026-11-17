package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"
)

func TestOracleNLSDateLanguageFromNLS(t *testing.T) {
	cases := []struct {
		nlsLang  string
		expected string
	}{
		{"SIMPLIFIED CHINESE_CHINA.AL32UTF8", "SIMPLIFIED CHINESE"},
		{"CHINESE_CHINA.ZHS16GBK", "SIMPLIFIED CHINESE"},
		{"TRADITIONAL CHINESE_TAIWAN.AL32UTF8", "TRADITIONAL CHINESE"},
		{"AMERICAN_AMERICA.AL32UTF8", "AMERICAN"},
		{"ENGLISH_UNITED KINGDOM.AL32UTF8", "ENGLISH"},
		{"DUTCH_NETHERLANDS.AL32UTF8", "DUTCH"},
		{"BRAZILIAN PORTUGUESE_BRAZIL.AL32UTF8", "BRAZILIAN PORTUGUESE"},
		{"LATIN AMERICAN SPANISH_AMERICA.AL32UTF8", "LATIN AMERICAN SPANISH"},
		{"", ""},
		{"AMERICAN'; DROP TABLE dual --", ""},
		{"AMERICAN_AMERICA.AL32UTF8'; DROP TABLE dual --", "AMERICAN"},
	}
	for _, testCase := range cases {
		if actual := oracleNLSDateLanguageFromNLS(testCase.nlsLang); actual != testCase.expected {
			t.Errorf("oracleNLSDateLanguageFromNLS(%q) = %q, want %q", testCase.nlsLang, actual, testCase.expected)
		}
	}
}

func TestOracleNLSDateLanguageFromLocale(t *testing.T) {
	cases := []struct {
		locale   string
		expected string
	}{
		{"zh-CN", "SIMPLIFIED CHINESE"},
		{"zh-Hans-CN", "SIMPLIFIED CHINESE"},
		{"zh_CN.UTF-8", "SIMPLIFIED CHINESE"},
		{"zh-TW", "TRADITIONAL CHINESE"},
		{"zh-Hant-HK", "TRADITIONAL CHINESE"},
		{"en-US", "AMERICAN"},
		{"ja-JP", "JAPANESE"},
		{"C", ""},
		{"", ""},
	}
	for _, testCase := range cases {
		if actual := oracleNLSDateLanguageFromLocale(testCase.locale); actual != testCase.expected {
			t.Errorf("oracleNLSDateLanguageFromLocale(%q) = %q, want %q", testCase.locale, actual, testCase.expected)
		}
	}
}

func TestSessionNLSDateLanguagesReadsEnvironment(t *testing.T) {
	t.Setenv("NLS_LANG", "TRADITIONAL CHINESE_TAIWAN.AL32UTF8")
	if actual, _ := sessionNLSDateLanguages(); actual != "TRADITIONAL CHINESE" {
		t.Fatalf("sessionNLSDateLanguages() = %q, want %q", actual, "TRADITIONAL CHINESE")
	}
}

func TestApplyOracleSessionNLSOverridesDateLanguage(t *testing.T) {
	executed, exec := newNLSRecorder("", nil)

	if err := applyOracleSessionNLS(exec, "SIMPLIFIED CHINESE", ""); err != nil {
		t.Fatalf("applyOracleSessionNLS() error = %v", err)
	}

	assertStatements(t, executed, []string{
		"ALTER SESSION SET NLS_LANGUAGE='AMERICAN'",
		"ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'",
	})
}

func TestApplyOracleSessionNLSUsesLocaleWhenNLSIsUnset(t *testing.T) {
	executed, exec := newNLSRecorder("", nil)

	if err := applyOracleSessionNLS(exec, "", "SIMPLIFIED CHINESE"); err != nil {
		t.Fatalf("applyOracleSessionNLS() error = %v", err)
	}

	assertStatements(t, executed, []string{
		"ALTER SESSION SET NLS_LANGUAGE='AMERICAN'",
		"ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'",
	})
}

func TestApplyOracleSessionNLSKeepsExplicitAmerican(t *testing.T) {
	executed, exec := newNLSRecorder("", nil)

	// An explicit AMERICAN NLS_LANG must win over a Chinese OS locale.
	if err := applyOracleSessionNLS(exec, "AMERICAN", "SIMPLIFIED CHINESE"); err != nil {
		t.Fatalf("applyOracleSessionNLS() error = %v", err)
	}

	assertStatements(t, executed, []string{"ALTER SESSION SET NLS_LANGUAGE='AMERICAN'"})
}

func TestApplyOracleSessionNLSFallsBackToLocaleWhenNLSIsRejected(t *testing.T) {
	executed, exec := newNLSRecorder("ALTER SESSION SET NLS_DATE_LANGUAGE='DUTCH'", errNLSRejected)

	if err := applyOracleSessionNLS(exec, "DUTCH", "SIMPLIFIED CHINESE"); err != nil {
		t.Fatalf("applyOracleSessionNLS() error = %v, want nil", err)
	}

	assertStatements(t, executed, []string{
		"ALTER SESSION SET NLS_LANGUAGE='AMERICAN'",
		"ALTER SESSION SET NLS_DATE_LANGUAGE='DUTCH'",
		"ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'",
	})
}

func TestApplyOracleSessionNLSKeepsConnectionWhenDateLanguageIsRejected(t *testing.T) {
	executed, exec := newNLSRecorder("ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'", errNLSRejected)

	if err := applyOracleSessionNLS(exec, "SIMPLIFIED CHINESE", ""); err != nil {
		t.Fatalf("applyOracleSessionNLS() error = %v, want nil", err)
	}

	if len(*executed) != 2 {
		t.Fatalf("executed %d statements, want 2", len(*executed))
	}
}

func TestApplyOracleSessionNLSFailsOnDriverFailure(t *testing.T) {
	_, exec := newNLSRecorder(
		"ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'",
		errors.New("TTC error: received code 0"),
	)

	if err := applyOracleSessionNLS(exec, "SIMPLIFIED CHINESE", ""); err == nil {
		t.Fatal("applyOracleSessionNLS() error = nil, want the transport failure")
	}
}

func TestApplyOracleSessionNLSFailsWhenNormalizationFails(t *testing.T) {
	_, exec := newNLSRecorder("ALTER SESSION SET NLS_LANGUAGE='AMERICAN'", errNLSRejected)

	if err := applyOracleSessionNLS(exec, "SIMPLIFIED CHINESE", ""); err == nil {
		t.Fatal("applyOracleSessionNLS() error = nil, want the normalization failure")
	}
}

func TestOracleNLSConnectorInitializesEveryPhysicalConnection(t *testing.T) {
	base := &nlsTestConnector{}
	db := sql.OpenDB(oracleNLSConnector{Connector: base, dateLanguage: "SIMPLIFIED CHINESE"})
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(2)
	defer db.Close()

	ctx := context.Background()
	first, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("db.Conn() error = %v", err)
	}
	defer first.Close()
	// Holding the first connection forces the pool to open a second one.
	second, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("second db.Conn() error = %v", err)
	}
	defer second.Close()

	if opened := base.openedConnections(); opened != 2 {
		t.Fatalf("opened %d connections, want 2", opened)
	}
	expected := []string{
		"ALTER SESSION SET NLS_LANGUAGE='AMERICAN'",
		"ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'",
		"ALTER SESSION SET NLS_LANGUAGE='AMERICAN'",
		"ALTER SESSION SET NLS_DATE_LANGUAGE='SIMPLIFIED CHINESE'",
	}
	executed := base.executedStatements()
	if len(executed) != len(expected) {
		t.Fatalf("executed %d statements (%q), want %d (%q)", len(executed), executed, len(expected), expected)
	}
	for index, statement := range expected {
		if executed[index] != statement {
			t.Errorf("statement %d = %q, want %q", index, executed[index], statement)
		}
	}
}

func TestOracleNLSConnectorClosesConnectionWhenNormalizationFails(t *testing.T) {
	base := &nlsTestConnector{failOn: "ALTER SESSION SET NLS_LANGUAGE='AMERICAN'"}
	db := sql.OpenDB(oracleNLSConnector{Connector: base})
	defer db.Close()

	conn, err := db.Conn(context.Background())
	if err == nil {
		conn.Close()
		t.Fatal("db.Conn() error = nil, want the normalization failure")
	}
	if closed := base.closedConnections(); closed != 1 {
		t.Fatalf("closed %d connections, want 1", closed)
	}
}

func TestOracleNLSConnectorRecoversDriverPanic(t *testing.T) {
	base := &nlsPanicConnector{}
	db := sql.OpenDB(oracleNLSConnector{Connector: base})
	defer db.Close()

	conn, err := db.Conn(context.Background())
	if err == nil {
		conn.Close()
		t.Fatal("db.Conn() error = nil, want the recovered panic")
	}
	if closed := base.closedConnections(); closed != 1 {
		t.Fatalf("closed %d connections, want 1", closed)
	}
}

func assertStatements(t *testing.T, executed *[]string, expected []string) {
	t.Helper()
	if len(*executed) != len(expected) {
		t.Fatalf("executed %d statements (%q), want %d (%q)", len(*executed), *executed, len(expected), expected)
	}
	for index, statement := range expected {
		if (*executed)[index] != statement {
			t.Errorf("statement %d = %q, want %q", index, (*executed)[index], statement)
		}
	}
}

var errNLSRejected = errors.New("ORA-12705: invalid or unknown NLS parameter value specified")

func newNLSRecorder(failOn string, failErr error) (*[]string, func(string) error) {
	executed := &[]string{}
	return executed, func(query string) error {
		*executed = append(*executed, query)
		if failOn != "" && query == failOn {
			return failErr
		}
		return nil
	}
}

type nlsTestConnector struct {
	mu       sync.Mutex
	failOn   string
	opened   int
	closed   int
	executed []string
}

func (c *nlsTestConnector) Connect(context.Context) (driver.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.opened++
	return &nlsTestConn{connector: c}, nil
}

func (c *nlsTestConnector) Driver() driver.Driver { return nlsTestDriver{} }

func (c *nlsTestConnector) openedConnections() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.opened
}

func (c *nlsTestConnector) closedConnections() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *nlsTestConnector) executedStatements() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.executed...)
}

type nlsTestDriver struct{}

func (nlsTestDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("nlsTestDriver.Open is not supported")
}

type nlsTestConn struct{ connector *nlsTestConnector }

func (c *nlsTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}

func (c *nlsTestConn) Close() error {
	c.connector.mu.Lock()
	defer c.connector.mu.Unlock()
	c.connector.closed++
	return nil
}

func (c *nlsTestConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported")
}

func (c *nlsTestConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.connector.mu.Lock()
	defer c.connector.mu.Unlock()
	c.connector.executed = append(c.connector.executed, query)
	if c.connector.failOn != "" && query == c.connector.failOn {
		return nil, errors.New("ALTER SESSION denied")
	}
	return driver.RowsAffected(0), nil
}

type nlsPanicConnector struct {
	mu     sync.Mutex
	closed int
}

func (c *nlsPanicConnector) Connect(context.Context) (driver.Conn, error) {
	return &nlsPanicConn{connector: c}, nil
}

func (c *nlsPanicConnector) Driver() driver.Driver { return nlsTestDriver{} }

func (c *nlsPanicConnector) closedConnections() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

type nlsPanicConn struct{ connector *nlsPanicConnector }

func (c *nlsPanicConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}

func (c *nlsPanicConn) Close() error {
	c.connector.mu.Lock()
	defer c.connector.mu.Unlock()
	c.connector.closed++
	return nil
}

func (c *nlsPanicConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported")
}

func (c *nlsPanicConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	panic("driver exploded")
}
