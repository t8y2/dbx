package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"os"

	keystore "github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

const jksMagic = 0xfeedfeed

func buildCassandraTLSConfig(config cassandraConfig) (*tls.Config, error) {
	tlsConfig := &tls.Config{InsecureSkipVerify: !config.hostVerification}
	if config.truststorePath != "" {
		certificates, err := loadTruststore(config.truststorePath, config.truststorePassword)
		if err != nil {
			return nil, fmt.Errorf("load Cassandra truststore %q: %w", config.truststorePath, err)
		}
		roots := x509.NewCertPool()
		for _, certificate := range certificates {
			roots.AddCert(certificate)
		}
		tlsConfig.RootCAs = roots
	}
	if config.keystorePath != "" {
		certificate, err := loadKeystore(config.keystorePath, config.keystorePassword)
		if err != nil {
			return nil, fmt.Errorf("load Cassandra keystore %q: %w", config.keystorePath, err)
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	}
	return tlsConfig, nil
}

func loadTruststore(path string, password string) ([]*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if isJKS(data) {
		return loadJKSTruststore(data, password)
	}
	certificates, err := pkcs12.DecodeTrustStore(data, password)
	if err == nil && len(certificates) > 0 {
		return certificates, nil
	}
	_, certificate, chain, chainErr := pkcs12.DecodeChain(data, password)
	if chainErr != nil {
		if err != nil {
			return nil, fmt.Errorf("decode PKCS#12 truststore: %w", err)
		}
		return nil, fmt.Errorf("PKCS#12 truststore contains no trusted certificates")
	}
	return append([]*x509.Certificate{certificate}, chain...), nil
}

func loadKeystore(path string, password string) (tls.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return tls.Certificate{}, err
	}
	if isJKS(data) {
		return loadJKSKeystore(data, password)
	}
	privateKey, certificate, caCertificates, err := pkcs12.DecodeChain(data, password)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("decode PKCS#12 keystore: %w", err)
	}
	chain := make([][]byte, 0, 1+len(caCertificates))
	chain = append(chain, certificate.Raw)
	for _, caCertificate := range caCertificates {
		chain = append(chain, caCertificate.Raw)
	}
	return tls.Certificate{Certificate: chain, PrivateKey: privateKey, Leaf: certificate}, nil
}

func isJKS(data []byte) bool {
	return len(data) >= 4 && binary.BigEndian.Uint32(data[:4]) == jksMagic
}

func loadJKS(data []byte, password string) (keystore.KeyStore, error) {
	store := keystore.New()
	passwordBytes := []byte(password)
	defer clear(passwordBytes)
	if err := store.Load(bytes.NewReader(data), passwordBytes); err != nil {
		return keystore.KeyStore{}, fmt.Errorf("decode JKS: %w", err)
	}
	return store, nil
}

func loadJKSTruststore(data []byte, password string) ([]*x509.Certificate, error) {
	store, err := loadJKS(data, password)
	if err != nil {
		return nil, err
	}
	certificates := make([]*x509.Certificate, 0)
	for _, alias := range store.Aliases() {
		switch {
		case store.IsTrustedCertificateEntry(alias):
			entry, err := store.GetTrustedCertificateEntry(alias)
			if err != nil {
				return nil, fmt.Errorf("read trusted certificate %q: %w", alias, err)
			}
			certificate, err := x509.ParseCertificate(entry.Certificate.Content)
			if err != nil {
				return nil, fmt.Errorf("parse trusted certificate %q: %w", alias, err)
			}
			certificates = append(certificates, certificate)
		case store.IsPrivateKeyEntry(alias):
			chain, err := store.GetPrivateKeyEntryCertificateChain(alias)
			if err != nil {
				return nil, fmt.Errorf("read certificate chain %q: %w", alias, err)
			}
			for _, entry := range chain {
				certificate, err := x509.ParseCertificate(entry.Content)
				if err != nil {
					return nil, fmt.Errorf("parse certificate chain %q: %w", alias, err)
				}
				certificates = append(certificates, certificate)
			}
		}
	}
	if len(certificates) == 0 {
		return nil, fmt.Errorf("JKS truststore contains no trusted certificates")
	}
	return certificates, nil
}

func loadJKSKeystore(data []byte, password string) (tls.Certificate, error) {
	store, err := loadJKS(data, password)
	if err != nil {
		return tls.Certificate{}, err
	}
	passwordBytes := []byte(password)
	defer clear(passwordBytes)
	for _, alias := range store.Aliases() {
		if !store.IsPrivateKeyEntry(alias) {
			continue
		}
		entry, err := store.GetPrivateKeyEntry(alias, passwordBytes)
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("read private key %q: %w", alias, err)
		}
		privateKey, err := parsePrivateKey(entry.PrivateKey)
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("parse private key %q: %w", alias, err)
		}
		chain := make([][]byte, 0, len(entry.CertificateChain))
		for _, certificate := range entry.CertificateChain {
			chain = append(chain, certificate.Content)
		}
		if len(chain) == 0 {
			return tls.Certificate{}, fmt.Errorf("private key %q has no certificate chain", alias)
		}
		leaf, err := x509.ParseCertificate(chain[0])
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("parse client certificate %q: %w", alias, err)
		}
		return tls.Certificate{Certificate: chain, PrivateKey: privateKey, Leaf: leaf}, nil
	}
	return tls.Certificate{}, fmt.Errorf("JKS keystore contains no private key entries")
}

func parsePrivateKey(data []byte) (any, error) {
	if value, err := x509.ParsePKCS8PrivateKey(data); err == nil {
		return value, nil
	}
	if value, err := x509.ParsePKCS1PrivateKey(data); err == nil {
		return value, nil
	}
	if value, err := x509.ParseECPrivateKey(data); err == nil {
		return value, nil
	}
	return nil, errors.New("unsupported private key encoding")
}
