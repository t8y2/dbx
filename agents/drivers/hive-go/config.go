package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHivePort           = 10000
	defaultHiveDatabase       = "default"
	defaultHiveHTTPPath       = "cliservice"
	defaultHiveService        = "hive"
	defaultZooKeeperNamespace = "hiveserver2"
	defaultConnectTimeout     = 15 * time.Second
	defaultRetryInterval      = time.Second
	defaultBrowserSSOTimeout  = 120 * time.Second
	defaultCookieName         = "hive.server2.auth"
)

type connectParams struct {
	Host             string   `json:"host"`
	Port             int      `json:"port"`
	Database         string   `json:"database"`
	Username         string   `json:"username"`
	Password         string   `json:"password"`
	URLParams        string   `json:"url_params"`
	ConnectionString string   `json:"connection_string"`
	SSL              bool     `json:"ssl"`
	CACertPath       string   `json:"ca_cert_path"`
	ClientCertPath   string   `json:"client_cert_path"`
	ClientKeyPath    string   `json:"client_key_path"`
	ConnectTimeout   int      `json:"connect_timeout_secs"`
	AgentJavaOptions []string `json:"agent_java_options"`
	SessionRole      string   `json:"sessionRole"`
}

type endpoint struct {
	Host          string
	Port          int
	TransportMode string
	HTTPPath      string
	Auth          string
	Principal     string
	SSL           bool
}

func (value endpoint) address() string {
	return net.JoinHostPort(value.Host, strconv.Itoa(value.Port))
}

type kerberosConfig struct {
	Enabled                 bool
	ServerPrincipal         string
	ServerPrincipalExplicit bool
	ClientPrincipal         string
	Service                 string
	ServerName              string
	Realm                   string
	ConfigPath              string
	JAASConfigPath          string
	KeytabPath              string
	CCachePath              string
	Password                string
	AuthorizationID         string
	QOP                     string
	UseKeytab               bool
	UseTicketCache          bool
	UseSSPI                 bool
	CanonicalHostname       bool
	ChannelBinding          bool
	DisablePAFXFAST         bool
}

type zooKeeperKerberosConfig struct {
	Enabled           bool
	Service           string
	ServerPrincipal   string
	Realm             string
	CanonicalHostname bool
}

type connectionConfig struct {
	Endpoints              []endpoint
	Database               string
	Username               string
	Password               string
	Auth                   string
	TransportMode          string
	HTTPPath               string
	TLSConfig              *tls.Config
	AuthExplicit           bool
	TransportModeExplicit  bool
	HTTPPathExplicit       bool
	TLSExplicit            bool
	HiveConfiguration      map[string]string
	ServiceDiscoveryMode   string
	ZooKeeperNamespace     string
	ZooKeeperAuthScheme    string
	ZooKeeperAuth          string
	ZooKeeperTLSConfig     *tls.Config
	ZooKeeperKerberos      zooKeeperKerberosConfig
	ConnectTimeout         time.Duration
	SocketTimeout          time.Duration
	FetchSize              int
	MaxMessageSize         int32
	Retries                int
	RetryInterval          time.Duration
	HTTPHeaders            map[string]string
	HTTPCookies            map[string]string
	RequestTracking        bool
	CookieAuth             bool
	CookieName             string
	JWT                    string
	DelegationToken        string
	BrowserToken           string
	BrowserClientID        string
	BrowserResponsePort    int
	BrowserResponseTimeout time.Duration
	BrowserDisableSSLCheck bool
	InitStatements         []string
	Kerberos               kerberosConfig
}

