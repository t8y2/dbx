package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writePEM(t *testing.T, dir, name, blockType string, der []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func generateCertificate(t *testing.T, dir string, ca *x509.Certificate, caKey *ecdsa.PrivateKey) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "dbx-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  ca == nil,
	}
	signer := ca
	signerKey := caKey
	if ca == nil {
		signer = template
		signerKey = key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certPath = writePEM(t, dir, "cert.pem", "CERTIFICATE", der)
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPath = writePEM(t, dir, "key.pem", "EC PRIVATE KEY", keyDER)
	return certPath, keyPath
}

func TestBuildZooKeeperTLSConfig(t *testing.T) {
	dir := t.TempDir()
	caCertPath, caKeyPath := generateCertificate(t, dir, nil, nil)
	caDER, _ := os.ReadFile(caCertPath)
	caBlock, _ := pem.Decode(caDER)
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		t.Fatalf("parse ca: %v", err)
	}
	keyDER, _ := os.ReadFile(caKeyPath)
	caKeyBlock, _ := pem.Decode(keyDER)
	caKey, err := x509.ParseECPrivateKey(caKeyBlock.Bytes)
	if err != nil {
		t.Fatalf("parse ca key: %v", err)
	}

	t.Run("disabled without options", func(t *testing.T) {
		config, err := buildZooKeeperTLSConfig(connectionConfig{})
		if err != nil || config != nil {
			t.Fatalf("expected (nil, nil), got (%v, %v)", config, err)
		}
	})

	t.Run("ca only sets RootCAs", func(t *testing.T) {
		caPath, _ := generateCertificate(t, dir, ca, caKey)
		config, err := buildZooKeeperTLSConfig(connectionConfig{CACertPath: caPath})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if config == nil || config.RootCAs == nil {
			t.Fatal("expected tls.Config with RootCAs")
		}
		if config.MinVersion != 0x0303 { // TLS 1.2
			t.Fatalf("expected MinVersion TLS1.2, got %x", config.MinVersion)
		}
	})

	t.Run("client cert and key load", func(t *testing.T) {
		clientCert, clientKey := generateCertificate(t, dir, ca, caKey)
		config, err := buildZooKeeperTLSConfig(connectionConfig{
			ClientCertPath: clientCert,
			ClientKeyPath:  clientKey,
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(config.Certificates) != 1 {
			t.Fatalf("expected 1 client certificate, got %d", len(config.Certificates))
		}
	})

	t.Run("client cert without key errors", func(t *testing.T) {
		clientCert, _ := generateCertificate(t, dir, ca, caKey)
		if _, err := buildZooKeeperTLSConfig(connectionConfig{ClientCertPath: clientCert}); err == nil {
			t.Fatal("expected error when client cert has no key")
		}
	})

	t.Run("insecure skip verify", func(t *testing.T) {
		config, err := buildZooKeeperTLSConfig(connectionConfig{
			SSL:       true,
			URLParams: "insecure_skip_verify=true",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !config.InsecureSkipVerify {
			t.Fatal("expected InsecureSkipVerify true")
		}
	})
}
