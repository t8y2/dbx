package gosasl

import (
	"bytes"
	"errors"
	"fmt"
	"testing"
)

type fakeGSSAPIBackend struct {
	establishAfter         int
	continueCalls          int
	established            bool
	integrity              bool
	confidentiality        bool
	initiatorName          string
	initiatedService       string
	channelBinding         []byte
	continueInputs         [][]byte
	continueOutputs        [][]byte
	securityLayerChallenge []byte
	wrapInputs             [][]byte
	wrapConfidentiality    []bool
	unwrapInputs           [][]byte
	disposed               bool
}

func (backend *fakeGSSAPIBackend) Initiate(serviceName string, channelBinding []byte) error {
	backend.initiatedService = serviceName
	backend.channelBinding = append([]byte(nil), channelBinding...)
	return nil
}

func (backend *fakeGSSAPIBackend) Continue(token []byte) ([]byte, error) {
	backend.continueInputs = append(backend.continueInputs, append([]byte(nil), token...))
	backend.continueCalls++
	if backend.continueCalls >= backend.establishAfter {
		backend.established = true
	}
	if backend.continueCalls <= len(backend.continueOutputs) {
		return append([]byte(nil), backend.continueOutputs[backend.continueCalls-1]...), nil
	}
	return nil, nil
}

func (backend *fakeGSSAPIBackend) IsEstablished() bool {
	return backend.established
}

func (backend *fakeGSSAPIBackend) InitiatorName() string {
	return backend.initiatorName
}

func (backend *fakeGSSAPIBackend) SupportsIntegrity() bool {
	return backend.integrity
}

func (backend *fakeGSSAPIBackend) SupportsConfidentiality() bool {
	return backend.confidentiality
}

func (backend *fakeGSSAPIBackend) Wrap(payload []byte, confidentiality bool) ([]byte, error) {
	backend.wrapInputs = append(backend.wrapInputs, append([]byte(nil), payload...))
	backend.wrapConfidentiality = append(backend.wrapConfidentiality, confidentiality)
	return append([]byte("wrapped:"), payload...), nil
}

func (backend *fakeGSSAPIBackend) Unwrap(token []byte) ([]byte, error) {
	backend.unwrapInputs = append(backend.unwrapInputs, append([]byte(nil), token...))
	if bytes.Equal(token, []byte("security-layer")) {
		return append([]byte(nil), backend.securityLayerChallenge...), nil
	}
	return append([]byte("unwrapped:"), token...), nil
}

func (backend *fakeGSSAPIBackend) Dispose() error {
	backend.disposed = true
	return nil
}

func installFakeGSSAPIBackend(t *testing.T, backend *fakeGSSAPIBackend) {
	t.Helper()
	previous := gssapiBackendFactory
	gssapiBackendFactory = func() (gssapiBackend, error) {
		return backend, nil
	}
	t.Cleanup(func() {
		gssapiBackendFactory = previous
	})
}

func installFakeGSSAPIBackendWithOptions(t *testing.T, factory func(GSSAPIOptions) (gssapiBackend, error)) {
	t.Helper()
	previous := gssapiBackendFactoryWithOptions
	gssapiBackendFactoryWithOptions = factory
	t.Cleanup(func() {
		gssapiBackendFactoryWithOptions = previous
	})
}

func newNegotiatedGSSAPIClient(t *testing.T, qop string, serverQOP byte, backend *fakeGSSAPIBackend) (*Client, *GSSAPIMechanism) {
	t.Helper()
	t.Setenv("DBX_KRB5_QOP", qop)
	installFakeGSSAPIBackend(t, backend)
	backend.establishAfter = 1
	backend.integrity = true
	backend.securityLayerChallenge = []byte{serverQOP, 0, 0x10, 0}
	mechanism, err := NewGSSAPIMechanism("hive")
	if err != nil {
		t.Fatal(err)
	}
	client := NewSaslClient("hs2.example.com", mechanism)
	if _, err := client.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Step([]byte("security-layer")); err != nil {
		t.Fatal(err)
	}
	return client, mechanism
}

