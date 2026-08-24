package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

var systemConsumerGroups = map[string]struct{}{
	"TOOLS_CONSUMER": {}, "FILTERSRV_CONSUMER": {}, "SELF_TEST_C_GROUP": {},
	"CID_ONS-HTTP-PROXY": {}, "CID_ONSAPI_PULL": {}, "CID_ONSAPI_PERMISSION": {},
	"CID_ONSAPI_OWNER": {}, "CID_SYS_RMQ_TRANS": {}, "CID_DefaultHeartBeatSyncerTopic": {},
}

type subscriptionGroupConfig struct {
	GroupName                      string `json:"groupName"`
	ConsumeEnable                  bool   `json:"consumeEnable"`
	ConsumeFromMinEnable           bool   `json:"consumeFromMinEnable"`
	ConsumeBroadcastEnable         bool   `json:"consumeBroadcastEnable"`
	ConsumeMessageOrderly          bool   `json:"consumeMessageOrderly"`
	RetryQueueNums                 int    `json:"retryQueueNums"`
	RetryMaxTimes                  int    `json:"retryMaxTimes"`
	BrokerID                       int64  `json:"brokerId"`
	WhichBrokerWhenConsumeSlowly   int64  `json:"whichBrokerWhenConsumeSlowly"`
	NotifyConsumerIDsChangedEnable bool   `json:"notifyConsumerIdsChangedEnable"`
}

func (a *rocketMQAgent) listConsumerGroups(params map[string]any) (any, error) {
	client, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()

	configs, err := a.collectSubscriptionGroupConfigs(ctx)
	if err != nil {
		return nil, err
	}
	topicFilter := stringValue(params, "topic")
	groupNames := make([]string, 0)
	if topicFilter != "" {
		groups, queryErr := client.QueryTopicConsumeByWho(ctx, topicFilter)
		if queryErr != nil {
			return nil, queryErr
		}
		groupNames = append(groupNames, groups...)
	} else {
		for name := range configs {
			groupNames = append(groupNames, name)
		}
	}
	sort.Strings(groupNames)
	groupNames = uniqueStrings(groupNames)
	keyword := strings.ToLower(stringValue(params, "keyword"))
	rows := make([]map[string]any, 0, len(groupNames))
	for _, groupID := range groupNames {
		if keyword != "" && !strings.Contains(strings.ToLower(groupID), keyword) {
			continue
		}
		row := map[string]any{
			"groupId": groupID, "state": "UNKNOWN", "simpleGroup": false,
			"groupType": classifyConsumerGroup(groupID, configs[groupID]), "messageModel": "CLUSTERING",
		}
		if topicFilter != "" {
			row["topics"] = []string{topicFilter}
		}
		rows = append(rows, row)
	}

	offset := max(0, intValue(params, 0, "offset"))
	limit := intValue(params, 200, "limit")
	if limit <= 0 {
		limit = 200
	}
	page := paginate(rows, offset, limit)
	if boolValue(params, false, "enrich") {
		a.enrichConsumerGroups(ctx, client, page)
	}
	if topicFilter != "" && boolValue(params, false, "includeLag") {
		a.attachConsumerGroupLag(page, topicFilter)
	}
	return map[string]any{
		"groups": page, "total": len(rows), "offset": offset, "limit": limit,
	}, nil
}

func (a *rocketMQAgent) describeConsumerGroup(params map[string]any) (any, error) {
	groupID, err := requireString(params, "groupId")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	connection, err := client.ExamineConsumerConnectionInfo(ctx, groupID)
	if err != nil {
		return nil, err
	}
	assignments := make([]map[string]any, 0, len(connection.SubscriptionTable))
	for _, topic := range sortedKeys(connection.SubscriptionTable) {
		subscription := connection.SubscriptionTable[topic]
		assignments = append(assignments, map[string]any{
			"topic": subscription.Topic, "subExpression": subscription.SubString,
		})
	}
	members := make([]map[string]any, 0, len(connection.ConnectionSet))
	for _, member := range connection.ConnectionSet {
		members = append(members, map[string]any{
			"memberId": member.ClientId, "clientId": member.ClientId,
			"host": member.ClientAddr, "assignments": assignments,
		})
	}
	return map[string]any{
		"groupId": groupID, "state": valueOrDefault(connection.ConsumeType, "UNKNOWN"),
		"partitionAssignor": emptyToNil(connection.MessageModel),
		"messageModel":      emptyToNil(connection.MessageModel), "members": members,
	}, nil
}

