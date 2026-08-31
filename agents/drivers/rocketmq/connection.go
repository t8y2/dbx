package main

import (
	"context"
	"fmt"
	"time"

	admin "github.com/amigoer/rocketmq-admin-go"
)

const (
	defaultRequestTimeout          = 30 * time.Second
	defaultConnectTimeout          = 10 * time.Second
	brokerRegistrationPollInterval = 100 * time.Millisecond
)

type socksProxyConfig struct {
	Host     string
	Port     int
	Username string
	Password string
}

type connectionConfig struct {
	NameServers    []string
	ClusterName    string
	BrokerAddr     string
	AccessKey      string
	SecretKey      string
	RequestTimeout time.Duration
	ConnectTimeout time.Duration
	TLSSkipVerify  bool
	SocksProxy     *socksProxyConfig
}

func parseConnection(params map[string]any) (connectionConfig, error) {
	connection := nestedMap(params, "connection")
	if connection == nil {
		connection = params
	}
	nameServers := splitAddresses(stringValue(connection, "namesrv_addr", "namesrvAddr"))
	if len(nameServers) == 0 {
		return connectionConfig{}, fmt.Errorf("namesrv_addr is required")
	}
	config := connectionConfig{
		NameServers:    nameServers,
		ClusterName:    stringValue(connection, "cluster_name", "clusterName"),
		BrokerAddr:     stringValue(connection, "broker_addr", "brokerAddr"),
		AccessKey:      stringValue(connection, "access_key", "accessKey"),
		SecretKey:      stringValue(connection, "secret_key", "secretKey"),
		RequestTimeout: time.Duration(intValue(connection, int(defaultRequestTimeout/time.Millisecond), "request_timeout_ms")) * time.Millisecond,
		ConnectTimeout: time.Duration(intValue(connection, int(defaultConnectTimeout/time.Millisecond), "connect_timeout_ms")) * time.Millisecond,
		TLSSkipVerify:  boolValue(connection, false, "tls_skip_verify"),
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = defaultRequestTimeout
	}
	if config.ConnectTimeout <= 0 {
		config.ConnectTimeout = defaultConnectTimeout
	}
	if proxy := nestedMap(connection, "socks_proxy"); proxy != nil {
		host := stringValue(proxy, "host")
		port := intValue(proxy, 0, "port")
		if host == "" || port <= 0 || port > 65535 {
			return connectionConfig{}, fmt.Errorf("socks_proxy host and port are required")
		}
		config.SocksProxy = &socksProxyConfig{
			Host: host, Port: port,
			Username: stringValue(proxy, "username"),
			Password: stringValue(proxy, "password"),
		}
	}
	return config, nil
}

func (a *rocketMQAgent) connect(params map[string]any) (any, error) {
	config, err := parseConnection(params)
	if err != nil {
		return nil, err
	}
	client, proxies, clusterInfo, err := buildClient(config)
	if err != nil {
		return nil, err
	}

	clusterName := resolveClusterName(clusterInfo, config.ClusterName)
	brokerAddr, err := resolveBrokerAddr(clusterInfo, config, proxies)
	if err != nil {
		client.Close()
		proxies.Close()
		return nil, err
	}

	a.mu.Lock()
	oldClient, oldProxies := a.client, a.proxies
	a.client = client
	a.proxies = proxies
	a.connection = config
	a.clusterName = clusterName
	a.brokerAddr = brokerAddr
	a.mu.Unlock()
	if oldClient != nil {
		_ = oldClient.Close()
	}
	if oldProxies != nil {
		oldProxies.Close()
	}
	return clusterTestResult(client, clusterInfo, config, proxies), nil
}

func (a *rocketMQAgent) testConnection(params map[string]any) (any, error) {
	config, err := parseConnection(params)
	if err != nil {
		return nil, err
	}
	a.mu.RLock()
	if a.client != nil && a.connection.equal(config) {
		client, proxies := a.client, a.proxies
		a.mu.RUnlock()
		ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
		defer cancel()
		clusterInfo, err := client.ExamineBrokerClusterInfo(ctx)
		if err != nil {
			return nil, err
		}
		return clusterTestResult(client, clusterInfo, config, proxies), nil
	}
	a.mu.RUnlock()

	client, proxies, clusterInfo, err := buildClient(config)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	defer proxies.Close()
	return clusterTestResult(client, clusterInfo, config, proxies), nil
}

