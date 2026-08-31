package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-zookeeper/zk"
)

const (
	defaultSessionTimeout      = 30 * time.Second
	defaultConnectionTimeout   = 15 * time.Second
	defaultProbeTimeout        = 2 * time.Second
	defaultBaseSleepTime       = 250 * time.Millisecond
	defaultMaxRetries          = 2
	defaultMaxBufferSize       = 32 * 1024 * 1024
	maximumMaxBufferSize       = 256 * 1024 * 1024
	defaultPort                = 2181
	defaultAuthScheme          = "digest"
	saslDigestAuthScheme       = "sasl_digest"
	maxBufferSizeParam         = "max_buffer_size"
	statLookupConcurrencyEnv   = "DBX_ZOOKEEPER_STAT_LOOKUP_CONCURRENCY"
	defaultStatLookupWorkers   = 16
	minimumStatLookupWorkers   = 1
	maximumStatLookupWorkers   = 64
	maximumReachabilityWorkers = 8
)

type connectionConfig struct {
	ZooKeeperConnectString string `json:"zookeeper_connect_string"`
	ConnectString          string `json:"connect_string"`
	ConnectionString       string `json:"connection_string"`
	Host                   string `json:"host"`
	Port                   int    `json:"port"`
	Namespace              string `json:"namespace"`
	Username               string `json:"username"`
	Password               string `json:"password"`
	AuthScheme             string `json:"auth_scheme"`
	URLParams              string `json:"url_params"`
	SessionTimeoutMS       int    `json:"session_timeout_ms"`
	ConnectionTimeoutMS    int    `json:"connection_timeout_ms"`
	BaseSleepTimeMS        *int   `json:"base_sleep_time_ms"`
	MaxRetries             *int   `json:"max_retries"`
	MaxBufferSize          *int   `json:"max_buffer_size"`
	SSL                    bool   `json:"ssl"`
	CACertPath             string `json:"ca_cert_path"`
	ClientCertPath         string `json:"client_cert_path"`
	ClientKeyPath          string `json:"client_key_path"`
	CertPath               string `json:"cert_path"`
	KeyPath                string `json:"key_path"`
}

type connectionParams struct {
	Connection json.RawMessage `json:"connection"`
}

type connectTarget struct {
	Servers []string
	Chroot  string
}

type clientSession struct {
	connection *zk.Conn
	prefix     string
	retryBase  time.Duration
	maxRetries int
}

type znodeClient interface {
	Close()
	Exists(path string) (bool, *zk.Stat, error)
	Get(path string) ([]byte, *zk.Stat, error)
	Children(path string) ([]string, *zk.Stat, error)
	Create(path string, data []byte, flags int32) (string, error)
	Set(path string, data []byte) (*zk.Stat, error)
	Delete(path string) error
}

func decodeConnectionConfig(params json.RawMessage) (connectionConfig, error) {
	var wrapper connectionParams
	if err := json.Unmarshal(params, &wrapper); err != nil {
		return connectionConfig{}, err
	}
	payload := params
	if len(wrapper.Connection) > 0 && string(wrapper.Connection) != "null" {
		payload = wrapper.Connection
	}
	var config connectionConfig
	if err := json.Unmarshal(payload, &config); err != nil {
		return connectionConfig{}, err
	}
	return config, nil
}

func (service *server) connect(params json.RawMessage) (map[string]bool, error) {
	config, err := decodeConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	nextClient, err := openClient(config)
	if err != nil {
		return nil, err
	}
	previousClient := service.activeClient
	service.activeClient = nextClient
	service.activeConfig = config
	if previousClient != nil {
		previousClient.Close()
	}
	return map[string]bool{"ok": true}, nil
}

func (service *server) testConnection(params json.RawMessage) (map[string]any, error) {
	config, err := decodeConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	probe, err := openClient(config)
	if err != nil {
		return nil, err
	}
	probe.Close()
	result := map[string]any{"ok": true}
	if info := databaseInfo(config); info != nil {
		result["databaseInfo"] = info
	}
	return result, nil
}

