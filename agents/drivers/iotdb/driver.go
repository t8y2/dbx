package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/apache/iotdb-client-go/v2/client"
)

const iotdbGoClientVersion = "2.0.9-0.20260807074554-e59fc7f55df1"

type iotdbSession interface {
	ExecuteQueryStatement(context.Context, string, *int64) (*client.SessionDataSet, error)
	ExecuteNonQueryStatement(context.Context, string) error
	Close() error
}

type nativeIoTDBSession struct {
	session *client.Session
}

func (s *nativeIoTDBSession) ExecuteQueryStatement(ctx context.Context, sql string, _ *int64) (*client.SessionDataSet, error) {
	return executeIoTDBStatement(ctx, s.session, sql)
}

func (s *nativeIoTDBSession) ExecuteNonQueryStatement(ctx context.Context, sql string) error {
	dataset, err := executeIoTDBStatement(ctx, s.session, sql)
	if err != nil {
		return err
	}
	if dataset != nil {
		return dataset.Close()
	}
	return nil
}

func (s *nativeIoTDBSession) Close() error {
	return s.session.Close()
}

func executeIoTDBStatement(ctx context.Context, session *client.Session, sql string) (dataset *client.SessionDataSet, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				dataset = nil
				err = ctxErr
				return
			}
			dataset = nil
			err = fmt.Errorf("IoTDB Go client panicked while executing statement: %v", recovered)
		}
	}()
	return session.ExecuteStatementWithContext(ctx, sql)
}

type connectionConfig struct {
	Host                  string
	Port                  int
	NodeURLs              []string
	Username              string
	Password              string
	Database              string
	Dialect               string
	FetchSize             int32
	TimeZone              string
	ConnectRetryMax       int
	ConnectTimeoutMS      int
	EnableCompression     bool
	TLSConfig             *client.TLSConfig
	TLSInsecureSkipVerify bool
}

type sessionClient struct {
	session iotdbSession
	dialect string
}

func parseConnectionConfig(params connectParams) (connectionConfig, error) {
	config := connectionConfig{
		Host:             strings.TrimSpace(params.Host),
		Port:             params.Port,
		Username:         params.Username,
		Password:         params.Password,
		Database:         strings.TrimSpace(params.Database),
		Dialect:          client.TreeSqlDialect,
		FetchSize:        defaultFetchSize,
		TimeZone:         client.DefaultTimeZone,
		ConnectRetryMax:  client.DefaultConnectRetryMax,
		ConnectTimeoutMS: int(defaultConnectTimeout / time.Millisecond),
	}
	if config.Host == "" {
		config.Host = "127.0.0.1"
	}
	if config.Port <= 0 {
		config.Port = defaultIoTDBPort
	}
	if config.Username == "" {
		config.Username = "root"
	}
	if config.Password == "" {
		config.Password = "root"
	}

	query := url.Values{}
	if raw := strings.TrimSpace(params.ConnectionString); raw != "" {
		normalized := strings.TrimPrefix(raw, "jdbc:")
		parsed, err := url.Parse(normalized)
		if err != nil {
			return connectionConfig{}, fmt.Errorf("parse IoTDB connection string: %w", err)
		}
		if parsed.Scheme != "" && !strings.EqualFold(parsed.Scheme, "iotdb") {
			return connectionConfig{}, fmt.Errorf("unsupported IoTDB connection scheme: %s", parsed.Scheme)
		}
		if parsed.Hostname() != "" {
			config.Host = parsed.Hostname()
		}
		if parsed.Port() != "" {
			port, err := strconv.Atoi(parsed.Port())
			if err != nil || port <= 0 {
				return connectionConfig{}, fmt.Errorf("invalid IoTDB port: %s", parsed.Port())
			}
			config.Port = port
		}
		if parsed.User != nil {
			if username := parsed.User.Username(); username != "" {
				config.Username = username
			}
			if password, ok := parsed.User.Password(); ok {
				config.Password = password
			}
		}
		if database := strings.Trim(strings.TrimSpace(parsed.Path), "/"); database != "" {
			config.Database = database
		}
		query = parsed.Query()
	}
	if raw := strings.TrimSpace(params.URLParams); raw != "" {
		values, err := url.ParseQuery(strings.TrimPrefix(raw, "?"))
		if err != nil {
			return connectionConfig{}, fmt.Errorf("parse IoTDB URL parameters: %w", err)
		}
		for key, entries := range values {
			query[key] = entries
		}
	}

	if dialect := strings.ToLower(strings.TrimSpace(firstQueryValue(query, "sql_dialect", "dialect"))); dialect != "" {
		switch dialect {
		case client.TreeSqlDialect, client.TableSqlDialect:
			config.Dialect = dialect
		default:
			return connectionConfig{}, fmt.Errorf("unsupported IoTDB SQL dialect: %s", dialect)
		}
	}
	if database := strings.TrimSpace(firstQueryValue(query, "database", "db")); database != "" {
		config.Database = database
	}
	if value := firstQueryValue(query, "fetch_size", "fetchSize"); value != "" {
		parsed, err := positiveInt(value, "fetch_size")
		if err != nil {
			return connectionConfig{}, err
		}
		config.FetchSize = int32(parsed)
	}
	if value := firstQueryValue(query, "time_zone", "timezone", "zone_id"); value != "" {
		config.TimeZone = value
	}
	if value := firstQueryValue(query, "connect_retry_max", "connectRetryMax"); value != "" {
		parsed, err := positiveInt(value, "connect_retry_max")
		if err != nil {
			return connectionConfig{}, err
		}
		config.ConnectRetryMax = parsed
	}
	if value := firstQueryValue(query, "connect_timeout_ms", "connection_timeout_ms"); value != "" {
		parsed, err := positiveInt(value, "connect_timeout_ms")
		if err != nil {
			return connectionConfig{}, err
		}
		config.ConnectTimeoutMS = parsed
	}
	config.EnableCompression = queryBool(query, "enable_compression", "rpc_compression")
	config.NodeURLs = parseNodeURLs(firstQueryValue(query, "node_urls", "nodes"))
	if len(config.NodeURLs) == 0 {
		config.NodeURLs = []string{net.JoinHostPort(config.Host, strconv.Itoa(config.Port))}
	}

	tlsEnabled := params.SSL || queryBool(query, "ssl", "useSSL", "use_ssl", "tls")
	if tlsEnabled {
		config.TLSInsecureSkipVerify = queryBool(query, "insecure_skip_verify", "tls_insecure_skip_verify")
		config.TLSConfig = &client.TLSConfig{
			Config: &tls.Config{
				ServerName:         config.Host,
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: config.TLSInsecureSkipVerify,
			},
			CAFile:   strings.TrimSpace(params.CACertPath),
			CertFile: strings.TrimSpace(params.ClientCertPath),
			KeyFile:  strings.TrimSpace(params.ClientKeyPath),
		}
		if (config.TLSConfig.CertFile == "") != (config.TLSConfig.KeyFile == "") {
			return connectionConfig{}, errors.New("both client_cert_path and client_key_path are required for IoTDB mTLS")
		}
	}
	return config, nil
}

