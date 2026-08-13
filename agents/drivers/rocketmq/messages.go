package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
	"github.com/apache/rocketmq-client-go/v2/primitive"
)

const sendMessageRequestCode = 10
const queryMessageNotFoundCode = 208

type messageQueueTarget struct {
	BrokerName string
	Address    string
	QueueID    int
}

func (a *rocketMQAgent) listProducers(params map[string]any) (any, error) {
	client, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	topic := stringValue(params, "topic")
	producerGroup := stringValue(params, "producerGroup", "group")
	rows := make([]map[string]any, 0)
	if producerGroup != "" {
		if topic == "" {
			return nil, fmt.Errorf("topic is required when producerGroup is specified")
		}
		connection, queryErr := client.ExamineProducerConnectionInfo(ctx, producerGroup, topic)
		if queryErr != nil {
			return nil, queryErr
		}
		for index, connectionInfo := range connection.ConnectionSet {
			rows = append(rows, producerRow(int64(index+1), producerGroup, connectionInfo))
		}
		return map[string]any{"producers": rows}, nil
	}

	addresses := make([]string, 0)
	if topic != "" {
		stats, statsErr := a.examineTopicStats(ctx, client, topic)
		if statsErr != nil {
			return nil, statsErr
		}
		hasMessages := false
		for _, offset := range stats {
			if offset.MaxOffset > offset.MinOffset {
				hasMessages = true
				break
			}
		}
		if !hasMessages {
			return map[string]any{"producers": rows}, nil
		}
		route, routeErr := client.ExamineTopicRouteInfo(ctx, topic)
		if routeErr != nil {
			return nil, routeErr
		}
		for _, broker := range route.BrokerDatas {
			if address := broker.BrokerAddrs["0"]; address != "" {
				addresses = append(addresses, address)
			}
		}
	} else {
		a.mu.RLock()
		addresses = append(addresses, a.brokerAddr)
		a.mu.RUnlock()
	}
	seen := make(map[string]struct{})
	var producerID int64 = 1
	for _, address := range uniqueStrings(addresses) {
		producerTable, tableErr := client.GetAllProducerInfo(ctx, address)
		if tableErr != nil {
			continue
		}
		for _, group := range sortedKeys(producerTable) {
			for _, connectionInfo := range producerTable[group] {
				key := group + "|" + connectionInfo.ClientAddr
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				rows = append(rows, producerRow(producerID, group, connectionInfo))
				producerID++
			}
		}
	}
	return map[string]any{"producers": rows}, nil
}

func (a *rocketMQAgent) peekMessages(params map[string]any) (any, error) {
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	count := min(max(1, intValue(params, 10, "count")), 100)
	partition, hasPartition := optionalInt(params, "partition")
	offset, hasOffset := optionalInt64(params, "offset")
	targets, err := a.messageQueueTargets(ctx, client, topic, false)
	if err != nil {
		return nil, err
	}
	messages := make([]map[string]any, 0, count)
	for _, target := range targets {
		if len(messages) >= count {
			break
		}
		if hasPartition && target.QueueID != partition {
			continue
		}
		startOffset := offset
		if !hasOffset {
			startOffset, err = queueOffset(ctx, target.Address, topic, target.QueueID, remoting.GetMinOffset)
			if err != nil {
				continue
			}
		}
		pullResult, pullErr := client.PullMessage(ctx, target.Address, topic, target.QueueID, startOffset, count-len(messages))
		if pullErr != nil {
			continue
		}
		for _, message := range pullResult.Messages {
			message.BrokerName = target.BrokerName
			messages = append(messages, messageMap(topic, message))
			if len(messages) >= count {
				break
			}
		}
	}
	sortMessageRows(messages)
	return map[string]any{"messages": messages}, nil
}

func (a *rocketMQAgent) viewMessage(params map[string]any) (any, error) {
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	messageID, err := requireString(params, "msgId")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	messages, queryErr := queryMessagesByKey(ctx, client, config.ConnectTimeout,
		topic, messageID, 32, 0, time.Now().UnixMilli())
	if queryErr == nil {
		for _, message := range messages {
			if message.MsgId == messageID || message.OffsetMsgId == messageID || message.Properties[primitive.PropertyUniqueClientMessageIdKeyIndex] == messageID {
				return map[string]any{"message": messageMap(topic, message)}, nil
			}
		}
		if len(messages) > 0 {
			return map[string]any{"message": messageMap(topic, messages[0])}, nil
		}
	}
	partition, hasPartition := optionalInt(params, "partition")
	offset, hasOffset := optionalInt64(params, "offset")
	if hasPartition && hasOffset {
		targets, targetErr := a.messageQueueTargets(ctx, client, topic, false)
		if targetErr == nil {
			for _, target := range targets {
				if target.QueueID != partition {
					continue
				}
				pullResult, pullErr := client.PullMessage(ctx, target.Address, topic, partition, offset, 1)
				if pullErr == nil && len(pullResult.Messages) > 0 {
					return map[string]any{"message": messageMap(topic, pullResult.Messages[0])}, nil
				}
			}
		}
	}
	if queryErr != nil {
		return nil, queryErr
	}
	return nil, fmt.Errorf("message not found: %s", messageID)
}

