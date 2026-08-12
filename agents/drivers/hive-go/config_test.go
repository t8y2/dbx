package main

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

func writeHadoopVInt(buffer *bytes.Buffer, value int64) {
	if value >= -112 && value <= 127 {
		buffer.WriteByte(byte(int8(value)))
		return
	}
	lengthMarker := int8(-112)
	encoded := value
	if value < 0 {
		encoded = ^value
		lengthMarker = -120
	}
	temporary := encoded
	for temporary != 0 {
		temporary >>= 8
		lengthMarker--
	}
	buffer.WriteByte(byte(lengthMarker))
	length := -int(lengthMarker)
	if lengthMarker < -120 {
		length -= 120
	} else {
		length -= 112
	}
	for index := length; index != 0; index-- {
		shift := uint((index - 1) * 8)
		buffer.WriteByte(byte(encoded >> shift))
	}
}

func encodeHadoopToken(identifier, password, kind, service []byte) string {
	var buffer bytes.Buffer
	for _, value := range [][]byte{identifier, password, kind, service} {
		writeHadoopVInt(&buffer, int64(len(value)))
		buffer.Write(value)
	}
	return base64.RawURLEncoding.EncodeToString(buffer.Bytes())
}

func TestParseDirectJDBCConnection(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hive.example.com:10001/analytics;transportMode=http;httpPath=gateway;ssl=true",
		Username:         "alice",
		Password:         "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.Endpoints) != 1 || config.Endpoints[0] != (endpoint{Host: "hive.example.com", Port: 10001}) {
		t.Fatalf("unexpected endpoints: %#v", config.Endpoints)
	}
	if config.Database != "analytics" || config.TransportMode != "http" || config.HTTPPath != "gateway" {
		t.Fatalf("unexpected config: %#v", config)
	}
	if config.TLSConfig == nil {
		t.Fatal("expected TLS config")
	}
}

