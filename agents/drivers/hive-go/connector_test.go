package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"testing"
)

type staticDiscovery struct {
	values []endpoint
}

func (discovery staticDiscovery) Endpoints(_ context.Context, rejected map[string]bool) ([]endpoint, error) {
	result := make([]endpoint, 0, len(discovery.values))
	for _, value := range discovery.values {
		if !rejected[value.address()] {
			result = append(result, value)
		}
	}
	return result, nil
}

type fakeConnector struct {
	connection driver.Conn
	err        error
}

func (connector fakeConnector) Connect(context.Context) (driver.Conn, error) {
	return connector.connection, connector.err
}

func (fakeConnector) Driver() driver.Driver { return fakeDriver{} }

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) { return &fakeConnection{}, nil }

type fakeConnection struct{}

func (*fakeConnection) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unsupported") }
func (*fakeConnection) Close() error                        { return nil }
func (*fakeConnection) Begin() (driver.Tx, error)           { return nil, errors.New("unsupported") }

type emptyRows struct{}

func (emptyRows) Columns() []string         { return nil }
func (emptyRows) Close() error              { return nil }
func (emptyRows) Next([]driver.Value) error { return io.EOF }

func TestDiscoveryConnectorFailsOver(t *testing.T) {
	first := endpoint{Host: "first", Port: 10000}
	second := endpoint{Host: "second", Port: 10000}
	connected := &fakeConnection{}
	var attempts []endpoint
	connector := &discoveryConnector{
		discovery: staticDiscovery{values: []endpoint{first, second}},
		driver:    fakeDriver{},
		factory: func(value endpoint) driver.Connector {
			attempts = append(attempts, value)
			if value == first {
				return fakeConnector{err: errors.New("unavailable")}
			}
			return fakeConnector{connection: connected}
		},
	}
	value, err := connector.Connect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if value != connected || !reflect.DeepEqual(attempts, []endpoint{first, second}) {
		t.Fatalf("unexpected failover result: value=%#v attempts=%#v", value, attempts)
	}
}

func TestDiscoveryConnectorRetriesAllEndpoints(t *testing.T) {
	target := endpoint{Host: "hs2", Port: 10000}
	connected := &fakeConnection{}
	attempts := 0
	connector := &discoveryConnector{
		discovery: staticDiscovery{values: []endpoint{target}},
		driver:    fakeDriver{},
		retries:   2,
		factory: func(endpoint) driver.Connector {
			attempts++
			if attempts == 1 {
				return fakeConnector{err: errors.New("temporarily unavailable")}
			}
			return fakeConnector{connection: connected}
		},
	}
	value, err := connector.Connect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if value != connected || attempts != 2 {
		t.Fatalf("unexpected retry result: value=%#v attempts=%d", value, attempts)
	}
}

func TestNormalizeHiveAuth(t *testing.T) {
	for input, expected := range map[string]string{
		"":                 "NONE",
		"noSasl":           "NOSASL",
		"kerberos":         "KERBEROS",
		"delegationToken":  "DIGEST-MD5",
		"vendor-auth-mode": "VENDOR-AUTH-MODE",
	} {
		if actual := normalizeHiveAuth(input); actual != expected {
			t.Fatalf("normalizeHiveAuth(%q) = %q, expected %q", input, actual, expected)
		}
	}
}

func TestKerberosServiceForEndpoint(t *testing.T) {
	target := endpoint{Host: "hs2.example.com", Port: 10000, Principal: "hive/hs2.example.com@EXAMPLE.COM"}
	discovered := connectionConfig{Kerberos: kerberosConfig{Service: "hive"}}
	if value := kerberosServiceForEndpoint(discovered, target); value != target.Principal {
		t.Fatalf("discovered principal was ignored: %s", value)
	}
	explicit := connectionConfig{Kerberos: kerberosConfig{
		Service:                 "hive",
		ServerPrincipal:         "hive/_HOST@USER.EXAMPLE.COM",
		ServerPrincipalExplicit: true,
	}}
	if value := kerberosServiceForEndpoint(explicit, target); value != explicit.Kerberos.ServerPrincipal {
		t.Fatalf("explicit principal was overwritten: %s", value)
	}
}

func TestKerberosUsesConnectionScopedGSSAPIOptions(t *testing.T) {
	config := kerberosConfig{
		Enabled:           true,
		ServerPrincipal:   "hive/_HOST@EXAMPLE.COM",
		ClientPrincipal:   "alice@EXAMPLE.COM",
		ServerName:        "canonical.example.com",
		CanonicalHostname: true,
		ConfigPath:        "/etc/krb5.conf",
		CCachePath:        "/tmp/alice.ccache",
		KeytabPath:        "/tmp/alice.keytab",
		Password:          "secret",
		AuthorizationID:   "proxy-user",
		QOP:               "auth-conf",
		UseTicketCache:    true,
		UseKeytab:         true,
		UseSSPI:           true,
		DisablePAFXFAST:   true,
	}
	options := gssapiOptionsFromKerberos(config)
	if options.ConfigPath != "/etc/krb5.conf" || options.Principal != "alice@EXAMPLE.COM" || options.Password != "secret" || options.AuthorizationID != "proxy-user" || options.ServiceHost != "canonical.example.com" || !options.CanonicalizeHost || options.CCachePath != "/tmp/alice.ccache" || options.KeytabPath != "/tmp/alice.keytab" || options.QOP != "auth-conf" || !options.UseCCache || !options.UseKeytab || !options.UseSSPI || !options.DisablePAFXFAST {
		t.Fatalf("unexpected GSSAPI options: %#v", options)
	}
}