func (a *rocketMQAgent) queryMessageByKey(params map[string]any) (any, error) {
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	key, err := requireString(params, "key")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	maxNum := min(max(1, intValue(params, 32, "maxNum")), 200)
	messages, err := queryMessagesByKey(ctx, client, config.ConnectTimeout, topic, key, maxNum,
		int64Value(params, 0, "begin"), int64Value(params, time.Now().UnixMilli(), "end"))
	if err != nil {
		if isEmptyMessageQueryError(err) {
			return emptyMessageQuery(), nil
		}
		return nil, err
	}
	return messageQueryResult(topic, messages), nil
}

func queryMessagesByKey(
	ctx context.Context,
	client *admin.Client,
	connectTimeout time.Duration,
	topic string,
	key string,
	maxNum int,
	beginTimestamp int64,
	endTimestamp int64,
) ([]*admin.MessageExt, error) {
	route, err := client.ExamineTopicRouteInfo(ctx, topic)
	if err != nil {
		return nil, err
	}
	targets := make([]messageQueueTarget, 0, len(route.BrokerDatas))
	for _, broker := range route.BrokerDatas {
		if address := broker.BrokerAddrs["0"]; address != "" {
			targets = append(targets, messageQueueTarget{BrokerName: broker.BrokerName, Address: address})
		}
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no RocketMQ master broker found for topic %s", topic)
	}
	messages := make([]*admin.MessageExt, 0)
	successCount := 0
	var lastErr error
	for _, target := range targets {
		response, requestErr := invokeRemotingAllowCodes(ctx, target.Address, connectTimeout,
			buildQueryMessageCommand(topic, key, maxNum, beginTimestamp, endTimestamp),
			remoting.Success, queryMessageNotFoundCode)
		if requestErr != nil {
			lastErr = requestErr
			continue
		}
		successCount++
		if response.Code == queryMessageNotFoundCode || len(response.Body) == 0 {
			continue
		}
		for _, message := range primitive.DecodeMessage(response.Body) {
			queueID := 0
			if message.Queue != nil {
				queueID = message.Queue.QueueId
			}
			messageTopic := message.Topic
			if messageTopic == "" {
				messageTopic = topic
			}
			messages = append(messages, &admin.MessageExt{
				Topic: messageTopic, QueueId: queueID, QueueOffset: message.QueueOffset,
				MsgId: message.MsgId, OffsetMsgId: message.OffsetMsgId, Body: message.Body,
				Flag: int(message.Flag), BornTimestamp: message.BornTimestamp,
				StoreTimestamp: message.StoreTimestamp, BornHost: message.BornHost,
				StoreHost: message.StoreHost, SysFlag: int(message.SysFlag),
				BrokerName: target.BrokerName, Properties: message.GetProperties(),
			})
		}
	}
	if successCount == 0 {
		return nil, fmt.Errorf("query messages for topic %s on all masters: %w", topic, lastErr)
	}
	return messages, nil
}

func buildQueryMessageCommand(topic, key string, maxNum int, beginTimestamp, endTimestamp int64) *remoting.RemotingCommand {
	return remoting.NewRequest(remoting.QueryMessage, map[string]string{
		"topic": topic, "key": key, "maxNum": strconv.Itoa(maxNum),
		"beginTimestamp": strconv.FormatInt(beginTimestamp, 10),
		"endTimestamp":   strconv.FormatInt(endTimestamp, 10),
	})
}

func (a *rocketMQAgent) queryMessageByTopic(params map[string]any) (any, error) {
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	maxNum := min(max(1, intValue(params, 32, "maxNum")), 200)
	messages, err := client.QueryMessageByTime(ctx, topic,
		int64Value(params, 0, "begin"), int64Value(params, time.Now().UnixMilli(), "end"), maxNum)
	if err != nil {
		return nil, err
	}
	return messageQueryResult(topic, messages), nil
}

func (a *rocketMQAgent) queryMessageTrace(params map[string]any) (any, error) {
	messageID, err := requireString(params, "msgId")
	if err != nil {
		return nil, err
	}
	traceTopic := stringValue(params, "traceTopic")
	if traceTopic == "" {
		traceTopic = "RMQ_SYS_TRACE_TOPIC"
	}
	result, err := a.queryMessageByKey(map[string]any{
		"topic": traceTopic, "key": messageID,
		"maxNum": intValue(params, 64, "maxNum"),
		"begin":  int64Value(params, 0, "begin"),
		"end":    int64Value(params, time.Now().UnixMilli(), "end"),
	})
	if err != nil {
		return nil, err
	}
	response := result.(map[string]any)
	response["msgId"] = messageID
	response["traceTopic"] = traceTopic
	return response, nil
}