func (service *server) connectionInfo() (map[string]any, error) {
	if _, err := service.requireClient(); err != nil {
		return nil, err
	}
	result := map[string]any{}
	if info := databaseInfo(service.activeConfig); info != nil {
		result["databaseInfo"] = info
	}
	return result, nil
}

func openClient(config connectionConfig) (*clientSession, error) {
	if hasTLSOptions(config) {
		return nil, errors.New("ZooKeeper TLS is not supported")
	}
	authScheme := resolveAuthScheme(config)
	if authScheme != defaultAuthScheme && authScheme != saslDigestAuthScheme {
		return nil, fmt.Errorf("Unsupported auth_scheme %q; expected %q or %q", authScheme, defaultAuthScheme, saslDigestAuthScheme)
	}
	if authScheme == saslDigestAuthScheme {
		if strings.TrimSpace(config.Username) == "" {
			return nil, errors.New(`username is required when auth_scheme = "sasl_digest"`)
		}
		if config.Password == "" {
			return nil, errors.New(`password is required when auth_scheme = "sasl_digest"`)
		}
	}
	if config.BaseSleepTimeMS != nil && *config.BaseSleepTimeMS < 0 {
		return nil, errors.New("base_sleep_time_ms must be non-negative")
	}
	if config.MaxRetries != nil && *config.MaxRetries < 0 {
		return nil, errors.New("max_retries must be non-negative")
	}
	maxBufferSize, err := resolveMaxBufferSize(config)
	if err != nil {
		return nil, err
	}

	target, err := parseConnectTarget(connectionString(config))
	if err != nil {
		return nil, err
	}
	connectionTimeout := millisecondsOrDefault(config.ConnectionTimeoutMS, defaultConnectionTimeout)
	probeTimeout := minDuration(defaultProbeTimeout, connectionTimeout)
	if err := requireReachableServer(target.Servers, probeTimeout); err != nil {
		return nil, err
	}

	dialer := newZooKeeperDialer(connectionTimeout, nil)
	if authScheme == saslDigestAuthScheme {
		dialer = newZooKeeperDialer(connectionTimeout, &saslDigestCredentials{
			Username: strings.TrimSpace(config.Username),
			Password: config.Password,
		})
	}

	sessionTimeout := millisecondsOrDefault(config.SessionTimeoutMS, defaultSessionTimeout)
	connection, events, err := zk.Connect(
		target.Servers,
		sessionTimeout,
		zk.WithDialer(dialer),
		zk.WithLogInfo(false),
		zk.WithMaxBufferSize(maxBufferSize),
	)
	if err != nil {
		return nil, err
	}
	connected := false
	timer := time.NewTimer(connectionTimeout)
	defer timer.Stop()
	for !connected {
		select {
		case event, open := <-events:
			if !open {
				connection.Close()
				return nil, errors.New("Connection timed out")
			}
			if event.State == zk.StateHasSession {
				connected = true
			}
			if event.State == zk.StateAuthFailed {
				connection.Close()
				return nil, errors.New("ZooKeeper authentication failed")
			}
		case <-timer.C:
			connection.Close()
			return nil, errors.New("Connection timed out")
		}
	}

	if authScheme == defaultAuthScheme && strings.TrimSpace(config.Username) != "" {
		credentials := []byte(strings.TrimSpace(config.Username) + ":" + config.Password)
		if err := connection.AddAuth(defaultAuthScheme, credentials); err != nil {
			connection.Close()
			return nil, err
		}
	}

	prefix := joinPrefix(target.Chroot, config.Namespace)
	retryBase := defaultBaseSleepTime
	if config.BaseSleepTimeMS != nil {
		retryBase = time.Duration(*config.BaseSleepTimeMS) * time.Millisecond
	}
	maxRetries := defaultMaxRetries
	if config.MaxRetries != nil {
		maxRetries = *config.MaxRetries
	}
	session := &clientSession{connection: connection, prefix: prefix, retryBase: retryBase, maxRetries: maxRetries}
	exists, _, err := session.Exists("/")
	if err != nil || !exists {
		connection.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("Root znode is not readable")
	}
	return session, nil
}