func parseConnectionConfig(params connectParams) (connectionConfig, error) {
	config := connectionConfig{
		Database:               strings.TrimSpace(params.Database),
		Username:               params.Username,
		Password:               params.Password,
		Auth:                   "NONE",
		TransportMode:          "binary",
		HTTPPath:               defaultHiveHTTPPath,
		HiveConfiguration:      map[string]string{},
		FetchSize:              defaultFetchSize,
		Retries:                1,
		RetryInterval:          defaultRetryInterval,
		BrowserResponseTimeout: defaultBrowserSSOTimeout,
		HTTPHeaders:            map[string]string{},
		HTTPCookies:            map[string]string{},
		CookieAuth:             true,
		CookieName:             defaultCookieName,
		ZooKeeperNamespace:     defaultZooKeeperNamespace,
		ZooKeeperKerberos: zooKeeperKerberosConfig{
			Service:           "zookeeper",
			CanonicalHostname: true,
		},
		ConnectTimeout: defaultConnectTimeout,
		Kerberos: kerberosConfig{
			Service:           defaultHiveService,
			QOP:               "auth",
			CanonicalHostname: true,
		},
	}
	if config.Database == "" {
		config.Database = defaultHiveDatabase
	}
	if params.ConnectTimeout > 0 {
		config.ConnectTimeout = time.Duration(params.ConnectTimeout) * time.Second
	}

	parsed, err := parseHiveConnectionString(params.ConnectionString)
	if err != nil {
		return connectionConfig{}, err
	}
	if len(parsed.endpoints) > 0 {
		config.Endpoints = parsed.endpoints
	} else {
		port := params.Port
		if port <= 0 {
			port = defaultHivePort
		}
		if host := strings.TrimSpace(params.Host); host != "" {
			for _, value := range splitEndpoints(host) {
				parsedEndpoint, endpointErr := parseEndpoint(value, port)
				if endpointErr != nil {
					return connectionConfig{}, endpointErr
				}
				config.Endpoints = append(config.Endpoints, parsedEndpoint)
			}
		}
	}
	if parsed.database != "" {
		config.Database = parsed.database
	}
	if parsed.username != "" {
		config.Username = parsed.username
	}
	if parsed.password != "" {
		config.Password = parsed.password
	}

	urlSections := parseHiveParameterSections(params.URLParams)
	values := mergeHiveParameters(parsed.parameters, urlSections.session)
	hiveConfs := mergeHiveAssignments(parsed.hiveConfs, urlSections.hiveConfs)
	hiveVars := mergeHiveAssignments(parsed.hiveVars, urlSections.hiveVars)
	if value, exists := firstParameter(values, "user", "username"); exists {
		config.Username = value
	}
	if value, exists := firstParameter(values, "password"); exists {
		config.Password = value
	}
	if err := applyHiveParameters(&config, values, hiveConfs); err != nil {
		return connectionConfig{}, err
	}
	applyOpenSessionVariables(&config, values, hiveConfs, hiveVars)
	if err := applyDelegationToken(&config, values); err != nil {
		return connectionConfig{}, err
	}
	applyKerberosJavaOptions(&config.Kerberos, params.AgentJavaOptions)
	applyZooKeeperKerberosJavaOptions(&config.ZooKeeperKerberos, params.AgentJavaOptions)
	applyKerberosEnvironment(&config.Kerberos)
	if err := finalizeKerberosConfig(&config); err != nil {
		return connectionConfig{}, err
	}
	if len(config.Endpoints) == 0 {
		return connectionConfig{}, errors.New("Hive host is required")
	}

	tlsConfig, err := buildTLSConfig(params, values, config.Endpoints[0].Host)
	if err != nil {
		return connectionConfig{}, err
	}
	config.TLSConfig = tlsConfig
	zooKeeperTLSConfig, err := buildZooKeeperTLSConfig(values)
	if err != nil {
		return connectionConfig{}, err
	}
	config.ZooKeeperTLSConfig = zooKeeperTLSConfig
	return config, nil
}

type parsedHiveConnection struct {
	endpoints  []endpoint
	database   string
	username   string
	password   string
	parameters map[string]string
	hiveConfs  map[string]string
	hiveVars   map[string]string
}

type hiveParameterSections struct {
	session   map[string]string
	hiveConfs map[string]string
	hiveVars  map[string]string
}

func newParsedHiveConnection() parsedHiveConnection {
	return parsedHiveConnection{
		parameters: map[string]string{},
		hiveConfs:  map[string]string{},
		hiveVars:   map[string]string{},
	}
}

func parseHiveConnectionString(raw string) (parsedHiveConnection, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return newParsedHiveConnection(), nil
	}
	if strings.HasPrefix(strings.ToLower(value), "jdbc:hive2://") {
		value = value[len("jdbc:hive2://"):]
	} else if strings.HasPrefix(strings.ToLower(value), "hive://") {
		parsedURL, err := url.Parse(value)
		if err != nil {
			return parsedHiveConnection{}, fmt.Errorf("invalid Hive connection string: %w", err)
		}
		result := newParsedHiveConnection()
		if parsedURL.User != nil {
			result.username = parsedURL.User.Username()
			result.password, _ = parsedURL.User.Password()
		}
		port := defaultHivePort
		if parsedURL.Port() != "" {
			parsedPort, err := strconv.Atoi(parsedURL.Port())
			if err != nil {
				return parsedHiveConnection{}, fmt.Errorf("invalid Hive port: %w", err)
			}
			port = parsedPort
		}
		result.endpoints = []endpoint{{Host: parsedURL.Hostname(), Port: port}}
		result.database = strings.Trim(parsedURL.Path, "/")
		for key, entries := range parsedURL.Query() {
			if len(entries) > 0 {
				setCaseInsensitive(result.parameters, key, entries[len(entries)-1])
			}
		}
		return result, nil
	} else {
		return parsedHiveConnection{}, errors.New("Hive connection string must start with jdbc:hive2:// or hive://")
	}

	result := newParsedHiveConnection()
	if fragment := strings.IndexByte(value, '#'); fragment >= 0 {
		result.hiveVars = parseHiveAssignments(value[fragment+1:], false)
		value = value[:fragment]
	}
	if query := strings.IndexByte(value, '?'); query >= 0 {
		result.hiveConfs = parseHiveAssignments(value[query+1:], false)
		value = value[:query]
	}
	pathStart := strings.IndexByte(value, '/')
	authority := value
	pathAndParams := ""
	if pathStart >= 0 {
		authority = value[:pathStart]
		pathAndParams = value[pathStart+1:]
	}
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		credentials := authority[:at]
		authority = authority[at+1:]
		if colon := strings.IndexByte(credentials, ':'); colon >= 0 {
			result.username, _ = url.QueryUnescape(credentials[:colon])
			result.password, _ = url.QueryUnescape(credentials[colon+1:])
		} else {
			result.username, _ = url.QueryUnescape(credentials)
		}
	}
	for _, value := range splitEndpoints(authority) {
		parsedEndpoint, err := parseEndpoint(value, defaultHivePort)
		if err != nil {
			return parsedHiveConnection{}, err
		}
		result.endpoints = append(result.endpoints, parsedEndpoint)
	}
	if separator := strings.IndexByte(pathAndParams, ';'); separator >= 0 {
		result.database = strings.TrimSpace(pathAndParams[:separator])
		result.parameters = mergeHiveParameters(result.parameters, parseHiveParameters(pathAndParams[separator+1:]))
	} else {
		result.database = strings.TrimSpace(pathAndParams)
	}
	return result, nil
}

