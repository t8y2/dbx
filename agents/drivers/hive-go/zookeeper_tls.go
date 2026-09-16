package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	keystore "github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

func buildZooKeeperTLSConfig(values map[string]string) (*tls.Config, error) {
	if !parameterBool(values, "zookeepersslenable") {
		return nil, nil
	}
	config := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: parameter(values, "zookeeperservername"),
	}
	trustStoreLocation := parameter(values, "zookeepertruststorelocation")
	if trustStoreLocation != "" {
		certificates, err := loadTrustStore(
			trustStoreLocation,
			parameter(values, "zookeepertruststorepassword"),
			parameter(values, "zookeepertruststoretype"),
		)
		if err != nil {
			return nil, fmt.Errorf("load ZooKeeper truststore: %w", err)
		}
		pool := x509.NewCertPool()
		for _, certificate := range certificates {
			pool.AddCert(certificate)
		}
		config.RootCAs = pool
	}
	keyStoreLocation := parameter(values, "zookeeperkeystorelocation")
	if keyStoreLocation != "" {
		certificate, err := loadClientKeyStore(
			keyStoreLocation,
			parameter(values, "zookeeperkeystorepassword"),
			parameter(values, "zookeeperkeystoretype"),
		)
		if err != nil {
			return nil, fmt.Errorf("load ZooKeeper keystore: %w", err)
		}
		config.Certificates = []tls.Certificate{certificate}
	}
	if parameterBool(values, "zookeepersslinsecureskipverify") {
		config.InsecureSkipVerify = true
	}
	return config, nil
}

func loadTrustStore(path, password, storeType string) ([]*x509.Certificate, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	switch normalizedStoreType(storeType, path) {
	case "PEM":
		return parsePEMCertificates(contents)
	case "PKCS12":
		certificates, err := pkcs12.DecodeTrustStore(contents, password)
		if err == nil {
			return certificates, nil
		}
		_, certificate, chain, chainErr := pkcs12.DecodeChain(contents, password)
		if chainErr != nil {
			return nil, err
		}
		return append([]*x509.Certificate{certificate}, chain...), nil
	case "JKS":
		store, err := loadJKS(contents, password)
		if err != nil {
			return nil, err
		}
		var certificates []*x509.Certificate
		for _, alias := range store.Aliases() {
			switch {
			case store.IsTrustedCertificateEntry(alias):
				entry, getErr := store.GetTrustedCertificateEntry(alias)
				if getErr != nil {
					return nil, getErr
				}
				certificate, parseErr := x509.ParseCertificate(entry.Certificate.Content)
				if parseErr != nil {
					return nil, parseErr
				}
				certificates = append(certificates, certificate)
			case store.IsPrivateKeyEntry(alias):
				chain, getErr := store.GetPrivateKeyEntryCertificateChain(alias)
				if getErr != nil {
					return nil, getErr
				}
				for _, entry := range chain {
					certificate, parseErr := x509.ParseCertificate(entry.Content)
					if parseErr != nil {
						return nil, parseErr
					}
					certificates = append(certificates, certificate)
				}
			}
		}
		if len(certificates) == 0 {
			return nil, errors.New("JKS truststore contains no certificates")
		}
		return certificates, nil
	default:
		return nil, fmt.Errorf("unsupported store type %q", storeType)
	}
}

func loadClientKeyStore(path, password, storeType string) (tls.Certificate, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return tls.Certificate{}, err
	}
	switch normalizedStoreType(storeType, path) {
	case "PEM":
		return tls.X509KeyPair(contents, contents)
	case "PKCS12":
		privateKey, certificate, chain, err := pkcs12.DecodeChain(contents, password)
		if err != nil {
			return tls.Certificate{}, err
		}
		result := tls.Certificate{PrivateKey: privateKey, Leaf: certificate}
		result.Certificate = append(result.Certificate, certificate.Raw)
		for _, entry := range chain {
			result.Certificate = append(result.Certificate, entry.Raw)
		}
		return result, nil
	case "JKS":
		store, err := loadJKS(contents, password)
		if err != nil {
			return tls.Certificate{}, err
		}
		passwordBytes := []byte(password)
		defer clear(passwordBytes)
		for _, alias := range store.Aliases() {
			if !store.IsPrivateKeyEntry(alias) {
				continue
			}
			entry, getErr := store.GetPrivateKeyEntry(alias, passwordBytes)
			if getErr != nil {
				return tls.Certificate{}, getErr
			}
			privateKey, parseErr := parsePrivateKey(entry.PrivateKey)
			if parseErr != nil {
				return tls.Certificate{}, parseErr
			}
			result := tls.Certificate{PrivateKey: privateKey}
			for index, certificate := range entry.CertificateChain {
				result.Certificate = append(result.Certificate, certificate.Content)
				if index == 0 {
					result.Leaf, _ = x509.ParseCertificate(certificate.Content)
				}
			}
			if len(result.Certificate) == 0 {
				return tls.Certificate{}, errors.New("JKS private key entry has no certificate chain")
			}
			return result, nil
		}
		return tls.Certificate{}, errors.New("JKS keystore contains no private key entry")
	default:
		return tls.Certificate{}, fmt.Errorf("unsupported store type %q", storeType)
	}
}

func normalizedStoreType(storeType, path string) string {
	value := strings.ToUpper(strings.TrimSpace(storeType))
	switch value {
	case "P12", "PFX", "PKCS#12":
		return "PKCS12"
	case "X509", "X.509":
		return "PEM"
	case "":
		switch strings.ToLower(filepath.Ext(path)) {
		case ".jks":
			return "JKS"
		case ".p12", ".pfx", ".pkcs12":
			return "PKCS12"
		default:
			return "PEM"
		}
	default:
		return value
	}
}

func loadJKS(contents []byte, password string) (keystore.KeyStore, error) {
	store := keystore.New()
	passwordBytes := []byte(password)
	defer clear(passwordBytes)
	if err := store.Load(bytes.NewReader(contents), passwordBytes); err != nil {
		return keystore.KeyStore{}, err
	}
	return store, nil
}

func parsePEMCertificates(contents []byte) ([]*x509.Certificate, error) {
	var certificates []*x509.Certificate
	for len(contents) > 0 {
		block, rest := pem.Decode(contents)
		if block == nil {
			break
		}
		contents = rest
		if block.Type != "CERTIFICATE" {
			continue
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, err
		}
		certificates = append(certificates, certificate)
	}
	if len(certificates) == 0 {
		return nil, errors.New("PEM truststore contains no certificates")
	}
	return certificates, nil
}

func parsePrivateKey(contents []byte) (any, error) {
	if value, err := x509.ParsePKCS8PrivateKey(contents); err == nil {
		return value, nil
	}
	if value, err := x509.ParsePKCS1PrivateKey(contents); err == nil {
		return value, nil
	}
	if value, err := x509.ParseECPrivateKey(contents); err == nil {
		return value, nil
	}
	return nil, errors.New("unsupported private key encoding")
}
