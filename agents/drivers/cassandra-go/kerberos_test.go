package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"path/filepath"
	"strings"
	"testing"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
	"github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/types"
)

func TestKerberosPasswordCredentialsTakePrecedenceOverEnvironmentCache(t *testing.T) {
	clearKerberosEnvironment(t)
	t.Setenv("KRB5CCNAME", filepath.Join(t.TempDir(), "missing.ccache"))
	config := defaultKerberosConfig()
	config.enabled = true
	config.configPath = writeKerberosConfig(t)
	config.principal = "alice@EXAMPLE.COM"
	config.password = "secret"

	if err := config.finalize("", ""); err != nil {
		t.Fatal(err)
	}
	if config.credentialMode != kerberosCredentialPassword || config.credentialUser != "alice" || config.credentialRealm != "EXAMPLE.COM" {
		t.Fatalf("unexpected password credential selection: %#v", config)
	}
}

func TestKerberosExplicitCredentialSourcesTakePrecedence(t *testing.T) {
	clearKerberosEnvironment(t)
	krb5Path := writeKerberosConfig(t)
	cachePath := writeTestFile(t, "alice.ccache", "placeholder")
	keytabPath := writeTestFile(t, "alice.keytab", "placeholder")

	t.Run("ccache", func(t *testing.T) {
		config := defaultKerberosConfig()
		config.enabled = true
		config.configPath = krb5Path
		config.ccachePath = "FILE:" + cachePath
		config.principal = "alice@EXAMPLE.COM"
		config.password = "ignored"
		if err := config.finalize("", ""); err != nil {
			t.Fatal(err)
		}
		if config.credentialMode != kerberosCredentialCCache || config.ccachePath != cachePath {
			t.Fatalf("unexpected ccache credential selection: %#v", config)
		}
	})

	t.Run("keytab", func(t *testing.T) {
		config := defaultKerberosConfig()
		config.enabled = true
		config.configPath = krb5Path
		config.keytabPath = "FILE:" + keytabPath
		config.principal = "alice@EXAMPLE.COM"
		config.password = "ignored"
		if err := config.finalize("", ""); err != nil {
			t.Fatal(err)
		}
		if config.credentialMode != kerberosCredentialKeytab || config.keytabPath != keytabPath {
			t.Fatalf("unexpected keytab credential selection: %#v", config)
		}
	})
}

func TestKerberosDiscoversJavaJAASAndKrb5Properties(t *testing.T) {
	clearKerberosEnvironment(t)
	krb5Path := writeKerberosConfig(t)
	cachePath := writeTestFile(t, "alice.ccache", "placeholder")
	jaasPath := writeTestFile(t, "jaas.conf", `
CassandraJavaClient {
  com.sun.security.auth.module.Krb5LoginModule required
    useTicketCache=true
    ticketCache="FILE:`+cachePath+`"
    principal="alice@EXAMPLE.COM";
};
`)
	t.Setenv("JAVA_TOOL_OPTIONS", `-Djava.security.krb5.conf="`+krb5Path+`" -Djava.security.auth.login.config='`+jaasPath+`'`)

	config := defaultKerberosConfig()
	config.enabled = true
	if err := config.finalize("", ""); err != nil {
		t.Fatal(err)
	}
	if config.configPath != krb5Path || config.jaasConfigPath != jaasPath {
		t.Fatalf("Java system properties were not applied: %#v", config)
	}
	if config.credentialMode != kerberosCredentialCCache || config.ccachePath != cachePath || config.principal != "alice@EXAMPLE.COM" {
		t.Fatalf("JAAS credential cache was not applied: %#v", config)
	}
}

func TestKerberosRejectsUnsupportedQOP(t *testing.T) {
	clearKerberosEnvironment(t)
	config := defaultKerberosConfig()
	config.enabled = true
	config.configPath = writeKerberosConfig(t)
	config.principal = "alice@EXAMPLE.COM"
	config.password = "secret"
	config.qop = "auth-conf"

	err := config.finalize("", "")
	if err == nil || !strings.Contains(err.Error(), "supports SASL QOP auth only") {
		t.Fatalf("expected QOP rejection, got %v", err)
	}
}

func TestKerberosAcceptsQOPPreferenceListContainingAuth(t *testing.T) {
	clearKerberosEnvironment(t)
	config := defaultKerberosConfig()
	config.enabled = true
	config.configPath = writeKerberosConfig(t)
	config.principal = "alice@EXAMPLE.COM"
	config.password = "secret"
	config.qop = "auth-conf, auth"

	if err := config.finalize("", ""); err != nil {
		t.Fatal(err)
	}
	if config.qop != "auth" {
		t.Fatalf("unexpected negotiated QOP preference: %q", config.qop)
	}
}

func TestNormalizeKerberosCachePathSupportsWindowsDrivePaths(t *testing.T) {
	path, err := normalizeKerberosCachePath(`C:\Users\alice\krb5cc`)
	if err != nil {
		t.Fatal(err)
	}
	if path != `C:\Users\alice\krb5cc` {
		t.Fatalf("unexpected Windows cache path: %q", path)
	}
	if _, err := normalizeKerberosCachePath("DIR:/tmp/krb5cc"); err == nil {
		t.Fatal("expected non-FILE credential cache type rejection")
	}
}