func splitEndpoints(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func parseEndpoint(value string, defaultPort int) (endpoint, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return endpoint{}, errors.New("Hive endpoint is empty")
	}
	host := value
	port := defaultPort
	if parsedHost, parsedPort, err := net.SplitHostPort(value); err == nil {
		host = parsedHost
		parsed, parseErr := strconv.Atoi(parsedPort)
		if parseErr != nil {
			return endpoint{}, fmt.Errorf("invalid Hive endpoint %q: %w", value, parseErr)
		}
		port = parsed
	} else if strings.Count(value, ":") == 1 {
		parts := strings.SplitN(value, ":", 2)
		parsed, parseErr := strconv.Atoi(parts[1])
		if parseErr != nil {
			return endpoint{}, fmt.Errorf("invalid Hive endpoint %q: %w", value, parseErr)
		}
		host = parts[0]
		port = parsed
	} else if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		host = strings.Trim(value, "[]")
	}
	if strings.TrimSpace(host) == "" || port <= 0 || port > 65535 {
		return endpoint{}, fmt.Errorf("invalid Hive endpoint %q", value)
	}
	return endpoint{Host: host, Port: port}, nil
}

func parseHiveParameters(raw string) map[string]string {
	return parseHiveAssignments(raw, false)
}

func parseHiveAssignments(raw string, lowercaseKeys bool) map[string]string {
	result := map[string]string{}
	trimmed := strings.Trim(strings.TrimSpace(raw), "?#&;")
	for _, part := range strings.FieldsFunc(trimmed, func(char rune) bool { return char == ';' || char == '&' }) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, found := strings.Cut(part, "=")
		key = strings.TrimSpace(key)
		if decoded, err := url.QueryUnescape(key); err == nil {
			key = decoded
		}
		if lowercaseKeys {
			key = strings.ToLower(key)
		}
		if key == "" {
			continue
		}
		if found {
			if decoded, err := url.QueryUnescape(strings.TrimSpace(value)); err == nil {
				value = decoded
			}
		} else {
			value = ""
		}
		if lowercaseKeys {
			result[key] = value
		} else {
			setCaseInsensitive(result, key, value)
		}
	}
	return result
}

func parseHiveParameterSections(raw string) hiveParameterSections {
	value := strings.TrimSpace(raw)
	sections := hiveParameterSections{
		session:   map[string]string{},
		hiveConfs: map[string]string{},
		hiveVars:  map[string]string{},
	}
	if fragment := strings.IndexByte(value, '#'); fragment >= 0 {
		sections.hiveVars = parseHiveAssignments(value[fragment+1:], false)
		value = value[:fragment]
	}
	if query := strings.IndexByte(value, '?'); query >= 0 {
		sections.hiveConfs = parseHiveAssignments(value[query+1:], false)
		value = value[:query]
	}
	sections.session = parseHiveParameters(value)
	return sections
}

func mergeHiveParameters(first, second map[string]string) map[string]string {
	result := make(map[string]string, len(first)+len(second))
	for key, value := range first {
		setCaseInsensitive(result, key, value)
	}
	for key, value := range second {
		setCaseInsensitive(result, key, value)
	}
	return result
}

func setCaseInsensitive(values map[string]string, key, value string) {
	for existing := range values {
		if strings.EqualFold(existing, key) {
			delete(values, existing)
		}
	}
	values[key] = value
}

func mergeHiveAssignments(first, second map[string]string) map[string]string {
	result := make(map[string]string, len(first)+len(second))
	for key, value := range first {
		result[key] = value
	}
	for key, value := range second {
		result[key] = value
	}
	return result
}

