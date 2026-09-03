package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	defaultPort      = 2379
	operationTimeout = 30 * time.Second
)

// connectionParams mirrors the host-side etcd connection configuration.
// gRPC-specific options are accepted and ignored: the v2 API is plain HTTP.
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

// authenticatedClient issues v2 API requests against one etcd endpoint with
// optional basic auth and TLS.
type authenticatedClient struct {
	endpoint      string
	http          *http.Client
	username      string
	password      string
	serverVersion string
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

func (s *etcd2Session) connect(params map[string]json.RawMessage) (any, error) {
	connection, err := connectionObject(params)
	if err != nil {
		return nil, err
	}
	endpointList := connectionEndpoints(connection)
	var lastErr error
	for _, endpoint := range endpointList {
		client, _, err := probeClient(endpoint, connection)
		if err != nil {
			lastErr = err
			continue
		}
		s.close()
		s.clientMu.Lock()
		s.httpClient = client
		s.connectedEndpoints = endpointList
		s.serverVersion = client.serverVersion
		s.clientMu.Unlock()
		return map[string]bool{"ok": true}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("No etcd endpoint configured")
	}
	return nil, lastErr
}

func (s *etcd2Session) activeClient() (*authenticatedClient, error) {
	s.clientMu.Lock()
	client := s.httpClient
	s.clientMu.Unlock()
	if client == nil {
		return nil, errors.New("Not connected")
	}
	return client, nil
}

func (s *etcd2Session) connectedEndpointList() []string {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()
	return append([]string(nil), s.connectedEndpoints...)
}

func (s *etcd2Session) validateConnection() (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	probe, err := client.probeV2(ctx)
	if err != nil {
		return nil, err
	}
	return probe, nil
}

func (s *etcd2Session) close() error {
	s.watchesMu.Lock()
	watches := s.watches
	s.watches = map[string]*watchState{}
	s.watchBufferedBytes = 0
	s.watchesMu.Unlock()
	for _, watch := range watches {
		watch.close()
	}
	s.clientMu.Lock()
	s.httpClient = nil
	s.connectedEndpoints = nil
	s.serverVersion = ""
	s.clientMu.Unlock()
	return nil
}

func buildHTTPClient(connection connectionParams) (*http.Client, error) {
	transport := &http.Transport{
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
	}
	if connection.SSL {
		tlsConfig, err := tlsConfigFor(connection)
		if err != nil {
			return nil, err
		}
		transport.TLSClientConfig = tlsConfig
	}
	return &http.Client{
		Transport: transport,
		// The request context governs per-call timeouts; the client-level
		// timeout stays high so long-poll watches are not cut short.
		Timeout: 10 * time.Minute,
	}, nil
}

func connectTimeoutSeconds(connection connectionParams) time.Duration {
	seconds := connection.ConnectTimeoutSecs
	if seconds == 0 {
		seconds = 30
	}
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 300 {
		seconds = 300
	}
	return time.Duration(seconds) * time.Second
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

// probeClient verifies the endpoint speaks the v2 API. It returns the
// connected client and a probe result shaped like the v3 agent's:
// {ok, endpoint, limited?}.
func probeClient(endpoint string, connection connectionParams) (*authenticatedClient, map[string]any, error) {
	httpClient, err := buildHTTPClient(connection)
	if err != nil {
		return nil, nil, err
	}
	client := &authenticatedClient{
		endpoint: strings.TrimSuffix(endpoint, "/"),
		http:     httpClient,
		username: connection.Username,
		password: connection.Password,
	}
	dialCtx, dialCancel := context.WithTimeout(context.Background(), connectTimeoutSeconds(connection))
	defer dialCancel()
	version, err := client.fetchVersion(dialCtx)
	if err != nil {
		return nil, nil, err
	}
	client.serverVersion = version.etcdserver
	probe, err := client.probeV2(dialCtx)
	if err != nil {
		return nil, nil, err
	}
	return client, probe, nil
}

type etcdVersion struct {
	etcdserver  string
	etcdcluster string
}

func (c *authenticatedClient) fetchVersion(ctx context.Context) (etcdVersion, error) {
	body, _, err := c.do(ctx, http.MethodGet, "/version", "", nil)
	if err != nil {
		return etcdVersion{}, err
	}
	var parsed struct {
		Etcdserver  string `json:"etcdserver"`
		Etcdcluster string `json:"etcdcluster"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return etcdVersion{}, fmt.Errorf("unrecognized etcd /version response from %s: %w", c.endpoint, err)
	}
	return etcdVersion{etcdserver: parsed.Etcdserver, etcdcluster: parsed.Etcdcluster}, nil
}

// probeV2 checks that the v2 keys API is actually served. A 403 proves the
// channel and credentials reached etcd, mirroring the v3 agent's
// PERMISSION_DENIED handling for restricted users.
func (c *authenticatedClient) probeV2(ctx context.Context) (map[string]any, error) {
	response, err := c.request(ctx, http.MethodGet, "/v2/members", "", nil)
	if err != nil {
		return nil, err
	}
	defer drainClose(response.Body)
	switch response.StatusCode {
	case http.StatusOK:
		return map[string]any{"ok": true, "endpoint": c.endpoint}, nil
	case http.StatusForbidden:
		return map[string]any{"ok": true, "endpoint": c.endpoint, "limited": true}, nil
	case http.StatusNotFound:
		return nil, fmt.Errorf("ETCD_V2_API_DISABLED: %s does not expose the etcd v2 API (removed in etcd 3.6+)", c.endpoint)
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("ETCD_UNAUTHENTICATED: authentication failed against %s", c.endpoint)
	default:
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("etcd v2 probe against %s failed: HTTP %d %s", c.endpoint, response.StatusCode, strings.TrimSpace(string(body)))
	}
}

// do performs a v2 API request and returns the body. Non-2xx responses are
// converted into etcdError values carrying the server's errorCode/message.
func (c *authenticatedClient) do(ctx context.Context, method, path, body string, header map[string]string) ([]byte, *http.Response, error) {
	response, err := c.request(ctx, method, path, body, header)
	if err != nil {
		return nil, response, err
	}
	payload, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response, errorFromResponse(response.StatusCode, payload)
	}
	if readErr != nil {
		return nil, response, readErr
	}
	return payload, response, nil
}

func (c *authenticatedClient) request(ctx context.Context, method, path, body string, header map[string]string) (*http.Response, error) {
	return c.requestAt(ctx, method, c.endpoint, path, body, header)
}

// requestAt targets a specific endpoint, used for per-member status fan-out.
func (c *authenticatedClient) requestAt(ctx context.Context, method, endpoint, path, body string, header map[string]string) (*http.Response, error) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(endpoint, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	if c.username != "" {
		req.SetBasicAuth(c.username, c.password)
	}
	for key, value := range header {
		req.Header.Set(key, value)
	}
	if body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	response, err := c.http.Do(req)
	if err != nil {
		// gRPC-style sentinel so the host-side transient-error handling keeps working.
		return nil, fmt.Errorf("etcd connection error: %w", err)
	}
	return response, nil
}

// doAt performs a v2 API request against a specific endpoint.
func (c *authenticatedClient) doAt(ctx context.Context, method, endpoint, path, body string) ([]byte, *http.Response, error) {
	response, err := c.requestAt(ctx, method, endpoint, path, body, nil)
	if err != nil {
		return nil, nil, err
	}
	payload, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response, errorFromResponse(response.StatusCode, payload)
	}
	if readErr != nil {
		return nil, response, readErr
	}
	return payload, response, nil
}

// etcdError carries the v2 API error payload (errorCode + message + index).
type etcdError struct {
	statusCode int
	errorCode  int64
	message    string
	cause      string
	index      int64
}

func (e *etcdError) Error() string {
	if e.message == "" {
		return fmt.Sprintf("etcd v2 error (HTTP %d)", e.statusCode)
	}
	if e.cause != "" {
		return fmt.Sprintf("%s (%s)", e.message, e.cause)
	}
	return e.message
}

func errorFromResponse(statusCode int, body []byte) *etcdError {
	parsed := &etcdError{statusCode: statusCode}
	if len(body) > 0 {
		var payload struct {
			ErrorCode int64  `json:"errorCode"`
			Message   string `json:"message"`
			Cause     string `json:"cause"`
			Index     int64  `json:"index"`
		}
		if json.Unmarshal(body, &payload) == nil && payload.Message != "" {
			parsed.errorCode = payload.ErrorCode
			parsed.message = payload.Message
			parsed.cause = payload.Cause
			parsed.index = payload.Index
			return parsed
		}
	}
	parsed.message = strings.TrimSpace(string(body))
	return parsed
}

func isEtcdErrorCode(err error, code int64) bool {
	var etcdErr *etcdError
	if errors.As(err, &etcdErr) {
		return etcdErr.errorCode == code
	}
	return false
}

func isNotFound(err error) bool {
	return isEtcdErrorCode(err, 100)
}

func isCompareFailed(err error) bool {
	return isEtcdErrorCode(err, 101)
}

func drainClose(body io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 4096))
	_ = body.Close()
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
		return strings.TrimSuffix(endpoint, "/")
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
