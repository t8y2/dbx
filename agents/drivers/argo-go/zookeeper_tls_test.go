package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	keystore "github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

func testZooKeeperCertificate(t *testing.T) (*rsa.PrivateKey, *x509.Certificate, []byte) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "zk.example.com"},
		DNSNames:     []string{"zk.example.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		IsCA:         true,
	}
	raw, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(raw)
	if err != nil {
		t.Fatal(err)
	}
	return privateKey, certificate, raw
}

func TestBuildZooKeeperTLSConfigFromPEM(t *testing.T) {
	_, _, raw := testZooKeeperCertificate(t)
	path := filepath.Join(t.TempDir(), "trust.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := buildZooKeeperTLSConfig(map[string]string{
		"zookeepersslenable":          "true",
		"zookeepertruststorelocation": path,
		"zookeepertruststoretype":     "PEM",
		"zookeeperservername":         "zk.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config == nil || config.RootCAs == nil || config.ServerName != "zk.example.com" {
		t.Fatalf("unexpected TLS config: %#v", config)
	}
}

func TestBuildZooKeeperTLSConfigFromJKS(t *testing.T) {
	privateKey, certificate, raw := testZooKeeperCertificate(t)
	password := []byte("changeit")
	store := keystore.New()
	if err := store.SetTrustedCertificateEntry("ca", keystore.TrustedCertificateEntry{
		CreationTime: time.Now(),
		Certificate:  keystore.Certificate{Type: "X509", Content: raw},
	}); err != nil {
		t.Fatal(err)
	}
	encodedKey, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetPrivateKeyEntry("client", keystore.PrivateKeyEntry{
		CreationTime: time.Now(),
		PrivateKey:   encodedKey,
		CertificateChain: []keystore.Certificate{
			{Type: "X509", Content: certificate.Raw},
		},
	}, password); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "client.jks")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Store(file, password); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	config, err := buildZooKeeperTLSConfig(map[string]string{
		"zookeepersslenable":          "true",
		"zookeepertruststorelocation": path,
		"zookeepertruststorepassword": string(password),
		"zookeepertruststoretype":     "JKS",
		"zookeeperkeystorelocation":   path,
		"zookeeperkeystorepassword":   string(password),
		"zookeeperkeystoretype":       "JKS",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.RootCAs == nil || len(config.Certificates) != 1 || config.Certificates[0].PrivateKey == nil {
		t.Fatalf("unexpected JKS TLS config: %#v", config)
	}
}

func TestBuildZooKeeperTLSConfigFromPKCS12(t *testing.T) {
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
	config, err := buildZooKeeperTLSConfig(map[string]string{
		"zookeepersslenable":          "true",
		"zookeepertruststorelocation": trustPath,
		"zookeepertruststorepassword": password,
		"zookeepertruststoretype":     "PKCS12",
		"zookeeperkeystorelocation":   keyPath,
		"zookeeperkeystorepassword":   password,
		"zookeeperkeystoretype":       "PKCS12",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.RootCAs == nil || len(config.Certificates) != 1 {
		t.Fatalf("unexpected PKCS12 TLS config: %#v", config)
	}
}

func TestZooKeeperTLSRequiresExistingStore(t *testing.T) {
	if _, err := buildZooKeeperTLSConfig(map[string]string{
		"zookeepersslenable":          "true",
		"zookeepertruststorelocation": filepath.Join(t.TempDir(), "missing.jks"),
	}); err == nil {
		t.Fatal("expected missing truststore error")
	}
}