func TestGSSAPIMechanismNegotiatesMultipleContextTokens(t *testing.T) {
	t.Setenv("DBX_KRB5_QOP", "auth-int")
	t.Setenv("DBX_KRB5_AUTHORIZATION_ID", "proxy-user")
	backend := &fakeGSSAPIBackend{
		establishAfter:         2,
		integrity:              true,
		confidentiality:        true,
		initiatorName:          "client@EXAMPLE.COM",
		continueOutputs:        [][]byte{[]byte("ap-req"), []byte("ap-rep-response")},
		securityLayerChallenge: []byte{QOP_TO_FLAG[AUTH] | QOP_TO_FLAG[AUTH_INT] | QOP_TO_FLAG[AUTH_CONF], 0, 0x20, 0},
	}
	installFakeGSSAPIBackend(t, backend)

	mechanism, err := NewGSSAPIMechanism("hive/_HOST@EXAMPLE.COM")
	if err != nil {
		t.Fatal(err)
	}
	mechanism.MaxLength = 0x1000
	client := NewSaslClient("hs2.example.com", mechanism)

	initial, err := client.Start()
	if err != nil {
		t.Fatal(err)
	}
	if string(initial) != "ap-req" {
		t.Fatalf("unexpected initial token %q", initial)
	}
	if backend.initiatedService != "hive/hs2.example.com@EXAMPLE.COM" {
		t.Fatalf("unexpected service name %q", backend.initiatedService)
	}
	mutual, err := client.Step([]byte("ap-rep"))
	if err != nil {
		t.Fatal(err)
	}
	if string(mutual) != "ap-rep-response" || client.Complete() {
		t.Fatalf("unexpected mutual-auth state token=%q complete=%v", mutual, client.Complete())
	}
	response, err := client.Step([]byte("security-layer"))
	if err != nil {
		t.Fatal(err)
	}
	if !client.Complete() {
		t.Fatal("client should be complete after security-layer negotiation")
	}
	if string(response) != "wrapped:\x02\x00\x10\x00proxy-user" {
		t.Fatalf("unexpected security-layer response %q", response)
	}
	if len(backend.wrapConfidentiality) != 1 || backend.wrapConfidentiality[0] {
		t.Fatalf("security-layer response must use integrity without confidentiality: %v", backend.wrapConfidentiality)
	}
}

func TestGSSAPIMechanismQOPSelectionAndDataProtection(t *testing.T) {
	testCases := []struct {
		qop             string
		serverQOP       byte
		confidentiality bool
		expectedHeader  []byte
		passThrough     bool
	}{
		{qop: AUTH, serverQOP: 7, expectedHeader: []byte{1, 0, 0, 0}, passThrough: true},
		{qop: AUTH_INT, serverQOP: 7, expectedHeader: []byte{2, 0, 0x10, 0}},
		{qop: AUTH_CONF, serverQOP: 7, confidentiality: true, expectedHeader: []byte{4, 0, 0x10, 0}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.qop, func(t *testing.T) {
			backend := &fakeGSSAPIBackend{confidentiality: true, initiatorName: "client@EXAMPLE.COM"}
			client, _ := newNegotiatedGSSAPIClient(t, testCase.qop, testCase.serverQOP, backend)
			if got := backend.wrapInputs[0]; !bytes.Equal(got, append(testCase.expectedHeader, []byte("client@EXAMPLE.COM")...)) {
				t.Fatalf("unexpected negotiation payload %v", got)
			}

			input := []byte("payload")
			encoded, err := client.Encode(input)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.passThrough {
				if !bytes.Equal(encoded, input) {
					t.Fatalf("auth QOP changed payload: %q", encoded)
				}
				input[0] = 'X'
				if string(encoded) != "payload" {
					t.Fatal("auth QOP returned an aliased buffer")
				}
			} else {
				if string(encoded) != "wrapped:payload" {
					t.Fatalf("unexpected encoded payload %q", encoded)
				}
				if got := backend.wrapConfidentiality[len(backend.wrapConfidentiality)-1]; got != testCase.confidentiality {
					t.Fatalf("unexpected confidentiality flag %v", got)
				}
			}

			decoded, err := client.Decode([]byte("reply"))
			if err != nil {
				t.Fatal(err)
			}
			expectedDecoded := "unwrapped:reply"
			if testCase.passThrough {
				expectedDecoded = "reply"
			}
			if string(decoded) != expectedDecoded {
				t.Fatalf("unexpected decoded payload %q", decoded)
			}
		})
	}
}