func applyHiveParameters(config *connectionConfig, values, hiveConfs map[string]string) error {
	if value := parameter(values, "auth"); value != "" {
		config.Auth = strings.ToUpper(value)
		config.AuthExplicit = true
	}
	if value := firstNonEmpty(parameter(values, "transportmode"), hiveAssignmentValue(hiveConfs, "hive.server2.transport.mode")); value != "" {
		config.TransportMode = strings.ToLower(value)
		config.TransportModeExplicit = true
	}
	if value := firstNonEmpty(parameter(values, "httppath"), hiveAssignmentValue(hiveConfs, "hive.server2.thrift.http.path")); value != "" {
		config.HTTPPath = strings.TrimPrefix(value, "/")
		config.HTTPPathExplicit = true
	}
	if value := parameter(values, "servicediscoverymode"); value != "" {
		config.ServiceDiscoveryMode = strings.ToLower(value)
	}
	if value := parameter(values, "zookeepernamespace"); value != "" {
		config.ZooKeeperNamespace = strings.Trim(value, "/")
	}
	if strings.EqualFold(config.ServiceDiscoveryMode, "zookeeperha") && parameter(values, "zookeepernamespace") == "" {
		config.ZooKeeperNamespace = "hs2ActivePassiveHA"
	}
	if hasParameter(values, "ssl") {
		config.TLSExplicit = true
	}
	config.ZooKeeperAuthScheme = parameter(values, "zookeeperauthscheme")
	config.ZooKeeperAuth = parameter(values, "zookeeperauth")
	config.HTTPHeaders = prefixedParameters(values, "http.header.")
	config.HTTPCookies = prefixedParameters(values, "http.cookie.")
	config.RequestTracking = parameterBool(values, "requesttrack")
	if value, exists := firstParameter(values, "cookieauth"); exists {
		config.CookieAuth = !strings.EqualFold(value, "false")
	}
	config.CookieName = firstNonEmpty(parameter(values, "cookiename"), defaultCookieName)
	config.JWT = firstNonEmpty(parameter(values, "jwt"), os.Getenv("JWT"))
	config.BrowserToken = firstNonEmpty(parameter(values, "browsertoken"), parameter(values, "token"))
	config.BrowserClientID = parameter(values, "browserclientidentifier")
	if value := parameter(values, "browserresponseport"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 || parsed > 65535 {
			return fmt.Errorf("invalid Hive browserResponsePort %q: expected 0-65535", value)
		}
		config.BrowserResponsePort = parsed
	}
	if value := parameter(values, "browserresponsetimeout"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed <= 0 {
			return fmt.Errorf("invalid Hive browserResponseTimeout %q: expected positive seconds", value)
		}
		config.BrowserResponseTimeout = time.Duration(parsed) * time.Second
	}
	config.BrowserDisableSSLCheck = parameterBool(values, "browserdisablesslcheck")
	if strings.EqualFold(config.Auth, "JWT") && config.JWT == "" {
		return errors.New("Hive JWT authentication requires jwt or the JWT environment variable")
	}
	if value := parameter(values, "fetchsize"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 {
			return fmt.Errorf("invalid Hive fetchSize %q: expected a positive integer", value)
		}
		config.FetchSize = parsed
	}
	if value := parameter(values, "sockettimeout"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid Hive socketTimeout %q: expected seconds", value)
		}
		if parsed > 0 {
			config.SocketTimeout = time.Duration(parsed) * time.Second
		}
	}
	if value := parameter(values, "thrift.client.max.message.size"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 32)
		if err != nil {
			return fmt.Errorf("invalid Hive thrift.client.max.message.size %q: expected bytes", value)
		}
		if parsed > 0 {
			config.MaxMessageSize = int32(parsed)
		}
	}
	if value := parameter(values, "retries"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err == nil && parsed > 0 {
			config.Retries = parsed
		}
	}
	if value := parameter(values, "retryinterval"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err == nil && parsed >= 0 {
			config.RetryInterval = time.Duration(parsed) * time.Millisecond
		}
	}
	if value := parameter(values, "initfile"); value != "" {
		statements, err := readHiveInitFile(value)
		if err != nil {
			return err
		}
		config.InitStatements = statements
	}

	kerberos := &config.Kerberos
	kerberos.ServerPrincipal = parameter(values, "principal")
	kerberos.ServerPrincipalExplicit = kerberos.ServerPrincipal != ""
	kerberos.ClientPrincipal = firstNonEmpty(
		parameter(values, "kerberosprincipal"),
		parameter(values, "clientprincipal"),
		parameter(values, "userprincipal"),
	)
	kerberos.Service = firstNonEmpty(parameter(values, "service"), serviceFromPrincipal(kerberos.ServerPrincipal), defaultHiveService)
	kerberos.ServerName = parameter(values, "servername")
	kerberos.Realm = firstNonEmpty(parameter(values, "realm"), realmFromPrincipal(kerberos.ClientPrincipal))
	kerberos.ConfigPath = firstNonEmpty(parameter(values, "krb5conf"), parameter(values, "kerberosconfig"))
	kerberos.JAASConfigPath = parameter(values, "jaasconfig")
	kerberos.KeytabPath = parameter(values, "keytab")
	kerberos.CCachePath = firstNonEmpty(parameter(values, "ccache"), parameter(values, "credentialcache"))
	kerberos.AuthorizationID = firstNonEmpty(parameter(values, "authorizationid"), parameter(values, "proxyuser"))
	kerberos.QOP = firstNonEmpty(
		parameter(values, "hive.server2.thrift.sasl.qop"),
		hiveAssignmentValue(hiveConfs, "hive.server2.thrift.sasl.qop"),
		parameter(values, "sasl.qop"),
		parameter(values, "saslqop"),
		"auth",
	)
	kerberos.UseKeytab = parameterBool(values, "usekeytab") || kerberos.KeytabPath != ""
	kerberos.UseTicketCache = parameterBool(values, "useticketcache") || kerberos.CCachePath != ""
	kerberos.UseSSPI = parameterBool(values, "usesspi")
	if hasParameter(values, "kerberosenablecanonicalhostnamecheck") {
		kerberos.CanonicalHostname = parameterBool(values, "kerberosenablecanonicalhostnamecheck")
	}
	kerberos.ChannelBinding = parameterBool(values, "kerberoschannelbinding") ||
		parameterBool(values, "tlschannelbinding") ||
		parameterBool(values, "channelbinding")
	kerberos.DisablePAFXFAST = parameterBool(values, "disablepafxfast")
	if kerberos.ServerPrincipal != "" || strings.EqualFold(config.Auth, "KERBEROS") {
		kerberos.Enabled = true
		config.Auth = "KERBEROS"
	}

	zooKeeperKerberos := &config.ZooKeeperKerberos
	zooKeeperKerberos.Enabled = kerberos.ServerPrincipalExplicit
	if value, exists := firstParameter(values, "hive.zookeeper.use.kerberos", "hiveconf:hive.zookeeper.use.kerberos"); exists {
		zooKeeperKerberos.Enabled = booleanValue(value)
	} else if value := hiveAssignmentValue(hiveConfs, "hive.zookeeper.use.kerberos"); value != "" {
		zooKeeperKerberos.Enabled = booleanValue(value)
	}
	if value, exists := firstParameter(values, "zookeeper.sasl.client"); exists && !booleanValue(value) {
		zooKeeperKerberos.Enabled = false
	}
	zooKeeperKerberos.Service = firstNonEmpty(parameter(values, "zookeeper.sasl.client.username"), "zookeeper")
	zooKeeperKerberos.ServerPrincipal = parameter(values, "zookeeper.server.principal")
	zooKeeperKerberos.Realm = parameter(values, "zookeeper.server.realm")
	if hasParameter(values, "zookeeper.sasl.client.canonicalize.hostname") {
		zooKeeperKerberos.CanonicalHostname = parameterBool(values, "zookeeper.sasl.client.canonicalize.hostname")
	}

	return nil
}

