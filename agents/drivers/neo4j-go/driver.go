package main

import (
	"context"
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

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
	neo4jauth "github.com/neo4j/neo4j-go-driver/v6/neo4j/auth"
	"github.com/neo4j/neo4j-go-driver/v6/neo4j/config"
	neo4jdb "github.com/neo4j/neo4j-go-driver/v6/neo4j/db"
)

const (
	defaultNeo4jPort       = 7687
	defaultDatabase        = "neo4j"
	defaultConnectTimeout  = 15 * time.Second
	optimizedReadBuffer    = 1024 * 1024
	defaultConnectionLimit = 64
)

func newConnectionRuntime(params connectParams) (*connectionRuntime, error) {
	runtime, err := openVerifiedRuntime(params)
	if err == nil {
		return runtime, nil
	}
	direct, changed := directConnectionParams(params)
	if !changed || !isRoutingUnsupported(err) {
		return nil, err
	}
	// Single-instance servers older than Neo4j 4 (which negotiate Bolt 3) do not
	// expose the cluster routing procedure, so `neo4j://` cannot be used against
	// them. Retry the same target with a direct `bolt://` connection instead of
	// failing the connection outright.
	runtime, directErr := openVerifiedRuntime(direct)
	if directErr != nil {
		return nil, directErr
	}
	return runtime, nil
}

// openVerifiedRuntime opens a driver for params and fails unless the server
// answers a connectivity check.
func openVerifiedRuntime(params connectParams) (*connectionRuntime, error) {
	driver, err := openDriver(params)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultConnectTimeout)
	defer cancel()
	if err := driver.VerifyConnectivity(ctx); err != nil {
		_ = driver.Close(context.Background())
		return nil, err
	}
	runtime := &connectionRuntime{driver: driver, params: params}
	if info, err := driver.GetServerInfo(ctx); err == nil {
		// Older Bolt versions supply numeric IDs in the element-ID fields.
		runtime.legacySingleDatabase = info.ProtocolVersion().Major < 4
		runtime.legacyGraphIDs = info.ProtocolVersion().Major < 5
	}
	return runtime, nil
}

func openDriver(params connectParams) (neo4j.Driver, error) {
	uri, err := buildNeo4jURI(params)
	if err != nil {
		return nil, err
	}
	authToken := neo4j.NoAuth()
	if params.Username != "" || params.Password != "" {
		authToken = neo4j.BasicAuth(params.Username, params.Password, "")
	}
	configurers := []func(*config.Config){func(driverConfig *config.Config) {
		driverConfig.ReadBufferSize = optimizedReadBuffer
		driverConfig.MaxConnectionPoolSize = defaultConnectionLimit
		driverConfig.ConnectionAcquisitionTimeout = 30 * time.Second
		driverConfig.SocketConnectTimeout = defaultConnectTimeout
		driverConfig.MaxConnectionLifetime = time.Hour
		driverConfig.TelemetryDisabled = true
	}}
	tlsConfigurer, err := neo4jTLSConfigurer(params)
	if err != nil {
		return nil, err
	}
	if tlsConfigurer != nil {
		configurers = append(configurers, tlsConfigurer)
	}
	return neo4j.NewDriver(uri, authToken, configurers...)
}

