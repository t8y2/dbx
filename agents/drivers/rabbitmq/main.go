package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const (
	protocolVersion         = 1
	agentProtocolVersion    = 1
	defaultAMQPPort         = 5672
	defaultRequestTimeout   = 30 * time.Second
	defaultHandshakeTimeout = 10 * time.Second
	defaultHeartbeat        = 60 * time.Second
	defaultChannelMax       = 2047
	maxRPCMessageBytes      = 32 * 1024 * 1024
)

var capabilities = []string{
	"mq_connect", "mq_test_connection", "mq_topics",
	"mq_messages", "mq_config", "mq_monitoring", "mq_exchanges",
	"mq_client_connections", "mq_user_permissions", "mq_policies",
}

var allVhostsUnsupportedMethods = map[string]struct{}{
	"mq_create_topic": {}, "mq_delete_topic": {}, "mq_purge_queue": {}, "mq_send_message": {},
	"mq_bind": {}, "mq_unbind": {}, "mq_create_exchange": {}, "mq_delete_exchange": {},
	"mq_peek_messages": {}, "mq_get_topic_stats": {}, "mq_list_consumers": {}, "mq_close_connection": {},
	"mq_grant_permission": {}, "mq_revoke_permission": {}, "mq_set_policy": {}, "mq_delete_policy": {},
}

type jsonObject map[string]any

type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type handshakeResult struct {
	ProtocolVersion      int      `json:"protocolVersion"`
	AgentProtocolVersion int      `json:"agentProtocolVersion"`
	Capabilities         []string `json:"capabilities"`
}

type address struct {
	Host string
	Port int
}

type vhostClient struct {
	connection *amqp.Connection
	channel    *amqp.Channel
}

type server struct {
	connection       *amqp.Connection
	channel          *amqp.Channel
	cachedConnection jsonObject
	vhostClients     map[string]*vhostClient
}

func main() {
	service := newServer()
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	fmt.Fprintln(os.Stdout, `{"ready":true}`)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxRPCMessageBytes)
	for scanner.Scan() {
		response, shutdown := service.handleRequest(scanner.Bytes())
		if err := encoder.Encode(response); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		if shutdown {
			return
		}
	}
	service.closeClients()
}

func newServer() *server {
	return &server{vhostClients: make(map[string]*vhostClient)}
}

func (s *server) handleRequest(line []byte) (rpcResponse, bool) {
	response := rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null")}
	var request rpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		response.Error = &rpcError{Code: -1, Message: normalizeErrorMessage(err)}
		return response, false
	}
	if len(request.ID) > 0 {
		response.ID = request.ID
	}
	params := jsonObject{}
	if len(request.Params) > 0 && string(request.Params) != "null" {
		var decoded any
		if err := decodeJSON(request.Params, &decoded); err != nil {
			response.Error = &rpcError{Code: -1, Message: normalizeErrorMessage(err)}
			return response, false
		}
		if object, ok := decoded.(map[string]any); ok {
			params = jsonObject(object)
		}
	}
	result, shutdown, err := s.dispatch(request.Method, params)
	if err != nil {
		response.Error = &rpcError{Code: -1, Message: normalizeErrorMessage(err)}
		return response, false
	}
	response.Result = result
	return response, shutdown
}