func applyOpenSessionVariables(config *connectionConfig, values, hiveConfs, hiveVars map[string]string) {
	for key, value := range values {
		lowerKey := strings.ToLower(key)
		switch {
		case strings.HasPrefix(lowerKey, "hiveconf:"):
			config.HiveConfiguration["set:hiveconf:"+key[len("hiveconf:"):]] = value
		case strings.HasPrefix(lowerKey, "hivevar:"):
			config.HiveConfiguration["set:hivevar:"+key[len("hivevar:"):]] = value
		}
	}
	for key, value := range hiveConfs {
		if strings.EqualFold(key, "hive.server2.transport.mode") || strings.EqualFold(key, "hive.server2.thrift.http.path") {
			continue
		}
		config.HiveConfiguration["set:hiveconf:"+key] = value
	}
	for key, value := range hiveVars {
		config.HiveConfiguration["set:hivevar:"+key] = value
	}
	if proxyUser := firstNonEmpty(parameter(values, "proxyuser"), parameter(values, "hive.server2.proxy.user")); proxyUser != "" {
		config.HiveConfiguration["hive.server2.proxy.user"] = proxyUser
	}
	if value := parameter(values, "hivecreateasexternallegacy"); value != "" {
		config.HiveConfiguration["set:hiveconf:hive.create.as.external.legacy"] = strings.ToLower(value)
	}
	if value := parameter(values, "wmpool"); value != "" {
		config.HiveConfiguration["set:hivevar:wmpool"] = value
	}
	if value := firstNonEmpty(parameter(values, "applicationname"), parameter(values, "ApplicationName")); value != "" {
		config.HiveConfiguration["set:hivevar:wmapp"] = value
	}
}

func hiveAssignmentValue(values map[string]string, key string) string {
	for candidate, value := range values {
		if strings.EqualFold(strings.TrimSpace(candidate), key) {
			return value
		}
	}
	return ""
}

func applyDelegationToken(config *connectionConfig, values map[string]string) error {
	if !strings.EqualFold(config.Auth, "DELEGATIONTOKEN") && !strings.EqualFold(config.Auth, "DELEGATION_TOKEN") {
		return nil
	}
	token := firstNonEmpty(parameter(values, "delegationtoken"), parameter(values, "token"), config.Password)
	if token == "" {
		return errors.New("Hive delegation token authentication requires delegationToken, token, or password")
	}
	config.DelegationToken = token
	identifier, password, err := decodeHadoopDelegationToken(token)
	if err != nil {
		return fmt.Errorf("decode Hive delegation token: %w", err)
	}
	config.Username = base64.StdEncoding.EncodeToString(identifier)
	config.Password = base64.StdEncoding.EncodeToString(password)
	return nil
}