func TestGSSAPIMechanismPrefersStrongestAvailableQOP(t *testing.T) {
	backend := &fakeGSSAPIBackend{confidentiality: true}
	_, mechanism := newNegotiatedGSSAPIClient(t, "", QOP_TO_FLAG[AUTH]|QOP_TO_FLAG[AUTH_INT]|QOP_TO_FLAG[AUTH_CONF], backend)
	if mechanism.qop != QOP_TO_FLAG[AUTH_CONF] {
		t.Fatalf("expected auth-conf, got %#02x", mechanism.qop)
	}
}

func TestGSSAPIMechanismRejectsUnavailableRequestedQOP(t *testing.T) {
	t.Setenv("DBX_KRB5_QOP", AUTH_CONF)
	backend := &fakeGSSAPIBackend{
		establishAfter:         1,
		integrity:              true,
		confidentiality:        true,
		securityLayerChallenge: []byte{QOP_TO_FLAG[AUTH] | QOP_TO_FLAG[AUTH_INT], 0, 0x10, 0},
	}
	installFakeGSSAPIBackend(t, backend)
	mechanism, err := NewGSSAPIMechanism("hive")
	if err != nil {
		t.Fatal(err)
	}
	client := NewSaslClient("host", mechanism)
	if _, err := client.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Step([]byte("security-layer")); err == nil {
		t.Fatal("expected unsupported QOP error")
	}
	if client.Complete() {
		t.Fatal("client must not complete after unsupported QOP")
	}
}

func TestGSSAPIMechanismRejectsInvalidSecurityLayer(t *testing.T) {
	testCases := []struct {
		name      string
		integrity bool
		challenge []byte
	}{
		{name: "missing integrity", challenge: []byte{1, 0, 0, 0}},
		{name: "short challenge", integrity: true, challenge: []byte{1, 0, 0}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("DBX_KRB5_QOP", AUTH)
			backend := &fakeGSSAPIBackend{
				establishAfter:         1,
				integrity:              testCase.integrity,
				securityLayerChallenge: testCase.challenge,
			}
			installFakeGSSAPIBackend(t, backend)
			mechanism, err := NewGSSAPIMechanism("hive")
			if err != nil {
				t.Fatal(err)
			}
			client := NewSaslClient("host", mechanism)
			if _, err := client.Start(); err != nil {
				t.Fatal(err)
			}
			if _, err := client.Step([]byte("security-layer")); err == nil {
				t.Fatal("expected invalid security-layer error")
			}
		})
	}
}

func TestGSSAPIMechanismConfigurationAndDisposal(t *testing.T) {
	t.Setenv("DBX_KRB5_QOP", "invalid")
	backend := &fakeGSSAPIBackend{}
	installFakeGSSAPIBackend(t, backend)
	if _, err := NewGSSAPIMechanism("hive"); err == nil {
		t.Fatal("expected invalid QOP configuration error")
	}
	if !backend.disposed {
		t.Fatal("backend should be disposed after constructor failure")
	}

	t.Setenv("DBX_KRB5_QOP", AUTH)
	backend = &fakeGSSAPIBackend{establishAfter: 1, integrity: true, securityLayerChallenge: []byte{1, 0, 0, 0}}
	gssapiBackendFactory = func() (gssapiBackend, error) { return backend, nil }
	mechanism, err := NewGSSAPIMechanism("hive")
	if err != nil {
		t.Fatal(err)
	}
	client := NewSaslClient("host", mechanism)
	client.Dispose()
	if !backend.disposed {
		t.Fatal("client disposal did not dispose backend")
	}
}