func (a *rocketMQAgent) sendMessage(params map[string]any) (any, error) {
	topic, err := requireString(params, "topic")
	if err != nil {
		return nil, err
	}
	payload, err := decodePayload(params)
	if err != nil {
		return nil, err
	}
	client, config, _ := a.requireClient()
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	targets, err := a.messageQueueTargets(ctx, client, topic, true)
	if err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no writable queue for topic %s", topic)
	}
	partition, hasPartition := optionalInt(params, "partition")
	selected := targets[0]
	if hasPartition {
		found := false
		for _, target := range targets {
			if target.QueueID == partition {
				selected = target
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("partition %d not found for topic %s", partition, topic)
		}
	}
	command := buildSendMessageCommand(topic, payload, selected.QueueID, params, time.Now().UnixMilli())
	response, err := invokeRemotingAllowCodes(ctx, selected.Address, config.ConnectTimeout, command, 0, 10, 11, 12)
	if err != nil {
		return nil, err
	}
	queueID, _ := strconv.Atoi(response.ExtFields["queueId"])
	queueOffset, _ := strconv.ParseInt(response.ExtFields["queueOffset"], 10, 64)
	return map[string]any{
		"ok": true, "topic": topic, "partition": queueID,
		"offset": queueOffset, "timestamp": time.Now().UnixMilli(),
	}, nil
}

func buildSendMessageCommand(topic string, payload []byte, queueID int, params map[string]any, bornTimestamp int64) *remoting.RemotingCommand {
	message := primitive.NewMessage(topic, payload)
	message.WithProperty(primitive.PropertyUniqueClientMessageIdKeyIndex, primitive.CreateUniqID())
	headers := mapValue(params, "headers")
	key := stringValue(params, "key")
	if key == "" {
		key = stringValue(headers, primitive.PropertyKeys)
	}
	tag := stringValue(params, "tag")
	if tag == "" {
		tag = stringValue(headers, primitive.PropertyTags)
	}
	if key != "" {
		message.WithKeys([]string{key})
	}
	if tag != "" {
		message.WithTag(tag)
	}
	for header, raw := range headers {
		if raw == nil {
			continue
		}
		value := strings.TrimSpace(fmt.Sprint(raw))
		if value == "" || header == primitive.PropertyKeys || header == primitive.PropertyTags || isReservedMessageProperty(header) {
			continue
		}
		message.WithProperty(header, value)
	}
	command := remoting.NewRequest(sendMessageRequestCode, map[string]string{
		"producerGroup": "_DBX_ROCKETMQ_PRODUCER", "topic": topic,
		"defaultTopic": "TBW102", "defaultTopicQueueNums": "4",
		"queueId": strconv.Itoa(queueID), "sysFlag": "0",
		"bornTimestamp": strconv.FormatInt(bornTimestamp, 10), "flag": "0",
		"properties": message.MarshallProperties(), "reconsumeTimes": "0",
		"unitMode": "false", "maxReconsumeTimes": "0", "batch": "false",
	})
	command.Body = payload
	return command
}

func (a *rocketMQAgent) messageQueueTargets(ctx context.Context, client *admin.Client, topic string, writable bool) ([]messageQueueTarget, error) {
	route, err := client.ExamineTopicRouteInfo(ctx, topic)
	if err != nil {
		return nil, err
	}
	addresses := make(map[string]string, len(route.BrokerDatas))
	for _, broker := range route.BrokerDatas {
		if address := broker.BrokerAddrs["0"]; address != "" {
			addresses[broker.BrokerName] = address
		}
	}
	targets := make([]messageQueueTarget, 0)
	for _, queueData := range route.QueueDatas {
		address := addresses[queueData.BrokerName]
		if address == "" {
			continue
		}
		queueCount := queueData.ReadQueueNums
		if writable {
			queueCount = queueData.WriteQueueNums
		}
		for queueID := 0; queueID < queueCount; queueID++ {
			targets = append(targets, messageQueueTarget{
				BrokerName: queueData.BrokerName, Address: address, QueueID: queueID,
			})
		}
	}
	sort.Slice(targets, func(i, j int) bool {
		if targets[i].BrokerName != targets[j].BrokerName {
			return targets[i].BrokerName < targets[j].BrokerName
		}
		return targets[i].QueueID < targets[j].QueueID
	})
	return targets, nil
}