func newZooKeeperDialer(connectionTimeout time.Duration, credentials *saslDigestCredentials) zk.Dialer {
	return func(network, address string, libraryTimeout time.Duration) (net.Conn, error) {
		timeout := libraryTimeout
		if timeout <= 0 || connectionTimeout < timeout {
			timeout = connectionTimeout
		}
		connection, err := net.DialTimeout(network, address, timeout)
		if err != nil {
			return nil, err
		}
		if credentials == nil {
			return connection, nil
		}
		return newSASLHandshakeConn(connection, timeout, *credentials), nil
	}
}

func connectionString(config connectionConfig) string {
	for _, candidate := range []string{config.ZooKeeperConnectString, config.ConnectString, config.ConnectionString} {
		if strings.TrimSpace(candidate) != "" {
			return strings.TrimSpace(candidate)
		}
	}
	host := strings.TrimSpace(config.Host)
	if host == "" {
		host = "127.0.0.1"
	}
	port := config.Port
	if port <= 0 {
		port = defaultPort
	}
	return net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
}

func databaseInfo(config connectionConfig) map[string]any {
	info := map[string]any{"productName": "ZooKeeper"}
	target, err := parseConnectTarget(connectionString(config))
	if err != nil {
		return info
	}
	if version := detectServerVersion(target.Servers, millisecondsOrDefault(config.ConnectionTimeoutMS, defaultConnectionTimeout)); version != "" {
		info["productVersion"] = version
	}
	return info
}

func detectServerVersion(servers []string, timeout time.Duration) string {
	deadline := timeout
	if deadline <= 0 || deadline > 2*time.Second {
		deadline = 2 * time.Second
	}
	for _, server := range servers {
		address, err := endpointAddress(server)
		if err != nil {
			continue
		}
		// ZooKeeper 3.5+ whitelists only "srvr" by default; "envi"/"stat"
		// are opt-in, so probe srvr first for default-config clusters.
		for _, command := range []string{"srvr", "envi", "stat"} {
			connection, err := net.DialTimeout("tcp", address, deadline)
			if err != nil {
				continue
			}
			_ = connection.SetDeadline(time.Now().Add(deadline))
			if _, err := connection.Write([]byte(command)); err != nil {
				connection.Close()
				continue
			}
			buffer := make([]byte, 16*1024)
			count, _ := connection.Read(buffer)
			if version := parseServerVersion(string(buffer[:count])); version != "" {
				connection.Close()
				return version
			}
			connection.Close()
		}
	}
	return ""
}

func parseServerVersion(response string) string {
	for _, line := range strings.Split(response, "\n") {
		line = strings.TrimSpace(line)
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			parts = strings.SplitN(line, ":", 2)
		}
		key := strings.ToLower(strings.TrimSpace(parts[0]))
		key = strings.NewReplacer(" ", ".", "_", ".").Replace(key)
		if len(parts) == 2 && key == "zookeeper.version" {
			version := strings.TrimSpace(parts[1])
			// Drop the ", built on ..." suffix envi/stat/srvr carry so only
			// the version itself is shown.
			if idx := strings.Index(version, ","); idx >= 0 {
				version = strings.TrimSpace(version[:idx])
			}
			return version
		}
	}
	return ""
}

func parseConnectTarget(value string) (connectTarget, error) {
	connectString := strings.TrimSpace(strings.TrimPrefix(value, "zookeeper://"))
	slash := strings.Index(connectString, "/")
	hostsPart := connectString
	chroot := ""
	if slash >= 0 {
		hostsPart = connectString[:slash]
		chroot = normalizePrefix(connectString[slash:])
	}
	servers := make([]string, 0)
	for _, item := range strings.Split(hostsPart, ",") {
		server := strings.TrimSpace(item)
		if server != "" {
			servers = append(servers, server)
		}
	}
	if len(servers) == 0 {
		return connectTarget{}, errors.New("ZooKeeper connect string contains no servers")
	}
	return connectTarget{Servers: servers, Chroot: chroot}, nil
}