func TestParseHTTPKerberosChannelBinding(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hive.example.com:10001/default;transportMode=http;ssl=true;auth=KERBEROS;principal=HTTP/_HOST@EXAMPLE.COM;kerberosChannelBinding=true",
		Username:         "alice@EXAMPLE.COM",
		Password:         "secret",
		AgentJavaOptions: []string{"-Djava.security.krb5.conf=/etc/krb5.conf"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.Kerberos.ChannelBinding {
		t.Fatal("expected HTTP Kerberos TLS channel binding")
	}
}

func TestParseZooKeeperKerberosJDBCConnection(t *testing.T) {
	configPath := "/etc/krb5.conf"
	if runtime.GOOS == "windows" {
		configPath = `C:\ProgramData\MIT\Kerberos5\krb5.ini`
	}
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://zk1.example.com:2181,zk2.example.com:2181/default;serviceDiscoveryMode=zooKeeper;zooKeeperNamespace=kyuubi;principal=hive/_HOST@EXAMPLE.COM;hive.server2.thrift.sasl.qop=auth-conf",
		Username:         "alice@EXAMPLE.COM",
		Password:         "secret",
		AgentJavaOptions: []string{"-Djava.security.krb5.conf=" + configPath},
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.ServiceDiscoveryMode != "zookeeper" || config.ZooKeeperNamespace != "kyuubi" {
		t.Fatalf("unexpected ZooKeeper config: %#v", config)
	}
	if len(config.Endpoints) != 2 || config.Endpoints[1].Host != "zk2.example.com" || config.Endpoints[1].Port != 2181 {
		t.Fatalf("unexpected endpoints: %#v", config.Endpoints)
	}
	if !config.Kerberos.Enabled || config.Kerberos.Service != "hive" || config.Kerberos.QOP != "auth-conf" {
		t.Fatalf("unexpected Kerberos config: %#v", config.Kerberos)
	}
	if config.Kerberos.ConfigPath != configPath {
		t.Fatalf("unexpected krb5 config path: %q", config.Kerberos.ConfigPath)
	}
	if !config.ZooKeeperKerberos.Enabled || config.ZooKeeperKerberos.Service != "zookeeper" || !config.ZooKeeperKerberos.CanonicalHostname {
		t.Fatalf("unexpected ZooKeeper Kerberos config: %#v", config.ZooKeeperKerberos)
	}
}

func TestParseZooKeeperKerberosCompatibilityProperties(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://zk.example.com:2181/default;serviceDiscoveryMode=zooKeeper;principal=hive/_HOST@HIVE.EXAMPLE.COM;zookeeper.sasl.client.username=zkservice;zookeeper.server.realm=ZK.EXAMPLE.COM;zookeeper.sasl.client.canonicalize.hostname=false",
		Username:         "alice@EXAMPLE.COM",
		Password:         "secret",
		AgentJavaOptions: []string{
			"-Djava.security.krb5.conf=/etc/krb5.conf",
			"-Dzookeeper.server.principal=zookeeper/zk.example.com@EXPLICIT.EXAMPLE.COM",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := zooKeeperKerberosConfig{
		Enabled:           true,
		Service:           "zkservice",
		ServerPrincipal:   "zookeeper/zk.example.com@EXPLICIT.EXAMPLE.COM",
		Realm:             "ZK.EXAMPLE.COM",
		CanonicalHostname: false,
	}
	if config.ZooKeeperKerberos != want {
		t.Fatalf("ZooKeeper Kerberos config = %#v, want %#v", config.ZooKeeperKerberos, want)
	}
}

func TestZooKeeperKerberosCanBeDisabledExplicitly(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://zk.example.com:2181/default;serviceDiscoveryMode=zooKeeper;principal=hive/_HOST@EXAMPLE.COM;hive.zookeeper.use.kerberos=true",
		Username:         "alice@EXAMPLE.COM",
		Password:         "secret",
		AgentJavaOptions: []string{
			"-Djava.security.krb5.conf=/etc/krb5.conf",
			"-Dzookeeper.sasl.client=false",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.ZooKeeperKerberos.Enabled {
		t.Fatalf("ZooKeeper Kerberos should be disabled: %#v", config.ZooKeeperKerberos)
	}
}

func TestURLParamsOverrideConnectionString(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		Host:             "hive.example.com",
		Port:             10000,
		ConnectionString: "jdbc:hive2://old.example.com:10000/default;transportMode=binary",
		URLParams:        "transportMode=http;httpPath=proxy",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.TransportMode != "http" || config.HTTPPath != "proxy" {
		t.Fatalf("URL params did not override connection string: %#v", config)
	}
}

func TestParseStandardJDBCURLSectionsAndCredentials(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com:10001/analytics;user=alice;password=p%40ss?hive.server2.transport.mode=http;hive.server2.thrift.http.path=proxy;hive.exec.dynamic.partition=true#SourceTable=events",
		URLParams:        "user=bob?hive.exec.dynamic.partition=false#SourceTable=override",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Username != "bob" || config.Password != "p@ss" {
		t.Fatalf("unexpected credentials: %q / %q", config.Username, config.Password)
	}
	if config.TransportMode != "http" || config.HTTPPath != "proxy" {
		t.Fatalf("deprecated Hive conf transport settings were not applied: %#v", config)
	}
	want := map[string]string{
		"set:hiveconf:hive.exec.dynamic.partition": "false",
		"set:hivevar:SourceTable":                  "override",
	}
	if !reflect.DeepEqual(config.HiveConfiguration, want) {
		t.Fatalf("unexpected OpenSession configuration: %#v", config.HiveConfiguration)
	}
}

func TestOpenSessionCompatibilityVariablesFromSessionParams(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		Host:      "hs2.example.com",
		URLParams: "proxyUser=alice;hiveCreateAsExternalLegacy=TRUE;wmPool=etl;hiveconf:hive.exec.compress.output=true;hivevar:source=events",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"hive.server2.proxy.user":                     "alice",
		"set:hiveconf:hive.create.as.external.legacy": "true",
		"set:hiveconf:hive.exec.compress.output":      "true",
		"set:hivevar:source":                          "events",
		"set:hivevar:wmpool":                          "etl",
	}
	if !reflect.DeepEqual(config.HiveConfiguration, want) {
		t.Fatalf("unexpected OpenSession compatibility variables: %#v", config.HiveConfiguration)
	}
}

func TestParseHiveJDBCClientCompatibilityOptions(t *testing.T) {
	directory := t.TempDir()
	initPath := filepath.Join(directory, "hive-init.sql")
	if err := os.WriteFile(initPath, []byte("# ignored\nSET hive.exec.dynamic.partition=true;\n-- ignored\nUSE analytics;\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com:10001/default;transportMode=http;auth=jwt;jwt=signed-token;fetchSize=77;socketTimeout=9;thrift.client.max.message.size=1048576;retries=3;retryInterval=250;requestTrack=true;cookieAuth=false;cookieName=CustomAuth;http.header.X-Trace-ID=trace-value;http.cookie.SessionID=cookie-value;applicationName=dbx-hive;initFile=" + url.QueryEscape(initPath),
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Auth != "JWT" || config.JWT != "signed-token" {
		t.Fatalf("unexpected JWT config: %#v", config)
	}
	if config.FetchSize != 77 || config.SocketTimeout != 9*time.Second || config.MaxMessageSize != 1048576 {
		t.Fatalf("unexpected client sizing config: %#v", config)
	}
	if config.Retries != 3 || config.RetryInterval != 250*time.Millisecond {
		t.Fatalf("unexpected retry config: %#v", config)
	}
	if config.CookieAuth || config.CookieName != "CustomAuth" {
		t.Fatalf("unexpected cookie auth config: %#v", config)
	}
	if config.HTTPHeaders["X-Trace-ID"] != "trace-value" || config.HTTPCookies["SessionID"] != "cookie-value" {
		t.Fatalf("HTTP header or cookie case was not preserved: %#v / %#v", config.HTTPHeaders, config.HTTPCookies)
	}
	if !config.RequestTracking {
		t.Fatal("requestTrack was not enabled")
	}
	if config.HiveConfiguration["set:hivevar:wmapp"] != "dbx-hive" {
		t.Fatalf("applicationName was not mapped: %#v", config.HiveConfiguration)
	}
	if !reflect.DeepEqual(config.InitStatements, []string{"SET hive.exec.dynamic.partition=true", "USE analytics"}) {
		t.Fatalf("unexpected init statements: %#v", config.InitStatements)
	}
}

func TestJWTCanComeFromEnvironment(t *testing.T) {
	t.Setenv("JWT", "environment-token")
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com:10001/default;transportMode=http;auth=jwt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.JWT != "environment-token" {
		t.Fatalf("unexpected JWT: %q", config.JWT)
	}
}

func TestBrowserAuthSupportsInteractiveSSOParameters(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com:10001/default;transportMode=http;auth=browser;browserResponsePort=18080;browserResponseTimeout=45;browserDisableSslCheck=true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.BrowserToken != "" || config.BrowserResponsePort != 18080 || config.BrowserResponseTimeout != 45*time.Second || !config.BrowserDisableSSLCheck {
		t.Fatalf("unexpected browser SSO config: %#v", config)
	}
}

func TestInvalidHiveJDBCClientSizesAreRejected(t *testing.T) {
	for _, params := range []string{
		"fetchSize=zero",
		"socketTimeout=soon",
		"thrift.client.max.message.size=huge",
	} {
		_, err := parseConnectionConfig(connectParams{
			ConnectionString: "jdbc:hive2://hs2.example.com/default;" + params,
		})
		if err == nil {
			t.Fatalf("expected %q to be rejected", params)
		}
	}
}

func TestJavaCredentialProviderPasswordPathIsNotSilentlyIgnored(t *testing.T) {
	_, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com/default;ssl=true;sslTrustStore=/tmp/truststore.jks;storePasswordPath=jceks://file/tmp/hive.jceks",
	})
	if err == nil || !strings.Contains(err.Error(), "configure trustStorePassword explicitly") {
		t.Fatalf("unexpected credential-provider error: %v", err)
	}
}

func TestKerberosAcceptsSaslQopCompatibilityAlias(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "krb5.conf")
	if err := os.WriteFile(configPath, []byte("[libdefaults]\n default_realm = EXAMPLE.COM\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com/default;auth=kerberos;principal=hive/_HOST@EXAMPLE.COM;kerberosPrincipal=alice@EXAMPLE.COM;sasl.qop=auth-int",
		Password:         "secret",
		AgentJavaOptions: []string{"-Djava.security.krb5.conf=" + configPath},
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Kerberos.QOP != "auth-int" {
		t.Fatalf("unexpected SASL QOP: %q", config.Kerberos.QOP)
	}
}

func TestDelegationTokenProducesDigestCredentials(t *testing.T) {
	identifier := []byte("token-identifier")
	password := []byte("token-password")
	token := encodeHadoopToken(identifier, password, []byte("HIVE_DELEGATION_TOKEN"), []byte("hs2.example.com:10000"))
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com/default;auth=delegationToken;delegationToken=" + token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Auth != "DELEGATIONTOKEN" {
		t.Fatalf("unexpected auth: %q", config.Auth)
	}
	if config.DelegationToken != token {
		t.Fatalf("raw delegation token was not retained: %q", config.DelegationToken)
	}
	if config.Username != base64.StdEncoding.EncodeToString(identifier) || config.Password != base64.StdEncoding.EncodeToString(password) {
		t.Fatalf("unexpected delegation token credentials: %q / %q", config.Username, config.Password)
	}
}

func TestDelegationTokenRejectsMalformedValue(t *testing.T) {
	_, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com/default;auth=delegationToken;delegationToken=not-a-token",
	})
	if err == nil || !strings.Contains(err.Error(), "decode Hive delegation token") {
		t.Fatalf("expected delegation token error, got %v", err)
	}
}