func (s *server) dispatch(method string, params jsonObject) (any, bool, error) {
	if _, unsupported := allVhostsUnsupportedMethods[method]; unsupported && allVhostsRequested(params) {
		return nil, false, errors.New("all_vhosts is only supported for list operations")
	}
	switch method {
	case "handshake":
		return handshakeResult{protocolVersion, agentProtocolVersion, capabilities}, false, nil
	case "connect":
		result, err := s.connect(params)
		return result, false, err
	case "test_connection":
		result, err := s.testConnection(params)
		return result, false, err
	case "disconnect":
		s.closeClients()
		return okResult(), false, nil
	case "shutdown":
		s.closeClients()
		return okResult(), true, nil
	case "mq_list_topics":
		result, err := s.listTopics(params)
		return result, false, err
	case "mq_create_topic":
		result, err := s.createTopic(params)
		return result, false, err
	case "mq_delete_topic":
		result, err := s.deleteTopic(params)
		return result, false, err
	case "mq_get_topic_stats":
		result, err := s.getTopicStats(params)
		return result, false, err
	case "mq_get_topic_config":
		result, err := s.getTopicConfig(params)
		return result, false, err
	case "mq_alter_topic_config":
		return nil, false, errors.New("RabbitMQ queue arguments are immutable after declaration; delete and re-declare the queue to change them")
	case "mq_purge_queue":
		result, err := s.purgeQueue(params)
		return result, false, err
	case "mq_list_consumers":
		result, err := s.listConsumers(params)
		return result, false, err
	case "mq_list_namespaces":
		result, err := s.listNamespaces(params)
		return result, false, err
	case "mq_create_namespace":
		result, err := s.createNamespace(params)
		return result, false, err
	case "mq_delete_namespace":
		result, err := s.deleteNamespace(params)
		return result, false, err
	case "mq_list_exchanges":
		result, err := s.listExchanges(params)
		return result, false, err
	case "mq_create_exchange":
		result, err := s.createExchange(params)
		return result, false, err
	case "mq_delete_exchange":
		result, err := s.deleteExchange(params)
		return result, false, err
	case "mq_list_bindings":
		result, err := s.listBindings(params)
		return result, false, err
	case "mq_bind":
		result, err := s.bind(params)
		return result, false, err
	case "mq_unbind":
		result, err := s.unbind(params)
		return result, false, err
	case "mq_list_connections":
		result, err := s.listClientConnections(params)
		return result, false, err
	case "mq_list_channels":
		result, err := s.listClientChannels(params)
		return result, false, err
	case "mq_close_connection":
		result, err := s.closeClientConnection(params)
		return result, false, err
	case "mq_list_users":
		result, err := s.listUsers(params)
		return result, false, err
	case "mq_create_user":
		result, err := s.createUser(params)
		return result, false, err
	case "mq_delete_user":
		result, err := s.deleteUser(params)
		return result, false, err
	case "mq_list_permissions":
		result, err := s.listPermissions(params)
		return result, false, err
	case "mq_grant_permission":
		result, err := s.grantPermission(params)
		return result, false, err
	case "mq_revoke_permission":
		result, err := s.revokePermission(params)
		return result, false, err
	case "mq_list_policies":
		result, err := s.listPolicies(params)
		return result, false, err
	case "mq_set_policy":
		result, err := s.setPolicy(params)
		return result, false, err
	case "mq_delete_policy":
		result, err := s.deletePolicy(params)
		return result, false, err
	case "mq_peek_messages":
		result, err := s.peekMessages(params)
		return result, false, err
	case "mq_send_message":
		result, err := s.sendMessage(params)
		return result, false, err
	case "mq_describe_cluster":
		result, err := s.describeCluster(params)
		return result, false, err
	case "mq_overview":
		result, err := s.getOverview(params)
		return result, false, err
	case "mq_list_nodes":
		result, err := s.listNodes(params)
		return result, false, err
	default:
		return nil, false, fmt.Errorf("Unknown method: %s", method)
	}
}

func (s *server) connect(params jsonObject) (any, error) {
	config := connectionObject(params)
	nextConnection, err := openConnection(config)
	if err != nil {
		return nil, err
	}
	nextChannel, err := nextConnection.Channel()
	if err != nil {
		closeConnection(nextConnection)
		return nil, err
	}
	s.closeClients()
	s.connection = nextConnection
	s.channel = nextChannel
	s.cachedConnection = deepCopyObject(config)
	return okResult(), nil
}

