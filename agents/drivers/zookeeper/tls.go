package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// dialZooKeeperConnection opens a raw ZooKeeper transport connection. When
// tlsConfig is non-nil the connection is wrapped in a TLS handshake so the
// caller can talk to a secure (clientCnxn with ssl) ZooKeeper port.
func dialZooKeeperConnection(address string, timeout time.Duration, tlsConfig *tls.Config) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout}
	if tlsConfig == nil {
		return dialer.Dial("tcp", address)
	}
	config := tlsConfig.Clone()
	if config.ServerName == "" {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("parse ZooKeeper TLS address %q: %w", address, err)
		}
		config.ServerName = host
	}
	return tls.DialWithDialer(dialer, "tcp", address, config)
}

// buildZooKeeperTLSConfig turns the TLS-related fields of a connectionConfig
// into a *tls.Config. It returns (nil, nil) when TLS is not requested so the
// caller can keep using the plain TCP dialer for non-secure clusters.
func buildZooKeeperTLSConfig(config connectionConfig) (*tls.Config, error) {
	if !tlsOptionsPresent(config) {
		return nil, nil
	}
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}
	caPath := firstNonBlank(config.CACertPath)
	if caPath != "" {
		pool, err := loadCACertPool(caPath)
		if err != nil {
			return nil, fmt.Errorf("load ZooKeeper CA certificate: %w", err)
		}
		tlsConfig.RootCAs = pool
	}
	certPath := firstNonBlank(config.ClientCertPath, config.CertPath)
	keyPath := firstNonBlank(config.ClientKeyPath, config.KeyPath)
	switch {
	case certPath != "" && keyPath != "":
		certificate, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("load ZooKeeper client certificate: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	case certPath != "":
		return nil, errors.New("client key (client_key_path) is required when a client certificate is provided")
	case keyPath != "":
		return nil, errors.New("client certificate (client_cert_path) is required when a client key is provided")
	}
	// insecure_skip_verify is exposed only as a connection URL parameter
	// (e.g. ?insecure_skip_verify=true). It defaults to off, so callers that
	// don't set it get full certificate-chain verification. Only enable it for
	// trusted or test-only clusters, since it disables that verification.
	if paramBool(connectionURLParams(config), "insecure_skip_verify") {
		tlsConfig.InsecureSkipVerify = true
	}
	return tlsConfig, nil
}

// tlsOptionsPresent reports whether the connection configuration requests a
// TLS-secured connection, either via the explicit ssl flag or by supplying any
// certificate/material paths.
func tlsOptionsPresent(config connectionConfig) bool {
	return config.SSL || firstNonBlank(
		config.CACertPath,
		config.ClientCertPath,
		config.ClientKeyPath,
		config.CertPath,
		config.KeyPath,
	) != ""
}

// loadCACertPool reads a PEM-encoded trust store (one or more CERTIFICATE
// blocks) and returns an x509.CertPool built from it. It uses
// x509.CertPool.AppendCertsFromPEM (the same helper etcd-go relies on) so a
// single call parses every CERTIFICATE block in the file, including CA-chain
// bundles, without a manual decode loop.
func loadCACertPool(path string) (*x509.CertPool, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(contents) {
		return nil, errors.New("PEM CA file contains no CERTIFICATE blocks")
	}
	return pool, nil
}

// paramBool parses a boolean connection URL parameter, treating missing or
// unparseable values as false.
func paramBool(params url.Values, name string) bool {
	value := strings.TrimSpace(params.Get(name))
	if value == "" {
		return false
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false
	}
	return parsed
}