func decodeHadoopDelegationToken(value string) ([]byte, []byte, error) {
	encoded := strings.Join(strings.Fields(strings.TrimSpace(value)), "")
	if encoded == "" {
		return nil, nil, errors.New("token is empty")
	}
	var decoded []byte
	var decodeErr error
	for _, encoding := range []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	} {
		decoded, decodeErr = encoding.DecodeString(encoded)
		if decodeErr == nil {
			break
		}
	}
	if decodeErr != nil {
		return nil, nil, decodeErr
	}
	reader := strings.NewReader(string(decoded))
	identifier, err := readHadoopByteArray(reader)
	if err != nil {
		return nil, nil, fmt.Errorf("identifier: %w", err)
	}
	password, err := readHadoopByteArray(reader)
	if err != nil {
		return nil, nil, fmt.Errorf("password: %w", err)
	}
	if len(identifier) == 0 || len(password) == 0 {
		return nil, nil, errors.New("token identifier and password must be non-empty")
	}
	if _, err := readHadoopByteArray(reader); err != nil {
		return nil, nil, fmt.Errorf("kind: %w", err)
	}
	if _, err := readHadoopByteArray(reader); err != nil {
		return nil, nil, fmt.Errorf("service: %w", err)
	}
	if reader.Len() != 0 {
		return nil, nil, errors.New("token contains trailing data")
	}
	return identifier, password, nil
}

func readHadoopByteArray(reader io.ByteReader) ([]byte, error) {
	length, err := readHadoopVInt(reader)
	if err != nil {
		return nil, err
	}
	if length < 0 {
		return nil, fmt.Errorf("negative length %d", length)
	}
	if length > 64*1024*1024 {
		return nil, fmt.Errorf("length %d exceeds limit", length)
	}
	value := make([]byte, int(length))
	byteReader, ok := reader.(io.Reader)
	if !ok {
		return nil, errors.New("reader cannot read token payload")
	}
	if _, err := io.ReadFull(byteReader, value); err != nil {
		return nil, err
	}
	return value, nil
}

func readHadoopVInt(reader io.ByteReader) (int64, error) {
	firstByte, err := reader.ReadByte()
	if err != nil {
		return 0, err
	}
	first := int8(firstByte)
	if first >= -112 {
		return int64(first), nil
	}
	length := -111 - int(first)
	negative := false
	if first < -120 {
		length = -119 - int(first)
		negative = true
	}
	var value int64
	for index := 0; index < length-1; index++ {
		current, readErr := reader.ReadByte()
		if readErr != nil {
			return 0, readErr
		}
		value = value<<8 | int64(current)
	}
	if negative {
		value = ^value
	}
	return value, nil
}

func applyKerberosJavaOptions(config *kerberosConfig, options []string) {
	for _, option := range options {
		trimmed := strings.TrimSpace(option)
		switch {
		case strings.HasPrefix(trimmed, "-Djava.security.krb5.conf="):
			config.ConfigPath = javaSystemPropertyValue(strings.TrimPrefix(trimmed, "-Djava.security.krb5.conf="))
		case strings.HasPrefix(trimmed, "-Djava.security.auth.login.config="):
			config.JAASConfigPath = javaSystemPropertyValue(strings.TrimPrefix(trimmed, "-Djava.security.auth.login.config="))
		}
	}
}

func applyZooKeeperKerberosJavaOptions(config *zooKeeperKerberosConfig, options []string) {
	for _, option := range options {
		trimmed := strings.TrimSpace(option)
		keyValue := strings.TrimPrefix(trimmed, "-D")
		key, value, found := strings.Cut(keyValue, "=")
		if !strings.HasPrefix(trimmed, "-D") || !found {
			continue
		}
		value = javaSystemPropertyValue(value)
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "hive.zookeeper.use.kerberos":
			config.Enabled = booleanValue(value)
		case "zookeeper.sasl.client":
			if !booleanValue(value) {
				config.Enabled = false
			}
		case "zookeeper.sasl.client.username":
			config.Service = firstNonEmpty(value, "zookeeper")
		case "zookeeper.sasl.client.canonicalize.hostname":
			config.CanonicalHostname = booleanValue(value)
		case "zookeeper.server.principal":
			config.ServerPrincipal = strings.TrimSpace(value)
		case "zookeeper.server.realm":
			config.Realm = strings.TrimSpace(value)
		}
	}
}

func javaSystemPropertyValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return value[1 : len(value)-1]
	}
	return value
}

func applyKerberosEnvironment(config *kerberosConfig) {
	config.ConfigPath = firstNonEmpty(config.ConfigPath, os.Getenv("KRB5_CONFIG"))
	config.CCachePath = firstNonEmpty(config.CCachePath, os.Getenv("KRB5CCNAME"))
	config.KeytabPath = firstNonEmpty(config.KeytabPath, os.Getenv("KRB5_CLIENT_KTNAME"), os.Getenv("KRB5_KTNAME"))
}

