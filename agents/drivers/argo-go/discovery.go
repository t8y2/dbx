package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-zookeeper/zk"
)

type endpointDiscovery interface {
	Endpoints(context.Context, map[string]bool) ([]endpoint, error)
}

type directDiscovery struct {
	endpoints []endpoint
}

func (discovery directDiscovery) Endpoints(_ context.Context, rejected map[string]bool) ([]endpoint, error) {
	return shuffledEndpoints(discovery.endpoints, rejected), nil
}

type zooKeeperDiscovery struct {
	servers       []endpoint
	namespace     string
	discoveryMode string
	authScheme    string
	auth          string
	timeout       time.Duration
	dialer        func([]string, time.Duration) (zooKeeperClient, <-chan zk.Event, error)
}

type zooKeeperClient interface {
	AddAuth(string, []byte) error
	Children(string) ([]string, *zk.Stat, error)
	Get(string) ([]byte, *zk.Stat, error)
	Close()
}

func newEndpointDiscovery(config connectionConfig) endpointDiscovery {
	if strings.EqualFold(config.ServiceDiscoveryMode, "zookeeper") || strings.EqualFold(config.ServiceDiscoveryMode, "zookeeperha") {
		return &zooKeeperDiscovery{
			servers:       append([]endpoint(nil), config.Endpoints...),
			namespace:     config.ZooKeeperNamespace,
			discoveryMode: config.ServiceDiscoveryMode,
			authScheme:    config.ZooKeeperAuthScheme,
			auth:          config.ZooKeeperAuth,
			timeout:       config.ConnectTimeout,
			dialer:        newZooKeeperDialer(config),
		}
	}
	return directDiscovery{endpoints: append([]endpoint(nil), config.Endpoints...)}
}

func newZooKeeperDialer(config connectionConfig) func([]string, time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
	if config.ZooKeeperKerberos.Enabled {
		return func(servers []string, timeout time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
			return connectKerberosZooKeeper(servers, timeout, config.ZooKeeperTLSConfig, config)
		}
	}
	tlsConfig := config.ZooKeeperTLSConfig
	if tlsConfig == nil {
		return func(servers []string, timeout time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
			return zk.Connect(servers, timeout, zk.WithLogInfo(false))
		}
	}
	return func(servers []string, timeout time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
		return zk.Connect(
			servers,
			timeout,
			zk.WithLogInfo(false),
			zk.WithDialer(func(network, address string, dialTimeout time.Duration) (net.Conn, error) {
				config := tlsConfig.Clone()
				if config.ServerName == "" {
					host, _, err := net.SplitHostPort(address)
					if err == nil {
						config.ServerName = host
					}
				}
				dialer := &net.Dialer{Timeout: dialTimeout}
				return tls.DialWithDialer(dialer, network, address, config)
			}),
		)
	}
}

func (discovery *zooKeeperDiscovery) Endpoints(ctx context.Context, rejected map[string]bool) ([]endpoint, error) {
	addresses := make([]string, 0, len(discovery.servers))
	for _, server := range discovery.servers {
		addresses = append(addresses, server.address())
	}
	timeout := discovery.timeout
	if timeout <= 0 {
		timeout = defaultConnectTimeout
	}
	connection, events, err := discovery.dialer(addresses, timeout)
	if err != nil {
		return nil, fmt.Errorf("connect to ZooKeeper: %w", err)
	}
	defer connection.Close()
	if err := waitForZooKeeperSession(ctx, events, timeout); err != nil {
		return nil, err
	}
	if discovery.authScheme != "" || discovery.auth != "" {
		if discovery.authScheme == "" || discovery.auth == "" {
			return nil, errors.New("ZooKeeper auth scheme and credentials must be configured together")
		}
		if err := connection.AddAuth(discovery.authScheme, []byte(discovery.auth)); err != nil {
			return nil, fmt.Errorf("authenticate to ZooKeeper: %w", err)
		}
	}
	resolved := make([]endpoint, 0)
	var listedPath string
	var nodeFailures []string
	for _, path := range discovery.paths() {
		children, _, childrenErr := connection.Children(path)
		if errors.Is(childrenErr, zk.ErrNoNode) {
			continue
		}
		if childrenErr != nil {
			return nil, fmt.Errorf("list ZooKeeper namespace %s: %w", path, childrenErr)
		}
		listedPath = path
		for _, child := range children {
			data, _, dataErr := connection.Get(path + "/" + child)
			if dataErr != nil {
				if errors.Is(dataErr, zk.ErrNoNode) {
					continue
				}
				nodeFailures = append(nodeFailures, fmt.Sprintf("%s/%s: %v", path, child, dataErr))
				continue
			}
			value, parseErr := parseHiveServerRegistration(child, data)
			if parseErr == nil {
				resolved = append(resolved, value)
			} else {
				nodeFailures = append(nodeFailures, fmt.Sprintf("%s/%s: %v", path, child, parseErr))
			}
		}
		if len(resolved) > 0 {
			break
		}
	}
	resolved = shuffledEndpoints(uniqueEndpoints(resolved), rejected)
	if len(resolved) == 0 {
		if listedPath == "" {
			return nil, fmt.Errorf("HiveServer2 ZooKeeper namespace not found; tried %s", strings.Join(discovery.paths(), ", "))
		}
		if len(nodeFailures) > 0 {
			return nil, fmt.Errorf("no usable HiveServer2 nodes in ZooKeeper namespace %s: %s", listedPath, strings.Join(nodeFailures, "; "))
		}
		return nil, fmt.Errorf("no available HiveServer2 nodes in ZooKeeper namespace %s", listedPath)
	}
	return resolved, nil
}