func TestKerberosServerNameSupportsExplicitOverride(t *testing.T) {
	name, err := kerberosServerName(kerberosConfig{serverName: "node1.example.com."}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if name != "node1.example.com" {
		t.Fatalf("unexpected explicit server name: %q", name)
	}
	if _, err := kerberosServerName(kerberosConfig{}, nil); err == nil {
		t.Fatal("expected missing host error")
	}

	host, err := gocql.NewHostInfoFromAddrPort(net.ParseIP("127.0.0.1"), 9042)
	if err != nil {
		t.Fatal(err)
	}
	if resolved, err := kerberosServerName(kerberosConfig{}, host); err != nil || strings.TrimSpace(resolved) == "" {
		t.Fatalf("expected loopback canonical name, got %q, %v", resolved, err)
	}
}

func TestKerberosInitialTokenContainsDecryptableAPRequest(t *testing.T) {
	key := testKerberosEncryptionKey()
	authenticator := kerberosAuthenticator{
		domain:     "EXAMPLE.COM",
		clientName: types.NewPrincipalName(1, "alice"),
		ticket: messages.Ticket{
			TktVNO: 5,
			Realm:  "EXAMPLE.COM",
			SName:  types.NewPrincipalName(2, "cassandra/node1.example.com"),
			EncPart: types.EncryptedData{
				EType:  key.KeyType,
				KVNO:   1,
				Cipher: []byte{1},
			},
		},
		sessionKey: key,
	}

	token, err := authenticator.initialToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 2 || token[0] != kerberosGSSAPITag {
		t.Fatalf("unexpected GSSAPI token prefix: %x", token)
	}
	encodedOID, err := asn1.Marshal(gssapi.OIDKRB5.OID())
	if err != nil {
		t.Fatal(err)
	}
	oidOffset := bytes.Index(token, encodedOID)
	if oidOffset < 0 {
		t.Fatalf("Kerberos OID missing from token: %x", token)
	}
	payload := token[oidOffset+len(encodedOID):]
	if len(payload) < 3 || binary.BigEndian.Uint16(payload[:2]) != kerberosAPRequestTokenID {
		t.Fatalf("unexpected Kerberos mechanism token: %x", payload)
	}
	var request messages.APReq
	if err := request.Unmarshal(payload[2:]); err != nil {
		t.Fatal(err)
	}
	if err := request.DecryptAuthenticator(key); err != nil {
		t.Fatal(err)
	}
	if request.Authenticator.CName.PrincipalNameString() != "alice" || request.Authenticator.CRealm != "EXAMPLE.COM" {
		t.Fatalf("unexpected AP-REQ authenticator: %#v", request.Authenticator)
	}
}

func TestKerberosSecurityLayerNegotiatesAuthAndAuthorizationID(t *testing.T) {
	key := testKerberosEncryptionKey()
	challenge := marshalKerberosAcceptorToken(t, key, []byte{0x07, 0x00, 0x10, 0x00})
	authenticator := kerberosAuthenticator{sessionKey: key, authorizationID: "assumed_role"}

	response, err := authenticator.securityLayerResponse(challenge)
	if err != nil {
		t.Fatal(err)
	}
	var decoded gssapi.WrapToken
	if err := decoded.Unmarshal(response, false); err != nil {
		t.Fatal(err)
	}
	valid, err := decoded.Verify(key, keyusage.GSSAPI_INITIATOR_SEAL)
	if err != nil || !valid {
		t.Fatalf("invalid security-layer response: valid=%t err=%v", valid, err)
	}
	want := append([]byte{kerberosSecurityNone, 0, 0, 0}, []byte("assumed_role")...)
	if !bytes.Equal(decoded.Payload, want) {
		t.Fatalf("unexpected security-layer payload: %x", decoded.Payload)
	}
}

func TestKerberosSecurityLayerRejectsUnavailableAuthQOP(t *testing.T) {
	key := testKerberosEncryptionKey()
	challenge := marshalKerberosAcceptorToken(t, key, []byte{0x02, 0, 0, 0})
	authenticator := kerberosAuthenticator{sessionKey: key}
	if _, err := authenticator.securityLayerResponse(challenge); err == nil {
		t.Fatal("expected server QOP rejection")
	}
}

func TestKerberosAuthenticatorChecksumRequestsIntegrityAndConfidentiality(t *testing.T) {
	checksum := kerberosAuthenticatorChecksum()
	if len(checksum) != 24 || binary.LittleEndian.Uint32(checksum[:4]) != 16 {
		t.Fatalf("unexpected channel-binding checksum: %x", checksum)
	}
	wantFlags := uint32(gssapi.ContextFlagInteg | gssapi.ContextFlagConf)
	if flags := binary.LittleEndian.Uint32(checksum[20:24]); flags != wantFlags {
		t.Fatalf("unexpected GSSAPI context flags: %x", flags)
	}
}

func clearKerberosEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"JAVA_TOOL_OPTIONS",
		"_JAVA_OPTIONS",
		"JDK_JAVA_OPTIONS",
		"KRB5_CONFIG",
		"KRB5CCNAME",
		"KRB5_CLIENT_KTNAME",
		"KRB5_KTNAME",
	} {
		t.Setenv(name, "")
	}
}

func writeKerberosConfig(t *testing.T) string {
	t.Helper()
	return writeTestFile(t, "krb5.conf", `
[libdefaults]
  default_realm = EXAMPLE.COM
  dns_lookup_realm = false
  dns_lookup_kdc = false

[realms]
  EXAMPLE.COM = {
    kdc = 127.0.0.1:88
  }
`)
}

func testKerberosEncryptionKey() types.EncryptionKey {
	return types.EncryptionKey{KeyType: 18, KeyValue: bytes.Repeat([]byte{0x42}, 32)}
}

func marshalKerberosAcceptorToken(t *testing.T, key types.EncryptionKey, payload []byte) []byte {
	t.Helper()
	token := gssapi.WrapToken{
		Flags:   0x01,
		EC:      12,
		Payload: payload,
	}
	if err := token.SetCheckSum(key, keyusage.GSSAPI_ACCEPTOR_SEAL); err != nil {
		t.Fatal(err)
	}
	encoded, err := token.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
