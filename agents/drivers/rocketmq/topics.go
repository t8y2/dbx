package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

var reservedTopicNames = map[string]struct{}{
	"TBW102": {}, "BenchmarkTest": {}, "SELF_TEST_TOPIC": {},
	"OFFSET_MOVED_EVENT": {}, "DefaultHeartBeatSyncerTopic": {},
}

type topicConfigWire struct {
	TopicName       string            `json:"topicName"`
	ReadQueueNums   int               `json:"readQueueNums"`
	WriteQueueNums  int               `json:"writeQueueNums"`
	Perm            int               `json:"perm"`
	TopicFilterType string            `json:"topicFilterType"`
	TopicSysFlag    int               `json:"topicSysFlag"`
	Order           bool              `json:"order"`
	Attributes      map[string]string `json:"attributes"`
}

func (a *rocketMQAgent) listTopics(params map[string]any) (any, error) {
	client, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()

	a.mu.RLock()
	clusterName, brokerAddr := a.clusterName, a.brokerAddr
	a.mu.RUnlock()
	topicList, err := client.FetchTopicsByCluster(ctx, clusterName)
	if err != nil {
		topicList, err = client.FetchAllTopicList(ctx)
	}
	if err != nil {
		return nil, err
	}
	_ = brokerAddr
	configs, complete := a.collectTopicConfigs(ctx)
	keyword := strings.ToLower(stringValue(params, "keyword"))
	rows := make([]map[string]any, 0, len(topicList.TopicList))
	names := make(map[string]struct{}, len(topicList.TopicList)+len(configs))
	for _, name := range topicList.TopicList {
		names[name] = struct{}{}
	}
	for name := range configs {
		names[name] = struct{}{}
	}
	if complete && len(configs) > 0 {
		names = make(map[string]struct{}, len(configs))
		for name := range configs {
			names[name] = struct{}{}
		}
	}
	for _, name := range sortedKeys(names) {
		if keyword != "" && !strings.Contains(strings.ToLower(name), keyword) {
			continue
		}
		configEntry := configs[name]
		partitions := 0
		perm := 6
		messageType := classifyTopicMessageType(name, clusterName, nil)
		if configEntry != nil {
			partitions = max(configEntry.ReadQueueNums, 1)
			perm = configEntry.Perm
			messageType = classifyTopicMessageType(name, clusterName, configEntry.Attributes)
		}
		if partitions <= 0 {
			if route, routeErr := client.ExamineTopicRouteInfo(ctx, name); routeErr == nil {
				if len(route.QueueDatas) > 0 {
					partitions = max(route.QueueDatas[0].ReadQueueNums, 1)
				}
			}
		}
		if partitions <= 0 {
			partitions = 1
		}
		rows = append(rows, map[string]any{
			"name": name, "partitions": partitions, "replicationFactor": 1,
			"internal":    messageType == "SYSTEM" || messageType == "RETRY" || messageType == "DLQ",
			"messageType": messageType, "readQueueNums": partitions,
			"writeQueueNums": writeQueueNums(configEntry, partitions), "perm": perm,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i]["name"].(string) < rows[j]["name"].(string) })
	offset := max(0, intValue(params, 0, "offset"))
	limit := intValue(params, 200, "limit")
	return map[string]any{
		"topics": paginate(rows, offset, limit), "total": len(rows), "offset": offset, "limit": limit,
	}, nil
}