func requireReachableServer(servers []string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout+500*time.Millisecond)
	defer cancel()
	workers := minInt(len(servers), maximumReachabilityWorkers)
	jobs := make(chan string)
	reachable := make(chan struct{}, 1)
	var waitGroup sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for server := range jobs {
				address, err := endpointAddress(server)
				if err != nil {
					continue
				}
				connection, err := net.DialTimeout("tcp", address, timeout)
				if err == nil {
					connection.Close()
					select {
					case reachable <- struct{}{}:
					default:
					}
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, server := range servers {
			select {
			case jobs <- server:
			case <-ctx.Done():
				return
			}
		}
	}()
	done := make(chan struct{})
	go func() {
		waitGroup.Wait()
		close(done)
	}()
	select {
	case <-reachable:
		return nil
	case <-done:
	case <-ctx.Done():
	}
	return fmt.Errorf("No reachable ZooKeeper server within %dms: %s", timeout.Milliseconds(), strings.Join(servers, ","))
}

func endpointAddress(endpoint string) (string, error) {
	value := strings.TrimSpace(endpoint)
	if strings.HasPrefix(value, "[") {
		if _, _, err := net.SplitHostPort(value); err == nil {
			return value, nil
		}
		return value + ":" + strconv.Itoa(defaultPort), nil
	}
	if strings.Count(value, ":") == 0 {
		return net.JoinHostPort(value, strconv.Itoa(defaultPort)), nil
	}
	if strings.Count(value, ":") == 1 {
		if _, _, err := net.SplitHostPort(value); err != nil {
			return "", err
		}
		return value, nil
	}
	return net.JoinHostPort(value, strconv.Itoa(defaultPort)), nil
}

func resolveAuthScheme(config connectionConfig) string {
	if strings.TrimSpace(config.AuthScheme) != "" {
		return strings.ToLower(strings.TrimSpace(config.AuthScheme))
	}
	if configured := strings.TrimSpace(connectionURLParams(config).Get("auth_scheme")); configured != "" {
		return strings.ToLower(configured)
	}
	return defaultAuthScheme
}

func resolveMaxBufferSize(config connectionConfig) (int, error) {
	configured := config.MaxBufferSize
	if configured == nil {
		value := strings.TrimSpace(connectionURLParams(config).Get(maxBufferSizeParam))
		if value == "" {
			return defaultMaxBufferSize, nil
		}
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return 0, fmt.Errorf("%s must be an integer number of bytes", maxBufferSizeParam)
		}
		configured = &parsed
	}
	if *configured <= 0 || *configured > maximumMaxBufferSize {
		return 0, fmt.Errorf("%s must be between 1 and %d bytes", maxBufferSizeParam, maximumMaxBufferSize)
	}
	return *configured, nil
}

func connectionURLParams(config connectionConfig) url.Values {
	params := strings.TrimPrefix(strings.TrimSpace(config.URLParams), "?")
	params = strings.ReplaceAll(params, ";", "&")
	parsed, _ := url.ParseQuery(params)
	return parsed
}

func hasTLSOptions(config connectionConfig) bool {
	return config.SSL || firstNonBlank(
		config.CACertPath,
		config.ClientCertPath,
		config.ClientKeyPath,
		config.CertPath,
		config.KeyPath,
	) != ""
}

func joinPrefix(chroot, namespace string) string {
	parts := make([]string, 0, 2)
	if normalized := normalizePrefix(chroot); normalized != "" {
		parts = append(parts, strings.Trim(normalized, "/"))
	}
	if normalized := normalizePrefix(namespace); normalized != "" {
		parts = append(parts, strings.Trim(normalized, "/"))
	}
	if len(parts) == 0 {
		return ""
	}
	return "/" + strings.Join(parts, "/")
}

func normalizePrefix(value string) string {
	trimmed := strings.Trim(strings.TrimSpace(value), "/")
	if trimmed == "" {
		return ""
	}
	return "/" + trimmed
}

func millisecondsOrDefault(value int, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return time.Duration(value) * time.Millisecond
}

