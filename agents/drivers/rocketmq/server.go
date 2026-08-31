package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	admin "github.com/amigoer/rocketmq-admin-go"
)

const (
	protocolVersion      = 1
	agentProtocolVersion = 1
)

var capabilities = []string{
	"mq_connect", "mq_test_connection", "mq_topics", "mq_consumer_groups",
	"mq_messages", "mq_acl", "mq_config", "mq_monitoring",
}

type rocketMQAgent struct {
	mu                sync.RWMutex
	client            *admin.Client
	connection        connectionConfig
	proxies           *proxyManager
	clusterName       string
	brokerAddr        string
	shutdownRequested bool
}

func newRocketMQAgent() *rocketMQAgent {
	return &rocketMQAgent{}
}

func (a *rocketMQAgent) dispatch(method string, raw json.RawMessage) (any, error) {
	params, err := decodeParams(raw)
	if err != nil {
		return nil, err
	}
	switch method {
	case "handshake":
		return map[string]any{
			"protocolVersion":      protocolVersion,
			"agentProtocolVersion": agentProtocolVersion,
			"capabilities":         capabilities,
		}, nil
	case "connect":
		return a.connect(params)
	case "test_connection":
		return a.testConnection(params)
	case "disconnect":
		a.close()
		return okResult(), nil
	case "shutdown":
		a.close()
		a.shutdownRequested = true
		return okResult(), nil
	case "mq_list_topics":
		return a.listTopics(params)
	case "mq_create_topic":
		return a.createTopic(params)
	case "mq_delete_topic":
		return a.deleteTopic(params)
	case "mq_update_partitions":
		return a.updatePartitions(params)
	case "mq_get_topic_stats":
		return a.getTopicStats(params)
	case "mq_get_topic_route":
		return a.getTopicRoute(params)
	case "mq_get_topic_config":
		return a.getTopicConfig(params)
	case "mq_alter_topic_config":
		return a.alterTopicConfig(params)
	case "mq_skip_topic_accumulation":
		return a.skipTopicAccumulation(params)
	case "mq_list_consumer_groups":
		return a.listConsumerGroups(params)
	case "mq_describe_consumer_group":
		return a.describeConsumerGroup(params)
	case "mq_delete_consumer_group":
		return a.deleteConsumerGroup(params)
	case "mq_get_subscription_group_config":
		return a.getSubscriptionGroupConfig(params)
	case "mq_alter_subscription_group_config":
		return a.alterSubscriptionGroupConfig(params)
	case "mq_reset_consumer_group_offsets":
		return a.resetConsumerGroupOffsets(params)
	case "mq_get_consumer_lag":
		return a.getConsumerLag(params)
	case "mq_list_producers":
		return a.listProducers(params)
	case "mq_peek_messages":
		return a.peekMessages(params)
	case "mq_view_message":
		return a.viewMessage(params)
	case "mq_query_message_by_key":
		return a.queryMessageByKey(params)
	case "mq_query_message_by_topic":
		return a.queryMessageByTopic(params)
	case "mq_query_message_trace":
		return a.queryMessageTrace(params)
	case "mq_send_message":
		return a.sendMessage(params)
	case "mq_list_acls":
		return a.listACLs(params)
	case "mq_create_acls":
		return a.createACLs(params)
	case "mq_delete_acls":
		return a.deleteACLs(params)
	case "mq_describe_cluster":
		return a.describeCluster(params)
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}

func (a *rocketMQAgent) requireClient() (*admin.Client, connectionConfig, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.client == nil {
		return nil, connectionConfig{}, errors.New("RocketMQ agent is not connected")
	}
	return a.client, a.connection, nil
}

func (a *rocketMQAgent) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client != nil {
		_ = a.client.Close()
	}
	if a.proxies != nil {
		a.proxies.Close()
	}
	a.client = nil
	a.proxies = nil
	a.connection = connectionConfig{}
	a.clusterName = ""
	a.brokerAddr = ""
}

func decodeParams(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}, nil
	}
	var params map[string]any
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	return params, nil
}

func normalizeError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return "RocketMQ operation failed"
	}
	return message
}

func okResult() map[string]any {
	return map[string]any{"ok": true}
}
