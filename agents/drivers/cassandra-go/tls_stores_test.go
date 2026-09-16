package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	keystore "github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

const tlsStoreTestPassword = "changeit"

func TestLoadJKSStores(t *testing.T) {
	_, certificate, privateKeyDER := testTLSIdentity(t)
	store := keystore.New()
	if err := store.SetTrustedCertificateEntry("ca", keystore.TrustedCertificateEntry{
		CreationTime: time.Now(),
		Certificate:  keystore.Certificate{Type: "X509", Content: certificate.Raw},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetPrivateKeyEntry("client", keystore.PrivateKeyEntry{
		CreationTime: time.Now(),
		PrivateKey:   privateKeyDER,
		CertificateChain: []keystore.Certificate{
			{Type: "X509", Content: certificate.Raw},
		},
	}, []byte(tlsStoreTestPassword)); err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := store.Store(&encoded, []byte(tlsStoreTestPassword)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "client.jks")
	if err := os.WriteFile(path, encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	trusted, err := loadTruststore(path, tlsStoreTestPassword)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := loadKeystore(path, tlsStoreTestPassword)
	if err != nil {
		t.Fatal(err)
	}
	if len(trusted) != 2 || identity.Leaf == nil {
		t.Fatalf("unexpected JKS contents: trusted=%d identity=%#v", len(trusted), identity)
	}
}

func TestLoadPKCS12Stores(t *testing.T) {
	privateKey, certificate, _ := testTLSIdentity(t)
	truststore, err := pkcs12.Modern.EncodeTrustStore([]*x509.Certificate{certificate}, tlsStoreTestPassword)
	if err != nil {
		t.Fatal(err)
	}
	keystoreData, err := pkcs12.Modern.Encode(privateKey, certificate, nil, tlsStoreTestPassword)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	truststorePath := filepath.Join(directory, "client-trust.p12")
	keystorePath := filepath.Join(directory, "client-key.p12")
	if err := os.WriteFile(truststorePath, truststore, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keystorePath, keystoreData, 0o600); err != nil {
		t.Fatal(err)
	}

	tlsConfig, err := buildCassandraTLSConfig(cassandraConfig{
		truststorePath:     truststorePath,
		truststorePassword: tlsStoreTestPassword,
		keystorePath:       keystorePath,
		keystorePassword:   tlsStoreTestPassword,
		hostVerification:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if tlsConfig.RootCAs == nil || len(tlsConfig.Certificates) != 1 || tlsConfig.InsecureSkipVerify {
		t.Fatalf("unexpected PKCS#12 TLS config: %#v", tlsConfig)
	}
}

func TestParseCassandraConfigRejectsStorePasswordWithoutPath(t *testing.T) {
	_, err := parseCassandraConfig(connectParams{Host: "localhost", TruststorePassword: "secret"})
	if err == nil {
		t.Fatal("expected truststore path validation error")
	}
}

func TestSecureConnectBundleIgnoresManualTLSStoreSettings(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		Username:   "token",
		Password:   "secret",
		CACertPath: "ca.pem",
		URLParams: url.Values{
			"secureconnectbundle": []string{"bundle.zip"},
			"truststorepath":      []string{"https://ignored.example/truststore"},
			"truststorepassword":  []string{"ignored"},
		}.Encode(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.secureConnectBundle != "bundle.zip" {
		t.Fatalf("unexpected secure connect bundle: %q", config.secureConnectBundle)
	}
}

func testTLSIdentity(t *testing.T) (*ecdsa.PrivateKey, *x509.Certificate, []byte) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "cassandra-client"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		IsCA:         true,
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(certificateDER)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return privateKey, certificate, privateKeyDER
}