func queueOffset(ctx context.Context, address, topic string, queueID, requestCode int) (int64, error) {
	response, err := invokeRemotingWithClient(ctx, address, remoting.NewRequest(requestCode, map[string]string{
		"topic": topic, "queueId": strconv.Itoa(queueID),
	}))
	if err != nil {
		return 0, err
	}
	offset, err := strconv.ParseInt(response.ExtFields["offset"], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid queue offset: %w", err)
	}
	return offset, nil
}

func messageMap(topic string, message *admin.MessageExt) map[string]any {
	headers := make(map[string]string, len(message.Properties))
	for key, value := range message.Properties {
		headers[key] = value
	}
	row := map[string]any{
		"topic": topic, "messageId": message.MsgId, "partition": message.QueueId,
		"offset": message.QueueOffset, "timestamp": message.StoreTimestamp,
		"key": message.Properties[primitive.PropertyKeys], "tag": message.Properties[primitive.PropertyTags],
		"headers": headers, "payloadBase64": base64.StdEncoding.EncodeToString(message.Body),
	}
	if utf8.Valid(message.Body) {
		row["payloadText"] = string(message.Body)
	}
	return row
}

func messageQueryResult(topic string, messages []*admin.MessageExt) map[string]any {
	rows := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		rows = append(rows, messageMap(topic, message))
	}
	sortMessageRows(rows)
	return map[string]any{"messages": rows, "indexLastUpdateTimestamp": int64(0)}
}

func emptyMessageQuery() map[string]any {
	return map[string]any{"messages": []map[string]any{}, "indexLastUpdateTimestamp": int64(0)}
}

func sortMessageRows(messages []map[string]any) {
	sort.Slice(messages, func(i, j int) bool {
		leftTime := anyInt64(messages[i]["timestamp"])
		rightTime := anyInt64(messages[j]["timestamp"])
		if leftTime != rightTime {
			return leftTime < rightTime
		}
		leftPartition := int(anyInt64(messages[i]["partition"]))
		rightPartition := int(anyInt64(messages[j]["partition"]))
		if leftPartition != rightPartition {
			return leftPartition < rightPartition
		}
		return anyInt64(messages[i]["offset"]) < anyInt64(messages[j]["offset"])
	})
}

func producerRow(producerID int64, group string, connection admin.Connection) map[string]any {
	return map[string]any{
		"producerId": producerID, "producerName": group, "msgRateIn": 0.0,
		"msgThroughputIn": 0.0, "clientVersion": strconv.Itoa(connection.Version),
		"address": connection.ClientAddr, "lastTimestamp": int64(0),
	}
}

func optionalInt(params map[string]any, key string) (int, bool) {
	if _, ok := params[key]; !ok || params[key] == nil {
		return 0, false
	}
	return intValue(params, 0, key), true
}

func optionalInt64(params map[string]any, key string) (int64, bool) {
	if _, ok := params[key]; !ok || params[key] == nil {
		return 0, false
	}
	return int64Value(params, 0, key), true
}

func mapValue(params map[string]any, key string) map[string]any {
	if value, ok := params[key].(map[string]any); ok {
		return value
	}
	return map[string]any{}
}

func anyInt64(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(typed, 10, 64)
		return parsed
	default:
		return 0
	}
}

func isEmptyMessageQueryError(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "208") || strings.Contains(message, "no message") || strings.Contains(message, "未找到消息")
}

func isReservedMessageProperty(key string) bool {
	switch key {
	case primitive.PropertyUniqueClientMessageIdKeyIndex, primitive.PropertyWaitStoreMsgOk,
		primitive.PropertyDelayTimeLevel, primitive.PropertyRetryTopic,
		primitive.PropertyRealTopic, primitive.PropertyRealQueueId,
		primitive.PropertyTransactionPrepared, primitive.PropertyProducerGroup,
		primitive.PropertyMinOffset, primitive.PropertyMaxOffset,
		primitive.PropertyBuyerId, primitive.PropertyOriginMessageId,
		primitive.PropertyTransferFlag, primitive.PropertyCorrectionFlag,
		primitive.PropertyMQ2Flag, primitive.PropertyReconsumeTime,
		primitive.PropertyMsgRegion, primitive.PropertyTraceSwitch,
		primitive.PropertyMaxReconsumeTimes, primitive.PropertyConsumeStartTime,
		primitive.PropertyTranscationPreparedQueueOffset, primitive.PropertyTranscationCheckTimes,
		primitive.PropertyCheckImmunityTimeInSeconds, primitive.PropertyShardingKey,
		primitive.PropertyTransactionID, primitive.PropertyCorrelationID,
		primitive.PropertyMessageReplyToClient, primitive.PropertyMessageTTL,
		primitive.PropertyReplyMessageArriveTime, primitive.PropertyMsgType,
		primitive.PropertyCluster:
		return true
	default:
		return false
	}
}
