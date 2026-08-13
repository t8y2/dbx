package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"unicode/utf8"

	amqp "github.com/rabbitmq/amqp091-go"
)

const (
	maxPeekMessages          = 10000
	defaultPermissionPattern = ".*"
)

var exchangeTypes = map[string]struct{}{
	"direct": {}, "fanout": {}, "topic": {}, "headers": {},
}

func (s *server) listTopics(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	allVhosts := allVhostsRequested(params)
	queues, err := managementGetAll(connection, managementListPath(params, connection, "queues"))
	if err != nil {
		return nil, err
	}
	topics := make([]jsonObject, 0, len(queues))
	for _, value := range queues {
		queue, ok := value.(map[string]any)
		if !ok {
			continue
		}
		info := topicInfoFromJSON(jsonObject(queue))
		if allVhosts {
			attachVhost(info, jsonObject(queue))
		}
		topics = append(topics, info)
	}
	sort.SliceStable(topics, func(left, right int) bool {
		return stringOrEmpty(topics[left], "name") < stringOrEmpty(topics[right], "name")
	})
	return jsonObject{"topics": topics}, nil
}

func topicInfoFromJSON(queue jsonObject) jsonObject {
	info := jsonObject{
		"name":       stringOrEmpty(queue, "name"),
		"durable":    boolOrDefault(queue, "durable", false),
		"autoDelete": boolOrDefault(queue, "auto_delete", false),
		"state":      stringOrEmpty(queue, "state"),
		"messages":   longOrDefault(queue, "messages", 0),
		"consumers":  longOrDefault(queue, "consumers", 0),
	}
	putIfPresent(info, "messagesReady", longOrNull(queue, "messages_ready"))
	putIfPresent(info, "messagesUnacked", longOrNull(queue, "messages_unacknowledged"))
	return info
}

