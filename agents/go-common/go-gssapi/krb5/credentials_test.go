package krb5

import (
	"testing"

	"github.com/jcmturner/gokrb5/v8/config"
)

func TestSplitPrincipal(t *testing.T) {
	username, realm, err := splitPrincipal("alice/admin@EXAMPLE.COM", "")
	if err != nil {
		t.Fatal(err)
	}
	if username != "alice/admin" || realm != "EXAMPLE.COM" {
		t.Fatalf("unexpected principal: %q %q", username, realm)
	}
}

func TestSplitPrincipalUsesDefaultRealm(t *testing.T) {
	username, realm, err := splitPrincipal("alice", "EXAMPLE.COM")
	if err != nil {
		t.Fatal(err)
	}
	if username != "alice" || realm != "EXAMPLE.COM" {
		t.Fatalf("unexpected principal: %q %q", username, realm)
	}
}

func TestConfigureServiceRealmSeparatesExplicitRealm(t *testing.T) {
	configuration := config.New()
	service := configureServiceRealm(configuration, "zookeeper/zk.example.com@ZK.EXAMPLE.COM")
	if service != "zookeeper/zk.example.com" {
		t.Fatalf("service = %q", service)
	}
	if configuration.DomainRealm["zk.example.com"] != "ZK.EXAMPLE.COM" {
		t.Fatalf("domain realm mapping = %#v", configuration.DomainRealm)
	}
}

func TestConfigureServiceRealmLeavesImplicitRealmResolution(t *testing.T) {
	configuration := config.New()
	service := configureServiceRealm(configuration, "hive/hs2.example.com")
	if service != "hive/hs2.example.com" || len(configuration.DomainRealm) != 0 {
		t.Fatalf("service=%q domain realms=%#v", service, configuration.DomainRealm)
	}
}