func (discovery *zooKeeperDiscovery) paths() []string {
	namespace := strings.Trim(discovery.namespace, "/")
	if strings.EqualFold(discovery.discoveryMode, "zookeeperha") {
		return []string{
			zooKeeperPath(namespace, "instances"),
			zooKeeperPath(namespace+"-unsecure", "instances"),
			zooKeeperPath(namespace+"-sasl", "instances"),
		}
	}
	return []string{zooKeeperPath(namespace)}
}

func zooKeeperPath(parts ...string) string {
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.Trim(part, "/"); value != "" {
			cleaned = append(cleaned, value)
		}
	}
	if len(cleaned) == 0 {
		return "/"
	}
	return "/" + strings.Join(cleaned, "/")
}

func waitForZooKeeperSession(ctx context.Context, events <-chan zk.Event, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("ZooKeeper connection timed out before a session was established")
		case event, ok := <-events:
			if !ok {
				return errors.New("ZooKeeper event stream closed before a session was established")
			}
			if event.Err != nil {
				return fmt.Errorf("ZooKeeper connection event: %w", event.Err)
			}
			switch event.State {
			case zk.StateHasSession:
				return nil
			case zk.StateAuthFailed:
				return errors.New("ZooKeeper authentication failed")
			case zk.StateExpired:
				return errors.New("ZooKeeper session expired during connection")
			}
		}
	}
}

func parseHiveServerRegistration(child string, data []byte) (endpoint, error) {
	candidates := []string{strings.TrimSpace(string(data)), strings.TrimSpace(child)}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if value, err := endpointFromRegistrationJSON(candidate); err == nil {
			return value, nil
		}
		parameters := parseHiveParameters(candidate)
		for _, key := range []string{"serveruri", "hiveserver2uri", "server_uri"} {
			if raw := parameter(parameters, key); raw != "" {
				return parseRegisteredEndpoint(raw)
			}
		}
		if value, err := endpointFromPublishedHiveConfig(parameters); err == nil {
			return value, nil
		}
		if strings.Contains(candidate, "=") {
			continue
		}
		if value, err := parseRegisteredEndpoint(candidate); err == nil {
			return value, nil
		}
	}
	return endpoint{}, fmt.Errorf("unsupported HiveServer2 ZooKeeper registration %q", child)
}

func endpointFromRegistrationJSON(value string) (endpoint, error) {
	var object map[string]any
	if json.Unmarshal([]byte(value), &object) != nil {
		return endpoint{}, errors.New("not JSON")
	}
	for _, key := range []string{"serverUri", "server_uri", "hiveServer2Uri", "uri"} {
		if raw, ok := object[key].(string); ok && strings.TrimSpace(raw) != "" {
			return parseRegisteredEndpoint(raw)
		}
	}
	if serviceRecordEndpoint, ok := endpointFromServiceRecord(object); ok {
		return serviceRecordEndpoint, nil
	}
	host, _ := object["host"].(string)
	if host == "" {
		host, _ = object["hostname"].(string)
	}
	port := 0
	switch value := object["port"].(type) {
	case float64:
		port = int(value)
	case string:
		port, _ = strconv.Atoi(value)
	}
	if host != "" && port > 0 {
		return endpoint{Host: host, Port: port}, nil
	}
	return endpoint{}, errors.New("JSON registration has no endpoint")
}