func buildClient(config connectionConfig) (*admin.Client, *proxyManager, *admin.ClusterInfo, error) {
	proxies := newProxyManager(config)
	localNameServers := make([]string, 0, len(config.NameServers))
	for _, address := range config.NameServers {
		local, err := proxies.ProxyFor(address, proxyTargetNameServer)
		if err != nil {
			proxies.Close()
			return nil, nil, nil, err
		}
		localNameServers = append(localNameServers, local)
	}
	client, err := admin.NewClient(
		admin.WithNameServers(localNameServers),
		admin.WithTimeout(config.RequestTimeout),
		admin.WithRetryTimes(1),
	)
	if err != nil {
		proxies.Close()
		return nil, nil, nil, err
	}
	if err := client.Start(); err != nil {
		proxies.Close()
		return nil, nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.ConnectTimeout)
	defer cancel()
	clusterInfo, err := waitForBrokerRegistration(ctx, brokerRegistrationPollInterval, client.ExamineBrokerClusterInfo)
	if err != nil {
		client.Close()
		proxies.Close()
		return nil, nil, nil, err
	}
	return client, proxies, clusterInfo, nil
}

func waitForBrokerRegistration(
	ctx context.Context,
	pollInterval time.Duration,
	examine func(context.Context) (*admin.ClusterInfo, error),
) (*admin.ClusterInfo, error) {
	if pollInterval <= 0 {
		pollInterval = brokerRegistrationPollInterval
	}
	var lastErr error
	for {
		clusterInfo, err := examine(ctx)
		if err == nil && hasMasterBroker(clusterInfo) {
			return clusterInfo, nil
		}
		if err != nil {
			lastErr = err
		}

		timer := time.NewTimer(pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			if lastErr != nil {
				return nil, fmt.Errorf("wait for RocketMQ broker registration after %v: %w", lastErr, ctx.Err())
			}
			return nil, fmt.Errorf("wait for RocketMQ broker registration: %w", ctx.Err())
		case <-timer.C:
		}
	}
}

func hasMasterBroker(info *admin.ClusterInfo) bool {
	if info == nil {
		return false
	}
	for _, broker := range info.BrokerAddrTable {
		if broker != nil && broker.BrokerAddrs["0"] != "" {
			return true
		}
	}
	return false
}

func clusterTestResult(client *admin.Client, info *admin.ClusterInfo, config connectionConfig, proxies *proxyManager) map[string]any {
	brokers := brokerNodes(info, proxies)
	aclEnabled := false
	if len(brokers) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), minDuration(config.ConnectTimeout/2, 5*time.Second))
		defer cancel()
		brokerAddr, err := resolveBrokerAddr(info, config, proxies)
		if err == nil {
			_, aclErr := client.GetBrokerClusterAclInfo(ctx, brokerAddr)
			aclEnabled = aclErr == nil
		}
	}
	var controller any
	if len(brokers) > 0 {
		controller = brokers[0]
	}
	return map[string]any{
		"ok": true, "clusterId": resolveClusterName(info, config.ClusterName),
		"brokers": brokers, "nodeCount": len(brokers), "controller": controller,
		"aclEnabled": aclEnabled,
	}
}

func (config connectionConfig) equal(other connectionConfig) bool {
	if config.ClusterName != other.ClusterName || config.BrokerAddr != other.BrokerAddr ||
		config.AccessKey != other.AccessKey || config.SecretKey != other.SecretKey ||
		config.RequestTimeout != other.RequestTimeout || config.ConnectTimeout != other.ConnectTimeout ||
		config.TLSSkipVerify != other.TLSSkipVerify ||
		len(config.NameServers) != len(other.NameServers) {
		return false
	}
	for index := range config.NameServers {
		if config.NameServers[index] != other.NameServers[index] {
			return false
		}
	}
	if (config.SocksProxy == nil) != (other.SocksProxy == nil) {
		return false
	}
	return config.SocksProxy == nil || *config.SocksProxy == *other.SocksProxy
}

func resolveClusterName(info *admin.ClusterInfo, configured string) string {
	if configured != "" {
		return configured
	}
	for _, name := range sortedKeys(info.ClusterAddrTable) {
		return name
	}
	return "DefaultCluster"
}

func resolveBrokerAddr(info *admin.ClusterInfo, config connectionConfig, proxies *proxyManager) (string, error) {
	if config.BrokerAddr != "" {
		if local := proxies.LocalForOriginal(config.BrokerAddr); local != "" {
			return local, nil
		}
		return proxies.ProxyFor(config.BrokerAddr, proxyTargetBroker)
	}
	for _, brokerName := range sortedKeys(info.BrokerAddrTable) {
		broker := info.BrokerAddrTable[brokerName]
		if address := broker.BrokerAddrs["0"]; address != "" {
			return address, nil
		}
		for _, brokerID := range sortedKeys(broker.BrokerAddrs) {
			if broker.BrokerAddrs[brokerID] != "" {
				return broker.BrokerAddrs[brokerID], nil
			}
		}
	}
	return "", fmt.Errorf("no RocketMQ broker address found")
}

func minDuration(left, right time.Duration) time.Duration {
	if left <= 0 || left > right {
		return right
	}
	return left
}