func configuredStatLookupConcurrency(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return defaultStatLookupWorkers
	}
	return maxInt(minimumStatLookupWorkers, minInt(maximumStatLookupWorkers, parsed))
}

func (service *server) requireClient() (znodeClient, error) {
	if service.activeClient == nil {
		return nil, errors.New("Not connected")
	}
	return service.activeClient, nil
}

func (service *server) closeClient() {
	if service.activeClient != nil {
		service.activeClient.Close()
		service.activeClient = nil
	}
	service.activeConfig = connectionConfig{}
}

func (session *clientSession) Close() {
	if session != nil && session.connection != nil {
		session.connection.Close()
	}
}

func (session *clientSession) physicalPath(logicalPath string) string {
	logical := normalizePath(logicalPath)
	if session.prefix == "" {
		return logical
	}
	if logical == "/" {
		return session.prefix
	}
	return session.prefix + logical
}

func (session *clientSession) logicalPath(physicalPath string) string {
	if session.prefix == "" {
		return normalizePath(physicalPath)
	}
	trimmed := strings.TrimPrefix(physicalPath, session.prefix)
	return normalizePath(trimmed)
}

func (session *clientSession) Exists(path string) (bool, *zk.Stat, error) {
	type result struct {
		exists bool
		stat   *zk.Stat
	}
	value, err := retryZooKeeper(session, func() (result, error) {
		exists, stat, err := session.connection.Exists(session.physicalPath(path))
		return result{exists: exists, stat: stat}, err
	})
	return value.exists, value.stat, err
}

func (session *clientSession) Get(path string) ([]byte, *zk.Stat, error) {
	type result struct {
		data []byte
		stat *zk.Stat
	}
	value, err := retryZooKeeper(session, func() (result, error) {
		data, stat, err := session.connection.Get(session.physicalPath(path))
		return result{data: data, stat: stat}, err
	})
	return value.data, value.stat, err
}

func (session *clientSession) Children(path string) ([]string, *zk.Stat, error) {
	type result struct {
		children []string
		stat     *zk.Stat
	}
	value, err := retryZooKeeper(session, func() (result, error) {
		children, stat, err := session.connection.Children(session.physicalPath(path))
		return result{children: children, stat: stat}, err
	})
	return value.children, value.stat, err
}

func (session *clientSession) Create(path string, data []byte, flags int32) (string, error) {
	createdPath, err := retryZooKeeper(session, func() (string, error) {
		return session.connection.Create(session.physicalPath(path), data, flags, zk.WorldACL(zk.PermAll))
	})
	if err != nil {
		return "", err
	}
	return session.logicalPath(createdPath), nil
}

func (session *clientSession) Set(path string, data []byte) (*zk.Stat, error) {
	return retryZooKeeper(session, func() (*zk.Stat, error) {
		return session.connection.Set(session.physicalPath(path), data, -1)
	})
}

func (session *clientSession) Delete(path string) error {
	_, err := retryZooKeeper(session, func() (struct{}, error) {
		return struct{}{}, session.connection.Delete(session.physicalPath(path), -1)
	})
	return err
}

func retryZooKeeper[T any](session *clientSession, operation func() (T, error)) (T, error) {
	for attempt := 0; ; attempt++ {
		value, err := operation()
		if err == nil || attempt >= session.maxRetries || !isRetryableZooKeeperError(err) {
			return value, err
		}
		delay := session.retryBase * time.Duration(1<<minInt(attempt, 8))
		if delay > 0 {
			time.Sleep(delay)
		}
	}
}

func isRetryableZooKeeperError(err error) bool {
	return errors.Is(err, zk.ErrConnectionClosed) || errors.Is(err, zk.ErrClosing) || errors.Is(err, zk.ErrSessionMoved)
}

func minDuration(first, second time.Duration) time.Duration {
	if first < second {
		return first
	}
	return second
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func minInt(first, second int) int {
	if first < second {
		return first
	}
	return second
}

func maxInt(first, second int) int {
	if first > second {
		return first
	}
	return second
}
