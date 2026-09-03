package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	defaultGrpcMaxInboundMessageSize = 32 * 1024 * 1024
	minGrpcMaxInboundMessageSize     = 1024 * 1024
	maxGrpcMaxInboundMessageSize     = 256 * 1024 * 1024
	grpcMaxInboundMessageSizeKey     = "grpc_max_inbound_message_size"
	defaultPort                      = 2379
)

// connectionParams mirrors the host-side etcd connection configuration.
type connectionParams struct {
	EtcdEndpoints             string `json:"etcd_endpoints"`
	Endpoints                 string `json:"endpoints"`
	ConnectionString          string `json:"connection_string"`
	Host                      string `json:"host"`
	Port                      int    `json:"port"`
	Username                  string `json:"username"`
	Password                  string `json:"password"`
	SSL                       bool   `json:"ssl"`
	CACertPath                string `json:"ca_cert_path"`
	ClientCertPath            string `json:"client_cert_path"`
	ClientKeyPath             string `json:"client_key_path"`
	CertPath                  string `json:"cert_path"`
	KeyPath                   string `json:"key_path"`
	ConnectTimeoutSecs        int    `json:"connect_timeout_secs"`
	GrpcMaxInboundMessageSize int    `json:"grpc_max_inbound_message_size"`
	URLParams                 string `json:"url_params"`
}

func connectionObject(params map[string]json.RawMessage) (connectionParams, error) {
	var connection connectionParams
	if raw, ok := params["connection"]; ok && raw != nil {
		if err := json.Unmarshal(raw, &connection); err != nil {
			return connection, err
		}
		return connection, nil
	}
	if err := decodeParams(params, &connection); err != nil {
		return connection, err
	}
	return connection, nil
}

func (s *etcdSession) connectMap(params map[string]json.RawMessage) (any, error) {
	if _, err := s.connect(params); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

func (s *etcdSession) connect(params map[string]json.RawMessage) (any, error) {
	connection, err := connectionObject(params)
	if err != nil {
		return nil, err
	}
	nextClient, err := buildClient(connection)
	if err != nil {
		return nil, err
	}
	endpointList := connectionEndpoints(connection)
	if _, err := probeClient(nextClient, endpointList); err != nil {
		_ = nextClient.Close()
		return nil, err
	}
	s.close()
	s.clientMu.Lock()
	s.client = nextClient
	s.connectedEndpoints = endpointList
	s.clientMu.Unlock()
	return map[string]bool{"ok": true}, nil
}

func (s *etcdSession) activeClient() (*clientv3.Client, error) {
	s.clientMu.Lock()
	client := s.client
	s.clientMu.Unlock()
	if client == nil {
		return nil, errors.New("Not connected")
	}
	return client, nil
}

func (s *etcdSession) connectedEndpointList() []string {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()
	return append([]string(nil), s.connectedEndpoints...)
}

func (s *etcdSession) validateConnection() (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	return probeClient(client, s.connectedEndpointList())
}

func (s *etcdSession) close() error {
	s.watchesMu.Lock()
	watches := s.watches
	s.watches = map[string]*watchState{}
	s.knownLeases = map[uint64]struct{}{}
	s.watchBufferedBytes = 0
	s.watchesMu.Unlock()
	for _, watch := range watches {
		watch.close()
	}
	s.clientMu.Lock()
	client := s.client
	s.client = nil
	s.connectedEndpoints = nil
	s.clientMu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	return nil
}

func buildClient(connection connectionParams) (*clientv3.Client, error) {
	endpoints := connectionEndpoints(connection)
	config := clientv3.Config{
		Endpoints:   endpoints,
		DialTimeout: time.Duration(connectTimeoutSeconds(connection)) * time.Second,
	}
	if size := grpcMaxInboundMessageSize(connection); size > 0 {
		config.MaxCallSendMsgSize = size
		config.MaxCallRecvMsgSize = size
	}
	if strings.TrimSpace(connection.Username) != "" {
		config.Username = connection.Username
		config.Password = connection.Password
	}
	if connection.SSL {
		tlsConfig, err := tlsConfigFor(connection)
		if err != nil {
			return nil, err
		}
		config.TLS = tlsConfig
	}
	return clientv3.New(config)
}

func connectTimeoutSeconds(connection connectionParams) int {
	seconds := connection.ConnectTimeoutSecs
	if seconds == 0 {
		seconds = rpcTimeoutSeconds
	}
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 300 {
		seconds = 300
	}
	return seconds
}

func grpcMaxInboundMessageSize(connection connectionParams) int {
	configured := connection.GrpcMaxInboundMessageSize
	if configured == 0 {
		configured = intURLParamOrDefault(connection.URLParams, grpcMaxInboundMessageSizeKey, defaultGrpcMaxInboundMessageSize)
	}
	if configured < minGrpcMaxInboundMessageSize {
		configured = minGrpcMaxInboundMessageSize
	}
	if configured > maxGrpcMaxInboundMessageSize {
		configured = maxGrpcMaxInboundMessageSize
	}
	return configured
}

func intURLParamOrDefault(params, key string, fallback int) int {
	if strings.TrimSpace(params) == "" {
		return fallback
	}
	for _, entry := range strings.Split(strings.TrimPrefix(params, "?"), "&") {
		separator := strings.Index(entry, "=")
		entryKey := entry
		if separator >= 0 {
			entryKey = entry[:separator]
		}
		if entryKey != key {
			continue
		}
		if separator < 0 {
			return fallback
		}
		value, err := strconv.Atoi(entry[separator+1:])
		if err != nil {
			return fallback
		}
		return value
	}
	return fallback
}

func tlsConfigFor(connection connectionParams) (*tls.Config, error) {
	tlsConfig := &tls.Config{}
	if ca := strings.TrimSpace(connection.CACertPath); ca != "" {
		authorityPEM, err := os.ReadFile(ca)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(authorityPEM) {
			return nil, fmt.Errorf("failed to parse CA certificate at %s", ca)
		}
		tlsConfig.RootCAs = pool
	}
	certPath := firstNonBlank(connection.ClientCertPath, connection.CertPath)
	keyPath := firstNonBlank(connection.ClientKeyPath, connection.KeyPath)
	if (certPath == "") != (keyPath == "") {
		return nil, errors.New("Client certificate and key must be provided together")
	}
	if certPath != "" {
		pair, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, err
		}
		tlsConfig.Certificates = []tls.Certificate{pair}
	}
	return tlsConfig, nil
}