func (a *rocketMQAgent) deleteConsumerGroup(params map[string]any) (any, error) {
	groupID, err := requireString(params, "groupId")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	addresses, err := a.masterBrokerAddresses("")
	if err != nil {
		return nil, err
	}
	successCount := 0
	var lastErr error
	for _, address := range addresses {
		if mutationErr := client.DeleteSubscriptionGroup(ctx, address, groupID); mutationErr != nil {
			lastErr = mutationErr
			continue
		}
		successCount++
	}
	if err := ensureMutationCoverage("delete", "consumer group "+groupID, len(addresses), successCount, lastErr); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (a *rocketMQAgent) getSubscriptionGroupConfig(params map[string]any) (any, error) {
	groupID, err := requireString(params, "groupId")
	if err != nil {
		return nil, err
	}
	_, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	configs, err := a.collectSubscriptionGroupConfigs(ctx)
	if err != nil {
		return nil, err
	}
	groupConfig := configs[groupID]
	if groupConfig == nil {
		return nil, fmt.Errorf("consumer group not found: %s", groupID)
	}
	return subscriptionGroupConfigMap(groupConfig), nil
}

func (a *rocketMQAgent) alterSubscriptionGroupConfig(params map[string]any) (any, error) {
	groupID, err := requireString(params, "groupId")
	if err != nil {
		return nil, err
	}
	_, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	configs, collectErr := a.collectSubscriptionGroupConfigs(ctx)
	if collectErr != nil {
		return nil, collectErr
	}
	groupConfig := configs[groupID]
	if groupConfig == nil {
		groupConfig = &subscriptionGroupConfig{
			GroupName: groupID, ConsumeEnable: true, ConsumeFromMinEnable: true,
			RetryQueueNums: 1, RetryMaxTimes: 16, NotifyConsumerIDsChangedEnable: true,
		}
	}
	applySubscriptionGroupUpdates(groupConfig, params)
	addresses, err := a.masterBrokerAddresses("")
	if err != nil {
		return nil, err
	}
	successCount := 0
	var lastErr error
	for _, address := range addresses {
		if mutationErr := writeSubscriptionGroupConfig(ctx, address, groupConfig); mutationErr != nil {
			lastErr = mutationErr
			continue
		}
		successCount++
	}
	if err := ensureMutationCoverage("update", "consumer group "+groupID, len(addresses), successCount, lastErr); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (a *rocketMQAgent) resetConsumerGroupOffsets(params map[string]any) (any, error) {
	groupID, err := requireString(params, "groupId")
	if err != nil {
		return nil, err
	}
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	if offsets, ok := params["offsets"].([]any); ok && len(offsets) > 0 {
		address, addressErr := a.brokerAddressForName(stringValue(params, "brokerName"))
		if addressErr != nil {
			return nil, addressErr
		}
		for _, raw := range offsets {
			offset, _ := raw.(map[string]any)
			if err := client.UpdateConsumeOffset(ctx, address, groupID, topic,
				intValue(offset, 0, "partition"), int64Value(offset, 0, "offset")); err != nil {
				return nil, err
			}
		}
		return okResult(), nil
	}
	position := strings.ToLower(stringValue(params, "position"))
	if position == "" {
		position = "latest"
	}
	var timestamp int64
	switch position {
	case "earliest":
		timestamp = 0
	case "latest":
		timestamp = time.Now().UnixMilli()
	case "timestamp":
		timestamp = int64Value(params, time.Now().UnixMilli(), "timestampMs")
	default:
		return nil, fmt.Errorf("unsupported reset position: %s", position)
	}
	if _, err := client.ResetOffsetByTimestamp(ctx, topic, groupID, timestamp, true); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (a *rocketMQAgent) getConsumerLag(params map[string]any) (any, error) {
	groupID, err := requireString(params, "groupId")
	if err != nil {
		return nil, err
	}
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	stats, err := a.examineConsumeStatsByTopic(ctx, client, groupID, topic)
	if err != nil {
		return nil, err
	}
	consumerClients := resolveConsumerClients(ctx, remotingConsumeStatusReader{
		client: client,
		invoke: invokeRemotingWithClient,
	}, groupID, topic)
	return buildConsumerLagResult(stats, consumerClients), nil
}

type consumeStatusReader interface {
	GetConsumeStatus(context.Context, string, string, string) (map[string]map[string]int64, error)
}

type consumerStatusInvoker func(
	context.Context,
	string,
	*remoting.RemotingCommand,
) (*remoting.RemotingCommand, error)

type remotingConsumeStatusReader struct {
	client *admin.Client
	invoke consumerStatusInvoker
}

func (r remotingConsumeStatusReader) GetConsumeStatus(
	ctx context.Context,
	topic string,
	groupID string,
	clientAddr string,
) (map[string]map[string]int64, error) {
	route, err := r.client.ExamineTopicRouteInfo(ctx, topic)
	if err != nil {
		return nil, err
	}
	return readConsumerStatusFromBrokers(
		ctx, masterAddressesFromRoute(route), topic, groupID, clientAddr, r.invoke,
	)
}

func readConsumerStatusFromBrokers(
	ctx context.Context,
	addresses []string,
	topic string,
	groupID string,
	clientAddr string,
	invoke consumerStatusInvoker,
) (map[string]map[string]int64, error) {
	if len(addresses) == 0 {
		return nil, fmt.Errorf("no RocketMQ master broker found for topic %s", topic)
	}
	orderedAddresses := append([]string(nil), addresses...)
	sort.Strings(orderedAddresses)
	merged := make(map[string]map[string]int64)
	successCount := 0
	var lastErr error
	for _, address := range orderedAddresses {
		fields := map[string]string{"topic": topic, "group": groupID}
		if clientAddr != "" {
			fields["clientAddr"] = clientAddr
		}
		response, requestErr := invoke(ctx, address,
			remoting.NewRequest(remoting.InvokeBrokerToGetConsumerStatus, fields))
		if requestErr != nil {
			lastErr = requestErr
			continue
		}
		if response == nil {
			lastErr = fmt.Errorf("empty consumer status response from %s", address)
			continue
		}
		partial, decodeErr := decodeConsumerStatus(response.Body)
		if decodeErr != nil {
			lastErr = decodeErr
			continue
		}
		successCount++
		for _, clientID := range sortedKeys(partial) {
			if merged[clientID] == nil {
				merged[clientID] = make(map[string]int64)
			}
			for _, queueKey := range sortedKeys(partial[clientID]) {
				merged[clientID][queueKey] = partial[clientID][queueKey]
			}
		}
	}
	if successCount == 0 {
		return nil, fmt.Errorf("query consumer status for group %s on all masters: %w", groupID, lastErr)
	}
	return merged, nil
}

func decodeConsumerStatus(body []byte) (map[string]map[string]int64, error) {
	// RocketMQ wraps assignments in GetConsumerStatusBody; admin-go v1.1.1
	// incorrectly decodes the complete response as the inner table.
	var wrapper struct {
		ConsumerTable map[string]map[string]int64 `json:"consumerTable"`
	}
	if err := json.Unmarshal(repairConsumerStatusJSON(body), &wrapper); err != nil {
		return nil, fmt.Errorf("decode consumer status: %w", err)
	}
	if wrapper.ConsumerTable == nil {
		wrapper.ConsumerTable = make(map[string]map[string]int64)
	}
	return wrapper.ConsumerTable, nil
}

func repairConsumerStatusJSON(body []byte) []byte {
	repaired := repairRocketMQJSON(body)
	result := make([]byte, 0, len(repaired)+64)
	for index := 0; index < len(repaired); {
		mapStart := index + 1
		for mapStart < len(repaired) && isJSONSpace(repaired[mapStart]) {
			mapStart++
		}
		if repaired[index] == ':' && mapStart+1 < len(repaired) &&
			repaired[mapStart] == '{' && repaired[mapStart+1] == '{' {
			if converted, next, ok := convertObjectKeyedInt64Map(repaired, mapStart); ok {
				result = append(result, repaired[index:mapStart]...)
				result = append(result, converted...)
				index = next
				continue
			}
		}
		result = append(result, repaired[index])
		index++
	}
	return result
}

func convertObjectKeyedInt64Map(body []byte, start int) ([]byte, int, bool) {
	result := []byte{'{'}
	index := start + 1
	first := true
	for index < len(body) {
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		if index >= len(body) {
			return nil, start, false
		}
		if body[index] == '}' {
			return append(result, '}'), index + 1, true
		}
		if body[index] == ',' {
			index++
			continue
		}
		if body[index] != '{' {
			return nil, start, false
		}
		keyEnd := matchingBrace(body, index)
		if keyEnd < 0 {
			return nil, start, false
		}
		key := body[index : keyEnd+1]
		index = keyEnd + 1
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		if index >= len(body) || body[index] != ':' {
			return nil, start, false
		}
		index++
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		valueStart := index
		if index < len(body) && body[index] == '-' {
			index++
		}
		digitStart := index
		for index < len(body) && body[index] >= '0' && body[index] <= '9' {
			index++
		}
		if index == digitStart {
			return nil, start, false
		}
		valueEnd := index
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		if index >= len(body) || (body[index] != ',' && body[index] != '}') {
			return nil, start, false
		}
		if !first {
			result = append(result, ',')
		}
		first = false
		result = append(result, '"')
		result = append(result, escapeJSONString(key)...)
		result = append(result, '"', ':')
		result = append(result, body[valueStart:valueEnd]...)
	}
	return nil, start, false
}

func resolveConsumerClients(
	ctx context.Context,
	reader consumeStatusReader,
	groupID string,
	topic string,
) map[parsedMessageQueue]string {
	clients := make(map[parsedMessageQueue]string)
	status, err := reader.GetConsumeStatus(ctx, topic, groupID, "")
	if err != nil {
		return clients
	}
	clientIDs := sortedKeys(status)
	for _, clientID := range clientIDs {
		if clientID == "" {
			continue
		}
		for _, key := range sortedKeys(status[clientID]) {
			queue := parseMessageQueueKey(key)
			if queue.Topic == "" || queue.BrokerName == "" || queue.QueueID < 0 {
				continue
			}
			if _, exists := clients[queue]; !exists {
				clients[queue] = clientID
			}
		}
	}
	return clients
}

func buildConsumerLagResult(
	stats *admin.ConsumeStats,
	consumerClients map[parsedMessageQueue]string,
) map[string]any {
	partitions := make([]map[string]any, 0, len(stats.OffsetTable))
	var totalLag int64
	for key, offset := range stats.OffsetTable {
		queue := parseMessageQueueKey(key)
		lag := max(int64(0), offset.BrokerOffset-offset.ConsumerOffset)
		totalLag += lag
		partitions = append(partitions, map[string]any{
			"partition": queue.QueueID, "currentOffset": offset.ConsumerOffset,
			"endOffset": offset.BrokerOffset, "lag": lag, "brokerName": queue.BrokerName,
			"lastTimestamp": offset.LastTimestamp, "consumerClient": consumerClients[queue],
		})
	}
	sort.Slice(partitions, func(i, j int) bool {
		left, right := partitions[i], partitions[j]
		if left["brokerName"] != right["brokerName"] {
			return fmt.Sprint(left["brokerName"]) < fmt.Sprint(right["brokerName"])
		}
		return left["partition"].(int) < right["partition"].(int)
	})
	return map[string]any{"partitions": partitions, "totalLag": totalLag}
}

func (a *rocketMQAgent) examineConsumeStatsByTopic(
	ctx context.Context,
	client *admin.Client,
	groupID string,
	topic string,
) (*admin.ConsumeStats, error) {
	route, err := client.ExamineTopicRouteInfo(ctx, topic)
	if err != nil {
		return nil, err
	}
	addresses := masterAddressesFromRoute(route)
	if len(addresses) == 0 {
		return nil, fmt.Errorf("no RocketMQ master broker found for topic %s", topic)
	}
	merged := &admin.ConsumeStats{OffsetTable: make(map[string]*admin.OffsetWrapper)}
	successCount := 0
	var lastErr error
	for _, address := range addresses {
		response, requestErr := invokeRemotingWithClient(ctx, address, remoting.NewRequest(
			remoting.GetConsumeStats,
			map[string]string{"consumerGroup": groupID, "topic": topic},
		))
		if requestErr != nil {
			lastErr = requestErr
			continue
		}
		partial, decodeErr := decodeConsumeStats(response.Body)
		if decodeErr != nil {
			lastErr = decodeErr
			continue
		}
		successCount++
		for key, offset := range partial.OffsetTable {
			merged.OffsetTable[key] = offset
		}
		merged.ConsumeTps += partial.ConsumeTps
	}
	if successCount == 0 {
		return nil, fmt.Errorf("query consumer lag for group %s on all masters: %w", groupID, lastErr)
	}
	if len(merged.OffsetTable) == 0 && successCount != len(addresses) {
		return nil, fmt.Errorf("consumer lag for group %s is incomplete: %w", groupID, lastErr)
	}
	return merged, nil
}

func decodeConsumeStats(body []byte) (*admin.ConsumeStats, error) {
	var stats admin.ConsumeStats
	if err := json.Unmarshal(repairRocketMQJSON(body), &stats); err != nil {
		return nil, fmt.Errorf("decode consumer stats: %w", err)
	}
	if stats.OffsetTable == nil {
		stats.OffsetTable = make(map[string]*admin.OffsetWrapper)
	}
	return &stats, nil
}

func (a *rocketMQAgent) collectSubscriptionGroupConfigs(ctx context.Context) (map[string]*subscriptionGroupConfig, error) {
	addresses, err := a.masterBrokerAddresses("")
	if err != nil {
		return nil, err
	}
	merged := make(map[string]*subscriptionGroupConfig)
	var lastErr error
	for _, address := range addresses {
		configs, fetchErr := fetchSubscriptionGroupConfigs(ctx, address)
		if fetchErr != nil {
			lastErr = fetchErr
			continue
		}
		for name, next := range configs {
			current := merged[name]
			if current == nil || next.ConsumeMessageOrderly {
				merged[name] = next
			}
		}
	}
	if len(merged) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return merged, nil
}

func fetchSubscriptionGroupConfigs(ctx context.Context, address string) (map[string]*subscriptionGroupConfig, error) {
	response, err := invokeRemotingWithClient(ctx, address,
		remoting.NewRequest(remoting.GetAllSubscriptionGroupConfig, nil))
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		SubscriptionGroupTable map[string]*subscriptionGroupConfig `json:"subscriptionGroupTable"`
	}
	if err := json.Unmarshal(repairRocketMQJSON(response.Body), &wrapper); err != nil {
		return nil, fmt.Errorf("decode subscription groups: %w", err)
	}
	return wrapper.SubscriptionGroupTable, nil
}

func writeSubscriptionGroupConfig(ctx context.Context, address string, config *subscriptionGroupConfig) error {
	body, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("encode subscription group config: %w", err)
	}
	command := remoting.NewRequest(remoting.UpdateAndCreateSubscriptionGroup, nil)
	command.Body = body
	_, err = invokeRemotingWithClient(ctx, address, command)
	return err
}

func ensureMutationCoverage(action, resource string, attempted, succeeded int, lastErr error) error {
	if attempted <= 0 {
		return fmt.Errorf("no RocketMQ master brokers available to %s %s", action, resource)
	}
	if succeeded == attempted {
		return nil
	}
	message := fmt.Sprintf("failed to %s %s on all masters: %d of %d succeeded", action, resource, succeeded, attempted)
	if lastErr != nil {
		return fmt.Errorf("%s: %w", message, lastErr)
	}
	return fmt.Errorf("%s", message)
}

func (a *rocketMQAgent) enrichConsumerGroups(ctx context.Context, client *admin.Client, rows []map[string]any) {
	for _, row := range rows {
		groupID := fmt.Sprint(row["groupId"])
		connection, err := client.ExamineConsumerConnectionInfo(ctx, groupID)
		if err != nil {
			if _, ok := row["topics"]; !ok {
				row["topics"] = []string{}
			}
			continue
		}
		row["consumeType"] = valueOrDefault(connection.ConsumeType, "UNKNOWN")
		row["messageModel"] = valueOrDefault(connection.MessageModel, "CLUSTERING")
		row["memberCount"] = len(connection.ConnectionSet)
		topics := make([]string, 0, len(connection.SubscriptionTable))
		for topic := range connection.SubscriptionTable {
			topics = append(topics, topic)
		}
		sort.Strings(topics)
		row["topics"] = topics
	}
}

func (a *rocketMQAgent) attachConsumerGroupLag(rows []map[string]any, topic string) {
	semaphore := make(chan struct{}, 8)
	var waitGroup sync.WaitGroup
	for _, row := range rows {
		row := row
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			result, err := a.getConsumerLag(map[string]any{"groupId": row["groupId"], "topic": topic})
			if err != nil {
				row["totalLagFailed"] = true
				return
			}
			lag := result.(map[string]any)
			row["totalLag"] = lag["totalLag"]
			row["partitions"] = lag["partitions"]
		}()
	}
	waitGroup.Wait()
}