func newSessionClient(config connectionConfig) (*sessionClient, error) {
	var session client.Session
	var err error
	// DBX applies a table database with USE after switching dialects. Do not
	// include a tree database in openSession: IoTDB 2.x rejects it there, while
	// DBX still retains it for metadata and path qualification.
	if len(config.NodeURLs) > 1 {
		session, err = client.NewClusterSession(&client.ClusterConfig{
			NodeUrls:        config.NodeURLs,
			UserName:        config.Username,
			Password:        config.Password,
			FetchSize:       config.FetchSize,
			TimeZone:        config.TimeZone,
			ConnectRetryMax: config.ConnectRetryMax,
			TLSConfig:       config.TLSConfig,
		})
		if err == nil {
			err = session.OpenCluster(config.EnableCompression)
		}
	} else {
		session = client.NewSession(&client.Config{
			Host:            config.Host,
			Port:            strconv.Itoa(config.Port),
			UserName:        config.Username,
			Password:        config.Password,
			FetchSize:       config.FetchSize,
			TimeZone:        config.TimeZone,
			ConnectRetryMax: config.ConnectRetryMax,
			TLSConfig:       config.TLSConfig,
		})
		err = session.Open(config.EnableCompression, config.ConnectTimeoutMS)
	}
	if err != nil {
		return nil, err
	}
	wrapped := &nativeIoTDBSession{session: &session}
	connected := &sessionClient{session: wrapped, dialect: config.Dialect}
	if config.Dialect == client.TableSqlDialect {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(config.ConnectTimeoutMS)*time.Millisecond)
		defer cancel()
		if err := wrapped.ExecuteNonQueryStatement(ctx, "SET SQL_DIALECT=TABLE"); err != nil {
			_ = wrapped.Close()
			return nil, err
		}
		if strings.TrimSpace(config.Database) != "" {
			if err := wrapped.ExecuteNonQueryStatement(ctx, "USE "+quoteTableIdentifier(config.Database)); err != nil {
				_ = wrapped.Close()
				return nil, err
			}
		}
	}
	return connected, nil
}

func (s *sessionClient) Close() error {
	if s == nil || s.session == nil {
		return nil
	}
	return s.session.Close()
}

func (s *server) ensureClient() (*sessionClient, error) {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()
	if s.client != nil {
		return s.client, nil
	}
	connected, err := newSessionClient(s.config)
	if err != nil {
		return nil, err
	}
	s.client = connected
	return connected, nil
}

func (s *server) invalidateClient(target *sessionClient) {
	s.clientMu.Lock()
	if s.client == target {
		s.client = nil
	}
	s.clientMu.Unlock()
	_ = target.Close()
}

func firstQueryValue(values url.Values, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(values.Get(key)); value != "" {
			return value
		}
	}
	return ""
}

func queryBool(values url.Values, keys ...string) bool {
	value := strings.ToLower(firstQueryValue(values, keys...))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func positiveInt(value, name string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}

func parseNodeURLs(value string) []string {
	parts := strings.FieldsFunc(value, func(char rune) bool { return char == ',' || char == ';' })
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if normalized := strings.TrimSpace(part); normalized != "" {
			result = append(result, normalized)
		}
	}
	return result
}