func (s *server) createTopic(params jsonObject) (any, error) {
	channel, err := s.channelFor(params)
	if err != nil {
		return nil, err
	}
	name, err := queueName(params)
	if err != nil {
		return nil, err
	}
	arguments := amqp.Table{}
	if configs := objectOrNil(params, "configs"); configs != nil {
		for key, value := range configs {
			if converted := argumentValue(value); converted != nil {
				arguments[key] = converted
			}
		}
	}
	_, err = channel.QueueDeclare(name, boolOrDefault(params, "durable", true), false, false, false, arguments)
	if err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) deleteTopic(params jsonObject) (any, error) {
	channel, err := s.channelFor(params)
	if err != nil {
		return nil, err
	}
	name, err := queueName(params)
	if err != nil {
		return nil, err
	}
	if _, err := channel.QueueDelete(name, false, false, false); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) getTopicStats(params jsonObject) (any, error) {
	name, err := queueName(params)
	if err != nil {
		return nil, err
	}
	if connection := s.currentConnectionConfig(params); connection != nil {
		vhost := effectiveVhost(params, connection)
		queue, managementError := managementGet(connection,
			"/api/queues/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name))
		if managementError == nil {
			if info, ok := queue.(map[string]any); ok {
				messages := longOrDefault(jsonObject(info), "messages", 0)
				return jsonObject{
					"name":          name,
					"messageCount":  messages,
					"consumerCount": longOrDefault(jsonObject(info), "consumers", 0),
					"totalMessages": messages,
				}, nil
			}
		} else {
			fmt.Fprintln(os.Stderr, "Management API unavailable for queue stats, falling back to passive declare: "+managementError.Error())
		}
	}
	channel, err := s.channelFor(params)
	if err != nil {
		return nil, err
	}
	queue, err := channel.QueueDeclarePassive(name, false, false, false, false, nil)
	if err != nil {
		return nil, err
	}
	return jsonObject{
		"name":          name,
		"messageCount":  queue.Messages,
		"consumerCount": queue.Consumers,
		"totalMessages": queue.Messages,
	}, nil
}

func (s *server) getTopicConfig(params jsonObject) (any, error) {
	channel, err := s.channelFor(params)
	if err != nil {
		return nil, err
	}
	name, err := queueName(params)
	if err != nil {
		return nil, err
	}
	configs := jsonObject{}
	if connection := s.currentConnectionConfig(params); connection != nil {
		vhost := effectiveVhost(params, connection)
		queue, managementError := managementGet(connection,
			"/api/queues/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name))
		if managementError == nil {
			if info, ok := queue.(map[string]any); ok {
				object := jsonObject(info)
				configs["durable"] = boolOrDefault(object, "durable", false)
				configs["auto_delete"] = boolOrDefault(object, "auto_delete", false)
				configs["exclusive"] = boolOrDefault(object, "exclusive", false)
				if arguments := objectOrNil(object, "arguments"); arguments != nil {
					for key, value := range arguments {
						if value == nil {
							configs[key] = nil
						} else {
							configs[key] = fmt.Sprint(value)
						}
					}
				}
			}
		} else {
			fmt.Fprintln(os.Stderr, "Management API unavailable for queue config: "+managementError.Error())
		}
	}
	if len(configs) == 0 {
		if _, err := channel.QueueDeclarePassive(name, false, false, false, false, nil); err != nil {
			return nil, err
		}
	}
	return jsonObject{"configs": configs}, nil
}

func (s *server) purgeQueue(params jsonObject) (any, error) {
	name, err := queueName(params)
	if err != nil {
		return nil, err
	}
	channel, err := s.channelFor(params)
	if err != nil {
		return nil, err
	}
	purged, err := channel.QueuePurge(name, false)
	if err != nil {
		return nil, err
	}
	return jsonObject{"ok": true, "purged": purged}, nil
}

func (s *server) listConsumers(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	name, err := queueName(params)
	if err != nil {
		return nil, err
	}
	vhost := effectiveVhost(params, connection)
	queue, err := managementGet(connection,
		"/api/queues/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name))
	if err != nil {
		return nil, err
	}
	info, ok := queue.(map[string]any)
	if !ok {
		return nil, errors.New("Unexpected management API response for queue details")
	}
	return jsonObject{"consumers": consumersFromQueueInfo(jsonObject(info))}, nil
}

func consumersFromQueueInfo(info jsonObject) []jsonObject {
	details := arrayOrNil(info, "consumer_details")
	consumers := make([]jsonObject, 0, len(details))
	for _, value := range details {
		consumerMap, ok := value.(map[string]any)
		if !ok {
			continue
		}
		consumer := jsonObject(consumerMap)
		channelName := ""
		if channelDetails := objectOrNil(consumer, "channel_details"); channelDetails != nil {
			channelName = stringOrEmpty(channelDetails, "name")
		}
		entry := jsonObject{
			"name":        channelName,
			"tag":         stringOrEmpty(consumer, "consumer_tag"),
			"active":      boolOrDefault(consumer, "active", false),
			"ackRequired": boolOrDefault(consumer, "ack_required", false),
		}
		if prefetch := integerOrNull(consumer, "prefetch_count"); prefetch != nil {
			entry["prefetch"] = *prefetch
		}
		consumers = append(consumers, entry)
	}
	return consumers
}

func (s *server) listNamespaces(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	vhosts, err := managementGet(connection, "/api/vhosts")
	if err != nil {
		return nil, err
	}
	array, ok := vhosts.([]any)
	if !ok {
		return nil, errors.New("Unexpected management API response for vhost listing")
	}
	namespaces := make([]jsonObject, 0, len(array))
	for _, value := range array {
		vhost, ok := value.(map[string]any)
		if ok {
			namespaces = append(namespaces, jsonObject{"name": stringOrEmpty(jsonObject(vhost), "name")})
		}
	}
	return jsonObject{"namespaces": namespaces}, nil
}

func (s *server) createNamespace(params jsonObject) (any, error) {
	namespace, err := namespaceName(params)
	if err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if _, err := managementSend(connection, http.MethodPut, "/api/vhosts/"+urlEncodeVhost(namespace), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) deleteNamespace(params jsonObject) (any, error) {
	namespace, err := namespaceName(params)
	if err != nil {
		return nil, err
	}
	if err := assertNamespaceDeletable(namespace, ""); err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if err := assertNamespaceDeletable(namespace, stringOrDefault(connection, "virtual_host", "/")); err != nil {
		return nil, err
	}
	if _, err := managementSend(connection, http.MethodDelete, "/api/vhosts/"+urlEncodeVhost(namespace), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func namespaceName(params jsonObject) (string, error) {
	name := stringOrEmpty(params, "namespace")
	if strings.TrimSpace(name) == "" {
		return "", errors.New("namespace is required")
	}
	if strings.TrimSpace(name) == "*" {
		return "", errors.New("namespace create/delete requires a specific virtual host (all-vhosts context)")
	}
	return name, nil
}

func assertNamespaceDeletable(namespace, connectedVhost string) error {
	if namespace == "/" {
		return errors.New("The default virtual host '/' cannot be deleted")
	}
	if connectedVhost != "" && namespace == connectedVhost {
		return fmt.Errorf("Cannot delete the virtual host '%s' while connected to it", namespace)
	}
	return nil
}

func (s *server) listExchanges(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	allVhosts := allVhostsRequested(params)
	exchanges, err := managementGetAll(connection, managementListPath(params, connection, "exchanges"))
	if err != nil {
		return nil, err
	}
	result := make([]jsonObject, 0, len(exchanges))
	for _, value := range exchanges {
		exchange, ok := value.(map[string]any)
		if !ok {
			continue
		}
		info := exchangeInfoFromJSON(jsonObject(exchange))
		if allVhosts {
			attachVhost(info, jsonObject(exchange))
		}
		result = append(result, info)
	}
	sort.SliceStable(result, func(left, right int) bool {
		return stringOrEmpty(result[left], "name") < stringOrEmpty(result[right], "name")
	})
	return jsonObject{"exchanges": result}, nil
}

func exchangeInfoFromJSON(exchange jsonObject) jsonObject {
	exchangeType := stringOrEmpty(exchange, "type")
	if exchangeType == "" {
		exchangeType = "default"
	}
	return jsonObject{
		"name":       stringOrEmpty(exchange, "name"),
		"type":       exchangeType,
		"durable":    boolOrDefault(exchange, "durable", false),
		"autoDelete": boolOrDefault(exchange, "auto_delete", false),
		"internal":   boolOrDefault(exchange, "internal", false),
	}
}

func (s *server) createExchange(params jsonObject) (any, error) {
	name, err := exchangeName(params)
	if err != nil {
		return nil, err
	}
	exchangeType, err := validateExchangeType(stringOrEmpty(params, "type"))
	if err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	vhost := effectiveVhost(params, connection)
	body := jsonObject{
		"type":        exchangeType,
		"durable":     boolOrDefault(params, "durable", true),
		"auto_delete": boolOrDefault(params, "autoDelete", false),
	}
	if _, err := managementSend(connection, http.MethodPut,
		"/api/exchanges/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name), body); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) deleteExchange(params jsonObject) (any, error) {
	name := stringOrEmpty(params, "name")
	if err := assertExchangeDeletable(name); err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		return nil, errors.New("name is required")
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	vhost := effectiveVhost(params, connection)
	if _, err := managementSend(connection, http.MethodDelete,
		"/api/exchanges/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func exchangeName(params jsonObject) (string, error) {
	name := stringOrEmpty(params, "name")
	if strings.TrimSpace(name) == "" {
		return "", errors.New("name is required")
	}
	return name, nil
}

func validateExchangeType(exchangeType string) (string, error) {
	if _, ok := exchangeTypes[exchangeType]; !ok {
		return "", fmt.Errorf("Invalid exchange type '%s'. Supported types: direct, fanout, topic, headers", exchangeType)
	}
	return exchangeType, nil
}

func assertExchangeDeletable(name string) error {
	if name == "" {
		return errors.New("The default exchange cannot be deleted")
	}
	if strings.HasPrefix(name, "amq.") {
		return fmt.Errorf("The built-in exchange '%s' cannot be deleted", name)
	}
	return nil
}

func (s *server) listBindings(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	allVhosts := allVhostsRequested(params)
	bindings, err := managementGetAll(connection, managementListPath(params, connection, "bindings"))
	if err != nil {
		return nil, err
	}
	exchangeFilter := stringOrEmpty(params, "exchange")
	queueFilter := stringOrEmpty(params, "queue")
	result := make([]jsonObject, 0, len(bindings))
	for _, value := range bindings {
		binding, ok := value.(map[string]any)
		if !ok {
			continue
		}
		info := bindingInfoFromJSON(jsonObject(binding))
		if exchangeFilter != "" && exchangeFilter != stringOrEmpty(info, "source") {
			continue
		}
		if queueFilter != "" && !(queueFilter == stringOrEmpty(info, "destination") && stringOrEmpty(info, "destinationType") == "queue") {
			continue
		}
		if allVhosts {
			attachVhost(info, jsonObject(binding))
		}
		result = append(result, info)
	}
	return jsonObject{"bindings": result}, nil
}

func bindingInfoFromJSON(binding jsonObject) jsonObject {
	info := jsonObject{
		"source":          stringOrEmpty(binding, "source"),
		"destination":     stringOrEmpty(binding, "destination"),
		"destinationType": stringOrEmpty(binding, "destination_type"),
		"routingKey":      stringOrEmpty(binding, "routing_key"),
	}
	if arguments := objectOrNil(binding, "arguments"); len(arguments) > 0 {
		mapped := jsonObject{}
		for key, value := range arguments {
			if value == nil {
				continue
			}
			if converted := argumentValue(value); converted != nil {
				mapped[key] = converted
			} else {
				encoded, _ := json.Marshal(value)
				mapped[key] = string(encoded)
			}
		}
		if len(mapped) > 0 {
			info["arguments"] = mapped
		}
	}
	return info
}

func (s *server) bind(params jsonObject) (any, error) {
	if err := s.applyBinding(params, true); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) unbind(params jsonObject) (any, error) {
	if err := s.applyBinding(params, false); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) applyBinding(params jsonObject, bind bool) error {
	source, err := requireBindingName(params, "source")
	if err != nil {
		return err
	}
	destination, err := requireBindingName(params, "destination")
	if err != nil {
		return err
	}
	destinationType := stringOrDefault(params, "destinationType", stringOrEmpty(params, "destination_type"))
	if destinationType != "queue" && destinationType != "exchange" {
		return fmt.Errorf("destinationType must be 'queue' or 'exchange', got '%s'", destinationType)
	}
	routingKey := stringOrDefault(params, "routingKey", stringOrEmpty(params, "routing_key"))
	arguments := bindingArguments(params)
	channel, err := s.channelFor(params)
	if err != nil {
		return err
	}
	if destinationType == "queue" {
		if bind {
			return channel.QueueBind(destination, routingKey, source, false, arguments)
		}
		return channel.QueueUnbind(destination, routingKey, source, arguments)
	}
	if bind {
		return channel.ExchangeBind(destination, routingKey, source, false, arguments)
	}
	return channel.ExchangeUnbind(destination, routingKey, source, false, arguments)
}

func requireBindingName(params jsonObject, key string) (string, error) {
	name := stringOrEmpty(params, key)
	if strings.TrimSpace(name) == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return name, nil
}

func bindingArguments(params jsonObject) amqp.Table {
	arguments := amqp.Table{}
	if values := objectOrNil(params, "arguments"); values != nil {
		for key, value := range values {
			if converted := argumentValue(value); converted != nil {
				arguments[key] = converted
			}
		}
	}
	return arguments
}

func (s *server) listClientConnections(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	connections, err := managementGetAll(connection, "/api/connections")
	if err != nil {
		return nil, err
	}
	allVhosts := allVhostsRequested(params)
	filter := vhostFilter(params, connection)
	result := make([]jsonObject, 0, len(connections))
	for _, value := range connections {
		entry, ok := value.(map[string]any)
		if !ok {
			continue
		}
		object := jsonObject(entry)
		if filter != "" && filter != stringOrEmpty(object, "vhost") {
			continue
		}
		info := clientConnectionInfoFromJSON(object)
		if allVhosts {
			attachVhost(info, object)
		}
		result = append(result, info)
	}
	sort.SliceStable(result, func(left, right int) bool {
		return stringOrEmpty(result[left], "name") < stringOrEmpty(result[right], "name")
	})
	return jsonObject{"connections": result}, nil
}

func clientConnectionInfoFromJSON(connection jsonObject) jsonObject {
	info := jsonObject{
		"name":     stringOrEmpty(connection, "name"),
		"user":     stringOrEmpty(connection, "user"),
		"peerHost": stringOrEmpty(connection, "peer_host"),
		"peerPort": longOrDefault(connection, "peer_port", 0),
		"state":    stringOrEmpty(connection, "state"),
		"channels": longOrDefault(connection, "channels", 0),
	}
	if rate := rateFromDetails(connection, "recv_oct_details"); rate != nil {
		info["recvRate"] = *rate
	}
	if rate := rateFromDetails(connection, "send_oct_details"); rate != nil {
		info["sendRate"] = *rate
	}
	if connectedAt := longOrNull(connection, "connected_at"); connectedAt != nil {
		info["connectedAt"] = *connectedAt
	}
	return info
}

func rateFromDetails(object jsonObject, key string) *float64 {
	return floatOrNull(objectOrNil(object, key), "rate")
}

func (s *server) listClientChannels(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	channels, err := managementGetAll(connection, "/api/channels")
	if err != nil {
		return nil, err
	}
	connectionFilter := stringOrEmpty(params, "connection")
	allVhosts := allVhostsRequested(params)
	filter := vhostFilter(params, connection)
	result := make([]jsonObject, 0, len(channels))
	for _, value := range channels {
		entry, ok := value.(map[string]any)
		if !ok {
			continue
		}
		object := jsonObject(entry)
		if filter != "" && filter != stringOrEmpty(object, "vhost") {
			continue
		}
		info := channelInfoFromJSON(object)
		if allVhosts {
			attachVhost(info, object)
		}
		if connectionFilter != "" && !channelMatchesConnection(info, connectionFilter) {
			continue
		}
		result = append(result, info)
	}
	sort.SliceStable(result, func(left, right int) bool {
		return stringOrEmpty(result[left], "name") < stringOrEmpty(result[right], "name")
	})
	return jsonObject{"channels": result}, nil
}

func channelInfoFromJSON(channel jsonObject) jsonObject {
	info := jsonObject{
		"name":  stringOrEmpty(channel, "name"),
		"state": stringOrEmpty(channel, "state"),
	}
	if details := objectOrNil(channel, "connection_details"); details != nil {
		if connectionName := stringOrEmpty(details, "name"); connectionName != "" {
			info["connectionName"] = connectionName
		}
	}
	if prefetch := integerOrNull(channel, "prefetch_count"); prefetch != nil {
		info["prefetch"] = *prefetch
	}
	if unacked := longOrNull(channel, "messages_unacknowledged"); unacked != nil {
		info["messagesUnacked"] = *unacked
	}
	if consumers := longOrNull(channel, "consumer_count"); consumers != nil {
		info["consumerCount"] = *consumers
	}
	return info
}

func channelMatchesConnection(channelInfo jsonObject, connectionName string) bool {
	return stringOrEmpty(channelInfo, "connectionName") == connectionName || strings.HasPrefix(stringOrEmpty(channelInfo, "name"), connectionName)
}

func (s *server) closeClientConnection(params jsonObject) (any, error) {
	name := stringOrEmpty(params, "name")
	if strings.TrimSpace(name) == "" {
		return nil, errors.New("name is required")
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if _, err := managementSend(connection, http.MethodDelete, "/api/connections/"+urlEncodeName(name), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) listUsers(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	users, err := managementGetAll(connection, "/api/users")
	if err != nil {
		return nil, err
	}
	result := make([]jsonObject, 0, len(users))
	for _, value := range users {
		user, ok := value.(map[string]any)
		if ok {
			result = append(result, userInfoFromJSON(jsonObject(user)))
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		return stringOrEmpty(result[left], "name") < stringOrEmpty(result[right], "name")
	})
	return jsonObject{"users": result}, nil
}

func userInfoFromJSON(user jsonObject) jsonObject {
	return jsonObject{
		"name": stringOrEmpty(user, "name"),
		"tags": parseUserTags(stringOrEmpty(user, "tags")),
	}
}

func parseUserTags(tags string) []string {
	result := make([]string, 0)
	for _, tag := range strings.Split(tags, ",") {
		if trimmed := strings.TrimSpace(tag); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func (s *server) createUser(params jsonObject) (any, error) {
	name, err := userName(params)
	if err != nil {
		return nil, err
	}
	password := stringOrEmpty(params, "password")
	if password == "" {
		return nil, errors.New("password is required")
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if err := assertNotConnectedUser("create or modify", name, stringOrDefault(connection, "username", "guest")); err != nil {
		return nil, err
	}
	body := jsonObject{"password": password, "tags": userTagsParam(params)}
	if _, err := managementSend(connection, http.MethodPut, "/api/users/"+urlEncodePathSegment(name), body); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func userTagsParam(params jsonObject) string {
	value, exists := params["tags"]
	if !exists || value == nil {
		return ""
	}
	if tags, ok := value.([]any); ok {
		parts := make([]string, 0, len(tags))
		for _, tag := range tags {
			trimmed := strings.TrimSpace(fmt.Sprint(tag))
			if trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
		return strings.Join(parts, ",")
	}
	return fmt.Sprint(value)
}

func (s *server) deleteUser(params jsonObject) (any, error) {
	name, err := userName(params)
	if err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if err := assertNotConnectedUser("delete", name, stringOrDefault(connection, "username", "guest")); err != nil {
		return nil, err
	}
	if _, err := managementSend(connection, http.MethodDelete, "/api/users/"+urlEncodePathSegment(name), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func assertNotConnectedUser(action, name, connectedUser string) error {
	if name == connectedUser {
		return fmt.Errorf("Cannot %s user '%s' while connected as that user", action, name)
	}
	return nil
}

func (s *server) listPermissions(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	permissions, err := managementGet(connection, "/api/permissions")
	if err != nil {
		return nil, err
	}
	array, ok := permissions.([]any)
	if !ok {
		return nil, errors.New("Unexpected management API response for permission listing")
	}
	vhostFilter := stringOrEmpty(params, "virtual_host")
	if allVhostsRequested(params) {
		vhostFilter = ""
	}
	userFilter := stringOrEmpty(params, "user")
	result := make([]jsonObject, 0, len(array))
	for _, value := range array {
		permission, ok := value.(map[string]any)
		if !ok {
			continue
		}
		info := permissionInfoFromJSON(jsonObject(permission))
		if vhostFilter != "" && vhostFilter != stringOrEmpty(info, "vhost") {
			continue
		}
		if userFilter != "" && userFilter != stringOrEmpty(info, "user") {
			continue
		}
		result = append(result, info)
	}
	sort.SliceStable(result, func(left, right int) bool {
		leftUser := stringOrEmpty(result[left], "user")
		rightUser := stringOrEmpty(result[right], "user")
		if leftUser != rightUser {
			return leftUser < rightUser
		}
		return stringOrEmpty(result[left], "vhost") < stringOrEmpty(result[right], "vhost")
	})
	return jsonObject{"permissions": result}, nil
}

func permissionInfoFromJSON(permission jsonObject) jsonObject {
	return jsonObject{
		"user":      stringOrEmpty(permission, "user"),
		"vhost":     stringOrEmpty(permission, "vhost"),
		"configure": stringOrEmpty(permission, "configure"),
		"write":     stringOrEmpty(permission, "write"),
		"read":      stringOrEmpty(permission, "read"),
	}
}

func (s *server) grantPermission(params jsonObject) (any, error) {
	user, err := userName(params)
	if err != nil {
		return nil, err
	}
	vhost, err := permissionVhost(params)
	if err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	body := jsonObject{
		"configure": permissionPattern(params, "configure"),
		"write":     permissionPattern(params, "write"),
		"read":      permissionPattern(params, "read"),
	}
	if _, err := managementSend(connection, http.MethodPut,
		"/api/permissions/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(user), body); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) revokePermission(params jsonObject) (any, error) {
	user, err := userName(params)
	if err != nil {
		return nil, err
	}
	vhost, err := permissionVhost(params)
	if err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if _, err := managementSend(connection, http.MethodDelete,
		"/api/permissions/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(user), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func permissionPattern(params jsonObject, key string) string {
	pattern := stringOrEmpty(params, key)
	if strings.TrimSpace(pattern) == "" {
		return defaultPermissionPattern
	}
	return pattern
}

func permissionVhost(params jsonObject) (string, error) {
	vhost := stringOrEmpty(params, "virtual_host")
	if strings.TrimSpace(vhost) == "" {
		return "", errors.New("virtual_host is required")
	}
	if vhost == "*" {
		return "", errors.New("all_vhosts is only supported for list operations")
	}
	return vhost, nil
}

func userName(params jsonObject) (string, error) {
	name := stringOrEmpty(params, "name")
	if strings.TrimSpace(name) == "" {
		name = stringOrEmpty(params, "user")
	}
	if strings.TrimSpace(name) == "" {
		return "", errors.New("user name is required")
	}
	return name, nil
}

func (s *server) listPolicies(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	allVhosts := allVhostsRequested(params) || stringOrEmpty(params, "virtual_host") == "*"
	path := "/api/policies/" + urlEncodeVhost(effectiveVhost(params, connection))
	if allVhosts {
		path = "/api/policies"
	}
	policies, err := managementGetAll(connection, path)
	if err != nil {
		return nil, err
	}
	result := make([]jsonObject, 0, len(policies))
	for _, value := range policies {
		policy, ok := value.(map[string]any)
		if ok {
			result = append(result, policyInfoFromJSON(jsonObject(policy)))
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		leftVhost := stringOrEmpty(result[left], "vhost")
		rightVhost := stringOrEmpty(result[right], "vhost")
		if leftVhost != rightVhost {
			return leftVhost < rightVhost
		}
		return stringOrEmpty(result[left], "name") < stringOrEmpty(result[right], "name")
	})
	return jsonObject{"policies": result}, nil
}

func policyInfoFromJSON(policy jsonObject) jsonObject {
	definition := jsonObject{}
	if rawDefinition := objectOrNil(policy, "definition"); rawDefinition != nil {
		for key, value := range rawDefinition {
			if value == nil {
				continue
			}
			if converted := argumentValue(value); converted != nil {
				definition[key] = converted
			} else {
				encoded, _ := json.Marshal(value)
				definition[key] = string(encoded)
			}
		}
	}
	return jsonObject{
		"name":       stringOrEmpty(policy, "name"),
		"vhost":      stringOrEmpty(policy, "vhost"),
		"pattern":    stringOrEmpty(policy, "pattern"),
		"applyTo":    stringOrEmpty(policy, "apply-to"),
		"priority":   longOrDefault(policy, "priority", 0),
		"definition": definition,
	}
}

func (s *server) setPolicy(params jsonObject) (any, error) {
	vhost, err := permissionVhost(params)
	if err != nil {
		return nil, err
	}
	name, err := policyName(params)
	if err != nil {
		return nil, err
	}
	pattern := stringOrEmpty(params, "pattern")
	if strings.TrimSpace(pattern) == "" {
		return nil, errors.New("pattern is required")
	}
	definition := objectOrNil(params, "definition")
	if definition == nil {
		return nil, errors.New("definition is required")
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	body := jsonObject{
		"pattern":    pattern,
		"apply-to":   stringOrDefault(params, "applyTo", "queues"),
		"priority":   intOrDefault(params, "priority", 0),
		"definition": definition,
	}
	if _, err := managementSend(connection, http.MethodPut,
		"/api/policies/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name), body); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func (s *server) deletePolicy(params jsonObject) (any, error) {
	vhost, err := permissionVhost(params)
	if err != nil {
		return nil, err
	}
	name, err := policyName(params)
	if err != nil {
		return nil, err
	}
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	if _, err := managementSend(connection, http.MethodDelete,
		"/api/policies/"+urlEncodeVhost(vhost)+"/"+urlEncodePathSegment(name), nil); err != nil {
		return nil, err
	}
	return okResult(), nil
}

func policyName(params jsonObject) (string, error) {
	name := stringOrEmpty(params, "name")
	if strings.TrimSpace(name) == "" {
		return "", errors.New("name is required")
	}
	return name, nil
}

func (s *server) peekMessages(params jsonObject) (any, error) {
	queue, err := queueName(params)
	if err != nil {
		return nil, err
	}
	offset := normalizePeekOffset(longOrDefault(params, "offset", 0))
	count := normalizePeekCount(intOrDefault(params, "count", 10))
	if offset >= maxPeekMessages {
		return jsonObject{"messages": []jsonObject{}}, nil
	}
	totalToFetch := offset + int64(count)
	if totalToFetch > maxPeekMessages {
		totalToFetch = maxPeekMessages
	}
	var channel *amqp.Channel
	var ownedConnection *amqp.Connection
	if s.cachedConnection != nil {
		channel, err = s.channelFor(params)
	} else {
		config := deepCopyObject(connectionObject(params))
		if vhost := stringOrNull(params, "virtual_host"); vhost != nil && strings.TrimSpace(*vhost) != "" {
			config["virtual_host"] = *vhost
		}
		ownedConnection, err = openConnection(config)
		if err == nil {
			channel, err = ownedConnection.Channel()
		}
	}
	if err != nil {
		closeConnection(ownedConnection)
		return nil, err
	}
	if ownedConnection != nil {
		defer closeConnection(ownedConnection)
		defer closeChannel(channel)
	}
	fetched := make([]amqp.Delivery, 0, totalToFetch)
	var lastDeliveryTag uint64
	for index := int64(0); index < totalToFetch; index++ {
		delivery, ok, getError := channel.Get(queue, false)
		if getError != nil {
			return nil, getError
		}
		if !ok {
			break
		}
		fetched = append(fetched, delivery)
		lastDeliveryTag = delivery.DeliveryTag
	}
	if lastDeliveryTag > 0 {
		if err := channel.Nack(lastDeliveryTag, true, true); err != nil {
			return nil, err
		}
	}
	messageCapacity := peekMessageCapacity(len(fetched), offset, count)
	messages := make([]jsonObject, 0, messageCapacity)
	for index := offset; index < int64(len(fetched)) && len(messages) < count; index++ {
		messages = append(messages, peekedMessageFromDelivery(queue, index, fetched[index]))
	}
	return jsonObject{"messages": messages}, nil
}

func peekMessageCapacity(fetched int, offset int64, count int) int {
	available := fetched - int(offset)
	if available < 0 {
		return 0
	}
	if available > count {
		return count
	}
	return available
}

func normalizePeekOffset(requested int64) int64 {
	if requested < 0 {
		return 0
	}
	return requested
}

func normalizePeekCount(requested int) int {
	if requested < 1 {
		return 1
	}
	return requested
}

func resolveRoutingKey(params jsonObject, queue string) string {
	routingKey := stringOrDefault(params, "routing_key", "")
	if routingKey == "" {
		routingKey = stringOrDefault(params, "routingKey", "")
	}
	if routingKey == "" {
		routingKey = stringOrDefault(params, "key", "")
	}
	if strings.TrimSpace(routingKey) == "" {
		return queue
	}
	return routingKey
}

func peekedMessageFromDelivery(queue string, index int64, delivery amqp.Delivery) jsonObject {
	message := jsonObject{
		"topic":         queue,
		"offset":        index,
		"exchange":      delivery.Exchange,
		"routingKey":    delivery.RoutingKey,
		"redelivered":   delivery.Redelivered,
		"deliveryTag":   delivery.DeliveryTag,
		"timestamp":     int64(0),
		"headers":       stringHeaders(delivery.Headers),
		"payloadBase64": base64.StdEncoding.EncodeToString(delivery.Body),
	}
	if delivery.MessageId != "" {
		message["messageId"] = delivery.MessageId
	}
	if !delivery.Timestamp.IsZero() {
		message["timestamp"] = delivery.Timestamp.UnixMilli()
	}
	if utf8.Valid(delivery.Body) {
		message["payloadText"] = string(delivery.Body)
	}
	return message
}

func stringHeaders(headers amqp.Table) map[string]string {
	result := make(map[string]string, len(headers))
	for key, value := range headers {
		switch typed := value.(type) {
		case []byte:
			result[key] = string(typed)
		default:
			result[key] = fmt.Sprint(typed)
		}
	}
	return result
}

func (s *server) sendMessage(params jsonObject) (any, error) {
	channel, err := s.channelFor(params)
	if err != nil {
		return nil, err
	}
	queue, err := queueName(params)
	if err != nil {
		return nil, err
	}
	exchange := stringOrDefault(params, "exchange", "")
	routingKey := resolveRoutingKey(params, queue)
	payload := stringOrEmpty(params, "payloadBase64")
	body := []byte{}
	if payload != "" {
		body, err = base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return nil, err
		}
	}
	publishing := amqp.Publishing{Body: body}
	if headers := objectOrNil(params, "headers"); headers != nil {
		publishing.Headers = amqp.Table{}
		for key, value := range headers {
			if converted := argumentValue(value); converted != nil {
				publishing.Headers[key] = converted
			}
		}
	}
	if err := channel.PublishWithContext(context.Background(), exchange, routingKey, false, false, publishing); err != nil {
		return nil, err
	}
	return jsonObject{"ok": true, "exchange": exchange, "routingKey": routingKey}, nil
}

func (s *server) describeCluster(params jsonObject) (any, error) {
	connection, err := s.requireConnection()
	if err != nil {
		return nil, err
	}
	config := s.currentConnectionConfig(params)
	nodes := make([]jsonObject, 0)
	if config != nil {
		addresses, resolveError := resolveAddresses(config)
		if resolveError != nil {
			return nil, resolveError
		}
		for _, endpoint := range addresses {
			nodes = append(nodes, jsonObject{"name": endpoint.Host, "port": endpoint.Port})
		}
	}
	return jsonObject{
		"clusterName": serverString(connection.Properties, "cluster_name"),
		"product":     serverString(connection.Properties, "product"),
		"version":     serverString(connection.Properties, "version"),
		"platform":    serverString(connection.Properties, "platform"),
		"nodes":       nodes,
		"nodeCount":   len(nodes),
	}, nil
}

func (s *server) getOverview(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	overview, err := managementGet(connection, "/api/overview")
	if err != nil {
		return nil, err
	}
	object, ok := overview.(map[string]any)
	if !ok {
		return nil, errors.New("Unexpected management API response for cluster overview")
	}
	return overviewInfoFromJSON(jsonObject(object)), nil
}

func overviewInfoFromJSON(overview jsonObject) jsonObject {
	info := jsonObject{}
	putIfPresent(info, "messagesReady", nestedLongOrNull(overview, "queue_totals", "messages_ready"))
	putIfPresent(info, "messagesUnacked", nestedLongOrNull(overview, "queue_totals", "messages_unacknowledged"))
	if stats := objectOrNil(overview, "message_stats"); stats != nil {
		putIfPresent(info, "publishRate", rateFromDetails(stats, "publish_details"))
		putIfPresent(info, "deliverRate", rateFromDetails(stats, "deliver_get_details"))
		putIfPresent(info, "ackRate", rateFromDetails(stats, "ack_details"))
	}
	putIfPresent(info, "totalQueues", nestedLongOrNull(overview, "object_totals", "queues"))
	putIfPresent(info, "totalExchanges", nestedLongOrNull(overview, "object_totals", "exchanges"))
	putIfPresent(info, "totalConnections", nestedLongOrNull(overview, "object_totals", "connections"))
	putIfPresent(info, "totalChannels", nestedLongOrNull(overview, "object_totals", "channels"))
	putIfPresent(info, "totalConsumers", nestedLongOrNull(overview, "object_totals", "consumers"))
	return info
}

func (s *server) listNodes(params jsonObject) (any, error) {
	connection, err := s.requireConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	nodes, err := managementGet(connection, "/api/nodes")
	if err != nil {
		return nil, err
	}
	array, ok := nodes.([]any)
	if !ok {
		return nil, errors.New("Unexpected management API response for node listing")
	}
	result := make([]jsonObject, 0, len(array))
	for _, value := range array {
		node, ok := value.(map[string]any)
		if ok {
			result = append(result, nodeInfoFromJSON(jsonObject(node)))
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		return stringOrEmpty(result[left], "name") < stringOrEmpty(result[right], "name")
	})
	return jsonObject{"nodes": result}, nil
}

func nodeInfoFromJSON(node jsonObject) jsonObject {
	info := jsonObject{
		"name":    stringOrEmpty(node, "name"),
		"running": boolOrDefault(node, "running", false),
	}
	putIfPresent(info, "memUsed", longOrNull(node, "mem_used"))
	putIfPresent(info, "memLimit", longOrNull(node, "mem_limit"))
	putIfPresent(info, "diskFree", longOrNull(node, "disk_free"))
	putIfPresent(info, "fdUsed", longOrNull(node, "fd_used"))
	putIfPresent(info, "fdTotal", longOrNull(node, "fd_total"))
	putIfPresent(info, "socketsUsed", longOrNull(node, "sockets_used"))
	putIfPresent(info, "socketsTotal", longOrNull(node, "sockets_total"))
	putIfPresent(info, "uptimeMs", longOrNull(node, "uptime"))
	return info
}

func nestedLongOrNull(object jsonObject, block, key string) *int64 {
	return longOrNull(objectOrNil(object, block), key)
}

func putIfPresent(info jsonObject, key string, value any) {
	switch typed := value.(type) {
	case *int64:
		if typed != nil {
			info[key] = *typed
		}
	case *float64:
		if typed != nil {
			info[key] = *typed
		}
	case nil:
	default:
		info[key] = typed
	}
}