func (s *server) testConnection(params jsonObject) (any, error) {
	config := connectionObject(params)
	connection, err := openConnection(config)
	if err != nil {
		return nil, err
	}
	defer closeConnection(connection)
	version := serverString(connection.Properties, "version")
	return jsonObject{
		"ok":            true,
		"product":       serverString(connection.Properties, "product"),
		"version":       version,
		"serverVersion": version,
		"clusterName":   serverString(connection.Properties, "cluster_name"),
		"platform":      serverString(connection.Properties, "platform"),
	}, nil
}

func (s *server) closeClients() {
	for key, client := range s.vhostClients {
		client.close()
		delete(s.vhostClients, key)
	}
	closeChannel(s.channel)
	s.channel = nil
	closeConnection(s.connection)
	s.connection = nil
	s.cachedConnection = nil
}

func (client *vhostClient) close() {
	if client == nil {
		return
	}
	closeChannel(client.channel)
	closeConnection(client.connection)
}

func (client *vhostClient) isOpen() bool {
	return client != nil && client.connection != nil && !client.connection.IsClosed() && client.channel != nil && !client.channel.IsClosed()
}

func closeChannel(channel *amqp.Channel) {
	if channel != nil {
		_ = channel.Close()
	}
}

func closeConnection(connection *amqp.Connection) {
	if connection != nil {
		_ = connection.Close()
	}
}

func openConnection(config jsonObject) (*amqp.Connection, error) {
	addresses, err := resolveAddresses(config)
	if err != nil {
		return nil, err
	}
	var lastError error
	for _, endpoint := range addresses {
		connection, dialError := dialAddress(config, endpoint)
		if dialError == nil {
			return connection, nil
		}
		lastError = dialError
	}
	if lastError == nil {
		return nil, errors.New("addresses is required")
	}
	return nil, lastError
}

func dialAddress(config jsonObject, endpoint address) (*amqp.Connection, error) {
	properties := objectOrNil(config, "properties")
	connectionTimeout := durationMilliseconds(config, "request_timeout_ms", defaultRequestTimeout)
	if configured, ok := integerProperty(properties, "connection_timeout_ms"); ok {
		connectionTimeout = time.Duration(configured) * time.Millisecond
	}
	handshakeTimeout := defaultHandshakeTimeout
	if configured, ok := integerProperty(properties, "handshake_timeout_ms"); ok {
		handshakeTimeout = time.Duration(configured) * time.Millisecond
	}
	heartbeat := int(defaultHeartbeat / time.Second)
	if configured, ok := integerProperty(properties, "requested_heartbeat"); ok {
		heartbeat = configured
	}
	scheme := "amqp"
	if amqpTLSEnabled(config) {
		scheme = "amqps"
	}
	uri := url.URL{Scheme: scheme, Host: net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port)), Path: "/"}
	query := uri.Query()
	query.Set("heartbeat", strconv.Itoa(heartbeat))
	uri.RawQuery = query.Encode()
	amqpConfig := amqp.Config{
		SASL: []amqp.Authentication{&amqp.PlainAuth{
			Username: credentialOrGuest(config, "username"),
			Password: credentialOrGuest(config, "password"),
		}},
		Vhost:      stringOrDefault(config, "virtual_host", "/"),
		ChannelMax: defaultChannelMax,
		Heartbeat:  time.Duration(heartbeat) * time.Second,
		Dial: func(network, target string) (net.Conn, error) {
			dialer := net.Dialer{Timeout: connectionTimeout}
			connection, err := dialer.Dial(network, target)
			if err != nil {
				return nil, err
			}
			if err := connection.SetDeadline(time.Now().Add(handshakeTimeout)); err != nil {
				_ = connection.Close()
				return nil, err
			}
			return connection, nil
		},
	}
	if scheme == "amqps" {
		amqpConfig.TLSClientConfig = &tls.Config{
			ServerName:         endpoint.Host,
			InsecureSkipVerify: tlsSkipVerify(config),
		}
	}
	return amqp.DialConfig(uri.String(), amqpConfig)
}

