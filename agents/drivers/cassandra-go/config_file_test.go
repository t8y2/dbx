package main

import (
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/gurkankaymak/hocon"
)

func TestCassandraConfigFileOverridesURLExceptEndpoint(t *testing.T) {
	configPath := writeTestFile(t, "application.conf", `
datastax-java-driver {
  basic {
    contact-points = ["ignored.example.com:9042"]
    session-keyspace = ignored_keyspace
    request {
      timeout = 2 seconds
      consistency = LOCAL_ONE
      serial-consistency = LOCAL_SERIAL
      page-size = 321
    }
    load-balancing-policy {
      class = BasicLoadBalancingPolicy
      local-datacenter = dc-config
    }
  }
  advanced {
    connection {
      connect-timeout = 3 seconds
      pool.local.size = 4
    }
    socket {
      tcp-no-delay = false
      keep-alive = true
    }
    protocol.version = V4
    retry-policy.class = FallthroughRetryPolicy
    reconnection-policy {
      class = ExponentialReconnectionPolicy
      base-delay = 4 seconds
      max-delay = 20 seconds
    }
    auth-provider {
      class = PlainTextAuthProvider
      username = file-user
      password = file-password
    }
    ssl-engine-factory {
      class = DefaultSslEngineFactory
      hostname-validation = false
    }
  }
}
`)

	config, err := parseCassandraConfig(connectParams{
		Host:     "url.example.com",
		Database: "url_keyspace",
		Username: "url-user",
		Password: "url-password",
		URLParams: url.Values{
			"configfile":        []string{configPath},
			"requesttimeout":    []string{"30s"},
			"connecttimeout":    []string{"31s"},
			"consistency":       []string{"QUORUM"},
			"serialconsistency": []string{"SERIAL"},
			"fetchsize":         []string{"999"},
			"localdatacenter":   []string{"dc-url"},
			"protocolversion":   []string{"5"},
			"numconns":          []string{"2"},
			"tcpnodelay":        []string{"true"},
			"keepalive":         []string{"false"},
			"retry":             []string{"DefaultRetryPolicy"},
			"reconnection":      []string{"ConstantReconnectionPolicy((long)1)"},
			"user":              []string{"query-user"},
			"password":          []string{"query-password"},
		}.Encode(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.hosts, []string{"url.example.com"}) || config.keyspace != "url_keyspace" {
		t.Fatalf("configfile must not replace endpoint or keyspace: %#v", config)
	}
	if config.username != "file-user" || config.password != "file-password" {
		t.Fatalf("configfile credentials did not override URL values: %#v", config)
	}
	if config.requestTimeout != 2*time.Second || config.connectTimeout != 3*time.Second {
		t.Fatalf("unexpected configfile timeouts: request=%s connect=%s", config.requestTimeout, config.connectTimeout)
	}
	if config.consistency != "LOCAL_ONE" || config.serialConsistency != "LOCAL_SERIAL" || config.pageSize != 321 {
		t.Fatalf("unexpected request config: %#v", config)
	}
	if config.localDatacenter != "dc-config" || config.loadBalancingPolicy != "default" || config.protocolVersion != 4 {
		t.Fatalf("unexpected topology/protocol config: %#v", config)
	}
	if config.numConnections != 4 || config.tcpNoDelay || !config.keepAlive {
		t.Fatalf("unexpected connection/socket config: %#v", config)
	}
	if config.retryPolicy != "fallthrough" || config.reconnectionPolicy != "exponential" {
		t.Fatalf("unexpected policy config: %#v", config)
	}
	if config.reconnectionBaseDelay != 4*time.Second || config.reconnectionMaxDelay != 20*time.Second {
		t.Fatalf("unexpected reconnection delays: %#v", config)
	}
	if !config.ssl || config.hostVerification {
		t.Fatalf("unexpected TLS config: %#v", config)
	}
}

func TestCassandraConfigFileSupportsKerberosLoginOptionCasing(t *testing.T) {
	parsed, err := hocon.ParseString(`
datastax-java-driver.advanced.auth-provider {
  class = com.instaclustr.cassandra.driver.auth.KerberosAuthProvider
  authorization-id = assumed_role
  sasl-protocol = cassandra-custom
  sasl-properties."javax.security.sasl.qop" = auth
  login-configuration {
    principal = "alice@EXAMPLE.COM"
    keyTab = "/tmp/alice.keytab"
    ticketCache = "FILE:/tmp/alice.ccache"
    useKeyTab = true
    useTicketCache = false
  }
}
`)
	if err != nil {
		t.Fatal(err)
	}
	config := cassandraConfig{kerberos: defaultKerberosConfig()}
	if err := applyJavaDriverHOCON(&config, parsed); err != nil {
		t.Fatal(err)
	}
	if !config.kerberos.enabled || config.kerberos.principal != "alice@EXAMPLE.COM" {
		t.Fatalf("unexpected Kerberos provider config: %#v", config.kerberos)
	}
	if config.kerberos.keytabPath != "/tmp/alice.keytab" || config.kerberos.ccachePath != "FILE:/tmp/alice.ccache" {
		t.Fatalf("unexpected Kerberos file options: %#v", config.kerberos)
	}
	if !config.kerberos.useKeytab || !config.kerberos.useKeytabSet || config.kerberos.useTicketCache || !config.kerberos.useTicketCacheSet {
		t.Fatalf("unexpected Kerberos credential switches: %#v", config.kerberos)
	}
	if config.kerberos.authorizationID != "assumed_role" || config.kerberos.serviceName != "cassandra-custom" || config.kerberos.qop != "auth" {
		t.Fatalf("unexpected Kerberos SASL options: %#v", config.kerberos)
	}
}

func TestMissingCassandraConfigFileIsIgnoredForJDBCCompatibility(t *testing.T) {
	missingPath := filepath.Join(t.TempDir(), "missing.conf")
	config, err := parseCassandraConfig(connectParams{
		Host:      "localhost",
		URLParams: url.Values{"configfile": []string{missingPath}, "requesttimeout": []string{"2s"}}.Encode(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.requestTimeout != 2*time.Second {
		t.Fatalf("missing configfile must leave URL options intact: %#v", config)
	}
}

func writeTestFile(t *testing.T, name, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
