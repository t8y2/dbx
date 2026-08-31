package main

import (
	"archive/zip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

func TestSecureConnectBundleBuildsAstraClusterWithoutHost(t *testing.T) {
	bundlePath := writeTestSecureConnectBundle(t)
	config, err := parseCassandraConfig(connectParams{
		Username: "token",
		Password: "astra-token",
		URLParams: url.Values{
			"secureconnectbundle": []string{bundlePath},
			"requesttimeout":      []string{"9s"},
			"connecttimeout":      []string{"7s"},
		}.Encode(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.hosts) != 0 || config.secureConnectBundle != bundlePath {
		t.Fatalf("unexpected Astra config: %#v", config)
	}

	cluster, err := config.clusterConfig("app")
	if err != nil {
		t.Fatal(err)
	}
	if cluster.HostDialer == nil {
		t.Fatal("Astra cluster must use the secure-connect HostDialer")
	}
	if reflect.DeepEqual(cluster.Hosts, config.hosts) || len(cluster.Hosts) != 3 {
		t.Fatalf("Astra cluster must use dialer placeholder hosts: %#v", cluster.Hosts)
	}
	credentials, ok := cluster.Authenticator.(*gocql.PasswordAuthenticator)
	if !ok || credentials.Username != "token" || credentials.Password != "astra-token" {
		t.Fatalf("unexpected Astra authenticator: %#v", cluster.Authenticator)
	}
	if cluster.Keyspace != "app" || cluster.Timeout != 9*time.Second || cluster.ConnectTimeout != 7*time.Second {
		t.Fatalf("unexpected Astra cluster options: %#v", cluster)
	}
}

func TestSecureConnectBundleSupportsHOCONConfiguration(t *testing.T) {
	bundlePath := writeTestSecureConnectBundle(t)
	configPath := writeTestFile(t, "astra.conf", `
datastax-java-driver {
  basic.cloud.secure-connect-bundle = "`+bundlePath+`"
  advanced.auth-provider {
    class = PlainTextAuthProvider
    username = token
    password = astra-token
  }
}
`)

	config, err := parseCassandraConfig(connectParams{
		URLParams: url.Values{"configfile": []string{configPath}}.Encode(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.secureConnectBundle != bundlePath || config.username != "token" || config.password != "astra-token" {
		t.Fatalf("unexpected HOCON Astra config: %#v", config)
	}
	if _, err := config.clusterConfig(""); err != nil {
		t.Fatal(err)
	}
}

func TestSecureConnectBundleValidatesCredentialsAndAuthMode(t *testing.T) {
	bundlePath := writeTestSecureConnectBundle(t)

	if _, err := parseCassandraConfig(connectParams{
		URLParams: url.Values{"secureconnectbundle": []string{bundlePath}}.Encode(),
	}); err == nil {
		t.Fatal("expected Astra credential validation error")
	}

	if _, err := parseCassandraConfig(connectParams{
		Username: "token",
		Password: "astra-token",
		URLParams: url.Values{
			"secureconnectbundle": []string{bundlePath},
			"usekrb5":             []string{"true"},
		}.Encode(),
	}); err == nil {
		t.Fatal("expected Astra and Kerberos conflict")
	}
}

func writeTestSecureConnectBundle(t *testing.T) string {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "dbx-astra-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyDER, err := x509.MarshalECPrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER})
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: privateKeyDER})
	configJSON, err := json.Marshal(map[string]any{"host": "astra.example.com", "port": 29042})
	if err != nil {
		t.Fatal(err)
	}

	bundlePath := filepath.Join(t.TempDir(), "secure-connect.zip")
	bundle, err := os.Create(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(bundle)
	for name, contents := range map[string][]byte{
		"config.json": configJSON,
		"ca.crt":      certificatePEM,
		"cert":        certificatePEM,
		"key":         privateKeyPEM,
	} {
		entry, createErr := archive.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write(contents); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := bundle.Close(); err != nil {
		t.Fatal(err)
	}
	return bundlePath
}