func probeClient(client *clientv3.Client, endpoints []string) (map[string]any, error) {
	var lastFailure error
	for _, endpoint := range endpoints {
		ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
		_, err := client.Maintenance.Status(ctx, endpoint)
		cancel()
		if err == nil {
			return map[string]any{"ok": true, "endpoint": endpoint}, nil
		}
		// A restricted etcd user may not be allowed to call Maintenance.Status.
		// PERMISSION_DENIED still proves that the channel reached an etcd server.
		if status.Code(err) == codes.PermissionDenied {
			return map[string]any{"ok": true, "endpoint": endpoint, "limited": true}, nil
		}
		lastFailure = err
	}
	if lastFailure != nil {
		return nil, lastFailure
	}
	return nil, errors.New("No etcd endpoint configured")
}

func connectionEndpoints(connection connectionParams) []string {
	configured := firstNonBlank(connection.EtcdEndpoints, connection.Endpoints, connection.ConnectionString)
	var result []string
	if configured != "" {
		for _, endpoint := range strings.FieldsFunc(configured, func(r rune) bool { return r == ',' || r == '\n' }) {
			normalized := normalizeEndpoint(strings.TrimSpace(endpoint), connection.SSL)
			if normalized != "" {
				result = append(result, normalized)
			}
		}
	}
	if len(result) == 0 {
		host := connection.Host
		if host == "" {
			host = "127.0.0.1"
		}
		port := connection.Port
		if port == 0 {
			port = defaultPort
		}
		result = append(result, normalizeEndpoint(fmt.Sprintf("%s:%d", host, port), connection.SSL))
	}
	return result
}

func normalizeEndpoint(endpoint string, tlsEnabled bool) string {
	if strings.TrimSpace(endpoint) == "" {
		return ""
	}
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		return endpoint
	}
	if strings.HasPrefix(endpoint, "unix://") || strings.HasPrefix(endpoint, "unixs://") {
		return endpoint
	}
	scheme := "http"
	if tlsEnabled {
		scheme = "https"
	}
	return scheme + "://" + endpoint
}

func endpointHost(rawEndpoint string) string {
	parsed, err := url.Parse(rawEndpoint)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
