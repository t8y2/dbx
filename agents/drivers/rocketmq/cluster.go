package main

import (
	"context"
	"strconv"

	admin "github.com/amigoer/rocketmq-admin-go"
)

func (a *rocketMQAgent) describeCluster(_ map[string]any) (any, error) {
	client, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	info, err := client.ExamineBrokerClusterInfo(ctx)
	if err != nil {
		return nil, err
	}
	a.mu.RLock()
	proxies := a.proxies
	clusterName := a.clusterName
	a.mu.RUnlock()
	brokers := brokerNodes(info, proxies)
	var controller any
	if len(brokers) > 0 {
		controller = brokers[0]
	}
	return map[string]any{
		"clusterId": clusterName, "controller": controller,
		"brokers": brokers, "nodeCount": len(brokers),
	}, nil
}

func brokerNodes(info *admin.ClusterInfo, proxies *proxyManager) []map[string]any {
	if info == nil {
		return []map[string]any{}
	}
	nodes := make([]map[string]any, 0)
	id := 0
	for _, brokerName := range sortedKeys(info.BrokerAddrTable) {
		broker := info.BrokerAddrTable[brokerName]
		if broker == nil {
			continue
		}
		for _, brokerID := range sortedKeys(broker.BrokerAddrs) {
			address := broker.BrokerAddrs[brokerID]
			if original := proxies.OriginalForLocal(address); original != "" {
				address = original
			}
			host, portText := parseSocketAddress(address)
			port, _ := strconv.Atoi(portText)
			brokerIDValue, _ := strconv.ParseInt(brokerID, 10, 64)
			role := "SLAVE"
			if brokerIDValue == 0 {
				role = "MASTER"
			}
			nodes = append(nodes, map[string]any{
				"id": id, "host": host, "port": port, "rack": nil,
				"brokerName": broker.BrokerName, "brokerId": brokerIDValue, "role": role,
			})
			id++
		}
	}
	return nodes
}
