package main

import (
	"reflect"
	"testing"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

func TestParseCassandraConfigSupportsLegacyJDBCOptions(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		Host:      "127.0.0.1",
		Database:  "app",
		Username:  "cassandra",
		Password:  "secret",
		URLParams: "?localdatacenter=dc1&requesttimeout=10000&connecttimeout=5s&protocolversion=4&consistency=local_quorum&numconns=4",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.hosts) != 1 || config.hosts[0] != "127.0.0.1" {
		t.Fatalf("unexpected hosts: %#v", config.hosts)
	}
	if config.port != 9042 || config.keyspace != "app" {
		t.Fatalf("unexpected endpoint: port=%d keyspace=%q", config.port, config.keyspace)
	}
	if config.localDatacenter != "dc1" || config.protocolVersion != 4 {
		t.Fatalf("unexpected topology config: %#v", config)
	}
	if config.requestTimeout != 10*time.Second || config.connectTimeout != 5*time.Second {
		t.Fatalf("unexpected timeouts: request=%s connect=%s", config.requestTimeout, config.connectTimeout)
	}
	if config.numConnections != 4 || !config.disableInitialHostLookup {
		t.Fatalf("unexpected pool/tunnel config: %#v", config)
	}
}

func TestParseCassandraConfigAcceptsConnectionString(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		ConnectionString: "jdbc:cassandra://alice:secret@db.example.com:9142/catalog?protocolversion=5",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.hosts) != 1 || config.hosts[0] != "db.example.com:9142" || config.port != 9142 {
		t.Fatalf("unexpected endpoint: %#v", config)
	}
	if config.keyspace != "catalog" || config.username != "alice" || config.password != "secret" {
		t.Fatalf("unexpected credentials/keyspace: %#v", config)
	}
	if config.protocolVersion != 5 {
		t.Fatalf("unexpected protocol version: %d", config.protocolVersion)
	}
}

func TestParseCassandraConfigCoversMappableJDBCWrapperOptions(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		ConnectionString: "jdbc:cassandra://host1--host2:9142/catalog?" +
			"user=query-user&password=query-secret&enablessl=true&hostnameverification=false&" +
			"tcpnodelay=false&keepalive=true&debug=true&retries=7&retry=DefaultRetryPolicy&" +
			"reconnection=ExponentialReconnectionPolicy((long)2,(long)30)&" +
			"loadbalancing=TokenAwarePolicy&compliancemode=Liquibase",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.hosts, []string{"host1", "host2:9142"}) || config.port != 9142 {
		t.Fatalf("unexpected multi-host endpoint: hosts=%#v port=%d", config.hosts, config.port)
	}
	if config.username != "query-user" || config.password != "query-secret" {
		t.Fatalf("unexpected query credentials: %#v", config)
	}
	if !config.ssl || config.hostVerification || config.tcpNoDelay || !config.keepAlive || !config.debug {
		t.Fatalf("unexpected transport options: %#v", config)
	}
	if config.retryPolicy != "simple" || config.retryCount != 7 || config.reconnectionPolicy != "exponential" {
		t.Fatalf("unexpected retry options: %#v", config)
	}
	if config.reconnectionBaseDelay != 2*time.Second || config.reconnectionMaxDelay != 30*time.Second {
		t.Fatalf("unexpected reconnection delays: %#v", config)
	}
	if config.loadBalancingPolicy != "token_aware" {
		t.Fatalf("unexpected load-balancing option: %#v", config)
	}

	cluster, err := config.clusterConfig(config.keyspace)
	if err != nil {
		t.Fatal(err)
	}
	dialer, ok := cluster.Dialer.(cassandraDialer)
	if !ok || dialer.tcpNoDelay || !dialer.keepAlive {
		t.Fatalf("unexpected socket dialer: %#v", cluster.Dialer)
	}
	retryPolicy, ok := cluster.RetryPolicy.(*gocql.SimpleRetryPolicy)
	if !ok || retryPolicy.NumRetries != 7 {
		t.Fatalf("unexpected query retry policy: %#v", cluster.RetryPolicy)
	}
	reconnectionPolicy, ok := cluster.ReconnectionPolicy.(*gocql.ExponentialReconnectionPolicy)
	if !ok || reconnectionPolicy.MaxRetries != 7 || reconnectionPolicy.InitialInterval != 2*time.Second || reconnectionPolicy.MaxInterval != 30*time.Second {
		t.Fatalf("unexpected reconnection policy: %#v", cluster.ReconnectionPolicy)
	}
}

func TestParseCassandraConfigUsesSecureTransportDefaults(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{Host: "127.0.0.1:9042", SSL: true})
	if err != nil {
		t.Fatal(err)
	}
	if !config.hostVerification || !config.tcpNoDelay || config.keepAlive {
		t.Fatalf("unexpected defaults: %#v", config)
	}
	if !config.disableInitialHostLookup {
		t.Fatal("loopback host with explicit port must disable peer discovery")
	}
}

func TestParseCassandraConfigAcceptsDefaultSSLEngineFactory(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		Host:      "localhost",
		URLParams: "sslenginefactory=com.datastax.oss.driver.internal.core.ssl.DefaultSslEngineFactory&usekrb5=false",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.ssl {
		t.Fatal("default SSL engine factory must enable TLS")
	}
}

func TestParseCassandraConfigRejectsCustomJavaImplementationClasses(t *testing.T) {
	tests := []string{
		"sslenginefactory=example.CustomSslEngineFactory",
		"loadbalancing=example.CustomPolicy",
		"retry=example.CustomRetryPolicy",
	}
	for _, urlParams := range tests {
		if _, err := parseCassandraConfig(connectParams{Host: "localhost", URLParams: urlParams}); err == nil {
			t.Fatalf("expected custom Java implementation rejection for %q", urlParams)
		}
	}
}

func TestParseReconnectionPolicySupportsFullyQualifiedClass(t *testing.T) {
	policy, baseDelay, maxDelay, err := parseReconnectionPolicy(
		"com.datastax.oss.driver.internal.core.connection.ExponentialReconnectionPolicy((long)1,(long)8)",
	)
	if err != nil {
		t.Fatal(err)
	}
	if policy != "exponential" || baseDelay != time.Second || maxDelay != 8*time.Second {
		t.Fatalf("unexpected policy: %s %s %s", policy, baseDelay, maxDelay)
	}
}

func TestParseCassandraConfigRejectsUnsupportedLoadBalancingClass(t *testing.T) {
	_, err := parseCassandraConfig(connectParams{
		Host:      "localhost",
		URLParams: "loadbalancing=example.CustomPolicy",
	})
	if err == nil {
		t.Fatal("expected unsupported load-balancing policy error")
	}
}

func TestParseCassandraConfigRejectsCassandra20Protocol(t *testing.T) {
	_, err := parseCassandraConfig(connectParams{
		Host:      "localhost",
		URLParams: "protocolversion=2",
	})
	if err == nil {
		t.Fatal("expected native protocol v2 rejection")
	}
}

func TestParseDurationOptionTreatsBareNumbersAsMilliseconds(t *testing.T) {
	duration, err := parseDurationOption("1500")
	if err != nil {
		t.Fatal(err)
	}
	if duration != 1500*time.Millisecond {
		t.Fatalf("unexpected duration: %s", duration)
	}
}