func classifyConsumerGroup(groupID string, config *subscriptionGroupConfig) string {
	if _, ok := systemConsumerGroups[groupID]; ok {
		return "SYSTEM"
	}
	if config == nil {
		return "UNKNOWN"
	}
	if config.ConsumeMessageOrderly {
		return "FIFO"
	}
	return "NORMAL"
}

func subscriptionGroupConfigMap(config *subscriptionGroupConfig) map[string]any {
	return map[string]any{
		"groupName": config.GroupName, "consumeEnable": config.ConsumeEnable,
		"consumeFromMinEnable":   config.ConsumeFromMinEnable,
		"consumeBroadcastEnable": config.ConsumeBroadcastEnable,
		"consumeMessageOrderly":  config.ConsumeMessageOrderly,
		"retryQueueNums":         config.RetryQueueNums, "retryMaxTimes": config.RetryMaxTimes,
		"brokerId": config.BrokerID, "whichBrokerWhenConsumeSlowly": config.WhichBrokerWhenConsumeSlowly,
	}
}

func applySubscriptionGroupUpdates(config *subscriptionGroupConfig, params map[string]any) {
	config.ConsumeEnable = boolValue(params, config.ConsumeEnable, "consumeEnable")
	config.ConsumeFromMinEnable = boolValue(params, config.ConsumeFromMinEnable, "consumeFromMinEnable")
	config.ConsumeBroadcastEnable = boolValue(params, config.ConsumeBroadcastEnable, "consumeBroadcastEnable")
	config.ConsumeMessageOrderly = boolValue(params, config.ConsumeMessageOrderly, "consumeMessageOrderly")
	config.RetryQueueNums = intValue(params, config.RetryQueueNums, "retryQueueNums")
	config.RetryMaxTimes = intValue(params, config.RetryMaxTimes, "retryMaxTimes")
	config.BrokerID = int64Value(params, config.BrokerID, "brokerId")
	config.WhichBrokerWhenConsumeSlowly = int64Value(params, config.WhichBrokerWhenConsumeSlowly, "whichBrokerWhenConsumeSlowly")
}

func uniqueStrings(values []string) []string {
	result := values[:0]
	var previous string
	for index, value := range values {
		if index == 0 || value != previous {
			result = append(result, value)
			previous = value
		}
	}
	return result
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func emptyToNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}