func finalizeKerberosConfig(config *connectionConfig) error {
	kerberos := &config.Kerberos
	if !kerberos.Enabled {
		return nil
	}
	kerberos.Password = config.Password
	kerberos.ConfigPath = normalizeKerberosReference(kerberos.ConfigPath)
	kerberos.CCachePath = normalizeKerberosReference(kerberos.CCachePath)
	kerberos.KeytabPath = normalizeKerberosReference(kerberos.KeytabPath)
	kerberos.JAASConfigPath = normalizeKerberosReference(kerberos.JAASConfigPath)
	if kerberos.JAASConfigPath != "" {
		if err := applyKerberosJAASFile(kerberos); err != nil {
			return err
		}
		kerberos.KeytabPath = normalizeKerberosReference(kerberos.KeytabPath)
		kerberos.CCachePath = normalizeKerberosReference(kerberos.CCachePath)
	}
	if kerberos.ConfigPath == "" {
		if candidate := defaultKerberosConfigPath(); fileExists(candidate) {
			kerberos.ConfigPath = candidate
		}
	}
	if !kerberos.UseTicketCache && kerberos.CCachePath == "" {
		if candidate := defaultKerberosCCachePath(); fileExists(candidate) {
			kerberos.CCachePath = candidate
			kerberos.UseTicketCache = true
		}
	}
	if runtime.GOOS == "windows" && kerberos.ConfigPath == "" && kerberos.KeytabPath == "" && kerberos.CCachePath == "" {
		kerberos.UseSSPI = true
	}
	if kerberos.UseSSPI {
		return nil
	}
	if kerberos.ConfigPath == "" {
		return errors.New("Kerberos requires krb5.conf or Windows SSPI")
	}
	if kerberos.ClientPrincipal == "" && !kerberos.UseTicketCache && !kerberos.UseKeytab {
		kerberos.ClientPrincipal = strings.TrimSpace(config.Username)
	}
	if kerberos.KeytabPath != "" {
		kerberos.UseKeytab = true
	}
	if kerberos.CCachePath != "" {
		kerberos.UseTicketCache = true
	}
	kerberos.Realm = firstNonEmpty(kerberos.Realm, realmFromPrincipal(kerberos.ClientPrincipal))
	if !kerberos.UseTicketCache && !kerberos.UseKeytab && (kerberos.ClientPrincipal == "" || kerberos.Password == "") {
		return errors.New("Kerberos requires SSPI, credential cache, keytab, or principal and password")
	}
	return nil
}

var jaasOptionPattern = regexp.MustCompile(`(?i)\b(principal|keytab|ticketcache|usekeytab|useticketcache)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;]+)`)

func applyKerberosJAASFile(config *kerberosConfig) error {
	contents, err := os.ReadFile(config.JAASConfigPath)
	if err != nil {
		return fmt.Errorf("read Kerberos JAAS config: %w", err)
	}
	text := string(contents)
	module := strings.Index(strings.ToLower(text), "krb5loginmodule")
	if module < 0 {
		return errors.New("Kerberos JAAS config contains no Krb5LoginModule")
	}
	block := text[module:]
	if end := strings.IndexByte(block, ';'); end >= 0 {
		block = block[:end]
	}
	for _, match := range jaasOptionPattern.FindAllStringSubmatch(block, -1) {
		key := strings.ToLower(match[1])
		value := decodeJAASValue(match[2])
		switch key {
		case "principal":
			if config.ClientPrincipal == "" {
				config.ClientPrincipal = value
			}
		case "keytab":
			if config.KeytabPath == "" {
				config.KeytabPath = value
			}
		case "ticketcache":
			if config.CCachePath == "" {
				config.CCachePath = value
			}
		case "usekeytab":
			config.UseKeytab = config.UseKeytab || parseJAASBool(value)
		case "useticketcache":
			config.UseTicketCache = config.UseTicketCache || parseJAASBool(value)
		}
	}
	return nil
}

func decodeJAASValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
		value = value[1 : len(value)-1]
	}
	value = strings.ReplaceAll(value, `\\`, `\`)
	value = strings.ReplaceAll(value, `\"`, `"`)
	value = strings.ReplaceAll(value, `\'`, `'`)
	return value
}

func parseJAASBool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func fileExists(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func normalizeKerberosReference(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToUpper(value), "FILE:") {
		value = value[5:]
	}
	if strings.HasPrefix(value, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			value = filepath.Join(home, value[2:])
		}
	}
	return filepath.Clean(value)
}

func buildTLSConfig(params connectParams, values map[string]string, serverName string) (*tls.Config, error) {
	enabled := params.SSL || parameterBool(values, "ssl") || strings.EqualFold(parameter(values, "ssl"), "true")
	if !enabled {
		return nil, nil
	}
	config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName}
	if parameterBool(values, "sslinsecureskipverify") || parameterBool(values, "allowselfsigned") {
		config.InsecureSkipVerify = true
	}
	var customRoots *x509.CertPool
	credentialProviderPath := parameter(values, "storepasswordpath")
	if path := strings.TrimSpace(params.CACertPath); path != "" {
		contents, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read Hive CA certificate: %w", err)
		}
		customRoots = x509.NewCertPool()
		if !customRoots.AppendCertsFromPEM(contents) {
			return nil, errors.New("Hive CA certificate contains no certificates")
		}
	}
	trustStoreLocation := parameter(values, "ssltruststore")
	if trustStoreLocation != "" {
		if parameter(values, "truststorepassword") == "" && credentialProviderPath != "" {
			return nil, errors.New("Hive storePasswordPath uses the Java Hadoop credential-provider format; configure trustStorePassword explicitly for the native agent")
		}
		certificates, err := loadTrustStore(
			trustStoreLocation,
			parameter(values, "truststorepassword"),
			parameter(values, "truststoretype"),
		)
		if err != nil {
			return nil, fmt.Errorf("load Hive truststore: %w", err)
		}
		if customRoots == nil {
			customRoots = x509.NewCertPool()
		}
		for _, certificate := range certificates {
			customRoots.AddCert(certificate)
		}
	}
	config.RootCAs = customRoots
	if params.ClientCertPath != "" || params.ClientKeyPath != "" {
		if params.ClientCertPath == "" || params.ClientKeyPath == "" {
			return nil, errors.New("Hive client certificate and key must be configured together")
		}
		certificate, err := tls.LoadX509KeyPair(params.ClientCertPath, params.ClientKeyPath)
		if err != nil {
			return nil, fmt.Errorf("load Hive client certificate: %w", err)
		}
		config.Certificates = []tls.Certificate{certificate}
	}
	keyStoreLocation := parameter(values, "sslkeystore")
	if keyStoreLocation != "" {
		if parameter(values, "keystorepassword") == "" && credentialProviderPath != "" {
			return nil, errors.New("Hive storePasswordPath uses the Java Hadoop credential-provider format; configure keyStorePassword explicitly for the native agent")
		}
		certificate, err := loadClientKeyStore(
			keyStoreLocation,
			parameter(values, "keystorepassword"),
			parameter(values, "keystoretype"),
		)
		if err != nil {
			return nil, fmt.Errorf("load Hive keystore: %w", err)
		}
		config.Certificates = append(config.Certificates, certificate)
	}
	if parameterBool(values, "twoway") {
		if keyStoreLocation == "" && len(config.Certificates) == 0 {
			return nil, errors.New("Hive two-way TLS requires sslKeyStore or a client certificate")
		}
		if trustStoreLocation == "" && config.RootCAs == nil {
			return nil, errors.New("Hive two-way TLS requires sslTrustStore or a CA certificate")
		}
	}
	return config, nil
}

func parameter(values map[string]string, key string) string {
	for candidate, value := range values {
		if strings.EqualFold(strings.TrimSpace(candidate), key) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func parameterBool(values map[string]string, key string) bool {
	return booleanValue(parameter(values, key))
}

func booleanValue(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func firstParameter(values map[string]string, keys ...string) (string, bool) {
	for _, key := range keys {
		for candidate, value := range values {
			if strings.EqualFold(strings.TrimSpace(candidate), key) {
				return strings.TrimSpace(value), true
			}
		}
	}
	return "", false
}

func hasParameter(values map[string]string, key string) bool {
	_, exists := firstParameter(values, key)
	return exists
}

func prefixedParameters(values map[string]string, prefix string) map[string]string {
	result := map[string]string{}
	for key, value := range values {
		if len(key) <= len(prefix) || !strings.EqualFold(key[:len(prefix)], prefix) {
			continue
		}
		name := strings.TrimSpace(key[len(prefix):])
		if name != "" {
			result[name] = value
		}
	}
	return result
}

func readHiveInitFile(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read Hive initFile: %w", err)
	}
	defer file.Close()

	var script strings.Builder
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "--") {
			continue
		}
		script.WriteString(line)
		script.WriteByte(' ')
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read Hive initFile: %w", err)
	}

	statements := make([]string, 0)
	for _, statement := range strings.Split(script.String(), ";") {
		if trimmed := strings.TrimSpace(statement); trimmed != "" {
			statements = append(statements, trimmed)
		}
	}
	return statements, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func serviceFromPrincipal(principal string) string {
	value := strings.TrimSpace(principal)
	if separator := strings.IndexByte(value, '/'); separator > 0 {
		return value[:separator]
	}
	return ""
}

func hostFromPrincipal(principal string) string {
	value := strings.TrimSpace(principal)
	separator := strings.IndexByte(value, '/')
	if separator < 0 {
		return ""
	}
	value = value[separator+1:]
	if realm := strings.IndexByte(value, '@'); realm >= 0 {
		value = value[:realm]
	}
	if value == "_HOST" {
		return ""
	}
	return value
}

func realmFromPrincipal(principal string) string {
	if separator := strings.LastIndexByte(principal, '@'); separator >= 0 {
		return strings.TrimSpace(principal[separator+1:])
	}
	return ""
}