func endpointFromServiceRecord(object map[string]any) (endpoint, bool) {
	internal, _ := object["internal"].([]any)
	for _, rawEndpoint := range internal {
		published, _ := rawEndpoint.(map[string]any)
		if !strings.EqualFold(registrationStringValue(published["api"]), "activeEndpoint") {
			continue
		}
		addresses, _ := published["addresses"].([]any)
		for _, rawAddress := range addresses {
			address, _ := rawAddress.(map[string]any)
			host := registrationStringValue(address["host"])
			port, _ := strconv.Atoi(registrationStringValue(address["port"]))
			if host != "" && port > 0 {
				result := endpoint{Host: host, Port: port}
				applyPublishedHiveConfig(&result, object)
				return result, true
			}
		}
	}
	return endpoint{}, false
}

func registrationStringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func applyPublishedHiveConfig(target *endpoint, parameters map[string]any) {
	value := func(key string) string {
		if nested, ok := parameters["attributes"].(map[string]any); ok {
			if result := registrationStringValue(nested[key]); result != "" {
				return result
			}
		}
		return registrationStringValue(parameters[key])
	}
	target.TransportMode = strings.ToLower(value("hive.server2.transport.mode"))
	target.HTTPPath = strings.TrimPrefix(value("hive.server2.thrift.http.path"), "/")
	target.Auth = strings.ToUpper(value("hive.server2.authentication"))
	target.Principal = value("hive.server2.authentication.kerberos.principal")
	target.SSL = strings.EqualFold(value("hive.server2.use.ssl"), "true")
}

func endpointFromPublishedHiveConfig(parameters map[string]string) (endpoint, error) {
	host := firstNonEmpty(
		parameter(parameters, "hive.server2.thrift.bind.host"),
		parameter(parameters, "host"),
	)
	transportMode := strings.ToLower(parameter(parameters, "hive.server2.transport.mode"))
	portValue := parameter(parameters, "hive.server2.thrift.port")
	if transportMode == "http" {
		portValue = firstNonEmpty(parameter(parameters, "hive.server2.thrift.http.port"), portValue)
	}
	port, err := strconv.Atoi(portValue)
	if host == "" || err != nil || port <= 0 {
		return endpoint{}, errors.New("published HiveServer2 configuration has no valid host and port")
	}
	return endpoint{
		Host:          host,
		Port:          port,
		TransportMode: transportMode,
		HTTPPath:      strings.TrimPrefix(parameter(parameters, "hive.server2.thrift.http.path"), "/"),
		Auth:          strings.ToUpper(parameter(parameters, "hive.server2.authentication")),
		Principal:     parameter(parameters, "hive.server2.authentication.kerberos.principal"),
		SSL:           parameterBool(parameters, "hive.server2.use.ssl"),
	}, nil
}

func parseRegisteredEndpoint(value string) (endpoint, error) {
	value = strings.TrimSpace(value)
	if parsed, err := url.Parse(value); err == nil && parsed.Hostname() != "" {
		port := defaultHivePort
		if parsed.Port() != "" {
			parsedPort, parseErr := strconv.Atoi(parsed.Port())
			if parseErr != nil {
				return endpoint{}, parseErr
			}
			port = parsedPort
		}
		return endpoint{Host: parsed.Hostname(), Port: port}, nil
	}
	return parseEndpoint(value, defaultHivePort)
}

func shuffledEndpoints(values []endpoint, rejected map[string]bool) []endpoint {
	result := make([]endpoint, 0, len(values))
	for _, value := range values {
		if !rejected[value.address()] {
			result = append(result, value)
		}
	}
	rand.Shuffle(len(result), func(first, second int) {
		result[first], result[second] = result[second], result[first]
	})
	return result
}

func uniqueEndpoints(values []endpoint) []endpoint {
	seen := map[string]bool{}
	result := make([]endpoint, 0, len(values))
	for _, value := range values {
		key := value.address()
		if !seen[key] {
			seen[key] = true
			result = append(result, value)
		}
	}
	return result
}