func TestParseIPv6Endpoint(t *testing.T) {
	value, err := parseEndpoint("[2001:db8::1]:10000", defaultHivePort)
	if err != nil {
		t.Fatal(err)
	}
	if value.Host != "2001:db8::1" || value.Port != 10000 {
		t.Fatalf("unexpected endpoint: %#v", value)
	}
}

func TestKerberosSeparatesServerAndClientPrincipals(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "krb5.conf")
	if err := os.WriteFile(configPath, []byte("[libdefaults]\n default_realm = CLIENT.EXAMPLE.COM\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://alias.example.com:10000/default;auth=kerberos;principal=hive/_HOST@SERVER.EXAMPLE.COM;kerberosPrincipal=alice@CLIENT.EXAMPLE.COM;kerberosEnableCanonicalHostnameCheck=false",
		Password:         "secret",
		AgentJavaOptions: []string{`-Djava.security.krb5.conf="` + configPath + `"`},
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Kerberos.ServerPrincipal != "hive/_HOST@SERVER.EXAMPLE.COM" {
		t.Fatalf("unexpected server principal: %q", config.Kerberos.ServerPrincipal)
	}
	if config.Kerberos.ClientPrincipal != "alice@CLIENT.EXAMPLE.COM" {
		t.Fatalf("unexpected client principal: %q", config.Kerberos.ClientPrincipal)
	}
	if config.Kerberos.Realm != "CLIENT.EXAMPLE.COM" || config.Kerberos.CanonicalHostname {
		t.Fatalf("unexpected Kerberos options: %#v", config.Kerberos)
	}
}

func TestKerberosReadsLegacyJAASKeytabOptions(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "krb5.conf")
	jaasPath := filepath.Join(directory, "hive jaas.conf")
	keytabPath := filepath.Join(directory, "alice.keytab")
	if err := os.WriteFile(configPath, []byte("[libdefaults]\n default_realm = EXAMPLE.COM\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	jaas := `HiveClient {
  com.sun.security.auth.module.Krb5LoginModule required
  useKeyTab=true
  keyTab="` + keytabPath + `"
  principal="alice@EXAMPLE.COM"
  doNotPrompt=true;
};`
	if err := os.WriteFile(jaasPath, []byte(jaas), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:hive2://hs2.example.com/default;auth=kerberos;principal=hive/_HOST@EXAMPLE.COM",
		AgentJavaOptions: []string{
			"-Djava.security.krb5.conf=" + configPath,
			`-Djava.security.auth.login.config="` + jaasPath + `"`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.Kerberos.UseKeytab || config.Kerberos.KeytabPath != keytabPath {
		t.Fatalf("JAAS keytab was not preserved: %#v", config.Kerberos)
	}
	if config.Kerberos.ClientPrincipal != "alice@EXAMPLE.COM" {
		t.Fatalf("JAAS principal was not preserved: %#v", config.Kerberos)
	}
}

func TestBuildHiveTLSConfigFromPKCS12Stores(t *testing.T) {
	privateKey, certificate, _ := testZooKeeperCertificate(t)
	password := "changeit"
	keyStore, err := pkcs12.Modern.Encode(privateKey, certificate, nil, password)
	if err != nil {
		t.Fatal(err)
	}
	trustStore, err := pkcs12.Modern.EncodeTrustStore([]*x509.Certificate{certificate}, password)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	keyPath := filepath.Join(directory, "client.p12")
	trustPath := filepath.Join(directory, "trust.p12")
	if err := os.WriteFile(keyPath, keyStore, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(trustPath, trustStore, 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := buildTLSConfig(connectParams{}, map[string]string{
		"ssl":                "true",
		"twoway":             "true",
		"ssltruststore":      trustPath,
		"truststorepassword": password,
		"truststoretype":     "PKCS12",
		"sslkeystore":        keyPath,
		"keystorepassword":   password,
		"keystoretype":       "PKCS12",
	}, "hs2.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if config == nil || config.RootCAs == nil || len(config.Certificates) != 1 {
		t.Fatalf("unexpected Hive TLS config: %#v", config)
	}
}

func TestBuildHiveTwoWayTLSRequiresTrustAndKeyMaterial(t *testing.T) {
	if _, err := buildTLSConfig(connectParams{}, map[string]string{
		"ssl":    "true",
		"twoway": "true",
	}, "hs2.example.com"); err == nil {
		t.Fatal("expected missing two-way TLS material error")
	}
}