func (s *server) channelFor(params jsonObject) (*amqp.Channel, error) {
	defaultVhost := "/"
	if s.cachedConnection != nil {
		defaultVhost = stringOrDefault(s.cachedConnection, "virtual_host", "/")
	}
	vhost := effectiveVhost(params, s.cachedConnection)
	if vhost == defaultVhost {
		return s.primaryChannel()
	}
	if s.cachedConnection == nil {
		return nil, errors.New("Not connected. Call connect first.")
	}
	if client := s.vhostClients[vhost]; client != nil && client.isOpen() {
		return client.channel, nil
	} else if client != nil {
		client.close()
		delete(s.vhostClients, vhost)
	}
	config := deepCopyObject(s.cachedConnection)
	config["virtual_host"] = vhost
	connection, err := openConnection(config)
	if err != nil {
		return nil, err
	}
	channel, err := connection.Channel()
	if err != nil {
		closeConnection(connection)
		return nil, err
	}
	s.vhostClients[vhost] = &vhostClient{connection: connection, channel: channel}
	return channel, nil
}

func (s *server) primaryChannel() (*amqp.Channel, error) {
	if s.connection != nil && !s.connection.IsClosed() && !needsNewChannel(s.channel) {
		return s.channel, nil
	}
	if s.connection == nil || s.connection.IsClosed() {
		if s.cachedConnection == nil {
			return nil, errors.New("Not connected. Call connect first.")
		}
		closeConnection(s.connection)
		connection, err := openConnection(s.cachedConnection)
		if err != nil {
			return nil, err
		}
		s.connection = connection
	}
	closeChannel(s.channel)
	channel, err := s.connection.Channel()
	if err != nil {
		return nil, err
	}
	s.channel = channel
	return channel, nil
}

func needsNewChannel(channel *amqp.Channel) bool {
	return channel == nil || channel.IsClosed()
}

func resolveAddresses(config jsonObject) ([]address, error) {
	addresses := strings.TrimSpace(stringOrEmpty(config, "addresses"))
	if addresses == "" {
		addresses = strings.TrimSpace(stringOrEmpty(config, "host"))
	}
	if addresses == "" {
		return nil, errors.New("addresses is required")
	}
	return parseAddresses(addresses, intOrDefault(config, "port", defaultAMQPPort))
}

func parseAddresses(value string, defaultPort int) ([]address, error) {
	result := make([]address, 0)
	for _, part := range strings.Split(value, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		host := trimmed
		port := defaultPort
		if parsedHost, parsedPort, err := net.SplitHostPort(trimmed); err == nil {
			host = parsedHost
			parsed, parseError := strconv.Atoi(parsedPort)
			if parseError != nil {
				return nil, parseError
			}
			port = parsed
		} else if colon := strings.LastIndex(trimmed, ":"); colon > 0 && colon < len(trimmed)-1 && strings.Count(trimmed, ":") == 1 {
			parsed, parseError := strconv.Atoi(trimmed[colon+1:])
			if parseError != nil {
				return nil, parseError
			}
			host = trimmed[:colon]
			port = parsed
		} else {
			host = strings.TrimPrefix(strings.TrimSuffix(trimmed, "]"), "[")
		}
		result = append(result, address{Host: host, Port: port})
	}
	if len(result) == 0 {
		return nil, errors.New("addresses is required")
	}
	return result, nil
}

func amqpTLSEnabled(config jsonObject) bool {
	_, nestedTLS := config["tls"].(map[string]any)
	if !nestedTLS {
		_, nestedTLS = config["tls"].(jsonObject)
	}
	return nestedTLS || boolOrDefault(config, "tls_skip_verify", false) || boolProperty(config, "ssl") || boolProperty(config, "tls")
}

func tlsSkipVerify(config jsonObject) bool {
	if boolOrDefault(config, "tls_skip_verify", false) {
		return true
	}
	tlsConfig := objectOrNil(config, "tls")
	return boolOrDefault(tlsConfig, "skip_verify", false)
}