func neo4jTLSConfigurer(params connectParams) (func(*config.Config), error) {
	var tlsConfig *tls.Config
	if params.CACertPath != "" {
		certificate, err := os.ReadFile(params.CACertPath)
		if err != nil {
			return nil, fmt.Errorf("read Neo4j CA certificate: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(certificate) {
			return nil, errors.New("Neo4j CA certificate contains no valid PEM certificate")
		}
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	}
	var clientCertificateProvider neo4jauth.ClientCertificateProvider
	if params.ClientCertPath != "" || params.ClientKeyPath != "" {
		if params.ClientCertPath == "" || params.ClientKeyPath == "" {
			return nil, errors.New("both client certificate and client key are required")
		}
		provider, err := neo4jauth.NewStaticClientCertificateProvider(neo4jauth.ClientCertificate{
			CertFile: params.ClientCertPath,
			KeyFile:  params.ClientKeyPath,
		})
		if err != nil {
			return nil, fmt.Errorf("load Neo4j client certificate: %w", err)
		}
		clientCertificateProvider = provider
	}
	if tlsConfig == nil && clientCertificateProvider == nil {
		return nil, nil
	}
	return func(driverConfig *config.Config) {
		if tlsConfig != nil {
			driverConfig.TlsConfig = tlsConfig
		}
		if clientCertificateProvider != nil {
			driverConfig.ClientCertificateProvider = clientCertificateProvider
		}
	}, nil
}

func buildNeo4jURI(params connectParams) (string, error) {
	if value := strings.TrimSpace(params.ConnectionString); value != "" {
		value = strings.TrimPrefix(value, "jdbc:")
		parsed, err := url.Parse(value)
		if err == nil && isNeo4jScheme(parsed.Scheme) && parsed.Host != "" {
			parsed.User = nil
			parsed.Path = ""
			parsed.RawPath = ""
			parsed.RawQuery = filterDriverURIQuery(parsed.Query()).Encode()
			return parsed.String(), nil
		}
	}
	host := strings.TrimSpace(params.Host)
	if host == "" {
		return "", errors.New("Neo4j host is required")
	}
	port := params.Port
	if port <= 0 {
		port = defaultNeo4jPort
	}
	return (&url.URL{Scheme: effectiveNeo4jScheme(params), Host: net.JoinHostPort(host, strconv.Itoa(port))}).String(), nil
}

// effectiveNeo4jScheme resolves the URI scheme a connection would use, in the
// same order as buildNeo4jURI: an explicit connection string wins, then an
// explicit `scheme` parameter, then TLS settings imply `neo4j+s`.
func effectiveNeo4jScheme(params connectParams) string {
	if value := strings.TrimSpace(params.ConnectionString); value != "" {
		parsed, err := url.Parse(strings.TrimPrefix(value, "jdbc:"))
		if err == nil && isNeo4jScheme(parsed.Scheme) && parsed.Host != "" {
			return strings.ToLower(parsed.Scheme)
		}
	}
	query := parseURLParams(params.URLParams)
	if configured := strings.ToLower(strings.TrimSpace(query.Get("scheme"))); isNeo4jScheme(configured) {
		return configured
	}
	if neo4jEncryptionRequested(params, query) {
		return "neo4j+s"
	}
	return "neo4j"
}

func neo4jEncryptionRequested(params connectParams, query url.Values) bool {
	return params.SSL || queryBool(query, "ssl") || queryBool(query, "encrypted") ||
		params.CACertPath != "" || params.ClientCertPath != ""
}

// directConnectionScheme maps a routing scheme to its direct counterpart. The
// second result is false for schemes that already connect directly.
func directConnectionScheme(scheme string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "neo4j":
		return "bolt", true
	case "neo4j+s":
		return "bolt+s", true
	case "neo4j+ssc":
		return "bolt+ssc", true
	default:
		return "", false
	}
}

// directConnectionParams rewrites routing-style settings (`neo4j://`) into the
// equivalent direct settings (`bolt://`), keeping TLS semantics. The second
// result is false when the connection is already direct or cannot be rewritten.
func directConnectionParams(params connectParams) (connectParams, bool) {
	direct, ok := directConnectionScheme(effectiveNeo4jScheme(params))
	if !ok {
		return params, false
	}
	if value := strings.TrimSpace(params.ConnectionString); value != "" {
		parsed, err := url.Parse(strings.TrimPrefix(value, "jdbc:"))
		if err != nil || !isNeo4jScheme(parsed.Scheme) || parsed.Host == "" {
			return params, false
		}
		parsed.Scheme = direct
		parsed.User = nil
		parsed.Path = ""
		parsed.RawPath = ""
		parsed.RawQuery = filterDriverURIQuery(parsed.Query()).Encode()
		params.ConnectionString = parsed.String()
		return params, true
	}
	if strings.TrimSpace(params.Host) == "" {
		return params, false
	}
	params.URLParams = withURLParam(params.URLParams, "scheme", direct)
	return params, true
}

// routingUnsupportedMessage is the wording the Neo4j driver uses when a Bolt 3
// server reports that cluster routing is unavailable.
const routingUnsupportedMessage = "does not support: routing"

// isRoutingUnsupported reports whether err is the driver's "routing requires a
// cluster" failure. The driver flattens its typed feature error into a usage
// error, so the message is inspected as well as the type.
func isRoutingUnsupported(err error) bool {
	if err == nil {
		return false
	}
	var featureErr *neo4jdb.FeatureNotSupportedError
	if errors.As(err, &featureErr) && strings.EqualFold(featureErr.Feature, "routing") {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), routingUnsupportedMessage)
}