func TestGSSAPIMechanismBackendFactoryError(t *testing.T) {
	previous := gssapiBackendFactory
	gssapiBackendFactory = func() (gssapiBackend, error) {
		return nil, errors.New("credentials unavailable")
	}
	t.Cleanup(func() { gssapiBackendFactory = previous })
	if _, err := NewGSSAPIMechanism("hive"); err == nil || err.Error() != "credentials unavailable" {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestGSSAPIMechanismWithOptionsUsesConnectionScopedSettings(t *testing.T) {
	t.Setenv("DBX_KRB5_PRINCIPAL", "environment@EXAMPLE.COM")
	t.Setenv("DBX_KRB5_QOP", AUTH)
	t.Setenv("DBX_KRB5_AUTHORIZATION_ID", "environment-user")
	t.Setenv("SERVICE_HOST_QUALIFIED", "environment.example.com")

	wantOptions := GSSAPIOptions{
		ConfigPath:       "/connection/krb5.conf",
		CCachePath:       "/connection/alice.ccache",
		KeytabPath:       "/connection/alice.keytab",
		Principal:        "alice@EXAMPLE.COM",
		Password:         "connection-secret",
		QOP:              AUTH_INT,
		AuthorizationID:  "proxy-user",
		ServerName:       "hive/_HOST@SERVER.EXAMPLE.COM",
		ServiceHost:      "canonical.example.com",
		UseCCache:        true,
		UseKeytab:        true,
		UseSSPI:          true,
		CanonicalizeHost: true,
		DisablePAFXFAST:  true,
	}
	backend := &fakeGSSAPIBackend{
		establishAfter:         1,
		integrity:              true,
		confidentiality:        true,
		initiatorName:          "backend@EXAMPLE.COM",
		continueOutputs:        [][]byte{[]byte("ap-req")},
		securityLayerChallenge: []byte{QOP_TO_FLAG[AUTH] | QOP_TO_FLAG[AUTH_INT], 0, 0x20, 0},
	}
	var gotOptions GSSAPIOptions
	installFakeGSSAPIBackendWithOptions(t, func(options GSSAPIOptions) (gssapiBackend, error) {
		gotOptions = options
		return backend, nil
	})

	mechanism, err := NewGSSAPIMechanismWithOptions("ignored-service", wantOptions)
	if err != nil {
		t.Fatal(err)
	}
	mechanism.MaxLength = 0x1000
	client := NewSaslClient("alias.example.com", mechanism)
	if _, err := client.Start(); err != nil {
		t.Fatal(err)
	}
	response, err := client.Step([]byte("security-layer"))
	if err != nil {
		t.Fatal(err)
	}

	if gotOptions != wantOptions {
		t.Fatalf("backend options = %#v, want %#v", gotOptions, wantOptions)
	}
	if backend.initiatedService != "hive/canonical.example.com@SERVER.EXAMPLE.COM" {
		t.Fatalf("service name = %q", backend.initiatedService)
	}
	if mechanism.qop != QOP_TO_FLAG[AUTH_INT] {
		t.Fatalf("selected QOP = %#02x, want auth-int", mechanism.qop)
	}
	if string(response) != "wrapped:\x02\x00\x10\x00proxy-user" {
		t.Fatalf("security-layer response = %q", response)
	}
}

func TestGSSAPIContextClientsKeepOptionsIsolated(t *testing.T) {
	t.Setenv("DBX_KRB5_PRINCIPAL", "environment@EXAMPLE.COM")
	t.Setenv("SERVICE_HOST_QUALIFIED", "environment.example.com")

	backends := []*fakeGSSAPIBackend{
		{establishAfter: 1, continueOutputs: [][]byte{[]byte("first-token")}},
		{establishAfter: 1, continueOutputs: [][]byte{[]byte("second-token")}},
	}
	var received []GSSAPIOptions
	installFakeGSSAPIBackendWithOptions(t, func(options GSSAPIOptions) (gssapiBackend, error) {
		received = append(received, options)
		return backends[len(received)-1], nil
	})

	firstOptions := GSSAPIOptions{Principal: "alice@FIRST.EXAMPLE", ServiceHost: "first.example.com"}
	secondOptions := GSSAPIOptions{Principal: "bob@SECOND.EXAMPLE", ServerName: "HTTP/second.example.com@SECOND.EXAMPLE"}
	first, err := NewGSSAPIContextClientWithOptions("HTTP", "alias.example.com", firstOptions)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewGSSAPIContextClientWithOptions("HTTP", "other-alias.example.com", secondOptions)
	if err != nil {
		t.Fatal(err)
	}
	if token, err := first.Start(nil); err != nil || string(token) != "first-token" {
		t.Fatalf("first start token=%q err=%v", token, err)
	}
	if token, err := second.Start(nil); err != nil || string(token) != "second-token" {
		t.Fatalf("second start token=%q err=%v", token, err)
	}

	if len(received) != 2 || received[0] != firstOptions || received[1] != secondOptions {
		t.Fatalf("received options = %#v", received)
	}
	if backends[0].initiatedService != "HTTP/first.example.com" {
		t.Fatalf("first service = %q", backends[0].initiatedService)
	}
	if backends[1].initiatedService != "HTTP/second.example.com@SECOND.EXAMPLE" {
		t.Fatalf("second service = %q", backends[1].initiatedService)
	}
}

func TestGSSAPIContextClientSupportsChannelBinding(t *testing.T) {
	backend := &fakeGSSAPIBackend{
		establishAfter:  2,
		continueOutputs: [][]byte{[]byte("initial"), nil},
	}
	installFakeGSSAPIBackend(t, backend)
	client, err := NewGSSAPIContextClient("HTTP", "hs2.example.com")
	if err != nil {
		t.Fatal(err)
	}
	token, err := client.Start([]byte("tls-server-end-point:hash"))
	if err != nil {
		t.Fatal(err)
	}
	if string(token) != "initial" {
		t.Fatalf("unexpected initial token %q", token)
	}
	if backend.initiatedService != "HTTP/hs2.example.com" {
		t.Fatalf("unexpected service %q", backend.initiatedService)
	}
	if string(backend.channelBinding) != "tls-server-end-point:hash" {
		t.Fatalf("unexpected channel binding %q", backend.channelBinding)
	}
	if _, err := client.Continue([]byte("mutual")); err != nil {
		t.Fatal(err)
	}
	if !client.Complete() {
		t.Fatal("context should be complete")
	}
	if err := client.Dispose(); err != nil {
		t.Fatal(err)
	}
	if !backend.disposed {
		t.Fatal("context backend was not disposed")
	}
}

func TestConfiguredQOPMask(t *testing.T) {
	for _, testCase := range []struct {
		value string
		want  byte
	}{
		{value: "", want: 7},
		{value: " AUTH ", want: 1},
		{value: "auth-int", want: 2},
		{value: "AUTH-CONF", want: 4},
	} {
		t.Run(fmt.Sprintf("%q", testCase.value), func(t *testing.T) {
			got, err := configuredQOPMask(testCase.value)
			if err != nil {
				t.Fatal(err)
			}
			if got != testCase.want {
				t.Fatalf("got %#02x, want %#02x", got, testCase.want)
			}
		})
	}
}

func TestQualifiedServiceNameCanonicalizesHost(t *testing.T) {
	previousLookup := lookupCanonicalHostname
	lookupCanonicalHostname = func(host string) (string, error) {
		if host != "alias.example.com" {
			t.Fatalf("unexpected lookup host: %s", host)
		}
		return "hs2.example.com.", nil
	}
	t.Cleanup(func() { lookupCanonicalHostname = previousLookup })
	t.Setenv("DBX_KRB5_CANONICALIZE_HOST", "true")
	t.Setenv("SERVICE_HOST_QUALIFIED", "")
	t.Setenv("DBX_KRB5_SERVER_NAME", "")

	if value := qualifiedServiceName("hive/_HOST@EXAMPLE.COM", "alias.example.com"); value != "hive/hs2.example.com@EXAMPLE.COM" {
		t.Fatalf("unexpected canonical service name: %s", value)
	}
}

func TestQualifiedServiceNameHonorsExplicitHost(t *testing.T) {
	t.Setenv("DBX_KRB5_CANONICALIZE_HOST", "true")
	t.Setenv("SERVICE_HOST_QUALIFIED", "explicit.example.com")
	t.Setenv("DBX_KRB5_SERVER_NAME", "")
	if value := qualifiedServiceName("hive", "alias.example.com"); value != "hive/explicit.example.com" {
		t.Fatalf("unexpected explicit service name: %s", value)
	}
}