func (a *rocketMQAgent) createTopic(params map[string]any) (any, error) {
	name, err := requireString(params, "name")
	if err != nil {
		return nil, err
	}
	readQueues := max(1, intValue(params, 8, "readQueueNums", "partitions"))
	writeQueues := max(1, intValue(params, readQueues, "writeQueueNums"))
	perm := normalizeTopicPerm(intValue(params, 6, "perm"))
	messageType := normalizeMessageType(stringValue(params, "messageType"))
	addresses, err := a.masterBrokerAddresses(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	_, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	for _, address := range addresses {
		if err := writeTopicConfig(ctx, address, &topicConfigWire{
			TopicName: name, ReadQueueNums: readQueues, WriteQueueNums: writeQueues,
			Perm: perm, TopicFilterType: "SINGLE_TAG", Attributes: map[string]string{"+message.type": messageType},
		}); err != nil {
			return nil, err
		}
	}
	return okResult(), nil
}

func writeTopicConfig(ctx context.Context, address string, config *topicConfigWire) error {
	fields := map[string]string{
		"topic": config.TopicName, "defaultTopic": "TBW102", "readQueueNums": strconv.Itoa(config.ReadQueueNums),
		"writeQueueNums": strconv.Itoa(config.WriteQueueNums), "perm": strconv.Itoa(config.Perm),
		"topicFilterType": valueOrDefault(config.TopicFilterType, "SINGLE_TAG"),
		"topicSysFlag":    strconv.Itoa(config.TopicSysFlag), "order": strconv.FormatBool(config.Order),
		"attributes": topicAttributesString(config.Attributes),
	}
	command := remoting.NewRequest(remoting.UpdateAndCreateTopic, fields)
	_, err := invokeRemotingWithClient(ctx, address, command)
	return err
}

func (a *rocketMQAgent) deleteTopic(params map[string]any) (any, error) {
	name, err := requireString(params, "name")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	addresses, err := a.masterBrokerAddresses(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	for _, address := range addresses {
		if err := client.DeleteTopicInBroker(ctx, address, name); err != nil {
			return nil, err
		}
	}
	if err := client.DeleteTopicInNameServer(ctx, name); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (a *rocketMQAgent) updatePartitions(params map[string]any) (any, error) {
	name, err := requireString(params, "name")
	if err != nil {
		return nil, err
	}
	_, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	addresses, err := a.masterBrokerAddresses(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	readQueues := max(1, intValue(params, intValue(params, 1, "totalPartitions"), "readQueueNums"))
	writeQueues := max(1, intValue(params, readQueues, "writeQueueNums"))
	for _, address := range addresses {
		current, configErr := readTopicConfig(ctx, address, name)
		if configErr != nil {
			current = &topicConfigWire{TopicName: name, Perm: 6, TopicFilterType: "SINGLE_TAG"}
		}
		current.ReadQueueNums = readQueues
		current.WriteQueueNums = writeQueues
		if err := writeTopicConfig(ctx, address, current); err != nil {
			return nil, err
		}
	}
	return okResult(), nil
}

func (a *rocketMQAgent) getTopicRoute(params map[string]any) (any, error) {
	name, err := requireString(params, "name", "topic")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	route, err := client.ExamineTopicRouteInfo(ctx, name)
	if err != nil {
		return nil, err
	}
	a.mu.RLock()
	proxies := a.proxies
	a.mu.RUnlock()
	brokerDatas := make([]map[string]any, 0, len(route.BrokerDatas))
	for _, broker := range route.BrokerDatas {
		addresses := make(map[string]string, len(broker.BrokerAddrs))
		for brokerID, address := range broker.BrokerAddrs {
			if original := proxies.OriginalForLocal(address); original != "" {
				address = original
			}
			addresses[brokerID] = address
		}
		brokerDatas = append(brokerDatas, map[string]any{
			"brokerName": broker.BrokerName, "cluster": broker.Cluster, "brokerAddrs": addresses,
		})
	}
	queueDatas := make([]map[string]any, 0, len(route.QueueDatas))
	for _, queue := range route.QueueDatas {
		queueDatas = append(queueDatas, map[string]any{
			"brokerName": queue.BrokerName, "readQueueNums": queue.ReadQueueNums,
			"writeQueueNums": queue.WriteQueueNums, "perm": queue.Perm,
		})
	}
	return map[string]any{"topic": name, "queueDatas": queueDatas, "brokerDatas": brokerDatas}, nil
}

func (a *rocketMQAgent) getTopicStats(params map[string]any) (any, error) {
	name, err := requireString(params, "name", "topic")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	stats, err := a.examineTopicStats(ctx, client, name)
	if err != nil {
		return nil, err
	}
	partitionStats := make([]map[string]any, 0, len(stats))
	var total int64
	for key, offset := range stats {
		queue := parseMessageQueueKey(key)
		count := max(int64(0), offset.MaxOffset-offset.MinOffset)
		total += count
		partitionStats = append(partitionStats, map[string]any{
			"partition": queue.QueueID, "brokerName": queue.BrokerName,
			"beginOffset": offset.MinOffset, "endOffset": offset.MaxOffset,
			"messageCount": count, "lastTimestamp": offset.LastUpdateTimestamp,
		})
	}
	sort.Slice(partitionStats, func(i, j int) bool {
		return partitionStats[i]["partition"].(int) < partitionStats[j]["partition"].(int)
	})
	return map[string]any{
		"name": name, "partitions": len(partitionStats), "replicationFactor": 1,
		"totalMessages": total, "partitionStats": partitionStats,
	}, nil
}

func (a *rocketMQAgent) examineTopicStats(
	ctx context.Context,
	client *admin.Client,
	topic string,
) (map[string]*admin.TopicOffset, error) {
	route, err := client.ExamineTopicRouteInfo(ctx, topic)
	if err != nil {
		return nil, err
	}
	addresses := masterAddressesFromRoute(route)
	if len(addresses) == 0 {
		return nil, fmt.Errorf("no RocketMQ master broker found for topic %s", topic)
	}
	merged := make(map[string]*admin.TopicOffset)
	var lastErr error
	successCount := 0
	for _, address := range addresses {
		response, requestErr := invokeRemotingWithClient(ctx, address,
			remoting.NewRequest(remoting.GetTopicStatsInfo, map[string]string{"topic": topic}))
		if requestErr != nil {
			lastErr = requestErr
			continue
		}
		partial, decodeErr := decodeTopicStats(response.Body)
		if decodeErr != nil {
			lastErr = decodeErr
			continue
		}
		successCount++
		for key, offset := range partial {
			merged[key] = offset
		}
	}
	if successCount != len(addresses) {
		return nil, fmt.Errorf("query topic stats for %s on all masters: %w", topic, lastErr)
	}
	if len(merged) == 0 {
		return nil, fmt.Errorf("topic stats not found: %s", topic)
	}
	return merged, nil
}

func decodeTopicStats(body []byte) (map[string]*admin.TopicOffset, error) {
	var stats admin.TopicStatsTable
	if err := json.Unmarshal(repairRocketMQJSON(body), &stats); err != nil {
		return nil, fmt.Errorf("decode topic stats: %w", err)
	}
	if stats.OffsetTable == nil {
		stats.OffsetTable = make(map[string]*admin.TopicOffset)
	}
	return stats.OffsetTable, nil
}

func masterAddressesFromRoute(route *admin.TopicRouteData) []string {
	addresses := make(map[string]struct{})
	for _, broker := range route.BrokerDatas {
		if address := broker.BrokerAddrs["0"]; address != "" {
			addresses[address] = struct{}{}
		}
	}
	return sortedKeys(addresses)
}

func (a *rocketMQAgent) getTopicConfig(params map[string]any) (any, error) {
	name, err := requireString(params, "name", "topic")
	if err != nil {
		return nil, err
	}
	_, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	address, err := a.brokerAddressForName(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	topicConfig, err := readTopicConfig(ctx, address, name)
	if err != nil {
		return nil, err
	}
	configs := map[string]any{
		"readQueueNums":  configEntry(strconv.Itoa(topicConfig.ReadQueueNums)),
		"writeQueueNums": configEntry(strconv.Itoa(topicConfig.WriteQueueNums)),
		"perm":           configEntry(strconv.Itoa(topicConfig.Perm)),
	}
	return map[string]any{"configs": configs}, nil
}

func (a *rocketMQAgent) alterTopicConfig(params map[string]any) (any, error) {
	name, err := requireString(params, "name", "topic")
	if err != nil {
		return nil, err
	}
	_, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	address, err := a.brokerAddressForName(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	topicConfig, err := readTopicConfig(ctx, address, name)
	if err != nil {
		return nil, err
	}
	if entries, ok := params["configs"].([]any); ok {
		for _, raw := range entries {
			entry, _ := raw.(map[string]any)
			value := stringValue(entry, "value")
			switch stringValue(entry, "key") {
			case "readQueueNums":
				topicConfig.ReadQueueNums = intValue(entry, topicConfig.ReadQueueNums, "value")
			case "writeQueueNums":
				topicConfig.WriteQueueNums = intValue(entry, topicConfig.WriteQueueNums, "value")
			case "perm":
				topicConfig.Perm = normalizeTopicPerm(intValue(entry, topicConfig.Perm, "value"))
			case "retention.ms", "retention.bytes":
				if value != "" {
					return nil, fmt.Errorf("RocketMQ topic retention is broker-level and cannot be changed per topic")
				}
			}
		}
	}
	if err := writeTopicConfig(ctx, address, topicConfig); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (a *rocketMQAgent) skipTopicAccumulation(params map[string]any) (any, error) {
	topic, err := requireString(params, "topic", "name")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	groups, err := client.QueryTopicConsumeByWho(ctx, topic)
	if err != nil {
		return nil, err
	}
	reset := make([]string, 0, len(groups))
	for _, group := range groups {
		if _, resetErr := client.ResetOffsetByTimestamp(ctx, topic, group, time.Now().UnixMilli(), true); resetErr == nil {
			reset = append(reset, group)
		}
	}
	return map[string]any{"ok": true, "resetGroups": len(reset)}, nil
}

func (a *rocketMQAgent) masterBrokerAddresses(brokerName string) ([]string, error) {
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
	addresses := make([]string, 0)
	for _, name := range sortedKeys(info.BrokerAddrTable) {
		if brokerName != "" && brokerName != name {
			continue
		}
		if address := info.BrokerAddrTable[name].BrokerAddrs["0"]; address != "" {
			addresses = append(addresses, address)
		}
	}
	if len(addresses) == 0 {
		a.mu.RLock()
		fallback := a.brokerAddr
		a.mu.RUnlock()
		if fallback != "" {
			addresses = append(addresses, fallback)
		}
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("no RocketMQ master broker found")
	}
	return addresses, nil
}

func (a *rocketMQAgent) brokerAddressForName(brokerName string) (string, error) {
	addresses, err := a.masterBrokerAddresses(brokerName)
	if err != nil {
		return "", err
	}
	return addresses[0], nil
}

type parsedMessageQueue struct {
	Topic      string
	BrokerName string
	QueueID    int
}

func parseMessageQueueKey(value string) parsedMessageQueue {
	value = strings.TrimSpace(value)
	var queue struct {
		Topic      string `json:"topic"`
		BrokerName string `json:"brokerName"`
		QueueID    int    `json:"queueId"`
	}
	if strings.HasPrefix(value, "{") && json.Unmarshal([]byte(value), &queue) == nil {
		return parsedMessageQueue(queue)
	}
	if strings.HasPrefix(value, "MessageQueue [") && strings.HasSuffix(value, "]") {
		fields := strings.Split(strings.TrimSuffix(strings.TrimPrefix(value, "MessageQueue ["), "]"), ",")
		for _, field := range fields {
			keyValue := strings.SplitN(strings.TrimSpace(field), "=", 2)
			if len(keyValue) != 2 {
				continue
			}
			switch keyValue[0] {
			case "topic":
				queue.Topic = keyValue[1]
			case "brokerName":
				queue.BrokerName = keyValue[1]
			case "queueId":
				queue.QueueID, _ = strconv.Atoi(keyValue[1])
			}
		}
		return parsedMessageQueue(queue)
	}
	parts := strings.Split(value, "-")
	if len(parts) >= 3 {
		queueID, _ := strconv.Atoi(parts[len(parts)-1])
		return parsedMessageQueue{Topic: strings.Join(parts[:len(parts)-2], "-"), BrokerName: parts[len(parts)-2], QueueID: queueID}
	}
	return parsedMessageQueue{}
}

func configEntry(value string) map[string]any {
	return map[string]any{
		"value": value, "isDefault": false,
		"isReadOnly": false, "isSensitive": false, "source": "USER",
	}
}

func isSystemTopic(topic, cluster string) bool {
	if topic == "" {
		return true
	}
	if _, ok := reservedTopicNames[topic]; ok {
		return true
	}
	return strings.HasPrefix(topic, "%") || strings.HasPrefix(topic, "RMQ_SYS") ||
		strings.HasPrefix(topic, "rmq_sys") || strings.HasPrefix(topic, "SCHEDULE_TOPIC_") ||
		strings.HasPrefix(topic, "rocketmq-broker-") || strings.HasSuffix(topic, "_REPLY_TOPIC") || topic == cluster
}

func classifyTopicMessageType(topic, cluster string, attributes map[string]string) string {
	if strings.HasPrefix(topic, "%RETRY%") || strings.HasPrefix(topic, "%R") {
		return "RETRY"
	}
	if strings.HasPrefix(topic, "%DLQ%") || strings.HasPrefix(topic, "%D") {
		return "DLQ"
	}
	if isSystemTopic(topic, cluster) {
		return "SYSTEM"
	}
	for _, key := range []string{"message.type", "+message.type"} {
		if value := normalizeMessageType(attributes[key]); value != "NORMAL" || attributes[key] != "" {
			return value
		}
	}
	return "UNSPECIFIED"
}

func (a *rocketMQAgent) collectTopicConfigs(ctx context.Context) (map[string]*topicConfigWire, bool) {
	addresses, err := a.masterBrokerAddresses("")
	if err != nil {
		return map[string]*topicConfigWire{}, false
	}
	merged := make(map[string]*topicConfigWire)
	complete := true
	for _, address := range addresses {
		if a.proxies.IsCollisionFallback(address) && len(merged) > 0 {
			complete = false
			continue
		}
		configs, fetchErr := fetchAllTopicConfigs(ctx, address)
		if fetchErr != nil {
			complete = false
			continue
		}
		for name, config := range configs {
			if merged[name] == nil {
				merged[name] = config
			}
		}
	}
	return merged, complete
}

func fetchAllTopicConfigs(ctx context.Context, address string) (map[string]*topicConfigWire, error) {
	response, err := invokeRemotingWithClient(ctx, address, remoting.NewRequest(remoting.GetAllTopicConfig, nil))
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		TopicConfigTable map[string]*topicConfigWire `json:"topicConfigTable"`
	}
	if err := json.Unmarshal(repairRocketMQJSON(response.Body), &wrapper); err != nil {
		return nil, err
	}
	return wrapper.TopicConfigTable, nil
}

func readTopicConfig(ctx context.Context, address, topic string) (*topicConfigWire, error) {
	response, err := invokeRemotingWithClient(ctx, address, remoting.NewRequest(remoting.GetTopicConfig, map[string]string{"topic": topic}))
	if err == nil {
		var config topicConfigWire
		if decodeErr := json.Unmarshal(repairRocketMQJSON(response.Body), &config); decodeErr != nil {
			return nil, decodeErr
		}
		return &config, nil
	}
	configs, fallbackErr := fetchAllTopicConfigs(ctx, address)
	if fallbackErr != nil {
		return nil, fmt.Errorf("read topic config %s: %v; fallback snapshot: %w", topic, err, fallbackErr)
	}
	config := configs[topic]
	if config == nil {
		return nil, fmt.Errorf("topic config not found: %s", topic)
	}
	if config.TopicName == "" {
		config.TopicName = topic
	}
	return config, nil
}

func topicAttributesString(attributes map[string]string) string {
	keys := sortedKeys(attributes)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		if !strings.HasPrefix(key, "+") && !strings.HasPrefix(key, "-") {
			continue
		}
		if attributes[key] == "" {
			parts = append(parts, key)
		} else {
			parts = append(parts, key+"="+attributes[key])
		}
	}
	return strings.Join(parts, ",")
}

func writeQueueNums(config *topicConfigWire, fallback int) int {
	if config == nil || config.WriteQueueNums <= 0 {
		return fallback
	}
	return config.WriteQueueNums
}