func isNeo4jScheme(value string) bool {
	switch strings.ToLower(value) {
	case "neo4j", "neo4j+s", "neo4j+ssc", "bolt", "bolt+s", "bolt+ssc":
		return true
	default:
		return false
	}
}

func parseURLParams(value string) url.Values {
	values := url.Values{}
	for _, pair := range strings.FieldsFunc(value, func(char rune) bool { return char == '&' || char == ';' }) {
		key, rawValue, found := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if !found {
			rawValue = ""
		}
		values.Set(key, strings.TrimSpace(rawValue))
	}
	return values
}

func filterDriverURIQuery(values url.Values) url.Values {
	result := url.Values{}
	for key, items := range values {
		switch strings.ToLower(key) {
		case "database", "scheme", "ssl", "encrypted":
			continue
		default:
			for _, item := range items {
				result.Add(key, item)
			}
		}
	}
	return result
}

// withURLParam replaces one `key=value` entry in a URL parameter string while
// keeping the remaining entries untouched. Values are copied verbatim (unlike
// url.Values.Encode) so schemes such as `bolt+s` are not percent-encoded.
func withURLParam(urlParams, key, value string) string {
	parts := make([]string, 0, 4)
	for _, pair := range strings.FieldsFunc(urlParams, func(char rune) bool { return char == '&' || char == ';' }) {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		existingKey, _, _ := strings.Cut(pair, "=")
		if strings.EqualFold(strings.TrimSpace(existingKey), key) {
			continue
		}
		parts = append(parts, pair)
	}
	parts = append(parts, key+"="+value)
	return strings.Join(parts, "&")
}

func testConnection(params connectParams) error {
	runtime, err := newConnectionRuntime(params)
	if err != nil {
		return err
	}
	_ = runtime.close()
	return nil
}

func (s *server) validateConnection() error {
	if s.runtime == nil || s.runtime.driver == nil {
		return errors.New("not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.runtime.driver.VerifyConnectivity(ctx)
}

func (s *server) databaseName(override string) string {
	if s.runtime != nil && s.runtime.legacySingleDatabase {
		// Servers that negotiated Bolt 3 only expose the default database and
		// reject any explicit database name, even the configured one.
		return ""
	}
	if value := strings.TrimSpace(override); value != "" {
		return value
	}
	return configuredDatabase(s.params)
}

func configuredDatabase(params connectParams) string {
	if value := strings.TrimSpace(params.Database); value != "" {
		return value
	}
	value := strings.TrimPrefix(strings.TrimSpace(params.ConnectionString), "jdbc:")
	if parsed, err := url.Parse(value); err == nil {
		if database := strings.TrimSpace(parsed.Query().Get("database")); database != "" {
			return database
		}
		if database := strings.Trim(strings.TrimSpace(parsed.Path), "/"); database != "" {
			return database
		}
	}
	return defaultDatabase
}

func queryBool(values url.Values, key string) bool {
	switch strings.ToLower(strings.TrimSpace(values.Get(key))) {
	case "1", "true", "yes", "on", "require", "required":
		return true
	default:
		return false
	}
}

func (s *server) newSession(ctx context.Context, database string, accessMode neo4j.AccessMode, fetchSize int) neo4j.Session {
	if fetchSize == 0 {
		fetchSize = neo4j.FetchDefault
	}
	return s.runtime.driver.NewSession(ctx, neo4j.SessionConfig{
		DatabaseName: s.databaseName(database),
		AccessMode:   accessMode,
		FetchSize:    fetchSize,
	})
}

func (s *server) connectionInfo() (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverInfo, err := s.runtime.driver.GetServerInfo(ctx)
	if err != nil {
		return nil, err
	}
	version := serverInfo.Agent()
	return map[string]any{
		"database":          s.databaseName(""),
		"schema":            "",
		"username":          s.params.Username,
		"version":           version,
		"identifierQuote":   "`",
		"compatibilityMode": "cypher",
		"databaseInfo": map[string]string{
			"productName":            "Neo4j",
			"productVersion":         version,
			"unquotedIdentifierCase": "mixed",
			"quotedIdentifierCase":   "mixed",
			"driverName":             "Neo4j Go Driver",
			"driverVersion":          "6.2.0",
		},
	}, nil
}
